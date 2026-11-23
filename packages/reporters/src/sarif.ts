import { defaultConfig, EXTENSION_KEY, fnv1a64, pageKey } from '@a11y-vision/core';
import type { BaselineConfig, Finding, Status } from '@a11y-vision/core';
import { statusOf } from './run.js';
import type { Run } from './run.js';

/**
 * SARIF 2.1.0, written for what GitHub code scanning documents that it reads
 * (docs.github.com, "SARIF support for code scanning") and valid against the OASIS schema.
 *
 * How the four statuses are written:
 *
 * | status   | level   | kind          |
 * |----------|---------|---------------|
 * | fail     | error   | fail          |
 * | likely   | warning | fail          |
 * | advisory | note    | fail          |
 * | info     | none    | informational | (left out unless `includeInfo`)
 *
 * `likely` could be `kind: "review"` in SARIF, which then requires `level: "none"`; GitHub
 * documents `note`, `warning` and `error` only, so a `likely` is a warning whose message opens
 * with the words that say a tester has to confirm it. Only `error` fails the code scanning check
 * of a pull request by default, which is the rule of the tool: only `fail` breaks a build.
 *
 * Where a finding is: on a web page, not in a file. GitHub reads `artifactLocation.uri` as a
 * path in the repository and documents nothing else. So there are two ways to write it:
 * - by default the address of the page, which is what the finding is about and what other SARIF
 *   viewers show; how GitHub lists such a result is not documented;
 * - with `anchor`, a file of the repository (the list of addresses is the natural one, each
 *   finding on the line of its page), which is the documented form. The address of the page is
 *   then in the message and in `properties`.
 * Either way the element is a `logicalLocation` of kind `element`.
 */

export interface SarifOptions {
  /** Also write `info` findings (inventory). Off by default. */
  includeInfo?: boolean;
  /**
   * A file of the repository to attach every result to, as a path relative to its root with
   * forward slashes, and the line of each requested address in it when it lists them.
   */
  anchor?: { uri: string; lines?: ReadonlyMap<string, number> };
  /** How the address of a page becomes part of the identity of a result. Defaults to the defaults of a baseline. */
  urlKey?: BaselineConfig;
  /** Results beyond this are left out, least severe first, and the log says so. Defaults to what GitHub accepts. */
  maxResults?: number;
}

type Level = 'error' | 'warning' | 'note' | 'none';

const LEVEL: Record<Status, Level> = { fail: 'error', likely: 'warning', advisory: 'note', info: 'none' };
const LEVEL_ORDER: Level[] = ['error', 'warning', 'note', 'none'];
/** What GitHub calls the severity of a rule that is not a security rule. */
const PROBLEM_SEVERITY: Record<Level, string> = { error: 'error', warning: 'warning', note: 'recommendation', none: 'recommendation' };
/** How sure the tool is: `fail` is measured, `likely` waits for a tester, the rest is weaker still. */
const PRECISION: Record<Level, string> = { error: 'high', warning: 'medium', note: 'low', none: 'low' };
const STATUS_LEAD: Record<Status, string> = {
  fail: '',
  likely: 'Needs confirmation by a tester: ',
  advisory: 'Best practice, not a failure: ',
  info: 'Inventory: ',
};
/** Limits GitHub gives for the texts of a rule. */
const MAX_NAME_CHARS = 255;
const MAX_DESCRIPTION_CHARS = 1024;
export const SARIF_SCHEMA_URI = 'https://json.schemastore.org/sarif-2.1.0.json';
/** The key of our own fingerprint, with its version. */
export const SARIF_FINGERPRINT_KEY = `${EXTENSION_KEY}/v1`;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** In a SARIF plain-text message, square brackets make a link: literal ones and the backslash are escaped (SARIF 2.1.0, 3.11.5). */
function plain(text: string): string {
  return text.replace(/[\\[\]]/g, (char) => `\\${char}`);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  help: { text: string };
  defaultConfiguration: { level: Exclude<Level, 'none'> };
  properties: { tags: string[]; precision: string; 'problem.severity': string };
}

