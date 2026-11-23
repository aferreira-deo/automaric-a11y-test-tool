import type { Judgement } from '../adjudication.js';
import { outlineCapture, perceptualHashOfPng } from '../measure/capture.js';
import { GROUP_CANDIDATE_RULE, groupingCandidates, GROUPING_GENERATOR_VERSION, UNASSOCIATED_LABEL_RULE } from '../measure/grouping.js';
import type { AiEvidence, Config, Finding, Png, Snapshot } from '../types.js';
import { PROBLEM_TEXT } from './headings-adjudication.js';

/**
 * The one question a model is asked about a set of radio buttons or checkboxes that stands under
 * a visible text (section 5.5, step 5 of the brief: "ask whether the visible text is the group's
 * label"). Fixed text: nothing of the page goes into it. Change it together with its version.
 */
export const GROUP_QUESTION =
  'The target is a piece of visible text that stands right before or beside a set of radio buttons or checkboxes. ' +
  'Is that text the question or the title that the set of controls answers, so that a reader needs it to understand the options? ' +
  'Answer "yes" if it is the label of the set as a whole. ' +
  'Answer "no" if it is something else: a hint or an error message for another field, a paragraph of the page, the title of a larger part of the form, ' +
  'or if the options are understood without it. ' +
  'Answer "unsure" if what you are given does not let you decide.';
export const GROUP_QUESTION_VERSION = 'grouping-1';

function count(ai: AiEvidence): string {
  return `${ai.votes.length} vote${ai.votes.length === 1 ? '' : 's'}`;
}

/** What the verdict adds to the message of deterministic code, which is kept as it is. */
function note(ai: AiEvidence, before: Finding['status'], after: Finding['status']): string {
  const basis = (ai.inputs === 'text' ? ', from the text alone (no capture was sent)' : '') + (ai.fromCache === true ? ', read from the cache' : '');
  if (ai.verdict === 'yes') {
    return after === before
      ? ` A model judged the same (${count(ai)}${basis}): the text is the label of the set. That does not replace the confirmation by a tester.`
      : ` Raised from ${before} to ${after}: a model judged (${count(ai)}${basis}) that the text is the label of the set. Confirm it.`;
  }
  if (ai.verdict === 'no') {
    return after === before
      ? after === 'likely'
        ? ` A model judged (${count(ai)}${basis}) that the text is not the label of the set. It stays ${after}: a verdict of a model is recorded for the tester and does not take a finding off the list.`
        : ` A model judged the same (${count(ai)}${basis}): the text is not the label of the set.`
      : ` Lowered from ${before} to ${after}: a model judged (${count(ai)}${basis}) that the text is not the label of the set. What was read from the page is unchanged.`;
  }
  const why = ai.problems?.length
    ? ai.problems.map((problem) => PROBLEM_TEXT[problem]).join('; ')
    : ai.votes.length > 1 && new Set(ai.votes).size > 1
      ? 'its votes disagree'
      : 'it was not sure';
  return ` A model was asked and gave no verdict (${why}), so the status is the one deterministic code gave.`;
}

/**
 * Status of a set under a visible text after a verdict. It moves between `info` and `likely` and
 * nowhere else: section 3E of the brief allows no `fail` for grouping, and a verdict that depends
 * on a model is never one.
 * - `yes`: `likely`, whether it was `likely` or `info`.
 * - `no`: a `likely` stays `likely` with the verdict recorded, unless `groupNoStatus` is `info`,
 *   which lowers it; an `info` stays `info`.
 * - `unsure`, which includes every failure: unchanged.
 */
export function groupStatusAfter(before: Finding['status'], verdict: AiEvidence['verdict'], config: Config): 'likely' | 'info' {
  const start = before === 'likely' ? 'likely' : 'info';
  if (verdict === 'yes') return 'likely';
  if (verdict === 'no') return start === 'likely' && config.adjudication.groupNoStatus !== 'info' ? 'likely' : 'info';
  return start;
}

export function applyGroupVerdict(finding: Finding, ai: AiEvidence, config: Config): Finding {
  // Only what deterministic code left between `info` and `likely` is a model's to move.
  if (finding.status !== 'likely' && finding.status !== 'info') return finding;
  const status = groupStatusAfter(finding.status, ai.verdict, config);
  return {
    ...finding,
    status,
    // The rule name follows the status, as it does without a model; the id does not (SET_FINGERPRINT_RULE).
    rule: status === 'likely' ? UNASSOCIATED_LABEL_RULE : GROUP_CANDIDATE_RULE,
    message: finding.message + note(ai, finding.status, status),
    ai,
  };
}

/**
 * What to ask about the findings of the grouping check: one request for each set of radio
 * buttons or checkboxes under a plain visible text that a judgement could change (`adjudicate`),
 * in the order of the candidates.
 *
 * Not asked about: sets whose text is a heading or a button, sets of switches and sets with
 * self-explanatory names (their status is a policy), split fields and sections with the same
 * names (names and groups are facts read from the accessibility tree), and the inventory.
 */
export function groupingJudgements(snapshot: Snapshot, findings: Finding[], config: Config): Judgement[] {
  if (!snapshot.grouping) return [];
  const reported = new Set(findings.filter((finding) => finding.check === 'grouping').map((finding) => finding.id));
  const { adjudication } = config;
  const out: Judgement[] = [];
  for (const candidate of groupingCandidates(snapshot.grouping, config.grouping)) {
    if (candidate.kind !== 'set' || !candidate.adjudicate || !reported.has(candidate.findingId)) continue;
    const capture = candidate.crop ? snapshot.screenshots.clips[candidate.crop] : undefined;
    let crop: Png | null = null;
    let cropHash = '';
    if (adjudication.sendImages && capture && candidate.cropTarget && capture.png.byteLength <= adjudication.maxImageBytes) {
      try {
        cropHash = perceptualHashOfPng(capture.png);
        crop = outlineCapture(capture, candidate.cropTarget, {
          color: adjudication.outlineColor,
          widthCssPx: adjudication.outlineWidthCssPx,
          gapCssPx: adjudication.outlineGapCssPx,
        });
      } catch {
        // A capture that cannot be read is no capture.
        crop = null;
        cropHash = '';
      }
    }
    if (!crop && !adjudication.judgeWithoutImage) continue;
    out.push({
      request: {
        findingId: candidate.findingId,
        check: 'grouping',
        question: GROUP_QUESTION,
        questionVersion: GROUP_QUESTION_VERSION,
        generatorVersion: GROUPING_GENERATOR_VERSION,
        crop,
        cropHash,
        context: candidate.context,
      },
      apply: applyGroupVerdict,
    });
  }
  return out;
}
