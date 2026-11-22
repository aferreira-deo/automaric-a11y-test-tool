import { headingJudgements } from './checks/headings-adjudication.js';
import { sortFindings } from './run.js';
import type { AiEvidence, AiProblem, CheckId, Config, Finding, JsonValue, Png, Snapshot, Verdict } from './types.js';

/**
 * The pure half of the adjudicator layer (section 6 of the brief). Core says what is asked about
 * which finding and what a verdict does to its status; asking is done elsewhere
 * (`@a11y-vision/adjudicators`), because it needs the network.
 *
 * A check takes part by adding one entry to `SOURCES`: a function that gives its judgements.
 */

/** One thing to ask a model about one finding. */
export interface JudgeRequest {
  /** `Finding.id` of the finding the answer is about. */
  findingId: string;
  check: CheckId;
  /** Fixed per check. Page content is never part of it. */
  question: string;
  /** Version of `question`; part of the prompt version and of the cache key. */
  questionVersion: string;
  /** Version of the code that makes the candidates; part of the cache key. */
  generatorVersion: string;
  /** The capture with the target outlined, or null when there is none to show. */
  crop: Png | null;
  /** Perceptual hash of the capture as taken; empty when there is none. Part of the cache key. */
  cropHash: string;
  /** Compact context: text, style, measurements, what surrounds the target. Text of the page under test, untrusted. */
  context: JsonValue;
}

/** One answer of a model, already validated, or the reason there is none. */
export interface Vote {
  verdict: Verdict;
  confidence: 'high' | 'low';
  rationale: string;
  problem?: AiProblem;
}

/** A request with what turns its outcome into a finding. */
export interface Judgement {
  request: JudgeRequest;
  /**
   * The finding after the verdict. Pure. It may change `status`, `rule`, `message` and `ai`, and
   * nothing else: the id, the selector and the evidence stay those of deterministic code.
   */
  apply: (finding: Finding, ai: AiEvidence, config: Config) => Finding;
}

type JudgementSource = (snapshot: Snapshot, findings: Finding[], config: Config) => Judgement[];

const SOURCES: Partial<Record<CheckId, JudgementSource>> = {
  headings: headingJudgements,
};

/**
 * What can be asked about the findings of a scan, in a fixed order: by check as configured, then
 * as each check orders its candidates. Only findings that are in `findings` are asked about.
 */
export function judgements(snapshot: Snapshot, findings: Finding[], config: Config): Judgement[] {
  const all: Judgement[] = [];
  for (const check of config.checks) {
    const source = SOURCES[check];
    if (source) all.push(...source(snapshot, findings, config));
  }
  return all;
}

/**
 * Votes into one verdict. `yes` or `no` only when every vote says so with high confidence;
 * anything else is `unsure`: a failed vote, a vote of low confidence, two votes that disagree,
 * no vote at all.
 */
export function combineVotes(votes: Vote[]): Pick<AiEvidence, 'votes' | 'verdict' | 'confidence' | 'rationale' | 'problems'> {
  const first = votes[0];
  const agreed =
    first !== undefined &&
    first.verdict !== 'unsure' &&
    votes.every((vote) => vote.problem === undefined && vote.confidence === 'high' && vote.verdict === first.verdict);
  const problems = [...new Set(votes.flatMap((vote) => (vote.problem ? [vote.problem] : [])))].sort();
  return {
    votes: votes.map((vote) => (vote.problem ? 'unsure' : vote.verdict)),
    verdict: agreed ? first.verdict : 'unsure',
    confidence: agreed ? 'high' : 'low',
    rationale: votes.find((vote) => vote.problem === undefined && vote.rationale !== '')?.rationale ?? '',
    ...(problems.length > 0 ? { problems } : {}),
  };
}

/**
 * The findings of a scan with the verdicts applied, sorted as `runChecks` sorts them.
 *
 * Whatever a check's `apply` returns, three things hold afterwards: the id of the finding is the
 * one it had, its evidence is the one it had, and its status is not `fail` unless deterministic
 * code had already made it one (a verdict that depends on a model is never `fail`).
 */
export function applyVerdicts(findings: Finding[], all: Judgement[], verdicts: ReadonlyMap<string, AiEvidence>, config: Config): Finding[] {
  const byId = new Map(all.map((judgement) => [judgement.request.findingId, judgement]));
  const next = findings.map((finding) => {
    const ai = verdicts.get(finding.id);
    const judgement = byId.get(finding.id);
    if (!ai || !judgement) return finding;
    const applied = judgement.apply(finding, { ...ai, statusBefore: finding.status }, config);
    const status = applied.status === 'fail' && finding.status !== 'fail' ? 'likely' : applied.status;
    return { ...applied, id: finding.id, check: finding.check, selector: finding.selector, frame: finding.frame, box: finding.box, wcag: finding.wcag, evidence: finding.evidence, status };
  });
  return sortFindings(next);
}

/** JSON with the keys of every object in order: the same value gives the same text, whatever order it was built in. */
export function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]!)}`)
    .join(',')}}`;
}
