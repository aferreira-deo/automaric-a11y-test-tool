import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { TestInfo } from '@playwright/test';
import Ajv from 'ajv';

/**
 * M7, through the built CLI and the fixture server on this machine: runs over several pages,
 * lists and sitemaps, the baseline file, SARIF, a stored session, and the script of the GitHub
 * Action. Nothing here reaches another machine.
 */

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const bin = join(root, 'packages/cli/dist/bin.js');
const actionScript = join(root, 'scripts/action-scan.mjs');
const SESSION = 'e2e-session-0123456789-SECRET';

interface Node {
  target: string[];
  findingId: string;
  baseline?: string;
}
interface Rule {
  id: string;
  nodes: Node[];
}
interface Finding {
  id: string;
  rule: string;
  status: string;
  selector: string;
  baseline?: string;
  evidence: { crops: string[] };
}
interface BaselineSummary {
  new: number;
  baselined: number;
  stale: number;
  notScanned: number;
  added: number;
  pruned: number;
}
interface PageReport {
  url: string;
  violations: Rule[];
  incomplete: Rule[];
  passes: unknown[];
  a11yVision: { findings: Finding[]; requestedUrl?: string; cropsDir?: string; baseline?: BaselineSummary };
}
interface RunReport {
  testEngine: { name: string };
  timestamp: string;
  pages: PageReport[];
  a11yVision: {
    summary: { pages: number; errors: number; fail: number; newFail: number; baselinedFail: number };
    errors: { url: string; message: string }[];
    baseline?: BaselineSummary;
    input?: { otherOrigin: number; overLimit: number; duplicates: number };
  };
}
interface Sarif {
  version: string;
  runs: {
    tool: { driver: { name: string; rules: { id: string }[] } };
    invocations: { executionSuccessful: boolean; toolExecutionNotifications: { message: { text: string } }[] }[];
    results: {
      ruleId: string;
      level: string;
      baselineState?: string;
      message: { text: string };
      partialFingerprints: Record<string, string>;
      locations: { physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number } } }[];
      properties: { requestedUrl: string; selector: string };
    }[];
  }[];
}

/** The environment without anything that could configure a model. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('A11Y_VISION_') || name.startsWith('INPUT_') || name.startsWith('GITHUB_')) delete env[name];
  return { ...env, ...extra };
}

async function node(script: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  await mkdir(cwd, { recursive: true });
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args], { maxBuffer: 64 * 1024 * 1024, cwd, env: cleanEnv(env) });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

const cli = (testInfo: TestInfo, ...args: string[]) => node(bin, args, testInfo.outputDir);

/** The official SARIF 2.1.0 schema, from the copy next to the unit tests of the reporters. */
const sarifErrors = (() => {
  const ajv = new Ajv({ schemaId: 'auto', allErrors: true, format: 'full', unknownFormats: [] });
  ajv.addMetaSchema(createRequire(import.meta.url)('ajv/lib/refs/json-schema-draft-04.json') as object);
  const validate = ajv.compile(JSON.parse(readFileSync(join(root, 'packages/reporters/test-fixtures/sarif-schema-2.1.0.json'), 'utf8')) as object);
  return (value: unknown): string[] => (validate(value) ? [] : (validate.errors ?? []).map((error) => `${error.dataPath} ${error.message ?? ''}`));
})();

const json = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
const failsOf = (page: PageReport): Finding[] => page.a11yVision.findings.filter((finding) => finding.status === 'fail');

// eslint-disable-next-line no-empty-pattern -- Playwright wants the fixtures destructured, and this test uses none.
test('--help names every option and the three exit codes, and claims nothing', async ({}, testInfo) => {
  const { code, stdout, stderr } = await cli(testInfo, '--help');
  expect(code).toBe(0);
  expect(stderr).toBe('');
  for (const option of [
    '--urls', '--sitemap', '--max-urls', '--any-origin', '--allow-file-urls', '--allow-http-errors', '--storage-state', '--output', '--html', '--sarif <file>', '--sarif-anchor',
    '--sarif-include-info', '--crops', '--quiet', '--baseline <file>', '--update-baseline', '--prune-baseline', '--checks', '--config', '--no-ai', '--version',
  ]) {
    expect(stdout, option).toContain(option);
  }
  expect(stdout).toMatch(/Exit codes:\n\s+0 .*\n(.*\n)*?\s+1 .*\n(.*\n)*?\s+2 /);
  expect(stdout).toContain('not a\nstatement of conformance');
  expect(stdout).toContain('session secrets');
  expect(stdout).toContain('captures are images of the page and can show them');
  expect(stdout).toContain('run.redactQueryParams');
});

