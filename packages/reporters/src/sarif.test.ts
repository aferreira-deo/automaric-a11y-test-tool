import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import type { Finding, ScanResult } from '@a11y-vision/core';
import { toHtmlRunReport } from './html.js';
import { toJsonReport, toJsonRunReport } from './json.js';
import { countRun } from './run.js';
import type { Run } from './run.js';
import { toSarifReport } from './sarif.js';

/**
 * The official SARIF 2.1.0 schema (OASIS, errata 01), kept next to the tests: see
 * test-fixtures/README.md. No test reads anything from the network.
 */
const schema = JSON.parse(readFileSync(new URL('../test-fixtures/sarif-schema-2.1.0.json', import.meta.url), 'utf8')) as object;
const require = createRequire(import.meta.url);

export function sarifValidator(): (value: unknown) => string[] {
  // The schema is a draft-04 one, which this major version of Ajv reads once it is given the meta-schema.
  const ajv = new Ajv({ schemaId: 'auto', allErrors: true, format: 'full', unknownFormats: [] });
  ajv.addMetaSchema(require('ajv/lib/refs/json-schema-draft-04.json') as object);
  const validate = ajv.compile(schema);
  return (value) => (validate(value) ? [] : (validate.errors ?? []).map((error) => `${error.dataPath} ${error.message ?? ''}`));
}

function finding(id: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    check: 'focus-indicator',
    rule: 'focus-indicator/no-visible-change',
    status: 'fail',
    wcag: { sc: '2.4.7', level: 'AA' },
    selector: `#${id}`,
    frame: '',
    signature: '',
    box: null,
    evidence: { crops: [], colors: {}, ratios: {}, flags: [] },
    message: 'Nothing changes on focus.',
    help: 'A focused component needs a visible change.',
    ...overrides,
  };
}

function page(url: string, findings: Finding[]): ScanResult {
  return {
    tool: { name: 'a11y-vision', version: '0.0.0' },
    url,
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: { url, devicePixelRatio: 2, viewport: { width: 1280, height: 720 }, colorScheme: 'light' },
    findings,
  };
}

const run: Run = {
  tool: { name: 'a11y-vision', version: '0.0.0' },
  timestamp: '2026-01-01T00:00:00.000Z',
  pages: [
    {
      requestedUrl: 'https://example.test/one',
      cropsDir: '001-example.test-one',
      result: page('https://example.test/one', [
        finding('a', { baseline: 'baselined' }),
        finding('b', { baseline: 'new', selector: 'input[type="text"]', frame: 'iframe#f', message: 'Brackets [x](1) and a \\ backslash.' }),
        finding('c', { status: 'likely', rule: 'headings/unmarked-heading', check: 'headings', wcag: { sc: '1.3.1', level: 'A' }, help: 'Text that works as a heading is exposed as one.' }),
        finding('d', { status: 'advisory', rule: 'lists/repeated-structure', check: 'lists', wcag: { sc: '1.3.1', level: 'A' } }),
        finding('e', { status: 'info', rule: 'focus-indicator/browser-default', wcag: null }),
      ]),
    },
    { requestedUrl: 'https://example.test/two#top', result: page('https://example.test/two', [finding('a')]) },
  ],
  errors: [{ url: 'https://example.test/gone', message: 'The page answered with HTTP status 404.' }],
  baseline: { new: 2, baselined: 1, stale: 0, notScanned: 0, unverified: 0, added: 0, pruned: 0 },
};