interface SarifLocation {
  physicalLocation: { artifactLocation: { uri: string; uriBaseId?: string }; region?: { startLine: number; startColumn: number; endLine: number; endColumn: number } };
  logicalLocations?: { name: string; fullyQualifiedName: string; kind: string }[];
}

interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  kind: 'fail' | 'informational';
  level: Level;
  message: { text: string };
  locations: SarifLocation[];
  partialFingerprints: Record<string, string>;
  baselineState?: 'new' | 'unchanged';
  properties: Record<string, unknown>;
}

export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: [
    {
      tool: { driver: { name: string; version: string; semanticVersion: string; rules: SarifRule[] } };
      automationDetails: { id: string };
      columnKind: 'utf16CodeUnits';
      invocations: [{ executionSuccessful: boolean; toolExecutionNotifications: { level: 'error' | 'warning'; message: { text: string }; locations?: SarifLocation[] }[] }];
      results: SarifResult[];
      properties: Record<string, unknown>;
    },
  ];
}

function tagsOf(finding: Finding): string[] {
  const tags = ['accessibility'];
  const sc = text(finding.wcag?.sc);
  if (sc !== '') {
    // The same tag the JSON report gives the rule (the form axe uses), and the level.
    tags.push(`wcag${sc.replaceAll('.', '')}`, `WCAG ${sc}`);
    if (finding.wcag?.level === 'A' || finding.wcag?.level === 'AA') tags.push(`WCAG level ${finding.wcag.level}`);
  }
  return tags;
}

/**
 * The SARIF log of a run, and how many results were left out to stay under `maxResults`.
 *
 * The same run gives the same log, apart from nothing: no date is written.
 */