test('one address keeps the single-page report, with a summary on stderr and nothing but JSON on stdout', async ({ baseURL }, testInfo) => {
  const { code, stdout, stderr } = await cli(testInfo, 'scan', `${baseURL}/focus-indicator/outline-none.html`);
  expect(code).toBe(1);
  const report = JSON.parse(stdout) as PageReport & Record<string, unknown>;
  expect(Object.keys(report)).toEqual(['testEngine', 'url', 'timestamp', 'violations', 'incomplete', 'passes', 'inapplicable', 'a11yVision']);
  expect(Object.keys(report.a11yVision)).toEqual(['environment', 'findings']);
  expect(report.violations[0]!.nodes[0]).not.toHaveProperty('baseline');
  expect(stderr).toBe(
    '[a11y-vision] 1 page scanned.\n' +
      `[a11y-vision] Findings: 2 fail, 0 likely, 0 advisory, ${report.a11yVision.findings.length - 2} info.\n` +
      '[a11y-vision] Exit code 1: "fail" findings. These are the findings of a small set of checks, not a statement of conformance.\n',
  );
  const quiet = await cli(testInfo, 'scan', `${baseURL}/focus-indicator/outline-none.html`, '--quiet');
  expect(quiet.stderr).toBe('');
  expect(quiet.code).toBe(1);
});

test('several addresses make one run: a report per page, captures per page, one HTML file, valid SARIF', async ({ baseURL }, testInfo) => {
  const out = (name: string): string => testInfo.outputPath(name);
  const urls = [`${baseURL}/focus-indicator/outline-none.html`, `${baseURL}/focus-indicator/low-contrast-outline.html#main`, `${baseURL}/noop/basic.html`];
  const { code, stdout, stderr } = await cli(testInfo, 'scan', ...urls, urls[0]!, '--html', out('report.html'), '--sarif', out('report.sarif'), '--crops', out('crops'));
  expect(code).toBe(1);

  const report = JSON.parse(stdout) as RunReport;
  expect(Object.keys(report)).toEqual(['testEngine', 'timestamp', 'pages', 'a11yVision']);
  expect(report.pages.map((page) => page.a11yVision.requestedUrl)).toEqual(urls);
  // The address given twice is scanned once.
  expect(report.a11yVision.input).toEqual({ otherOrigin: 0, overLimit: 0, duplicates: 1 });
  expect(report.a11yVision.errors).toEqual([]);
  // Each page is a report in the single-page shape.
  for (const page of report.pages) {
    expect(Object.keys(page)).toEqual(['testEngine', 'url', 'timestamp', 'violations', 'incomplete', 'passes', 'inapplicable', 'a11yVision']);
    expect(page.passes).toEqual([]);
  }
  expect(report.pages[0]!.violations[0]!.nodes.map((entry) => entry.target[0]).sort()).toEqual(['#none-button', '#none-link']);
  const fails = report.pages.map((page) => failsOf(page).length);
  expect(fails[0]).toBe(2);
  expect(fails[1]).toBeGreaterThan(0);
  expect(fails[2]).toBe(0);
  expect(report.a11yVision.summary).toMatchObject({ pages: 3, errors: 0, fail: fails[0]! + fails[1]!, newFail: fails[0]! + fails[1]!, baselinedFail: 0 });

  // Captures: one directory per page, named in the report, holding the ids of that page.
  expect(report.pages.map((page) => page.a11yVision.cropsDir)).toEqual([
    expect.stringMatching(/^001-127\.0\.0\.1-\d+-focus-indicator-outline-none\.html$/),
    expect.stringMatching(/^002-127\.0\.0\.1-\d+-focus-indicator-low-contrast-outline\.html$/),
    expect.stringMatching(/^003-127\.0\.0\.1-\d+-noop-basic\.html$/),
  ]);
  for (const page of report.pages) {
    for (const id of page.a11yVision.findings.flatMap((finding) => finding.evidence.crops)) {
      expect(existsSync(join(out('crops'), page.a11yVision.cropsDir!, id)), id).toBe(true);
    }
  }
  expect((await readdir(out('crops'))).sort()).toEqual(report.pages.map((page) => page.a11yVision.cropsDir).filter((dir) => existsSync(join(out('crops'), dir!))).sort());

  expect(stderr).toContain(`[a11y-vision] Page 2 of 3: ${urls[1]}\n`);
  expect(stderr).toContain('[a11y-vision] 3 pages scanned.\n');
  expect(stderr).toContain('[a11y-vision] Exit code 1: "fail" findings.');

  const html = await readFile(out('report.html'), 'utf8');
  expect(html).toContain('3 page(s) scanned, 0 not scanned');
  expect(html).toContain(`<h3>Page 2: <code>${urls[1]}</code></h3>`);
  expect(html).toContain('data:image/png;base64,');
  expect(html).toContain('makes no statement of conformance');

  const sarif = await json<Sarif>(out('report.sarif'));
  expect(sarifErrors(sarif)).toEqual([]);
  const [only] = sarif.runs;
  expect(only!.tool.driver.name).toBe('a11y-vision');
  expect(only!.invocations[0]!.executionSuccessful).toBe(true);
  expect(only!.results.filter((result) => result.level === 'error')).toHaveLength(fails[0]! + fails[1]!);
  expect(only!.results.every((result) => result.level !== 'none')).toBe(true);
  expect(only!.results[0]!.locations[0]!.physicalLocation.artifactLocation.uri).toBe(urls[0]);
  expect(only!.results[0]!.baselineState).toBeUndefined();
  expect(new Set(only!.results.map((result) => result.partialFingerprints['primaryLocationLineHash'])).size).toBe(only!.results.length);
});

