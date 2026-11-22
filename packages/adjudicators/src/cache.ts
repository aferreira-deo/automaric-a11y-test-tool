import { stableStringify } from '@a11y-vision/core';
import type { AiEvidence, JudgeRequest, Verdict } from '@a11y-vision/core';
import { cleanRationale } from './prompt.js';
import type { Adjudicator } from './types.js';

/** What is kept of a verdict. Provider, model and prompt version are in the key, not in the entry. */
export type CachedVerdict = Pick<AiEvidence, 'votes' | 'verdict' | 'confidence' | 'rationale' | 'inputs'>;

/** Where verdicts are kept between calls. Local by definition: an implementation must not send them anywhere. */
export interface VerdictCache {
  get(key: string): CachedVerdict | undefined;
  set(key: string, verdict: CachedVerdict): void;
}

/** Version of the key layout and of the entries. */
const CACHE_VERSION = 1;

/**
 * Key of a verdict: SHA-256 over the version of the candidate generator, the candidate's context
 * (its text, its measurements, what surrounds it), the perceptual hash of its capture, the
 * endpoint, the model and its settings, the prompt version and the number of votes. Any of them
 * changing gives another key, so a component that did not change is not judged twice and one
 * that did is judged again.
 */
export async function verdictKey(request: JudgeRequest, adjudicator: Adjudicator, votes: number): Promise<string> {
  const material = stableStringify([
    CACHE_VERSION,
    request.check,
    request.generatorVersion,
    request.questionVersion,
    adjudicator.promptVersion,
    adjudicator.cacheIdentity,
    votes,
    request.crop ? 'text+image' : 'text',
    request.cropHash,
    request.context,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const VERDICTS: readonly Verdict[] = ['yes', 'no', 'unsure'];

/** An entry read back from storage, or undefined when it is not one: a cache file can be edited by anyone. */
export function validCachedVerdict(value: unknown, maxRationaleChars: number): CachedVerdict | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const { votes, verdict, confidence, rationale, inputs } = value as Record<string, unknown>;
  if (!Array.isArray(votes) || votes.length === 0 || !votes.every((vote) => VERDICTS.includes(vote as Verdict))) return undefined;
  if (!VERDICTS.includes(verdict as Verdict)) return undefined;
  if (confidence !== 'high' && confidence !== 'low') return undefined;
  if (typeof rationale !== 'string') return undefined;
  if (inputs !== 'text' && inputs !== 'text+image') return undefined;
  const all = votes as Verdict[];
  // The verdict is worked out again from the votes: an entry cannot claim more than its votes say.
  const agreed = confidence === 'high' && all[0] !== 'unsure' && all.every((vote) => vote === all[0]);
  return { votes: [...all], verdict: agreed ? all[0]! : 'unsure', confidence: agreed ? 'high' : 'low', rationale: cleanRationale(rationale, maxRationaleChars), inputs };
}

export interface MemoryCache extends VerdictCache {
  /** True when something was added since the cache was made or last marked as saved. */
  readonly dirty: boolean;
  markSaved(): void;
  /** `{ version, entries }`, for writing to a file. */
  toJSON(): { version: number; entries: Record<string, CachedVerdict> };
}

/**
 * A cache in memory, optionally started from what `toJSON` gave earlier. Entries that are not
 * valid are dropped on the way in. Holds at most `maxEntries`, dropping the oldest.
 */
export function createMemoryCache(options: { maxEntries: number; maxRationaleChars: number; from?: unknown }): MemoryCache {
  const entries = new Map<string, CachedVerdict>();
  let dirty = false;
  const trim = (): void => {
    for (const key of entries.keys()) {
      if (entries.size <= options.maxEntries) break;
      entries.delete(key);
    }
  };
  const stored = options.from as { version?: unknown; entries?: unknown } | null | undefined;
  if (stored && typeof stored === 'object' && stored.version === CACHE_VERSION && stored.entries !== null && typeof stored.entries === 'object') {
    for (const [key, value] of Object.entries(stored.entries as Record<string, unknown>)) {
      const entry = /^[0-9a-f]{64}$/.test(key) ? validCachedVerdict(value, options.maxRationaleChars) : undefined;
      if (entry) entries.set(key, entry);
    }
    trim();
  }
  return {
    get: (key) => entries.get(key),
    set(key, verdict) {
      entries.delete(key);
      entries.set(key, verdict);
      trim();
      dirty = true;
    },
    get dirty() {
      return dirty;
    },
    markSaved() {
      dirty = false;
    },
    toJSON: () => ({ version: CACHE_VERSION, entries: Object.fromEntries(entries) }),
  };
}
