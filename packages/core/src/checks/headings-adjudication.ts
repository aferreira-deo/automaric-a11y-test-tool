import type { Judgement } from '../adjudication.js';
import { outlineCapture, perceptualHashOfPng } from '../measure/capture.js';
import { headingReport, HEADING_CANDIDATE_RULE, HEADINGS_GENERATOR_VERSION, NON_HEADINGS_GENERATOR_VERSION, UNMARKED_HEADING_RULE } from '../measure/headings.js';
import type { AiEvidence, AiProblem, Config, Finding, Png, Snapshot } from '../types.js';

/**
 * The one question a model is asked about a heading candidate (section 5.3 step 7 of the brief).
 * Fixed text: nothing of the page goes into it. Change it together with its version.
 */
export const HEADING_QUESTION =
  'Does the target text function as a heading for the content that follows it? ' +
  'Answer "yes" if it names or introduces the content placed after it, as a heading does, whatever its markup. ' +
  'Answer "no" if it is something else that only looks prominent: the label of a form control or of a value, a price or a figure, ' +
  'a slogan or a tagline, a quotation, a sentence that leads into a paragraph, a link or a button, the name of a person or of an item in a series, a caption, a badge. ' +
  'Answer "unsure" if what you are given does not let you decide.';
export const HEADING_QUESTION_VERSION = 'headings-1';

/** Why a model gave no vote, in words, for the message of a finding. Shared by the checks that are adjudicated. */
export const PROBLEM_TEXT: Record<AiProblem, string> = {
  timeout: 'the model did not answer in time',
  network: 'the model endpoint could not be reached',
  http: 'the model endpoint answered with an error',
  'invalid-output': 'the answer of the model was not in the form that was asked for',
  refusal: 'the model declined to answer',
  truncated: 'the answer of the model was cut off',
  'too-large': 'the answer of the model was too long to read',
  stopped: 'adjudication was stopped before this candidate, because the endpoint kept failing or the time allowed for the page ran out',
};

function count(ai: AiEvidence): string {
  return `${ai.votes.length} vote${ai.votes.length === 1 ? '' : 's'}`;
}

/** What the verdict adds to the message of deterministic code, which is kept as it is. */
function note(ai: AiEvidence, before: Finding['status'], after: Finding['status']): string {
  const basis = (ai.inputs === 'text' ? ', from the text alone (no capture was sent)' : '') + (ai.fromCache === true ? ', read from the cache' : '');
  if (ai.verdict === 'yes') {
    return after === before
      ? ` A model judged the same (${count(ai)}${basis}): it functions as a heading for what follows. That does not replace the confirmation by a tester.`
      : ` Raised from ${before} to ${after}: a model judged (${count(ai)}${basis}) that it functions as a heading for what follows. Confirm it.`;
  }
  if (ai.verdict === 'no') {
    return after === before
      ? after === 'likely'
        ? ` A model judged (${count(ai)}${basis}) that it does not function as a heading. It stays ${after}: a verdict of a model is recorded for the tester and does not take a finding off the list.`
        : ` A model judged the same (${count(ai)}${basis}): it does not function as a heading.`
      : ` Lowered from ${before} to ${after}: a model judged (${count(ai)}${basis}) that it does not function as a heading. The measurements are unchanged.`;
  }
  const why = ai.problems?.length
    ? ai.problems.map((problem) => PROBLEM_TEXT[problem]).join('; ')
    : ai.votes.length > 1 && new Set(ai.votes).size > 1
      ? 'its votes disagree'
      : 'it was not sure';
  return ` A model was asked and gave no verdict (${why}), so the status is the one deterministic code gave.`;
}

/**
 * Status of a heading candidate after a verdict. It moves between `info` and `likely` and
 * nowhere else: whether text functions as a heading stays a matter for a tester.
 * - `yes`: `likely`, whether it was `likely` or `info`.
 * - `no`: a `likely` stays `likely` with the verdict recorded, unless `headingNoStatus` is `info`,
 *   which lowers it; an `info` stays `info`.
 * - `unsure`, which includes every failure: unchanged.
 */
export function headingStatusAfter(before: Finding['status'], verdict: AiEvidence['verdict'], config: Config): 'likely' | 'info' {
  const start = before === 'likely' ? 'likely' : 'info';
  if (verdict === 'yes') return 'likely';
  if (verdict === 'no') return start === 'likely' && config.adjudication.headingNoStatus !== 'info' ? 'likely' : 'info';
  return start;
}

export function applyHeadingVerdict(finding: Finding, ai: AiEvidence, config: Config): Finding {
  const status = headingStatusAfter(finding.status, ai.verdict, config);
  return {
    ...finding,
    status,
    // The rule name follows the status, as it does without a model; the id does not (CANDIDATE_FINGERPRINT_RULE).
    rule: status === 'likely' ? UNMARKED_HEADING_RULE : HEADING_CANDIDATE_RULE,
    message: finding.message + note(ai, finding.status, status),
    ai,
  };
}