test('a page that cannot be scanned is reported, the others are scanned, and the run exits 2', async ({ baseURL }, testInfo) => {
  const out = (name: string): string => testInfo.outputPath(name);
  const good = `${baseURL}/noop/basic.html`;
  const { code, stderr } = await cli(testInfo, 'scan', 'http://127.0.0.1:1/', `${baseURL}/_ci/error.html`, good, '--checks', 'noop', '-o', out('report.json'), '--html', out('report.html'), '--sarif', out('report.sarif'));
  expect(code).toBe(2);
  const report = await json<RunReport>(out('report.json'));
  expect(report.pages.map((page) => page.a11yVision.requestedUrl)).toEqual([good]);
  expect(report.a11yVision.errors).toEqual([
    { url: 'http://127.0.0.1:1/', message: expect.stringContaining('net::ERR_') },
    { url: `${baseURL}/_ci/error.html`, message: expect.stringContaining('HTTP status 500') },
  ]);
  expect(report.a11yVision.summary).toMatchObject({ pages: 1, errors: 2 });
  expect(stderr).toContain('Not scanned: http://127.0.0.1:1/: ');
  expect(stderr).toContain('[a11y-vision] 1 page scanned, 2 pages NOT scanned.');
  expect(stderr).toContain('[a11y-vision] Exit code 2: the run is not complete.');
  const html = await readFile(out('report.html'), 'utf8');
  expect(html).toContain('<h2>Not scanned (2)</h2>');
  const sarif = await json<Sarif>(out('report.sarif'));
  expect(sarifErrors(sarif)).toEqual([]);
  expect(sarif.runs[0]!.invocations[0]!.executionSuccessful).toBe(false);
  expect(sarif.runs[0]!.invocations[0]!.toolExecutionNotifications).toHaveLength(2);

  // An error page is not scanned in place of the page, alone or in a run, unless that is asked for.
  const alone = await cli(testInfo, 'scan', `${baseURL}/_ci/error.html`, '--checks', 'noop');
  expect(alone.code).toBe(2);
  expect(alone.stdout).toBe('');
  expect(alone.stderr).toContain('Scan failed: The page answered with HTTP status 500');
  const allowed = await cli(testInfo, 'scan', `${baseURL}/_ci/error.html`, '--checks', 'noop', '--allow-http-errors');
  expect(allowed.code).toBe(0);
});

