import type { AiProblem, CheckId, JsonValue, Png, Verdict } from '@a11y-vision/core';

export interface JudgeInput {
  check: CheckId;
  /** Fixed per check, versioned. */
  question: string;
  /** Target outlined, plus context. Empty when the candidate is judged from text alone. */
  crops: Png[];
  /** Compact: text, accessibility subtree, style summary. Text of the page under test: untrusted. */
  context: JsonValue;
}

/**
 * One answer. `verdict` and `rationale` are the interface of the brief (section 6); the rest
 * says how far the answer can be relied on and, when there is none, why.
 */
export interface JudgeResult {
  verdict: Verdict;
  rationale: string;
  /** Picked by the model from two words. Missing counts as `low`. */
  confidence?: 'high' | 'low';
  /** Set when the call gave no usable answer; `verdict` is then `unsure`. A code, never a message. */
  problem?: AiProblem;
  /** With `problem`: sending the same request again may work (network, 408, 429, 5xx). */
  retryable?: boolean;
}

/** How one request is made. */
export interface JudgeOptions {
  /**
   * Fires when the caller no longer wants the answer: the request is aborted, and the result
   * says `stopped`. Without it a request ends by its answer or by its timeout, as it always did.
   */
  signal?: AbortSignal;
}

/**
 * One interface for every provider. `judge` sends ONE request and never throws: every failure is
 * a result with a `problem`. Votes, retries, the cap on calls and the cache are handled by the
 * caller (`adjudicateFindings`), the same way for every adapter.
 */
export interface Adjudicator {
  /** Label shown in findings. Never a URL, never a key. */
  readonly provider: string;
  /** Model name as configured. */
  readonly model: string;
  /** Version of the instructions this adapter sends around the question. */
  readonly promptVersion: string;
  /** What tells this endpoint and its settings from another, for the cache key. It is hashed, never shown. */
  readonly cacheIdentity: string;
  judge(input: JudgeInput, options?: JudgeOptions): Promise<JudgeResult>;
}
