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
  capEntries(entries, limits);
  return { version: DECISIONS_VERSION, updatedAt: now.toISOString(), entries };
}

/** Beyond the limit, takes the entries changed longest ago out of `entries`. */
function capEntries(entries: Record<string, DecisionEntry>, limits: ExtensionConfig['storage']): void {
  const keys = Object.keys(entries);
  if (keys.length <= limits.maxDecisionsPerPage) return;
  keys.sort((a, b) => (entries[a]!.at < entries[b]!.at ? -1 : entries[a]!.at > entries[b]!.at ? 1 : 0));
  for (const old of keys.slice(0, keys.length - limits.maxDecisionsPerPage)) delete entries[old];
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

  async #index(): Promise<Record<string, string>> {
    const stored = (await this.#area.get(INDEX_KEY))[INDEX_KEY];
    const index: Record<string, string> = {};
    if (stored !== null && typeof stored === 'object') {
      for (const [name, at] of Object.entries(stored as Record<string, unknown>)) {
        if (name.startsWith(PREFIX) && typeof at === 'string') index[name] = at;
      }
    }
    return index;
  }

  /**
   * Writes the decisions of a page. With `changed` (keys of `page.entries`, as `decisionKey`
   * gives them), only those entries are written, set or removed, onto what storage holds for
   * the page at that moment; without it `page` replaces what is there.
   *
   * `chrome.storage` has no transaction, and two panels (two windows) can save at the same
   * time. What is done about it: nothing is written from a copy older than it has to be. The
   * page is read right before it is merged, and the index right before it is written, and in
   * both only what this save is about is changed. What is left is the moment between such a
   * read and its write: a save of another window that lands exactly there is overwritten in the
   * index (the page then misses there until it is saved again, and is not counted for
   * `maxPages`), or, for two saves of the same decision of the same page, the later write wins.
   */
  async save(key: string, page: PageDecisions, changed?: readonly string[]): Promise<void> {
    let merged = page;
    if (changed) {
      const entries = { ...(await this.load(key, new Date(page.updatedAt))).entries };
      for (const name of changed) {
        const entry = page.entries[name];
        if (entry) entries[name] = entry;
        else delete entries[name];
      }
      capEntries(entries, this.#limits);
      merged = { version: DECISIONS_VERSION, updatedAt: page.updatedAt, entries };
    }
    const empty = Object.keys(merged.entries).length === 0;
    let dropped: string[] = [];
    if (empty) await this.#area.remove(key);
    else {
      // The page being saved always stays; of the others, the ones written longest ago go first.
      const known = await this.#index();
      const others = Object.keys(known)
        .filter((name) => name !== key)
        .sort((a, b) => (known[a]! < known[b]! ? -1 : known[a]! > known[b]! ? 1 : 0));
      dropped = others.slice(0, Math.max(0, others.length - (this.#limits.maxPages - 1)));
      if (dropped.length > 0) await this.#area.remove(dropped);
    }
    // Read again: what another window has written to the index since is kept.
    const index = await this.#index();
    for (const name of dropped) delete index[name];
    if (empty) {
      delete index[key];
      await this.#area.set({ [INDEX_KEY]: index });
    } else {
      index[key] = merged.updatedAt;
      await this.#area.set({ [key]: merged, [INDEX_KEY]: index });
    }
  }
}

/**
 * The decisions of the page that was scanned, as a panel holds them, and their way to storage.
 *
 * `set` changes what is held at once, without waiting for anything: whatever is decided next is
 * decided on top of it (a note and, in the same moment, a click on Confirm keep both). `save`
 * writes what changed since the last save, and saves run one after the other, in the order
 * they were asked for.
 */
export class DecisionSession {
  readonly #store: DecisionStore;
  readonly #key: string;
  readonly #limits: ExtensionConfig['storage'];
  #page: PageDecisions;
  readonly #dirty = new Set<string>();
  #queue: Promise<void> = Promise.resolve();

  constructor(store: DecisionStore, key: string, page: PageDecisions, limits: ExtensionConfig['storage']) {
    this.#store = store;
    this.#key = key;
    this.#page = page;
    this.#limits = limits;
  }

  get page(): PageDecisions {
    return this.#page;
  }

  /** True while something that was set has not reached storage. */
  get unsaved(): boolean {
    return this.#dirty.size > 0;
  }

  /** Sets the decision, the note, or both, of a finding; what is not given stays. Returns the entry as it now is. */
  set(finding: Pick<Finding, 'id' | 'signature'>, change: { decision?: Decision | null; note?: string }, now: Date): DecisionEntry | undefined {
    const current = decisionFor(this.#page, finding);
    const next = { decision: change.decision !== undefined ? change.decision : (current?.decision ?? null), note: change.note ?? current?.note ?? '' };
    this.#page = withDecision(this.#page, finding, next, this.#limits, now);
    this.#dirty.add(decisionKey(finding));
    return decisionFor(this.#page, finding);
  }

  /** Writes what changed. Rejects when storage refused; what was to be written then waits for the next save. */
  save(): Promise<void> {
    const run = this.#queue.then(async () => {
      if (this.#dirty.size === 0) return;
      const changed = [...this.#dirty];
      this.#dirty.clear();
      try {
        await this.#store.save(this.#key, this.#page, changed);
      } catch (error) {
        for (const name of changed) this.#dirty.add(name);
        throw error;
      }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }
}