/**
 * The one question a model is asked about an exposed heading that does not read as one
 * (`headings/heading-not-a-heading`). Fixed text: nothing of the page goes into it. Change it
 * together with its version. "yes" speaks against the finding here, "no" for it.
 */
export const NOT_HEADING_QUESTION =
  'The target text is marked up as a heading. Does it function as a heading for the content that follows it? ' +
  'Answer "yes" if it names or introduces the content placed after it, as a heading does, however long it is and however it is styled. ' +
  'Answer "no" if it is something else that was given heading markup: a paragraph of running text, a slogan or a tagline, a legal line, a line of an address, ' +
  'a quotation, a date, a price or a figure, a label, or text with nothing after it that it could be the heading of. ' +
  'Answer "unsure" if what you are given does not let you decide.';
export const NOT_HEADING_QUESTION_VERSION = 'headings-not-heading-1';

function notHeadingNote(ai: AiEvidence, before: Finding['status'], after: Finding['status']): string {
  const basis = (ai.inputs === 'text' ? ', from the text alone (no capture was sent)' : '') + (ai.fromCache === true ? ', read from the cache' : '');
  if (ai.verdict === 'no') {
    return ` A model judged the same (${count(ai)}${basis}): it does not function as a heading for what follows. That does not replace the confirmation by a tester, and does not raise the status.`;
  }
  if (ai.verdict === 'yes') {
    return after === before
      ? after === 'info'
        ? ` A model judged (${count(ai)}${basis}) that it functions as a heading for what follows.`
        : ` A model judged (${count(ai)}${basis}) that it functions as a heading for what follows. It stays ${after}: a verdict of a model is recorded for the tester and does not take a finding off the list.`
      : ` Lowered from ${before} to ${after}: a model judged (${count(ai)}${basis}) that it functions as a heading for what follows. The measurements are unchanged.`;
  }
  const why = ai.problems?.length
    ? ai.problems.map((problem) => PROBLEM_TEXT[problem]).join('; ')
    : ai.votes.length > 1 && new Set(ai.votes).size > 1
      ? 'its votes disagree'
      : 'it was not sure';
  return ` A model was asked and gave no verdict (${why}), so the status is the one deterministic code gave.`;
}

/**
 * Status of a heading reported as not reading as one, after a verdict. A verdict lowers the
 * status or keeps it, and never raises it:
 * - `no` (it does not function as a heading): unchanged, with the verdict recorded. What made
 *   the finding `advisory` or `info` and not `likely` is a measurement, which a model does not redo.
 * - `yes` (it does): unchanged with the verdict recorded, unless `headingNoStatus` is `info`,
 *   which lowers it to `info`: the same decision of the owner as for a candidate a model speaks against.
 * - `unsure`, which includes every failure: unchanged.
 */
export function notHeadingStatusAfter(before: Finding['status'], verdict: AiEvidence['verdict'], config: Config): 'likely' | 'advisory' | 'info' {
  const start = before === 'likely' || before === 'advisory' ? before : 'info';
  return verdict === 'yes' && config.adjudication.headingNoStatus === 'info' ? 'info' : start;
}

export function applyNotHeadingVerdict(finding: Finding, ai: AiEvidence, config: Config): Finding {
  const status = notHeadingStatusAfter(finding.status, ai.verdict, config);
  return { ...finding, status, message: finding.message + notHeadingNote(ai, finding.status, status), ai };
}

/**
 * What to ask about the heading candidates of a snapshot: one request for each candidate a
 * judgement could change (`adjudicate`), in the order of the candidates; then one for each
 * exposed heading reported as not reading as one, in their order.
 *
 * A candidate without a capture is still asked about, from its context alone, when
 * `judgeWithoutImage` is set: the text, its style against body text and the text after it carry
 * most of what the question needs, and the finding says that no picture was used.
 */
export function headingJudgements(snapshot: Snapshot, findings: Finding[], config: Config): Judgement[] {
  if (!snapshot.headings) return [];
  const reported = new Set(findings.filter((finding) => finding.check === 'headings').map((finding) => finding.id));
  const { adjudication } = config;
  const out: Judgement[] = [];
  const report = headingReport(snapshot.headings, config.headings);
  const asked = [
    ...report.candidates.map((candidate) => ({ candidate, question: HEADING_QUESTION, questionVersion: HEADING_QUESTION_VERSION, generatorVersion: HEADINGS_GENERATOR_VERSION, apply: applyHeadingVerdict })),
    ...report.nonHeadings.map((candidate) => ({
      candidate,
      question: NOT_HEADING_QUESTION,
      questionVersion: NOT_HEADING_QUESTION_VERSION,
      generatorVersion: NON_HEADINGS_GENERATOR_VERSION,
      apply: applyNotHeadingVerdict,
    })),
  ];
  for (const { candidate, question, questionVersion, generatorVersion, apply } of asked) {
    if (!candidate.adjudicate || !reported.has(candidate.findingId)) continue;
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
        check: 'headings',
        question,
        questionVersion,
        generatorVersion,
        crop,
        cropHash,
        context: candidate.context,
      },
      apply,
    });
  }
  return out;
}
