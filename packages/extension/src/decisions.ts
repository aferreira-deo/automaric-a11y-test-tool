import { pageKey } from '@a11y-vision/core';
import type { Config, Finding } from '@a11y-vision/core';
import type { StorageArea } from './chrome-api.js';
import type { ExtensionConfig } from './config.js';

/** What the auditor said about a finding. `null`: a note without a decision. */
export type Decision = 'confirmed' | 'dismissed';

export interface DecisionEntry {
  decision: Decision | null;
  note: string;
  /** ISO 8601, when it was last changed. */
  at: string;
}

/** The decisions kept for one page. */
export interface PageDecisions {
  version: 1;
  /** ISO 8601, when anything in it was last changed. */
  updatedAt: string;
  /** By `decisionKey`. */
  entries: Record<string, DecisionEntry>;
}

export const DECISIONS_VERSION = 1;
const PREFIX = 'decisions:';
const INDEX_KEY = 'decisions-index';

/**
 * A decision is about a finding on an element: the id of the finding (rule, criterion, frame,
 * selector) and the signature of the element (what it is). When another element takes the place
 * the selector names, the signature differs and the decision no longer applies; it is kept, and
 * applies again if the element comes back.
 */
export function decisionKey(finding: Pick<Finding, 'id' | 'signature'>): string {
  return `${finding.id}|${finding.signature}`;
}

/**
 * The storage key of a page: its address as the baseline of the CLI keys pages (fragment
 * dropped), without the query parameters that are named as holding secrets. The address itself
 * is not stored anywhere else.
 */
export function pageStorageKey(url: string, config: Pick<Config, 'baseline' | 'run'>): string {
  return PREFIX + pageKey(url, config.baseline, config.run.redactQueryParams);
}

export function emptyPageDecisions(now: Date): PageDecisions {
  return { version: DECISIONS_VERSION, updatedAt: now.toISOString(), entries: {} };
}

/** What storage gave, checked: anything that is not a decision as this version writes it is dropped. */
export function parsePageDecisions(value: unknown, limits: ExtensionConfig['storage'], now: Date): PageDecisions {
  const page = emptyPageDecisions(now);
  if (value === null || typeof value !== 'object') return page;
  const stored = value as { version?: unknown; updatedAt?: unknown; entries?: unknown };
  if (stored.version !== DECISIONS_VERSION || stored.entries === null || typeof stored.entries !== 'object') return page;
  if (typeof stored.updatedAt === 'string') page.updatedAt = stored.updatedAt;
  for (const [key, raw] of Object.entries(stored.entries as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object') continue;
    const entry = raw as { decision?: unknown; note?: unknown; at?: unknown };
    const decision = entry.decision === 'confirmed' || entry.decision === 'dismissed' ? entry.decision : null;
    const note = typeof entry.note === 'string' ? entry.note.slice(0, limits.maxNoteChars) : '';
    if (decision === null && note === '') continue;
    page.entries[key] = { decision, note, at: typeof entry.at === 'string' ? entry.at : page.updatedAt };
  }
  return page;
}

/**
 * `page` with the decision on `finding` set. No decision and no note takes the entry away.
 * Pure: a new object is returned. Beyond the limit the entries changed longest ago are dropped.
 */
export function withDecision(
  page: PageDecisions,
  finding: Pick<Finding, 'id' | 'signature'>,
  change: { decision: Decision | null; note: string },
  limits: ExtensionConfig['storage'],
  now: Date,
): PageDecisions {
  const entries = { ...page.entries };
  const key = decisionKey(finding);
  const note = change.note.slice(0, limits.maxNoteChars);
  if (change.decision === null && note.trim() === '') delete entries[key];
  else entries[key] = { decision: change.decision, note, at: now.toISOString() };
  const keys = Object.keys(entries);
  if (keys.length > limits.maxDecisionsPerPage) {
    keys.sort((a, b) => (entries[a]!.at < entries[b]!.at ? -1 : entries[a]!.at > entries[b]!.at ? 1 : 0));
    for (const old of keys.slice(0, keys.length - limits.maxDecisionsPerPage)) delete entries[old];
  }
  return { version: DECISIONS_VERSION, updatedAt: now.toISOString(), entries };
}

export function decisionFor(page: PageDecisions | null, finding: Pick<Finding, 'id' | 'signature'>): DecisionEntry | undefined {
  return page?.entries[decisionKey(finding)];
}

/**
 * Decisions in `chrome.storage.local`, one item per page (`decisions:<page key>`) and an index of
 * when each was last written, which is what tells the pages to drop when there are too many.
 */
export class DecisionStore {
  readonly #area: StorageArea;
  readonly #limits: ExtensionConfig['storage'];

  constructor(area: StorageArea, limits: ExtensionConfig['storage']) {
    this.#area = area;
    this.#limits = limits;
  }

  async load(key: string, now: Date): Promise<PageDecisions> {
    const stored = await this.#area.get(key);
    return parsePageDecisions(stored[key], this.#limits, now);
  }

  async save(key: string, page: PageDecisions): Promise<void> {
    const stored = (await this.#area.get(INDEX_KEY))[INDEX_KEY];
    const index: Record<string, string> = {};
    if (stored !== null && typeof stored === 'object') {
      for (const [name, at] of Object.entries(stored as Record<string, unknown>)) {
        if (name.startsWith(PREFIX) && typeof at === 'string') index[name] = at;
      }
    }
    if (Object.keys(page.entries).length === 0) {
      delete index[key];
      await this.#area.remove(key);
      await this.#area.set({ [INDEX_KEY]: index });
      return;
    }
    index[key] = page.updatedAt;
    // The page being saved always stays; of the others, the ones written longest ago go first.
    const others = Object.keys(index)
      .filter((name) => name !== key)
      .sort((a, b) => (index[a]! < index[b]! ? -1 : index[a]! > index[b]! ? 1 : 0));
    const dropped = others.slice(0, Math.max(0, others.length - (this.#limits.maxPages - 1)));
    for (const name of dropped) delete index[name];
    if (dropped.length > 0) await this.#area.remove(dropped);
    await this.#area.set({ [key]: page, [INDEX_KEY]: index });
  }
}