describe('toSarifReport', () => {
  const validate = sarifValidator();
  const { sarif, omitted } = toSarifReport(run);
  const [only] = sarif.runs;

  it('is valid SARIF 2.1.0 against the official schema', () => {
    expect(validate(sarif)).toEqual([]);
    expect(sarif.version).toBe('2.1.0');
    expect(omitted).toBe(0);
  });

  it('is refused by the same validator when it is damaged, so the validation means something', () => {
    const damaged = structuredClone(sarif) as unknown as { runs: { results: { level: string }[] }[] };
    damaged.runs[0]!.results[0]!.level = 'fatal';
    expect(validate(damaged)).not.toEqual([]);
    expect(validate({ version: '2.1.0' })).not.toEqual([]);
  });

  it('writes fail as error, likely as warning, advisory as note, and leaves info out unless asked', () => {
    expect(only.results.map((result) => [result.properties['findingId'], result.level, result.kind])).toEqual([
      ['a', 'error', 'fail'],
      ['b', 'error', 'fail'],
      ['a', 'error', 'fail'],
      ['c', 'warning', 'fail'],
      ['d', 'note', 'fail'],
    ]);
    const withInfo = toSarifReport(run, { includeInfo: true }).sarif;
    expect(validate(withInfo)).toEqual([]);
    expect(withInfo.runs[0].results.at(-1)).toMatchObject({ level: 'none', kind: 'informational' });
    expect(only.results.find((result) => result.level === 'warning')!.message.text).toMatch(/^Needs confirmation by a tester: /);
  });

  it('gives every rule what GitHub requires, with the criterion in the tags and the help', () => {
    expect(only.tool.driver.rules.map((rule) => rule.id)).toEqual(['focus-indicator/no-visible-change', 'headings/unmarked-heading', 'lists/repeated-structure']);
    for (const rule of only.tool.driver.rules) {
      expect(rule.shortDescription.text).not.toBe('');
      expect(rule.fullDescription.text.length).toBeLessThanOrEqual(1024);
      expect(rule.help.text).toContain('not a statement of conformance');
      expect(rule.properties.tags.length).toBeLessThanOrEqual(20);
    }
    const [focus, headings, lists] = only.tool.driver.rules;
    expect(focus).toMatchObject({ defaultConfiguration: { level: 'error' }, properties: { tags: ['accessibility', 'wcag247', 'WCAG 2.4.7', 'WCAG level AA'], 'problem.severity': 'error' } });
    expect(focus!.help.text).toContain('WCAG 2.2 success criterion 2.4.7 (Level AA).');
    expect(headings).toMatchObject({ defaultConfiguration: { level: 'warning' }, properties: { 'problem.severity': 'warning' } });
    expect(lists).toMatchObject({ defaultConfiguration: { level: 'note' }, properties: { 'problem.severity': 'recommendation' } });
    for (const result of only.results) expect(only.tool.driver.rules[result.ruleIndex]!.id).toBe(result.ruleId);
  });

  it('locates a finding on its page and its element, and escapes brackets in the message', () => {
    const b = only.results[1]!;
    expect(b.locations).toEqual([
      {
        physicalLocation: { artifactLocation: { uri: 'https://example.test/one' } },
        logicalLocations: [{ name: 'input[type="text"]', fullyQualifiedName: 'iframe#f >>> input[type="text"]', kind: 'element' }],
      },
    ]);
    expect(b.message.text).toBe('Brackets \\[x\\](1) and a \\\\ backslash. Element: iframe#f >>> input\\[type="text"\\]. Page: https://example.test/one');
  });

  it('attaches results to a file of the repository when given one, on the line of the page', () => {
    const anchored = toSarifReport(run, { anchor: { uri: 'a11y/urls.txt', lines: new Map([['https://example.test/two#top', 7]]) } }).sarif;
    expect(validate(anchored)).toEqual([]);
    const results = anchored.runs[0].results;
    expect(results[0]!.locations[0]!.physicalLocation).toEqual({
      artifactLocation: { uri: 'a11y/urls.txt', uriBaseId: '%SRCROOT%' },
      region: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
    });
    expect(results[2]!.locations[0]!.physicalLocation.region!.startLine).toBe(7);
    expect(results[2]!.message.text).toContain('Page: https://example.test/two');
    // The identity of a result does not depend on where it is attached.
    expect(results.map((result) => result.partialFingerprints)).toEqual(only.results.map((result) => result.partialFingerprints));
  });

  it('gives each result an identity of its page and finding id, the same on every run', () => {
    const prints = only.results.map((result) => result.partialFingerprints['primaryLocationLineHash']);
    expect(new Set(prints).size).toBe(prints.length);
    expect(prints.every((print) => /^[0-9a-f]{16}:1$/.test(print!))).toBe(true);
    expect(toSarifReport(structuredClone(run)).sarif).toEqual(sarif);
    // The fragment is not part of the identity of a page, as in a baseline.
    const moved = structuredClone(run);
    moved.pages[1]!.requestedUrl = 'https://example.test/two';
    expect(toSarifReport(moved).sarif.runs[0].results[2]!.partialFingerprints).toEqual(only.results[2]!.partialFingerprints);
  });

  it('gives another identity to another element at the same selector, and the same one whatever a secret parameter holds', () => {
    const print = (changed: Run): string => toSarifReport(changed).sarif.runs[0].results[0]!.partialFingerprints['primaryLocationLineHash']!;
    const other = structuredClone(run);
    other.pages[0]!.result.findings[0]!.signature = 'button||00000000000000ff';
    expect(print(other)).not.toBe(print(run));
    expect(toSarifReport(other).sarif.runs[0].results[0]!.properties['signature']).toBe('button||00000000000000ff');
    const withToken = (token: string): Run => {
      const changed = structuredClone(run);
      changed.pages[0]!.requestedUrl = `https://user:pw@example.test/one?id=1&token=${token}`;
      return changed;
    };
    expect(print(withToken('abc'))).toBe(print(withToken('def')));
    expect(toSarifReport(withToken('abc'), { redactQueryParams: [] }).sarif.runs[0].results[0]!.partialFingerprints).not.toEqual(
      toSarifReport(withToken('def'), { redactQueryParams: [] }).sarif.runs[0].results[0]!.partialFingerprints,
    );
  });

  it('says that a sitemap was cut at the limit of pages', () => {
    const cut = structuredClone(run);
    cut.input = { otherOrigin: 0, overLimit: 12, duplicates: 0 };
    const [only_] = toSarifReport(cut).sarif.runs;
    expect(validate(toSarifReport(cut).sarif)).toEqual([]);
    expect(only_.properties['input']).toEqual(cut.input);
    expect(only_.invocations[0].toolExecutionNotifications.map((note) => [note.level, note.message.text])).toContainEqual(['warning', expect.stringContaining('12 page(s) of the sitemap were NOT scanned')]);
    // Nothing is said when nothing was cut.
    cut.input.overLimit = 0;
    expect(toSarifReport(cut).sarif.runs[0].invocations[0].toolExecutionNotifications).toHaveLength(1);
  });

  it('carries the baseline state of a fail, and none where no baseline was used', () => {
    expect(only.results.map((result) => result.baselineState)).toEqual(['unchanged', 'new', undefined, undefined, undefined]);
  });

  it('says which pages were not scanned, and that the run was not complete', () => {
    expect(only.invocations[0].executionSuccessful).toBe(false);
    expect(only.invocations[0].toolExecutionNotifications).toEqual([{ level: 'error', message: { text: 'Not scanned: https://example.test/gone. The page answered with HTTP status 404.' } }]);
    expect(toSarifReport({ ...run, errors: [] }).sarif.runs[0].invocations[0].executionSuccessful).toBe(true);
  });

  it('cuts the least severe results first when there are more than the limit, and says so', () => {
    const cut = toSarifReport(run, { maxResults: 3 });
    expect(cut.omitted).toBe(2);
    expect(cut.sarif.runs[0].results.map((result) => result.level)).toEqual(['error', 'error', 'error']);
    expect(cut.sarif.runs[0].invocations[0].toolExecutionNotifications.at(-1)!.message.text).toContain('2 result(s) were left out');
    expect(validate(cut.sarif)).toEqual([]);
  });

  it('copes with findings that are not what this version writes', () => {
    const odd = { ...run, pages: [{ requestedUrl: 'https://example.test/', result: page('https://example.test/', [{ status: 'catastrophic', rule: 7 } as unknown as Finding]) }] };
    const out = toSarifReport(odd, { includeInfo: true }).sarif;
    expect(validate(out)).toEqual([]);
    // An unknown status is inventory, never an error.
    expect(out.runs[0].results[0]).toMatchObject({ level: 'none', ruleId: 'unknown' });
  });
});

