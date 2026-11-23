import type { Finding, ScanResult } from '@a11y-vision/core';

/**
 * Keeping the values of a stored session out of what is written.
 *
 * A page that is scanned signed in may show what its session holds (a token in a link, an id made
 * from it, a name), and a check reads the page. So the values of the storage state are looked for
 * in every text that was read from the page, and replaced, before a report, a SARIF file or a
 * baseline is made from it. Texts only: a value is never looked for in a serialised report, where
 * it could match a key or a word of the format, and never in the words of the tool itself (a
 * status, a check, a rule), so a report stays a report whatever a cookie holds.
 *
 * Captures are images of the page: what the page shows, they show. Nothing here changes that.
 */

export const REDACTED = '[redacted]';

/**
 * The values of a Playwright storage state that have to stay out of what is written: the value
 * of every cookie and of every local storage item (and what a state holds of IndexedDB), the
 * string values inside those that are JSON, at any depth, and the URL-decoded and URL-encoded
 * form of each. Values shorter than `minChars` are left out: they would match by chance.
 * Longest first, so that a value that holds another is replaced whole.
 */
export function collectSecrets(state: unknown, minChars: number): string[] {
  const secrets = new Set<string>();
  const keep = (value: string): void => {
    if (value.length >= minChars) secrets.add(value);
  };
  // A state is parsed JSON, and so is what is parsed out of it: a tree, and each text inside a text is shorter.
  const add = (value: unknown): void => {
    if (typeof value === 'string') {
      keep(value);
      try {
        keep(decodeURIComponent(value));
      } catch {
        // Not URL-encoded.
      }
      keep(encodeURIComponent(value));
      const trimmed = value.trim();
      if (/^[[{"]/.test(trimmed)) {
        try {
          add(JSON.parse(trimmed));
        } catch {
          // Not JSON.
        }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) add(item);
    } else if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) add(item);
    }
  };
  const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {});
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const root = record(state);
  for (const cookie of list(root['cookies'])) add(record(cookie)['value']);
  for (const origin of list(root['origins'])) {
    for (const item of list(record(origin)['localStorage'])) add(record(item)['value']);
    add(record(origin)['indexedDB']);
  }
  return [...secrets].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

/** `text` with every secret replaced. */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret !== '') out = out.replaceAll(secret, REDACTED);
  return out;
}

/** Every string value in `value` through `clean`. Keys, numbers and the shape are left as they are. */
function deep<T>(value: T, clean: (text: string) => string): T {
  if (typeof value === 'string') return clean(value) as T;
  if (Array.isArray(value)) return value.map((item) => deep(item as unknown, clean)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item as unknown, clean)])) as T;
  }
  return value;
}

/** Fields of a finding that hold words of the tool, never text of a page: left as they are. */
const TOOL_FIELDS = new Set<string>(['id', 'check', 'rule', 'status', 'wcag', 'signature', 'box', 'help', 'baseline']);
const TOOL_EVIDENCE_FIELDS = new Set<string>(['crops', 'colors', 'ratios', 'flags']);

function cleanFinding(finding: Finding, clean: (text: string) => string): Finding {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(finding)) {
    if (TOOL_FIELDS.has(key)) out[key] = value;
    else if (key === 'evidence' && value !== null && typeof value === 'object') {
      out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, TOOL_EVIDENCE_FIELDS.has(name) ? item : deep(item, clean)]));
    } else if (key === 'ai' && value !== null && typeof value === 'object') {
      // Of what a model said, only its own words are free text.
      out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, name === 'rationale' ? deep(item, clean) : item]));
    } else out[key] = deep(value, clean);
  }
  return out as unknown as Finding;
}

/**
 * The result of a page with every text that came from the page through `clean`: the selector,
 * frame and message of each finding, what was read into its evidence, the words of a model, and
 * the addresses of the page (through `cleanAddress`, which also takes credentials out).
 */
export function cleanResult(result: ScanResult, clean: (text: string) => string, cleanAddress: (url: string) => string): ScanResult {
  const address = (url: string): string => clean(cleanAddress(url));
  const { navigatedFrom, ...environment } = result.environment;
  return {
    ...result,
    url: address(result.url),
    environment: { ...environment, url: address(environment.url), ...(navigatedFrom !== undefined ? { navigatedFrom: address(navigatedFrom) } : {}) },
    findings: result.findings.map((finding) => cleanFinding(finding, clean)),
  };
}
