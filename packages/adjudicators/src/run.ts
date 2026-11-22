import { applyVerdicts, combineVotes, judgements } from '@a11y-vision/core';
import type { AiEvidence, AiProblem, Config, Finding, Judgement, Snapshot, Vote } from '@a11y-vision/core';
import { validCachedVerdict, verdictKey } from './cache.js';
import type { CachedVerdict, VerdictCache } from './cache.js';
import type { Adjudicator, JudgeResult } from './types.js';

/**
 * What the adjudicator layer did on one page. Not part of the result of a scan: how many
 * verdicts came from the cache differs between two runs, and a result must not.
 */
export interface AdjudicationStats {
  provider: string;
  model: string;
  /** Findings a judgement could change. */
  candidates: number;
  /** Of those, judged by calling the model now. */
  judged: number;
  /** Answered from the cache, without a call. */
  cached: number;
  /** Left as they were because `maxCallsPerPage` allowed no more. */
  skipped: number;
  /** Requests sent, retries included. Never more than `maxCallsPerPage`. */
  calls: number;
  /** Requests that gave no usable answer, by reason. */
  problems: Partial<Record<AiProblem, number>>;
  /** Findings whose status the verdicts changed. */
  changed: number;
  /** Candidates nothing was sent about because adjudication of the page had been stopped. They keep their status and say `stopped`. */
  stopped: number;
  /**
   * Why adjudication stopped before every candidate was asked about, or null when it did not:
   * `failures` after `maxConsecutiveFailures` requests in a row got no answer (timeout, network),
   * `budget` when `pageBudgetMs` ran out.
   */
  stopReason: 'failures' | 'budget' | null;
  /** `maxConsecutiveFailures` as it was in force, for the line that says why adjudication stopped. */
  failureLimit: number;
}