describe('reports of a run over several pages', () => {
  it('counts by status, and the fails by whether a baseline records them', () => {
    expect(countRun(run)).toEqual({ pages: 2, errors: 1, fail: 3, likely: 1, advisory: 1, info: 1, newFail: 2, baselinedFail: 1 });
  });

  it('JSON: one single-page report per page, and the run under the extension key', () => {
    const report = toJsonRunReport(run);
    expect(Object.keys(report)).toEqual(['testEngine', 'timestamp', 'pages', 'a11yVision']);
    expect(report.pages).toHaveLength(2);
    // A page is exactly the report of that page alone, plus where it came from.
    const { requestedUrl, cropsDir, ...rest } = report.pages[0]!.a11yVision;
    expect({ ...report.pages[0], a11yVision: rest }).toEqual(toJsonReport(run.pages[0]!.result));
    expect([requestedUrl, cropsDir]).toEqual(['https://example.test/one', '001-example.test-one']);
    expect(report.pages[0]!.violations[0]!.nodes.map((node) => node.baseline)).toEqual(['baselined', 'new']);
    expect(report.pages[0]!.passes).toEqual([]);
    expect(report.a11yVision.errors).toEqual(run.errors);
    expect(report.a11yVision.baseline).toEqual(run.baseline);
    expect(report.a11yVision.summary.newFail).toBe(2);
  });

  it('JSON of one page is what it was when no baseline is used', () => {
    const result = page('https://example.test/', [finding('a')]);
    expect(Object.keys(toJsonReport(result).a11yVision)).toEqual(['environment', 'findings']);
    expect(toJsonReport(result).violations[0]!.nodes[0]).not.toHaveProperty('baseline');
    expect(toJsonReport(result, { baseline: run.baseline! }).a11yVision.baseline).toEqual(run.baseline);
  });

  it('HTML: pages that were not scanned first, every page with its findings, marks of the baseline, no claim', () => {
    const hostile = structuredClone(run);
    hostile.errors[0]!.message = '<img src=x onerror=alert(1)>';
    hostile.pages[1]!.requestedUrl = 'https://example.test/two?"><script>';
    const html = toHtmlRunReport(hostile, [{}, {}]);
    expect(html).toContain('<h2>Not scanned (1)</h2>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('<h3>Page 1: <code>https://example.test/one</code></h3>');
    expect(html).toContain('<a href="#page-2">');
    expect(html).toContain('<span class="status">Fail</span> <span class="verdict">In the baseline</span> <code>#a</code>');
    expect(html).toContain('<span class="status">Fail</span> <span class="verdict">New</span>');
    expect(html).toContain('2 Fail finding(s) are new');
    expect(html).toContain('they are still failures');
    expect(html).toContain('makes no statement of conformance');
    expect(html).not.toMatch(/\bpass(es|ed)?\b/i);
    // A sitemap that was cut, and entries of the baseline that were not looked for, are said.
    expect(html).not.toContain('NOT scanned: the sitemap');
    const cut = structuredClone(run);
    cut.input = { otherOrigin: 0, overLimit: 7, duplicates: 0 };
    cut.baseline = { ...cut.baseline!, unverified: 3 };
    const said = toHtmlRunReport(cut, [{}, {}]);
    expect(said).toContain('<strong>7 page(s) of the sitemap were NOT scanned: the sitemap lists more pages than the limit for a run');
    expect(said).toContain('3 entr(y/ies) were not looked for: their check did not run, or their page ended on another address');
    // Headings go down one level at a time: run, pages, page, status, finding.
    expect(html.match(/<h[1-6]/g)!.slice(0, 6)).toEqual(['<h1', '<h2', '<h2', '<h3', '<h4', '<h5']);
  });
});
