/**
 * The adjudicator layer (section 6 of the brief): model adapters behind one interface, and the
 * code that asks. Everything that touches the network is in this package and uses the global
 * `fetch`, so it runs in Node and in an extension service worker alike. What is asked, and what
 * an answer may change, is decided in `@a11y-vision/core`.
 */
export type { Adjudicator, JudgeInput, JudgeResult } from './types.js';
export { buildPrompt, cleanRationale, parseVerdict, PROMPT_VERSION, SYSTEM_PROMPT, VERDICT_SCHEMA } from './prompt.js';
export type { ParsedVerdict, Prompt } from './prompt.js';
export { chatCompletionsBody, createOpenAiCompatibleAdjudicator, OPENAI_COMPATIBLE } from './openai-compatible.js';
export type { OpenAiCompatibleOptions } from './openai-compatible.js';
export { AdjudicationConfigError, createAdjudicator, isLoopbackHost, redact, secretsOf } from './provider.js';
export type { Env } from './provider.js';
export { createMemoryCache, validCachedVerdict, verdictKey } from './cache.js';
export type { CachedVerdict, MemoryCache, VerdictCache } from './cache.js';
export { adjudicateFindings, describeStats } from './run.js';
export type { AdjudicateOptions, AdjudicationStats } from './run.js';