test('--urls reads a list with comments and blank lines; SARIF can be attached to it, line by line', async ({ baseURL }, testInfo) => {
  const out = (name: string): string => testInfo.outputPath(name);
  await mkdir(testInfo.outputPath('a11y'), { recursive: true });
  const list = '# The pages of the test site\r\n\r\n' + `${baseURL}/focus-indicator/outline-none.html\r\n` + '# a comment between two addresses\n' + `   ${baseURL}/focus-indicator/low-contrast-outline.html  \n`;
  await writeFile(testInfo.outputPath('a11y', 'urls with space.txt'), list);
  const { code } = await cli(testInfo, 'scan', '--urls', join('a11y', 'urls with space.txt'), '-o', out('report.json'), '--sarif', out('report.sarif'), '--sarif-anchor', 'a11y\\urls with space.txt', '--checks', 'focus-indicator');
  expect(code).toBe(1);
  const report = await json<RunReport>(out('report.json'));
  expect(report.pages).toHaveLength(2);
  const sarif = await json<Sarif>(out('report.sarif'));
  expect(sarifErrors(sarif)).toEqual([]);
  const lines = new Map(sarif.runs[0]!.results.map((result) => [result.properties.requestedUrl, result.locations[0]!.physicalLocation]));
  expect(lines.get(`${baseURL}/focus-indicator/outline-none.html`)).toMatchObject({ artifactLocation: { uri: 'a11y/urls%20with%20space.txt' }, region: { startLine: 3 } });
  expect(lines.get(`${baseURL}/focus-indicator/low-contrast-outline.html`)).toMatchObject({ region: { startLine: 5 } });
  expect(sarif.runs[0]!.results[0]!.message.text).toContain(`Page: ${baseURL}/focus-indicator/outline-none.html`);

  // A list with a line that is not an address is not scanned in part.
  await writeFile(out('bad.txt'), `${baseURL}/noop/basic.html\nnoop/basic.html\n`);
  const bad = await cli(testInfo, 'scan', '--urls', out('bad.txt'));
  expect(bad.code).toBe(2);
  expect(bad.stdout).toBe('');
  expect(bad.stderr).toContain('line 2: not an http(s) address');
  expect((await cli(testInfo, 'scan', '--urls', out('missing.txt'))).code).toBe(2);
  // The anchor is a path inside the repository.
  for (const path of ['../urls.txt', '/etc/urls.txt', 'C:\\urls.txt']) {
    expect((await cli(testInfo, 'scan', `${baseURL}/noop/basic.html`, '--sarif', out('x.sarif'), '--sarif-anchor', path)).code, path).toBe(2);
  }
});