export interface AdjudicateOptions {
  snapshot: Snapshot;
  findings: Finding[];
  config: Config;
  adjudicator: Adjudicator;
  cache?: VerdictCache;
  /** For tests: waits between retries. */
  sleep?: (ms: number) => Promise<void>;
  /** For tests: the clock the time budget of the page is measured with, in milliseconds. */
  now?: () => number;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `tasks` with at most `limit` in flight. Tasks never reject here: each one catches what it does. */
async function pool(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) await tasks[next++]!();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

function toVote(result: JudgeResult): Vote {
  // Whatever an adapter returns, a vote is one of the three verdicts or a failure.
  const verdict = result.verdict === 'yes' || result.verdict === 'no' ? result.verdict : 'unsure';
  if (result.problem) return { verdict: 'unsure', confidence: 'low', rationale: '', problem: result.problem };
  return { verdict, confidence: result.confidence === 'high' ? 'high' : 'low', rationale: typeof result.rationale === 'string' ? result.rationale : '' };
}

/**
 * Asks the model about the findings of one page and gives the findings back with the verdicts
 * applied (see `applyVerdicts` in core for what a verdict may change).
 *
 * - Order: verdicts are applied by finding id, and findings are sorted as always, so the result
 *   does not depend on which request finished first.
 * - Votes: `votes` requests per candidate, one after the other; the second is not sent when the
 *   first already makes the verdict `unsure` (a failure, `unsure`, low confidence).
 * - Cap: at most `maxCallsPerPage` requests, retries included. Candidates are admitted in order
 *   while their votes fit; the rest are left exactly as deterministic code reported them.
 * - Retries: only for failures worth trying again, with a doubling wait, and only while the cap
 *   has requests to spare.
 * - Failure: a candidate whose calls fail keeps its status and says why in `ai.problems`. One
 *   candidate failing changes nothing for the others, and nothing here throws for a failed call.
 * - Giving up: when `maxConsecutiveFailures` requests in a row got no answer at all (a timeout, a
 *   network error; an HTTP error is an answer), or when `pageBudgetMs` has run out, nothing more
 *   is sent for this page. Requests in flight end by themselves. The candidates not yet asked
 *   about keep their status and get the problem `stopped`. An endpoint that hangs costs that many
 *   timeouts, not one for every candidate.
 * - Cache: a verdict is stored when every vote was a valid answer, and found again by a key that
 *   changes with the candidate, its capture, the model and the prompt. Failures are not stored.
 *   Two candidates of one page with the same key are judged once. An entry is checked again when
 *   it is read (`validCachedVerdict`, with the number of votes in force), whatever cache it comes
 *   from, and a finding says when its verdict was read from the cache (`ai.fromCache`).
 */
export async function adjudicateFindings(options: AdjudicateOptions): Promise<{ findings: Finding[]; stats: AdjudicationStats }> {
  const { snapshot, findings, config, adjudicator, cache } = options;
  const settings = config.adjudication;
  const sleep = options.sleep ?? wait;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const all = judgements(snapshot, findings, config);
  const stats: AdjudicationStats = {
    provider: adjudicator.provider,
    model: adjudicator.model,
    candidates: all.length,
    judged: 0,
    cached: 0,
    skipped: 0,
    calls: 0,
    problems: {},
    changed: 0,
    stopped: 0,
    stopReason: null,
    failureLimit: settings.maxConsecutiveFailures,
  };

  const keys = await Promise.all(all.map((judgement) => verdictKey(judgement.request, adjudicator, settings.votes)));
  const byKey = new Map<string, CachedVerdict | null>();
  const toJudge: { key: string; judgement: Judgement }[] = [];
  all.forEach((judgement, index) => {
    const key = keys[index]!;
    if (byKey.has(key)) return;
    // Checked here and not only when a file is loaded: a cache can be any object, and an entry has
    // to be one that the settings in force could have produced.
    const stored = cache?.get(key);
    const hit = stored === undefined ? undefined : validCachedVerdict(stored, settings.maxRationaleChars, settings.votes);
    byKey.set(key, hit ?? null);
    if (!hit) toJudge.push({ key, judgement });
  });
  const fromCache = new Set([...byKey].filter(([, hit]) => hit !== null).map(([key]) => key));

  const admitted = toJudge.slice(0, Math.floor(settings.maxCallsPerPage / settings.votes));
  // What the cap leaves once every admitted candidate has its votes: the allowance for retries.
  let spare = settings.maxCallsPerPage - admitted.length * settings.votes;
  const judgedKeys = new Set<string>();
  const stoppedKeys = new Set<string>();
  let failuresInARow = 0;
  /** Sets `stopReason` when the time for the page is up; true once adjudication has stopped for either reason. */
  const hasStopped = (): boolean => {
    if (stats.stopReason === null && settings.pageBudgetMs > 0 && now() - startedAt >= settings.pageBudgetMs) stats.stopReason = 'budget';
    return stats.stopReason !== null;
  };

  const call = async (judgement: Judgement): Promise<Vote> => {
    const { request } = judgement;
    let last: JudgeResult | undefined;
    for (let attempt = 0; ; attempt++) {
      // Nothing is sent once adjudication has stopped: a retry that was waiting keeps the failure
      // it had, and a vote that was never asked for says so.
      if (hasStopped()) return last ? toVote(last) : { verdict: 'unsure', confidence: 'low', rationale: '', problem: 'stopped' };
      stats.calls++;
      let result: JudgeResult;
      try {
        result = await adjudicator.judge({ check: request.check, question: request.question, crops: request.crop ? [request.crop] : [], context: request.context });
      } catch {
        // An adapter is not supposed to throw. If one does, that is a failed call like any other.
        result = { verdict: 'unsure', rationale: '', problem: 'network' };
      }
      // No answer at all, as opposed to an answer that is an error or cannot be used: the sign
      // of an endpoint that hangs or is gone.
      if (result.problem === 'timeout' || result.problem === 'network') {
        failuresInARow++;
        if (settings.maxConsecutiveFailures > 0 && failuresInARow >= settings.maxConsecutiveFailures) stats.stopReason ??= 'failures';
      } else {
        failuresInARow = 0;
      }
      if (!result.problem) return toVote(result);
      stats.problems[result.problem] = (stats.problems[result.problem] ?? 0) + 1;
      if (!result.retryable || attempt >= settings.maxRetries || spare <= 0 || stats.stopReason !== null) return toVote(result);
      last = result;
      spare--;
      await sleep(Math.min(settings.retryMaxDelayMs, settings.retryBaseDelayMs * 2 ** attempt));
    }
  };

  await pool(
    admitted.map(({ key, judgement }) => async () => {
      const votes: Vote[] = [];
      for (let i = 0; i < settings.votes; i++) {
        const vote = await call(judgement);
        votes.push(vote);
        const first = votes[0]!;
        if (vote.problem || vote.verdict === 'unsure' || vote.confidence !== 'high' || vote.verdict !== first.verdict) break;
      }
      // Requests this candidate did not need go to the retries of the others.
      spare += settings.votes - votes.length;
      const verdict: CachedVerdict = { ...combineVotes(votes), inputs: judgement.request.crop ? 'text+image' : 'text' };
      byKey.set(key, verdict);
      // A first vote that says `stopped` means that nothing was sent about this candidate.
      if (votes[0]?.problem === 'stopped') stoppedKeys.add(key);
      else judgedKeys.add(key);
      if (cache && votes.every((vote) => vote.problem === undefined)) {
        const { votes: cast, verdict: agreed, confidence, rationale, inputs } = verdict;
        cache.set(key, { votes: cast, verdict: agreed, confidence, rationale, inputs });
      }
    }),
    settings.concurrency,
  );

  const verdicts = new Map<string, AiEvidence>();
  all.forEach((judgement, index) => {
    const key = keys[index]!;
    const verdict = byKey.get(key);
    if (!verdict) {
      stats.skipped++;
      return;
    }
    if (fromCache.has(key)) stats.cached++;
    else if (judgedKeys.has(key)) stats.judged++;
    else if (stoppedKeys.has(key)) stats.stopped++;
    verdicts.set(judgement.request.findingId, {
      provider: adjudicator.provider,
      model: adjudicator.model,
      promptVersion: `${adjudicator.promptVersion}/${judgement.request.questionVersion}`,
      ...verdict,
      fromCache: fromCache.has(key),
      // Set from the finding by applyVerdicts.
      statusBefore: 'info',
    });
  });

  const before = new Map(findings.map((finding) => [finding.id, finding.status]));
  const after = applyVerdicts(findings, all, verdicts, config);
  stats.changed = after.filter((finding) => before.get(finding.id) !== finding.status).length;
  return { findings: after, stats };
}

/** One line about what was done, for a log. Counts only. */
export function describeStats(stats: AdjudicationStats): string {
  const limit = `${stats.failureLimit} call(s)`;
  const stopped =
    stats.stopReason === null
      ? ''
      : `; stopped ${stats.stopReason === 'failures' ? `after ${limit} in a row got no answer` : 'when the time allowed for the page ran out'}; ${stats.stopped} candidate(s) were not asked about`;
  const problems = Object.entries(stats.problems)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([problem, count]) => `${problem}: ${count}`)
    .join(', ');
  return (
    `Model ${stats.model} (${stats.provider}): ${stats.candidates} candidate(s), ${stats.judged} judged with ${stats.calls} call(s), ` +
    `${stats.cached} from the cache, ${stats.skipped} left out by the limit of calls, ${stats.changed} status change(s)` +
    stopped +
    (problems ? `; failed calls: ${problems}` : '') +
    '.'
  );
}