export function toSarifReport(run: Run, options: SarifOptions = {}): { sarif: SarifLog; omitted: number } {
  const urlKey = options.urlKey ?? defaultConfig.baseline;
  const maxResults = options.maxResults ?? defaultConfig.run.sarifMaxResults;

  interface Draft {
    finding: Finding;
    status: Status;
    level: Level;
    requestedUrl: string;
    pageUrl: string;
    order: number;
  }
  let drafts: Draft[] = [];
  for (const page of run.pages) {
    for (const finding of page.result.findings) {
      const status = statusOf(finding);
      if (status === 'info' && !options.includeInfo) continue;
      drafts.push({ finding, status, level: LEVEL[status], requestedUrl: page.requestedUrl, pageUrl: text(page.result.url) || page.requestedUrl, order: drafts.length });
    }
  }
  // Most severe first, then as the run has them: what is cut, if anything is, is the least severe.
  drafts.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || a.order - b.order);
  const omitted = Math.max(0, drafts.length - maxResults);
  drafts = drafts.slice(0, maxResults);

  // One rule per rule name, with the most severe level any of its results has in this run.
  const byRule = new Map<string, { first: Finding; level: Level; status: Status }>();
  for (const draft of drafts) {
    const id = text(draft.finding.rule) || 'unknown';
    const known = byRule.get(id);
    if (!known) byRule.set(id, { first: draft.finding, level: draft.level, status: draft.status });
    else if (LEVEL_ORDER.indexOf(draft.level) < LEVEL_ORDER.indexOf(known.level)) {
      known.level = draft.level;
      known.status = draft.status;
    }
  }
  const ruleIds = [...byRule.keys()].sort();
  const rules: SarifRule[] = ruleIds.map((id) => {
    const { first, level } = byRule.get(id)!;
    const help = text(first.help) || id;
    const sc = text(first.wcag?.sc);
    const criterion = sc === '' ? 'Relates to no WCAG success criterion.' : `WCAG 2.2 success criterion ${sc} (Level ${text(first.wcag?.level)}).`;
    return {
      id,
      name: clip(id, MAX_NAME_CHARS),
      shortDescription: { text: clip(help, MAX_DESCRIPTION_CHARS) },
      fullDescription: { text: clip(`${help} ${criterion}`, MAX_DESCRIPTION_CHARS) },
      help: {
        text: `${help}\n\n${criterion}\n\nStatuses: "fail" is measured or structurally certain and is written as an error; "likely" needs confirmation by a tester (warning); "advisory" is best practice (note). The tool assists a tester and covers a small set of checks: the absence of results is not a statement of conformance.`,
      },
      defaultConfiguration: { level: level === 'none' ? 'note' : level },
      properties: { tags: tagsOf(first), precision: PRECISION[level], 'problem.severity': PROBLEM_SEVERITY[level] },
    };
  });

  const results: SarifResult[] = drafts.map(({ finding, status, level, requestedUrl, pageUrl }) => {
    const ruleId = text(finding.rule) || 'unknown';
    const selector = text(finding.selector);
    const frame = text(finding.frame);
    const element = frame === '' ? selector : `${frame} >>> ${selector}`;
    const identity = fnv1a64(`${pageKey(requestedUrl, urlKey)}\u0000${text(finding.id)}`);
    const line = options.anchor?.lines?.get(requestedUrl) ?? 1;
    const physicalLocation: SarifLocation['physicalLocation'] = options.anchor
      ? { artifactLocation: { uri: options.anchor.uri, uriBaseId: '%SRCROOT%' }, region: { startLine: line, startColumn: 1, endLine: line, endColumn: 1 } }
      : { artifactLocation: { uri: pageUrl } };
    return {
      ruleId,
      ruleIndex: ruleIds.indexOf(ruleId),
      kind: status === 'info' ? 'informational' : 'fail',
      level,
      message: { text: plain(`${STATUS_LEAD[status]}${text(finding.message)} Element: ${element}. Page: ${pageUrl}`) },
      locations: [{ physicalLocation, logicalLocations: [{ name: selector, fullyQualifiedName: element, kind: 'element' }] }],
      // GitHub reads `primaryLocationLineHash` and nothing else. Given here, because it cannot be
      // worked out from a line of a file: the identity of a result is its page and its finding id.
      partialFingerprints: { primaryLocationLineHash: `${identity}:1`, [SARIF_FINGERPRINT_KEY]: identity },
      ...(finding.baseline ? { baselineState: finding.baseline === 'baselined' ? ('unchanged' as const) : ('new' as const) } : {}),
      properties: {
        status,
        findingId: text(finding.id),
        check: text(finding.check),
        pageUrl,
        requestedUrl,
        selector,
        frame,
        ...(sc(finding) !== '' ? { wcag: sc(finding) } : {}),
        ...(finding.baseline ? { baseline: finding.baseline } : {}),
      },
    };
  });

  const notifications: SarifLog['runs'][0]['invocations'][0]['toolExecutionNotifications'] = run.errors.map((error) => ({
    level: 'error',
    message: { text: plain(`Not scanned: ${error.url}. ${error.message}`) },
  }));
  if (omitted > 0) {
    notifications.push({ level: 'warning', message: { text: `${omitted} result(s) were left out of this file, the least severe first, to stay under ${maxResults} results.` } });
  }

  return {
    omitted,
    sarif: {
      $schema: SARIF_SCHEMA_URI,
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: run.tool.name, version: run.tool.version, semanticVersion: run.tool.version, rules } },
          // Up to the last slash is what GitHub calls the category of the analysis.
          automationDetails: { id: `${run.tool.name}/` },
          columnKind: 'utf16CodeUnits',
          invocations: [{ executionSuccessful: run.errors.length === 0, toolExecutionNotifications: notifications }],
          results,
          properties: {
            pagesScanned: run.pages.length,
            pagesNotScanned: run.errors.length,
            ...(run.baseline ? { baseline: run.baseline } : {}),
            note: 'Findings of a small set of accessibility checks, to assist a tester. Not a statement of conformance.',
          },
        },
      ],
    },
  };
}

function sc(finding: Finding): string {
  return text(finding.wcag?.sc);
}