test('--sitemap reads a sitemap, an index and gzip, stays on its origin, and refuses a document type declaration', async ({ baseURL }, testInfo) => {
  const out = (name: string): string => testInfo.outputPath(name);
  const plain = await cli(testInfo, 'scan', '--sitemap', `${baseURL}/_ci/sitemap.xml`, '--checks', 'noop');
  expect(plain.code).toBe(0);
  const report = JSON.parse(plain.stdout) as RunReport;
  // The entity in the second address is decoded; the entry on another origin is left out, and said.
  expect(report.pages.map((page) => page.a11yVision.requestedUrl)).toEqual([`${baseURL}/noop/basic.html`, `${baseURL}/focus-indicator/outline-none.html?a=1&b=2`]);
  expect(report.a11yVision.input).toEqual({ otherOrigin: 1, overLimit: 0, duplicates: 0 });
  expect(plain.stderr).toContain('1 entr(y/ies) of the sitemap');
  expect(plain.stderr).toContain('--any-origin');

  // With --any-origin the other entry is tried, cannot be reached, and the run says so.
  const any = await cli(testInfo, 'scan', '--sitemap', `${baseURL}/_ci/sitemap.xml`, '--checks', 'noop', '--any-origin', '-o', out('any.json'));
  expect(any.code).toBe(2);
  expect((await json<RunReport>(out('any.json'))).a11yVision.errors.map((error) => error.url)).toEqual(['http://other-origin.invalid/page.html']);

  // An index: both sitemaps of this origin are read (one of them gzip), the one elsewhere is not, and a page in both is scanned once.
  const index = await cli(testInfo, 'scan', '--sitemap', `${baseURL}/_ci/sitemap-index.xml`, '--checks', 'noop');
  expect(index.code).toBe(0);
  const indexed = JSON.parse(index.stdout) as RunReport;
  expect(indexed.pages.map((page) => new URL(page.a11yVision.requestedUrl!).pathname)).toEqual(['/noop/basic.html', '/focus-indicator/outline-none.html', '/focus-indicator/good-outline.html']);
  expect(indexed.a11yVision.input).toMatchObject({ duplicates: 1 });

  // The limit of pages: the sitemap is cut, the cut is said and is in the report.
  const cut = await cli(testInfo, 'scan', '--sitemap', `${baseURL}/_ci/sitemap-index.xml`, '--checks', 'noop', '--max-urls', '1');
  expect(cut.code).toBe(0);
  expect((JSON.parse(cut.stdout) as RunReport).pages).toHaveLength(1);
  expect(cut.stderr).toContain('were NOT scanned');

  const xxe = await cli(testInfo, 'scan', '--sitemap', `${baseURL}/_ci/sitemap-xxe.xml`, '--checks', 'noop');
  expect(xxe.code).toBe(2);
  expect(xxe.stdout).toBe('');
  expect(xxe.stderr).toContain('document type declaration');
  expect(xxe.stderr).not.toContain('root:');

  // From a file, gzip or not; and a page that is not a sitemap is an error, not an empty run.
  const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${baseURL}/noop/basic.html</loc></url></urlset>`;
  await writeFile(out('sitemap.xml.gz'), gzipSync(xml));
  const fromFile = await cli(testInfo, 'scan', '--sitemap', out('sitemap.xml.gz'), '--checks', 'noop');
  expect(fromFile.code).toBe(0);
  expect((JSON.parse(fromFile.stdout) as RunReport).pages).toHaveLength(1);
  const notOne = await cli(testInfo, 'scan', '--sitemap', `${baseURL}/noop/basic.html`);
  expect(notOne.code).toBe(2);
  expect(notOne.stderr).toContain('Not a sitemap this tool reads');
  expect((await cli(testInfo, 'scan', '--sitemap', `${baseURL}/_ci/nothing.xml`)).stderr).toContain('HTTP status 404');
});

test('baseline: written, compared, only a new fail breaks the build, and a file that cannot be read is an error', async ({ baseURL }, testInfo) => {
  const out = (name: string): string => testInfo.outputPath(name);
  const one = `${baseURL}/focus-indicator/outline-none.html`;
  const two = `${baseURL}/focus-indicator/low-contrast-outline.html`;
  const file = out('baseline.json');
  const common = ['--checks', 'focus-indicator', '--baseline', file];

  // No file yet: an error, not a run where everything is new or nothing is.
  const missing = await cli(testInfo, 'scan', one, ...common);
  expect(missing.code).toBe(2);
  expect(missing.stdout).toBe('');
  expect(missing.stderr).toContain('does not exist');
  expect(missing.stderr).toContain('--update-baseline');

  // Written from a run over one page: the run then has nothing new.
  const written = await cli(testInfo, 'scan', `${one}#top`, '--urls', await (async () => (await writeFile(out('one.txt'), `${one}\n`), out('one.txt')))(), ...common, '--update-baseline');
  expect(written.code).toBe(0);
  // Two addresses, one page: its two failures are found twice and recorded once.
  expect(written.stderr).toContain('Findings: 4 fail (0 new, 4 in the baseline)');
  expect(written.stderr).toContain('Baseline: 2 entries added.');
  const first = await readFile(file, 'utf8');
  const baseline = JSON.parse(first) as { version: number; tool: string; urlKey: unknown; pages: { url: string; findings: { id: string; check: string; rule: string; sc: string; frame: string; selector: string; signature: string }[] }[] };
  expect(baseline.version).toBe(2);
  expect(baseline.urlKey).toEqual({ stripFragment: true, sortQuery: false, stripTrailingSlash: false, dropQueryParams: [] });
  // The address with a fragment and the one without are one page.
  expect(baseline.pages).toEqual([
    {
      url: one,
      findings: [
        expect.objectContaining({ check: 'focus-indicator', rule: 'focus-indicator/no-visible-change', sc: '2.4.7', selector: '#none-button', signature: expect.stringMatching(/^button\|\|[0-9a-f]{16}$/) }),
        expect.objectContaining({ selector: '#none-link', signature: expect.stringMatching(/^a\|\|[0-9a-f]{16}$/) }),
      ],
    },
  ]);
  expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/);

  // Compared, alone: exit 0, the fails are still there, in violations, marked, in every report.
  const same = await cli(testInfo, 'scan', one, ...common, '--html', out('same.html'), '--sarif', out('same.sarif'));
  expect(same.code).toBe(0);
  const report = JSON.parse(same.stdout) as PageReport;
  expect(report.violations[0]!.nodes.map((entry) => entry.baseline)).toEqual(['baselined', 'baselined']);
  expect(failsOf(report).map((finding) => finding.baseline)).toEqual(['baselined', 'baselined']);
  expect(report.a11yVision.baseline).toEqual({ new: 0, baselined: 2, stale: 0, notScanned: 0, unverified: 0, added: 0, pruned: 0 });
  expect(same.stderr).toContain('Exit code 0: no "fail" finding that the baseline does not record.');
  const html = await readFile(out('same.html'), 'utf8');
  expect(html.match(/<span class="verdict">In the baseline<\/span>/g)).toHaveLength(2);
  expect(html).toContain('they are still failures');
  expect(html).not.toMatch(/\bpass(es|ed)?\b/i);
  const sarif = await json<Sarif>(out('same.sarif'));
  expect(sarifErrors(sarif)).toEqual([]);
  expect(sarif.runs[0]!.results.filter((result) => result.level === 'error').map((result) => result.baselineState)).toEqual(['unchanged', 'unchanged']);
  // Comparing does not write the file.
  expect(await readFile(file, 'utf8')).toBe(first);

  // A second page with failures of its own: those are new, the run exits 1, and the first page stays recorded.
  const both = await cli(testInfo, 'scan', one, two, ...common, '--sarif', out('both.sarif'));
  expect(both.code).toBe(1);
  const run2 = JSON.parse(both.stdout) as RunReport;
  expect(failsOf(run2.pages[0]!).every((finding) => finding.baseline === 'baselined')).toBe(true);
  expect(failsOf(run2.pages[1]!).length).toBeGreaterThan(0);
  expect(failsOf(run2.pages[1]!).every((finding) => finding.baseline === 'new')).toBe(true);
  expect(run2.a11yVision.baseline).toMatchObject({ new: failsOf(run2.pages[1]!).length, baselined: 2 });
  expect((await json<Sarif>(out('both.sarif'))).runs[0]!.results.filter((result) => result.level === 'error').map((result) => result.baselineState)).toContain('new');

  // Updating from the second page alone adds to the file and keeps what is there for the first.
  const added = await cli(testInfo, 'scan', two, ...common, '--update-baseline');
  expect(added.code).toBe(0);
  const after = JSON.parse(await readFile(file, 'utf8')) as typeof baseline;
  expect(after.pages.map((page) => page.url)).toEqual([two, one].sort());
  expect((await cli(testInfo, 'scan', one, two, ...common)).code).toBe(0);
  // Written twice from the same pages, the file is the same, byte for byte.
  const again = await readFile(file, 'utf8');
  await cli(testInfo, 'scan', two, one, ...common, '--update-baseline');
  expect(await readFile(file, 'utf8')).toBe(again);

  // Entries that no longer occur: counted, kept, and removed only with --prune-baseline. Entries of a page that was not scanned stay.
  const stale = { ...after, pages: after.pages.map((page) => (page.url === one ? { ...page, findings: [...page.findings, { id: '0000000000000000', check: 'focus-indicator', rule: 'focus-indicator/no-visible-change', sc: '2.4.7', frame: '', selector: '#gone', signature: '' }] } : page)) };
  await writeFile(file, `${JSON.stringify(stale, null, 2)}\n`);
  const kept = await cli(testInfo, 'scan', one, ...common);
  expect(kept.code).toBe(0);
  expect((JSON.parse(kept.stdout) as PageReport).a11yVision.baseline).toMatchObject({ stale: 1, pruned: 0, notScanned: after.pages.find((page) => page.url === two)!.findings.length });
  expect(kept.stderr).toContain('1 entry no longer occurs on the scanned pages (--prune-baseline removes them)');
  expect(await readFile(file, 'utf8')).toContain('#gone');
  const pruned = await cli(testInfo, 'scan', one, ...common, '--prune-baseline');
  expect(pruned.code).toBe(0);
  expect(pruned.stderr).toContain('Baseline: 1 entry removed;');
  expect(await readFile(file, 'utf8')).toBe(again);

  // An entry for the same element under another rule covers nothing.
  const otherRule = { ...after, pages: after.pages.map((page) => ({ ...page, findings: page.findings.map((entry) => ({ ...entry, rule: 'focus-indicator/low-contrast' })) })) };
  await writeFile(file, JSON.stringify(otherRule));
  expect((await cli(testInfo, 'scan', one, ...common)).code).toBe(1);

  // An entry for the same selector and another element covers nothing either.
  const otherElement = { ...after, pages: after.pages.map((page) => ({ ...page, findings: page.findings.map((entry) => ({ ...entry, signature: 'button||0000000000000000' })) })) };
  await writeFile(file, JSON.stringify(otherElement));
  expect((await cli(testInfo, 'scan', one, ...common)).code).toBe(1);

  // A file that cannot be used: exit 2, nothing on stdout, whatever the flags, and it is not overwritten.
  for (const [content, said] of [
    ['{ "version": 2, "pages": [', 'not valid JSON'],
    [JSON.stringify({ ...after, version: 0 }), 'format version 0'],
    // The format before this one: refused with the reason, not read as if nothing were recorded.
    [JSON.stringify({ ...after, version: 1 }), 'format version 1, and this version of a11y-vision reads version 2 (an older format does not record which element'],
    [JSON.stringify({ ...after, version: 3 }), 'format version 3'],
    [JSON.stringify({ version: 2, pages: [] }), '"urlKey" settings are missing'],
    [JSON.stringify({ ...after, pages: after.pages.map((page) => ({ ...page, findings: page.findings.map(({ signature: _signature, ...entry }) => entry) })) }), 'lacks "id", "check", "rule", "sc", "frame", "selector" or "signature"'],
    ['[]', 'does not hold a JSON object'],
    ['', 'not valid JSON'],
  ] as const) {
    await writeFile(file, content);
    for (const flags of [[], ['--update-baseline'], ['--prune-baseline']]) {
      const broken = await cli(testInfo, 'scan', one, ...common, ...flags);
      expect(broken.code, said).toBe(2);
      expect(broken.stdout).toBe('');
      expect(broken.stderr).toContain(said);
      expect(broken.stderr).toContain('Nothing was scanned');
    }
    expect(await readFile(file, 'utf8')).toBe(content);
  }
  expect((await cli(testInfo, 'scan', one, '--update-baseline')).code).toBe(2);
});

