import type { Judgement } from '../adjudication.js';
import { outlineCapture, perceptualHashOfPng } from '../measure/capture.js';
import { GLYPH_CANDIDATE_RULE, GLYPH_LIST_RULE, listCandidates, LISTS_GENERATOR_VERSION } from '../measure/lists.js';
import type { AiEvidence, Config, Finding, Png, Snapshot } from '../types.js';
import { PROBLEM_TEXT } from './headings-adjudication.js';

/**
 * The one question a model is asked about a series of lines that each open with a bullet or a
 * number (section 5.4, step 1 of the brief). Fixed text: nothing of the page goes into it.
 * Change it together with its version.
 */
export const LIST_QUESTION =
  'Is the target content presented as a list: a series of parallel items, one under the other, each introduced by a bullet, a dash, a number, a letter or a small symbol? ' +
  'Answer "yes" if a reader would take the lines for the items of one list, whatever their markup. ' +
  'Answer "no" if the lines only open like items: the replies of a dialogue, dates or other figures that happen to count up, footnotes, names with initials, ' +
  'the numbered titles of sections each followed by its own text, lines that each carry a different symbol as a label, prices. ' +
  'Answer "unsure" if what you are given does not let you decide.';
export const LIST_QUESTION_VERSION = 'lists-1';

function count(ai: AiEvidence): string {
  return `${ai.votes.length} vote${ai.votes.length === 1 ? '' : 's'}`;
}

/** What the verdict adds to the message of deterministic code, which is kept as it is. */
function note(ai: AiEvidence, before: Finding['status'], after: Finding['status']): string {
  const basis = (ai.inputs === 'text' ? ', from the text alone (no capture was sent)' : '') + (ai.fromCache === true ? ', read from the cache' : '');
  if (ai.verdict === 'yes') {
    return after === before
      ? ` A model judged the same (${count(ai)}${basis}): the lines are presented as a list. That does not replace the confirmation by a tester.`
      : ` Raised from ${before} to ${after}: a model judged (${count(ai)}${basis}) that the lines are presented as a list. Confirm it.`;
  }
  if (ai.verdict === 'no') {
    return after === before
      ? after === 'likely'
        ? ` A model judged (${count(ai)}${basis}) that the lines are not presented as a list. It stays ${after}: a verdict of a model is recorded for the tester and does not take a finding off the list.`
        : ` A model judged the same (${count(ai)}${basis}): the lines are not presented as a list.`
      : ` Lowered from ${before} to ${after}: a model judged (${count(ai)}${basis}) that the lines are not presented as a list. What was read from the page is unchanged.`;
  }
  const why = ai.problems?.length
    ? ai.problems.map((problem) => PROBLEM_TEXT[problem]).join('; ')
    : ai.votes.length > 1 && new Set(ai.votes).size > 1
      ? 'its votes disagree'
      : 'it was not sure';
  return ` A model was asked and gave no verdict (${why}), so the status is the one deterministic code gave.`;
}

/**
 * Status of a series of lines with bullets or numbers after a verdict. It moves between `info`
 * and `likely` and nowhere else: whether content is presented as a list stays a matter for a tester.
 * - `yes`: `likely`, whether it was `likely` or `info`.
 * - `no`: a `likely` stays `likely` with the verdict recorded, unless `listDisagreeStatus` is `info`,
 *   which lowers it; an `info` stays `info`.
 * - `unsure`, which includes every failure: unchanged.
 */
export function listStatusAfter(before: Finding['status'], verdict: AiEvidence['verdict'], config: Config): 'likely' | 'info' {
  const start = before === 'likely' ? 'likely' : 'info';
  if (verdict === 'yes') return 'likely';
  if (verdict === 'no') return start === 'likely' && config.adjudication.listDisagreeStatus !== 'info' ? 'likely' : 'info';
  return start;
}

export function applyListVerdict(finding: Finding, ai: AiEvidence, config: Config): Finding {
  // Only what deterministic code left between `info` and `likely` is a model's to move.
  if (finding.status !== 'likely' && finding.status !== 'info') return finding;
  const status = listStatusAfter(finding.status, ai.verdict, config);
  return {
    ...finding,
    status,
    // The rule name follows the status, as it does without a model; the id does not (GLYPH_FINGERPRINT_RULE).
    rule: status === 'likely' ? GLYPH_LIST_RULE : GLYPH_CANDIDATE_RULE,
    message: finding.message + note(ai, finding.status, status),
    ai,
  };
}

/**
 * What to ask about the findings of the lists check: one request for each series of lines with
 * bullets or numbers that a judgement could change (`adjudicate`), in the order of the candidates.
 *
 * Not asked about: lists with a removed role (their markers and their role are facts), series of
 * blocks of one shape and layouts of names and values (their status is a policy, section 10.2 of
 * the brief), the inventory of lists without markers, and series inside navigation.
 */
export function listJudgements(snapshot: Snapshot, findings: Finding[], config: Config): Judgement[] {
  if (!snapshot.lists) return [];
  const reported = new Set(findings.filter((finding) => finding.check === 'lists').map((finding) => finding.id));
  const { adjudication } = config;
  const out: Judgement[] = [];
  for (const candidate of listCandidates(snapshot.lists, config.lists)) {
    if (candidate.kind !== 'glyph' || !candidate.adjudicate || !reported.has(candidate.findingId)) continue;
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
        check: 'lists',
        question: LIST_QUESTION,
        questionVersion: LIST_QUESTION_VERSION,
        generatorVersion: LISTS_GENERATOR_VERSION,
        crop,
        cropHash,
        context: candidate.context,
      },
      apply: applyListVerdict,
    });
  }
  return out;
}
