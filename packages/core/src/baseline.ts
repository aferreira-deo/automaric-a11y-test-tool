import { TOOL_NAME } from './meta.js';
import type { BaselineConfig, BaselineState, Finding } from './types.js';

/**
 * A baseline file records the `fail` findings a team has accepted for now, so that a build only
 * breaks on a `fail` that is not in it. Everything here is pure: reading and writing the file is
 * done by the caller.
 *
 * What an entry is: one `fail` finding on one page. The page is the address that was asked for,
 * turned into a key by `pageKey` with the settings kept in the file. The finding is its id (the
 * fingerprint of rule, success criterion, frame and selector), the check, rule, criterion, frame
 * and selector themselves, and the signature of the element (`Finding.signature`): an entry only
 * covers a finding where all of them are equal. A failure of another rule on the same element is
 * never covered, neither is a hash collision, and neither is another element that has taken the
 * place of the one that was recorded: a selector that is a path of positions says where an
 * element is, and the signature says what it is.
 *
 * Only `fail` findings are recorded. A finding that was `likely` when the file was written and
 * is `fail` now is therefore new.
 *
 * Version 2 added `check` and `signature` to an entry. A file of version 1 cannot say which
 * element an entry is about, so it is refused and not converted.
 */
export const BASELINE_VERSION = 2;

export interface BaselineEntry {
  id: string;
  /** The check that reported it: an entry is only looked for on a run where this check ran. */
  check: string;
  rule: string;
  /** Success criterion number, or an empty string. */
  sc: string;
  frame: string;
  selector: string;
  /** `Finding.signature`: what the element is. A hash; no text of the page. */
  signature: string;
}

export interface BaselinePage {
  /** The key of the page: see `pageKey`. */
  url: string;
  findings: BaselineEntry[];
}

export interface Baseline {
  version: typeof BASELINE_VERSION;
  tool: string;
  /** The settings the keys in `pages` were made with. A comparison uses these, not those of the run. */
  urlKey: BaselineConfig;
  pages: BaselinePage[];
}

/** The findings of one page of a run. `url` is the address that was asked for. */
export interface BaselineInput {
  url: string;
  findings: Finding[];
  /**
   * The checks that ran on the page. An entry of another check is not known to be gone when no
   * finding matches it. Left out: every check is taken to have run.
   */
  checks?: readonly string[];
  /**
   * The address the page ended on. When it is not the page that was asked for (another origin or
   * path, after the settings of the key), the entries of the page are not known to be gone: a
   * session that is over sends to a sign-in page, which has none of the failures. Left out: `url`.
   */
  finalUrl?: string;
}

export interface BaselineSummary {
  /** `fail` findings that the file does not record. Only these break a build. */
  new: number;
  /** `fail` findings that the file records. Reported like the others, and marked. */
  baselined: number;
  /** Entries for pages of this run that no `fail` finding matches any more. */
  stale: number;
  /** Entries for pages that this run did not scan; nothing is known about them. */
  notScanned: number;
  /**
   * Entries for pages of this run that no `fail` finding matches, and that were not looked for:
   * their check did not run, or the page ended on another address than the one asked for. Never
   * counted as stale and never pruned.
   */
  unverified: number;
  /** Entries added to the file by this run. */
  added: number;
  /** Stale entries taken out of the file by this run. */
  pruned: number;
}

/** A baseline file that cannot be used. Never treated as "nothing is baselined" or "everything is". */
export class BaselineError extends Error {}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The key of a page in a baseline, from its absolute address as `new URL(x).href` writes it
 * (scheme and host in lower case, default port left out: that part is the caller's, since `URL`
 * is not available here). Works on the text: nothing is decoded or encoded again.
 *
 * A user name and a password in the address are never part of a key. `alsoDrop` names further
 * query parameters to leave out, compared without regard to case: those whose value is a secret
 * (`RunConfig.redactQueryParams`).
 */