test('--storage-state scans a signed-in page and keeps the session out of everything that is written', async ({ baseURL }, testInfo) => {
  const out = (name: string): string => testInfo.outputPath(name);
  const url = `${baseURL}/_ci/private.html`;
  // Without the session the page answers 401: not scanned, and not a clean scan.
  const anonymous = await cli(testInfo, 'scan', url);
  expect(anonymous.code).toBe(2);
  expect(anonymous.stderr).toContain('HTTP status 401');

  const state = out('state.json');
  await writeFile(state, JSON.stringify({ cookies: [{ name: 'e2e_session', value: SESSION, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] }));
  const signedIn = await cli(testInfo, 'scan', url, `${baseURL}/noop/basic.html`, '--storage-state', state, '--html', out('report.html'), '--sarif', out('report.sarif'), '--sarif-include-info', '--crops', out('crops'), '--baseline', out('baseline.json'), '--update-baseline');
  expect(signedIn.code).toBe(0);
  const report = JSON.parse(signedIn.stdout) as RunReport;
  expect(failsOf(report.pages[0]!).map((finding) => finding.selector).sort()).toEqual(['#none-button', '#none-link']);
  // The page shows the value of its session in its text, and a check reads that text: it is replaced before anything is written.
  expect(signedIn.stdout).toContain('Session [redacted]');
  for (const text of [signedIn.stdout, signedIn.stderr, await readFile(out('report.html'), 'utf8'), await readFile(out('report.sarif'), 'utf8'), await readFile(out('baseline.json'), 'utf8')]) {
    expect(text).not.toContain(SESSION);
    expect(text).not.toContain('e2e_session');
  }
  expect(sarifErrors(await json(out('report.sarif')))).toEqual([]);

  // A file that is not a storage state: an error that names the file and shows nothing of it.
  await writeFile(out('broken.json'), `{"cookies":[{"value":"${SESSION}"`);
  await writeFile(out('other.json'), JSON.stringify({ cookies: SESSION }));
  for (const file of [out('broken.json'), out('other.json'), out('missing.json')]) {
    const refused = await cli(testInfo, 'scan', url, '--storage-state', file);
    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('storage state file');
    expect(refused.stderr).not.toContain(SESSION);
  }
});

test('the script of the GitHub Action takes its inputs from the environment and cannot be made to run anything else', async ({ baseURL }, testInfo) => {
  const cwd = testInfo.outputDir;
  await mkdir(join(cwd, 'a11y'), { recursive: true });
  await writeFile(join(cwd, 'a11y', 'urls.txt'), `${baseURL}/focus-indicator/outline-none.html\n${baseURL}/noop/basic.html\n`);
  const env = { GITHUB_OUTPUT: join(cwd, 'github-output.txt'), GITHUB_STEP_SUMMARY: join(cwd, 'summary.md') };
  const outputs = async (): Promise<Record<string, string>> => Object.fromEntries((await readFile(env.GITHUB_OUTPUT, 'utf8')).trim().split('\n').slice(-5).map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string]));

  // First run: no baseline yet, so the two failures are new.
  const first = await node(actionScript, [], cwd, { ...env, INPUT_URLS_FILE: 'a11y/urls.txt', INPUT_CHECKS: 'focus-indicator' });
  expect(first.code).toBe(0);
  expect(await outputs()).toEqual({
    'exit-code': '1',
    'json-file': join('a11y-vision-report', 'report.json'),
    'html-file': join('a11y-vision-report', 'report.html'),
    'sarif-file': join('a11y-vision-report', 'report.sarif'),
    'crops-dir': join('a11y-vision-report', 'crops'),
  });
  const sarif = await json<Sarif>(join(cwd, 'a11y-vision-report', 'report.sarif'));
  expect(sarifErrors(sarif)).toEqual([]);
  // Attached to the list of addresses, which is a file of the repository, on the line of the page.
  expect(sarif.runs[0]!.results[0]!.locations[0]!.physicalLocation).toMatchObject({ artifactLocation: { uri: 'a11y/urls.txt' }, region: { startLine: 1 } });
  expect((await json<RunReport>(join(cwd, 'a11y-vision-report', 'report.json'))).pages).toHaveLength(2);
  const summary = await readFile(env.GITHUB_STEP_SUMMARY, 'utf8');
  expect(summary).toContain('- 2 pages scanned.');
  expect(summary).toContain('not a statement of conformance');
  expect(summary).not.toContain(baseURL!);

  // Inline addresses and another output directory.
  const inline = await node(actionScript, [], cwd, { ...env, INPUT_URLS: `${baseURL}/noop/basic.html\n  ${baseURL}/focus-indicator/good-outline.html`, INPUT_CHECKS: 'noop', INPUT_OUTPUT_DIR: 'out dir' });
  expect(inline.code).toBe(0);
  expect((await outputs())['exit-code']).toBe('0');
  expect((await json<RunReport>(join(cwd, 'out dir', 'report.json'))).pages).toHaveLength(2);

  // Inputs that try to be options or commands are values, or refused.
  const marker = join(cwd, 'pwned');
  for (const hostile of [
    { INPUT_URLS: `--update-baseline ${baseURL}/noop/basic.html` },
    { INPUT_URLS: `${baseURL}/noop/basic.html`, INPUT_CHECKS: `noop; node -e "require('fs').writeFileSync('pwned','')"` },
    { INPUT_URLS: `${baseURL}/noop/basic.html`, INPUT_CHECKS: '$(touch pwned)' },
    { INPUT_URLS: `${baseURL}/noop/basic.html`, INPUT_BASELINE: '--update-baseline' },
    { INPUT_URLS: `${baseURL}/noop/basic.html`, INPUT_MAX_URLS: '1 --update-baseline' },
    {},
  ]) {
    const attempt = await node(actionScript, [], cwd, { ...env, INPUT_OUTPUT_DIR: 'hostile', ...hostile });
    const code = attempt.code === 0 ? (await outputs())['exit-code'] : String(attempt.code);
    expect(code, JSON.stringify(hostile)).toBe('2');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(cwd, '--update-baseline'))).toBe(false);
  }
  // A scan that stopped before it wrote a report names no report.
  expect((await outputs())['sarif-file'] ?? '').toBe('');
});

test('the workflows pin every action to a commit and put no expression into a shell command', async () => {
  for (const file of ['action.yml', '.github/workflows/ci.yml']) {
    const text = await readFile(join(root, file), 'utf8');
    const uses = [...text.matchAll(/^\s*(?:- )?uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length, file).toBeGreaterThan(0);
    for (const [, ref, rest] of uses) {
      expect(ref, file).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      expect(rest, `${file}: ${ref}`).toMatch(/^ # v\d+\.\d+\.\d+$/);
    }
    // In a `run:` block, and in a `run:` on one line, nothing is interpolated by GitHub: values come through `env:`.
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      const run = /^(\s*)(?:- )?run:\s*(.*)$/.exec(line);
      if (!run) return;
      const indent = run[1]!.length;
      const block = [run[2]!];
      for (let next = index + 1; next < lines.length && (lines[next]!.trim() === '' || lines[next]!.search(/\S/) > indent); next++) block.push(lines[next]!);
      expect(block.join('\n'), `${file}:${index + 1}`).not.toContain('${{');
    });
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/pull_request_target/);
  }
  // The action: no upload to code scanning from a pull request of a fork, which has no permission for
  // it, and the step that sets the outcome of the job runs whatever happened before it.
  const action = await readFile(join(root, 'action.yml'), 'utf8');
  const step = (name: string): string => new RegExp(`^ {4}- name: ${name}\\n((?: {6}.*\\n| *\\n)*)`, 'm').exec(action)?.[1] ?? '';
  expect(step('Upload SARIF to code scanning')).toContain("github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository");
  expect(step('SARIF upload skipped')).toContain('github.event.pull_request.head.repo.full_name != github.repository');
  expect(step('Result')).toMatch(/^ {6}if: always\(\)$/m);
  const ci = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8');
  expect(ci).toMatch(/^permissions:\n {2}contents: read\n/m);
  expect(ci).toContain('persist-credentials: false');
});