export function pageKey(given: string, options: BaselineConfig, alsoDrop: readonly string[] = []): string {
  const href = withoutUserinfo(given);
  const hashAt = href.indexOf('#');
  const fragment = hashAt === -1 ? '' : href.slice(hashAt);
  const withoutFragment = hashAt === -1 ? href : href.slice(0, hashAt);
  const queryAt = withoutFragment.indexOf('?');
  let path = queryAt === -1 ? withoutFragment : withoutFragment.slice(0, queryAt);
  let query = queryAt === -1 ? '' : withoutFragment.slice(queryAt + 1);
  const hadQuery = queryAt !== -1;

  if (options.stripTrailingSlash) {
    const schemeEnd = path.indexOf('://');
    const pathStart = schemeEnd === -1 ? -1 : path.indexOf('/', schemeEnd + 3);
    // The root path stays: "https://host/" is how the address of a site is written.
    if (pathStart !== -1 && path.length > pathStart + 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
  }
  const emptyQuery = query === '';
  const normalises = options.dropQueryParams.length > 0 || options.sortQuery;
  if (hadQuery && (normalises || alsoDrop.length > 0)) {
    const dropped = new Set(options.dropQueryParams);
    const secret = new Set(alsoDrop.map((name) => name.toLowerCase()));
    let parts = query.split('&').filter((part) => part !== '');
    const nameOf = (part: string): string => {
      const equals = part.indexOf('=');
      return equals === -1 ? part : part.slice(0, equals);
    };
    parts = parts.filter((part) => !dropped.has(nameOf(part)) && !secret.has(nameOf(part).toLowerCase()));
    if (options.sortQuery) {
      // Stable, and by name only: the order of two values of one parameter is kept.
      parts = parts.map((part, index) => ({ part, index })).sort((a, b) => compare(nameOf(a.part), nameOf(b.part)) || a.index - b.index).map(({ part }) => part);
    }
    query = parts.join('&');
  }
  // A bare "?" stays when nothing was asked of the query.
  const keepQuery = hadQuery && (query !== '' || (emptyQuery && !normalises));
  return path + (keepQuery ? `?${query}` : '') + (options.stripFragment ? '' : fragment);
}

/** The address without the user name and password it may carry between the scheme and the host. */
export function withoutUserinfo(href: string): string {
  const schemeEnd = href.indexOf('://');
  if (schemeEnd === -1) return href;
  const start = schemeEnd + 3;
  let end = href.length;
  for (const char of ['/', '?', '#']) {
    const at = href.indexOf(char, start);
    if (at !== -1 && at < end) end = at;
  }
  const at = href.lastIndexOf('@', end - 1);
  return at >= start ? href.slice(0, start) + href.slice(at + 1) : href;
}

/** The key of a page without its query and fragment: which document of which origin it is. */
function placeOf(href: string, options: BaselineConfig): string {
  const key = pageKey(href, options);
  const cut = key.search(/[?#]/);
  return cut === -1 ? key : key.slice(0, cut);
}

function entryOf(finding: Finding): BaselineEntry {
  return {
    id: finding.id,
    check: finding.check,
    rule: finding.rule,
    sc: finding.wcag?.sc ?? '',
    frame: finding.frame,
    selector: finding.selector,
    signature: typeof finding.signature === 'string' ? finding.signature : '',
  };
}

function sameEntry(a: BaselineEntry, b: BaselineEntry): boolean {
  return a.id === b.id && a.check === b.check && a.rule === b.rule && a.sc === b.sc && a.frame === b.frame && a.selector === b.selector && a.signature === b.signature;
}

function sortEntries(entries: BaselineEntry[]): BaselineEntry[] {
  return entries.sort(
    (a, b) =>
      compare(a.rule, b.rule) || compare(a.frame, b.frame) || compare(a.selector, b.selector) || compare(a.sc, b.sc) || compare(a.signature, b.signature) || compare(a.id, b.id),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The baseline a parsed JSON value holds. Strict: a file of another version, or one that is not
 * exactly what this version writes, is refused with a message that says what to do. Guessing at
 * a damaged file could hide findings.
 */
export function parseBaseline(value: unknown): Baseline {
  if (!isRecord(value)) throw new BaselineError('it does not hold a JSON object');
  if (value['version'] !== BASELINE_VERSION) {
    const found = typeof value['version'] === 'number' || typeof value['version'] === 'string' ? JSON.stringify(value['version']) : 'none';
    const older = typeof value['version'] === 'number' && value['version'] < BASELINE_VERSION;
    const why = older ? ' (an older format does not record which element an entry is about, so its entries cannot be carried over)' : '';
    throw new BaselineError(
      `it has format version ${found}, and this version of ${TOOL_NAME} reads version ${BASELINE_VERSION}${why}; move the old file away and write a new one with --update-baseline`,
    );
  }
  const urlKey = value['urlKey'];
  if (
    !isRecord(urlKey) ||
    typeof urlKey['stripFragment'] !== 'boolean' ||
    typeof urlKey['sortQuery'] !== 'boolean' ||
    typeof urlKey['stripTrailingSlash'] !== 'boolean' ||
    !Array.isArray(urlKey['dropQueryParams']) ||
    !urlKey['dropQueryParams'].every((name) => typeof name === 'string')
  ) {
    throw new BaselineError('its "urlKey" settings are missing or damaged');
  }
  if (!Array.isArray(value['pages'])) throw new BaselineError('its "pages" list is missing');
  const pages: BaselinePage[] = [];
  const seen = new Set<string>();
  for (const page of value['pages'] as unknown[]) {
    if (!isRecord(page) || typeof page['url'] !== 'string' || page['url'] === '' || !Array.isArray(page['findings'])) {
      throw new BaselineError('one of its pages has no "url" or no "findings" list');
    }
    if (seen.has(page['url'])) throw new BaselineError('one page is listed twice');
    seen.add(page['url']);
    const findings: BaselineEntry[] = [];
    for (const entry of page['findings'] as unknown[]) {
      if (
        !isRecord(entry) ||
        typeof entry['id'] !== 'string' ||
        entry['id'] === '' ||
        typeof entry['check'] !== 'string' ||
        entry['check'] === '' ||
        typeof entry['rule'] !== 'string' ||
        entry['rule'] === '' ||
        typeof entry['sc'] !== 'string' ||
        typeof entry['frame'] !== 'string' ||
        typeof entry['selector'] !== 'string' ||
        typeof entry['signature'] !== 'string'
      ) {
        throw new BaselineError('one of its entries lacks "id", "check", "rule", "sc", "frame", "selector" or "signature"');
      }
      findings.push({ id: entry['id'], check: entry['check'], rule: entry['rule'], sc: entry['sc'], frame: entry['frame'], selector: entry['selector'], signature: entry['signature'] });
    }
    pages.push({ url: page['url'], findings });
  }
  return {
    version: BASELINE_VERSION,
    tool: typeof value['tool'] === 'string' ? value['tool'] : TOOL_NAME,
    urlKey: {
      stripFragment: urlKey['stripFragment'],
      sortQuery: urlKey['sortQuery'],
      stripTrailingSlash: urlKey['stripTrailingSlash'],
      dropQueryParams: [...urlKey['dropQueryParams']],
    },
    pages,
  };
}

/** A baseline with nothing in it, for the first `--update-baseline`. */
export function emptyBaseline(urlKey: BaselineConfig): Baseline {
  return { version: BASELINE_VERSION, tool: TOOL_NAME, urlKey: { ...urlKey, dropQueryParams: [...urlKey.dropQueryParams].sort() }, pages: [] };
}

/**
 * The text of a baseline file. The same content always gives the same bytes: pages by key,
 * entries by rule, frame, selector and signature, no date and nothing of the run. A change of the file in a
 * review is then a change of what is accepted.
 */
export function serializeBaseline(baseline: Baseline): string {
  const pages = baseline.pages
    .filter((page) => page.findings.length > 0)
    .map((page) => ({
      url: page.url,
      findings: sortEntries(
        page.findings.map((entry) => ({ id: entry.id, check: entry.check, rule: entry.rule, sc: entry.sc, frame: entry.frame, selector: entry.selector, signature: entry.signature })),
      ),
    }))
    .sort((a, b) => compare(a.url, b.url));
  const { stripFragment, sortQuery, stripTrailingSlash, dropQueryParams } = baseline.urlKey;
  const ordered = {
    version: BASELINE_VERSION,
    tool: baseline.tool,
    urlKey: { stripFragment, sortQuery, stripTrailingSlash, dropQueryParams: [...dropQueryParams].sort() },
    pages,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export interface BaselineComparison {
  /** The pages that were given, in their order, each `fail` finding carrying `baseline`. Copies: the input is not changed. */
  pages: BaselineInput[];
  /** The file as it should be written, when it is: see `update` and `prune`. */
  baseline: Baseline;
  summary: BaselineSummary;
  /** The pages that ended on another address than the one asked for, for a message. */
  moved: { url: string; finalUrl: string }[];
}

export interface BaselineOptions {
  /** The `fail` findings the file does not record are added to it, and marked `baselined`. */
  update?: boolean;
  /** Entries that are known to be gone are taken out. */
  prune?: boolean;
  /** Query parameters left out of every key on top of those of the file: `RunConfig.redactQueryParams`. */
  redactQueryParams?: readonly string[];
}

/**
 * Compares the pages of a run with a baseline.
 *
 * An entry that no `fail` finding matches is known to be gone (`stale`, and pruned when asked)
 * only when it was looked for: its check ran on its page, and the page that was read is the one
 * that was asked for. A run of some checks, or a page that sent the browser to a sign-in page,
 * says nothing about the other entries: they are counted as `unverified` and always kept.
 * Neither `update` nor `prune` ever takes out an entry of a page or a check that did not run.
 *
 * Entries for pages this run did not scan (not asked for, or not loaded) are never touched and
 * never counted as stale: nothing is known about them. Several addresses of a run with one key
 * are one page here: an entry is matched when any of them has the finding.
 */
export function compareWithBaseline(pages: BaselineInput[], baseline: Baseline, options: BaselineOptions = {}): BaselineComparison {
  const alsoDrop = options.redactQueryParams ?? [];
  const recorded = new Map<string, BaselineEntry[]>(baseline.pages.map((page) => [page.url, page.findings]));
  /** Per key: the failures found, and the checks that looked on the page that was asked for (null: all of them). */
  const scanned = new Map<string, { failing: BaselineEntry[]; looked: Set<string> | null }>();
  const summary: BaselineSummary = { new: 0, baselined: 0, stale: 0, notScanned: 0, unverified: 0, added: 0, pruned: 0 };
  const moved: BaselineComparison['moved'] = [];

  const marked = pages.map((page) => {
    const key = pageKey(page.url, baseline.urlKey, alsoDrop);
    const entries = recorded.get(key) ?? [];
    const state = scanned.get(key) ?? { failing: [], looked: new Set<string>() };
    scanned.set(key, state);
    const landed = page.finalUrl === undefined || placeOf(page.finalUrl, baseline.urlKey) === placeOf(page.url, baseline.urlKey);
    if (!landed) moved.push({ url: page.url, finalUrl: page.finalUrl! });
    else if (page.checks === undefined) state.looked = null;
    else if (state.looked !== null) for (const check of page.checks) state.looked.add(check);
    const { failing } = state;
    const findings = page.findings.map((finding) => {
      // Only a `fail` is ever looked up; anything else carries no mark.
      if (finding.status !== 'fail') {
        const rest = { ...finding };
        delete rest.baseline;
        return rest;
      }
      const entry = entryOf(finding);
      const known = entries.some((candidate) => sameEntry(candidate, entry));
      if (!failing.some((candidate) => sameEntry(candidate, entry))) failing.push(entry);
      const mark: BaselineState = known || options.update ? 'baselined' : 'new';
      if (mark === 'new') summary.new += 1;
      else summary.baselined += 1;
      return { ...finding, baseline: mark };
    });
    return { ...page, findings };
  });

  const next: BaselinePage[] = [];
  for (const [key, entries] of recorded) {
    const state = scanned.get(key);
    if (!state) {
      summary.notScanned += entries.length;
      next.push({ url: key, findings: [...entries] });
      continue;
    }
    const kept: BaselineEntry[] = [];
    for (const entry of entries) {
      const still = state.failing.some((candidate) => sameEntry(candidate, entry));
      const lookedFor = state.looked === null || state.looked.has(entry.check);
      if (still) kept.push(entry);
      else if (!lookedFor) {
        summary.unverified += 1;
        kept.push(entry);
      } else {
        summary.stale += 1;
        if (options.prune) summary.pruned += 1;
        else kept.push(entry);
      }
    }
    next.push({ url: key, findings: kept });
  }
  if (options.update) {
    for (const [key, { failing }] of scanned) {
      let page = next.find((candidate) => candidate.url === key);
      if (!page) {
        page = { url: key, findings: [] };
        next.push(page);
      }
      for (const entry of failing) {
        if (page.findings.some((candidate) => sameEntry(candidate, entry))) continue;
        page.findings.push(entry);
        summary.added += 1;
      }
    }
  }
  return { pages: marked, baseline: { ...baseline, pages: next.filter((page) => page.findings.length > 0) }, summary, moved };
}

/**
 * Whether a set of findings breaks a build: a `fail` that is not marked as recorded in a
 * baseline. Without a baseline no finding carries a mark, and every `fail` counts.
 */
export function hasNewFailures(findings: Finding[]): boolean {
  return findings.some((finding) => finding.status === 'fail' && finding.baseline !== 'baselined');
}
