import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { A11yVision } from '@a11y-vision/playwright';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, TestInfo } from '@playwright/test';

/**
 * What a review of M7 found, each with the case that showed it: identity of a baseline entry,
 * pruning on a run that covers less, generated ids in selectors, session values and credentials
 * in what is written, schemes, and origins after a redirect. Through the built CLI and the
 * fixture server on this machine; nothing here reaches another machine.
 */

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const bin = join(root, 'packages/cli/dist/bin.js');

interface Finding {
  id: string;
  check: string;
  rule: string;
  status: string;
  selector: string;
  signature: string;
  message: string;
  baseline?: string;
}
interface BaselineSummary {
  new: number;
  baselined: number;
  stale: number;
  notScanned: number;
  unverified: number;
  added: number;
  pruned: number;
}
interface PageReport {
  url: string;
  violations: { id: string; nodes: { target: string[] }[] }[];
  a11yVision: { findings: Finding[]; requestedUrl?: string; baseline?: BaselineSummary };
}
interface RunReport {
  pages: PageReport[];
  a11yVision: {
    summary: { pages: number; errors: number; fail: number; newFail: number; baselinedFail: number };
    errors: { url: string; message: string }[];
    baseline?: BaselineSummary;
    input?: { otherOrigin: number; overLimit: number; duplicates: number };
  };
}
interface BaselineFile {
  version: number;
  pages: { url: string; findings: { id: string; check: string; rule: string; sc: string; frame: string; selector: string; signature: string }[] }[];
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('A11Y_VISION_') || name.startsWith('INPUT_') || name.startsWith('GITHUB_')) delete env[name];
  return env;
}

async function cli(testInfo: TestInfo, ...args: string[]) {
  await mkdir(testInfo.outputDir, { recursive: true });
  try {
    const { stdout, stderr } = await run(process.execPath, [bin, ...args], { maxBuffer: 64 * 1024 * 1024, cwd: testInfo.outputDir, env: cleanEnv() });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

const json = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
const failsOf = (page: PageReport): Finding[] => page.a11yVision.findings.filter((finding) => finding.status === 'fail');
const entriesOf = (baseline: BaselineFile): number => baseline.pages.reduce((sum, page) => sum + page.findings.length, 0);

/** Pages with a version of their own for this test, and the call that changes it. */
function scope(testInfo: TestInfo, baseURL: string | undefined, request: APIRequestContext) {
  const id = `${testInfo.testId}-${testInfo.repeatEachIndex}-${testInfo.workerIndex}-${Date.now()}`.replace(/[^\w-]/g, '-');
  return {
    url: (name: string): string => `${baseURL}/_ci/s/${id}/${name}`,
    version: async (v: number): Promise<void> => {
      expect((await request.get(`${baseURL}/_ci/s/${id}/set?v=${v}`)).ok()).toBe(true);
    },
  };
}

test('baseline: an entry does not cover another control that fails in the same place', async ({ baseURL, request }, testInfo) => {
  const pages = scope(testInfo, baseURL, request);
  const file = testInfo.outputPath('baseline.json');
  const slot = 'html > body > main > ul > li:nth-of-type(2) > button';

  const written = await cli(testInfo, 'scan', pages.url('mask.html'), pages.url('two.html'), '--baseline', file, '--update-baseline', '-o', testInfo.outputPath('a.json'));
  expect(written.code).toBe(0);
  const first = await json<RunReport>(testInfo.outputPath('a.json'));
  expect(failsOf(first.pages[0]!).map((finding) => finding.selector)).toEqual([slot]);
  const text = await readFile(file, 'utf8');
  const baseline = JSON.parse(text) as BaselineFile;
  expect(baseline.version).toBe(2);
  expect(entriesOf(baseline)).toBe(3);
  for (const entry of baseline.pages.flatMap((page) => page.findings)) {
    expect(Object.keys(entry)).toEqual(['id', 'check', 'rule', 'sc', 'frame', 'selector', 'signature']);
    expect(entry.signature).toMatch(/^button\|[^|]*\|[0-9a-f]{16}$/);
  }
  // What identifies the element is a hash: no text of the page is in the file.
  expect(text).not.toContain('Bravo');
  expect(text).not.toContain('Settings');

  // The same pages again: nothing is new.
  expect((await cli(testInfo, 'scan', pages.url('mask.html'), pages.url('two.html'), '--baseline', file)).code).toBe(0);

  // The control that failed is fixed, and another one fails at the same selector: that one is new.
  await pages.version(2);
  const again = await cli(testInfo, 'scan', pages.url('mask.html'), pages.url('two.html'), '--baseline', file, '-o', testInfo.outputPath('b.json'));
  expect(again.code).toBe(1);
  const second = await json<RunReport>(testInfo.outputPath('b.json'));
  expect(failsOf(second.pages[0]!).map((finding) => [finding.selector, finding.baseline])).toEqual([[slot, 'new']]);
  expect(failsOf(second.pages[0]!)[0]!.signature).not.toBe(failsOf(first.pages[0]!)[0]!.signature);
  expect(failsOf(second.pages[1]!).every((finding) => finding.baseline === 'baselined')).toBe(true);
  expect(second.a11yVision.baseline).toMatchObject({ new: 1, baselined: 2, stale: 1 });
});

test('baseline: nothing is pruned for a check that did not run, or for a page that ended on another address', async ({ baseURL, request }, testInfo) => {
  const pages = scope(testInfo, baseURL, request);
  const file = testInfo.outputPath('baseline.json');
  const all = [pages.url('mask.html'), pages.url('two.html'), pages.url('app.html')];
  expect((await cli(testInfo, 'scan', ...all, '--baseline', file, '--update-baseline', '-q', '-o', testInfo.outputPath('a.json'))).code).toBe(0);
  const first = await readFile(file, 'utf8');
  const baseline = JSON.parse(first) as BaselineFile;
  expect(baseline.pages.flatMap((page) => page.findings.map((entry) => entry.check)).sort()).toEqual(['focus-indicator', 'focus-indicator', 'focus-indicator', 'icon-contrast']);

  // A run of one check that finds nothing: the entries of the others are not known to be gone.
  const narrow = await cli(testInfo, 'scan', ...all, '--checks', 'headings', '--baseline', file, '--prune-baseline', '-o', testInfo.outputPath('b.json'));
  expect(narrow.code).toBe(0);
  expect(await readFile(file, 'utf8')).toBe(first);
  expect((await json<RunReport>(testInfo.outputPath('b.json'))).a11yVision.baseline).toMatchObject({ stale: 0, pruned: 0, unverified: 4 });
  expect(narrow.stderr).toContain('4 entries were not looked for');
  // The same for an update: it adds, and takes nothing out.
  expect((await cli(testInfo, 'scan', ...all, '--checks', 'headings', '--baseline', file, '--update-baseline', '-q', '-o', testInfo.outputPath('c.json'))).code).toBe(0);
  expect(await readFile(file, 'utf8')).toBe(first);

  // The session is over: the application sends to a sign-in page that answers 200 and has no failure.
  await pages.version(2);
  const expired = await cli(testInfo, 'scan', ...all, '--checks', 'focus-indicator', '--baseline', file, '--prune-baseline', '-o', testInfo.outputPath('d.json'));
  // The control that fails on the first page now is not the one that was recorded.
  expect(expired.code).toBe(1);
  expect(expired.stderr).toContain(`${pages.url('app.html')} ended on ${baseURL}/_ci/sign-in.html`);
  const summary = (await json<RunReport>(testInfo.outputPath('d.json'))).a11yVision.baseline!;
  // Pruned: the entry of the first page, whose check ran and whose page is the one asked for.
  // Kept: the icon entry (its check did not run) and the entry of the page that went elsewhere.
  expect(summary).toMatchObject({ new: 1, baselined: 1, stale: 1, pruned: 1, unverified: 2 });
  const after = await json<BaselineFile>(file);
  expect(after.pages.map((page) => [page.url, page.findings.map((entry) => entry.check)])).toEqual(
    [
      [pages.url('app.html'), ['focus-indicator']],
      [pages.url('two.html'), ['focus-indicator', 'icon-contrast']],
    ].sort(),
  );
  // Only the file is left: it was written beside itself and moved into place.
  expect((await readdir(testInfo.outputDir)).filter((name) => name.startsWith('baseline'))).toEqual(['baseline.json']);
});

test('selectors: generated and content-keyed ids are not used, stable attributes are, and each selector finds its element', async ({ page, baseURL, request }, testInfo) => {
  const pages = scope(testInfo, baseURL, request);
  const expected: [string, string][] = [
    ['html > body > main > div:nth-of-type(1) > button', 'React'],
    ['html > body > main > button:nth-of-type(1)', 'Aria'],
    ['html > body > main > button:nth-of-type(2)', 'Radix'],
    ['html > body > main > button:nth-of-type(3)', 'Headless'],
    ['html > body > main > button:nth-of-type(4)', 'Mui'],
    ['html > body > main > button:nth-of-type(5)', 'Ember'],
    ['html > body > main > button:nth-of-type(6)', 'Item'],
    ['#save', 'Stable'],
    ['button[data-testid="submit-order"]', 'Test id'],
    ['html > body > main > button:nth-of-type(9)', 'Keyed test id'],
    ['input[name="email"]', ''],
    ['button[name="go"]', 'Go'],
    // A name that two controls share is not one element.
    ['html > body > main > p > input:nth-of-type(1)', ''],
    ['html > body > main > p > input:nth-of-type(2)', ''],
    ['div[data-cy="panel"] > button', 'In panel'],
  ];
  const scan = async () => {
    await page.goto(pages.url('ids.html'));
    const result = await new A11yVision({ page }).withChecks(['focus-indicator']).analyze();
    for (const finding of result.findings) {
      expect(await page.locator(finding.selector).count(), finding.selector).toBe(1);
    }
    // The walk as a whole is reported on the document: that finding is about no control.
    return result.findings.filter((finding) => finding.selector !== 'html');
  };
  const first = await scan();
  expect(first.map((finding) => finding.selector).sort()).toEqual(expected.map(([selector]) => selector).sort());
  for (const [selector, text] of expected) expect((await page.locator(selector).innerText()).trim(), selector).toBe(text);

  // Another render: every generated id is another one, and nothing in the findings moved.
  await pages.version(2);
  const second = await scan();
  expect(second.map(({ id, selector, signature }) => ({ id, selector, signature }))).toEqual(first.map(({ id, selector, signature }) => ({ id, selector, signature })));

  // The pattern and the attributes are settings.
  await page.goto(pages.url('ids.html'));
  const custom = await new A11yVision({ page }).options({ checks: ['focus-indicator'], selector: { unstableIdPattern: '^save$', stableAttributes: [] } }).analyze();
  const selectors = custom.findings.map((finding) => finding.selector).filter((selector) => selector !== 'html');
  expect(selectors).not.toContain('#save');
  expect(selectors).toContain('#mui-2');
  expect(selectors).toContain('#mui-92 > button');
  expect(selectors.filter((selector) => selector.includes('['))).toEqual([]);
});

test('baseline on a page whose ids are made from item numbers and whose order changes', async ({ baseURL, request }, testInfo) => {
  const pages = scope(testInfo, baseURL, request);
  const file = testInfo.outputPath('baseline.json');
  const common = [pages.url('hn.html'), '--checks', 'focus-indicator', '--baseline', file];
  expect((await cli(testInfo, 'scan', ...common, '--update-baseline', '-q', '-o', testInfo.outputPath('a.json'))).code).toBe(0);
  const first = await json<PageReport>(testInfo.outputPath('a.json'));
  // The link "new", the search button, and an arrow and a title per item.
  expect(failsOf(first)).toHaveLength(10);
  for (const finding of failsOf(first)) expect(finding.selector).not.toMatch(/\d{3}/);
  expect(failsOf(first).map((finding) => finding.selector)).toContain('button[name="q-go"]');
  expect(failsOf(first).map((finding) => finding.selector)).toContain('#hnmain > tbody > tr:nth-of-type(2) > td > table > tbody > tr:nth-of-type(1) > td:nth-of-type(2) > a');
  // Unchanged page: nothing new.
  expect((await cli(testInfo, 'scan', ...common, '-q', '-o', testInfo.outputPath('b.json'))).code).toBe(0);

  // A new item on top: the others move down one place and the last one leaves the page.
  await pages.version(2);
  const moved = await cli(testInfo, 'scan', ...common, '-o', testInfo.outputPath('c.json'));
  const second = await json<PageReport>(testInfo.outputPath('c.json'));
  const byState = (state: string): Finding[] => failsOf(second).filter((finding) => finding.baseline === state);
  // What does not depend on the items, and the arrows (one template, whatever the item): recorded.
  expect(byState('baselined')).toHaveLength(6);
  expect(byState('baselined').every((finding) => !finding.selector.endsWith('td:nth-of-type(3) > a'))).toBe(true);
  // The titles: each place now holds another link. They are new, and this is the part that churns
  // on a page that reorders: nothing is masked, and the build breaks until the file is updated.
  expect(byState('new')).toHaveLength(4);
  expect(byState('new').every((finding) => finding.selector.endsWith('td:nth-of-type(3) > a'))).toBe(true);
  expect(second.a11yVision.baseline).toMatchObject({ new: 4, baselined: 6, stale: 4 });
  expect(moved.code).toBe(1);
});

test('--storage-state: values of the session are replaced in texts, never in the structure of a report', async ({ baseURL }, testInfo) => {
  const out = (name: string): string => testInfo.outputPath(name);
  const { host, hostname } = new URL(baseURL!);
  const cookie = (name: string, value: string) => ({ name, value, domain: hostname, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' });
  const secrets = ['COOKIESECRETabc', 'TOKENSECRETabcdef', 'PLAINSECRETxyz', 'SPACED SECRET/42', 'SPACED%20SECRET%2F42', 'NESTEDsecretValue'];
  await writeFile(
    out('state.json'),
    JSON.stringify({
      // Two values that are also words of the report format.
      cookies: [cookie('sid', 'COOKIESECRETabc'), cookie('mode', 'findings'), cookie('kind', 'advisory'), cookie('check', 'focus-indicator')],
      origins: [
        {
          origin: `http://${host}`,
          localStorage: [
            { name: 'auth', value: JSON.stringify({ session: { token: 'TOKENSECRETabcdef', inner: JSON.stringify({ deep: 'NESTEDsecretValue' }) } }) },
            { name: 'plain', value: 'PLAINSECRETxyz' },
            { name: 'spaced', value: 'SPACED SECRET/42' },
          ],
        },
      ],
    }),
  );
  const args = ['scan', `${baseURL}/_ci/secret.html`, '--storage-state', out('state.json'), '--baseline', out('baseline.json')];
  const scanned = await cli(testInfo, ...args, '--update-baseline', '-o', out('report.json'), '--html', out('report.html'), '--sarif', out('report.sarif'), '--sarif-include-info');
  expect(scanned.code).toBe(0);

  const texts = { json: await readFile(out('report.json'), 'utf8'), html: await readFile(out('report.html'), 'utf8'), sarif: await readFile(out('report.sarif'), 'utf8'), baseline: await readFile(out('baseline.json'), 'utf8'), stderr: scanned.stderr };
  for (const [name, text] of Object.entries(texts)) for (const secret of secrets) expect(text, `${secret} in ${name}`).not.toContain(secret);

  // The report is still the report: its keys, its statuses and its rule names are untouched.
  const report = JSON.parse(texts.json) as PageReport & Record<string, unknown>;
  expect(Object.keys(report)).toEqual(['testEngine', 'url', 'timestamp', 'violations', 'incomplete', 'passes', 'inapplicable', 'a11yVision']);
  expect(Object.keys(report.a11yVision)).toEqual(['environment', 'findings', 'baseline']);
  expect(report.a11yVision.findings.length).toBeGreaterThan(4);
  for (const finding of report.a11yVision.findings) {
    expect(['fail', 'likely', 'advisory', 'info']).toContain(finding.status);
    expect(['focus-indicator', 'icon-contrast', 'headings', 'lists', 'grouping']).toContain(finding.check);
    expect(finding.rule.startsWith(`${finding.check}/`)).toBe(true);
  }
  expect(report.violations.map((rule) => rule.id)).toEqual(['focus-indicator/no-visible-change']);
  // The texts read from the page are there, with the values replaced.
  const messages = report.a11yVision.findings.map((finding) => finding.message).join('\n');
  expect(messages).toContain('Token [redacted]');
  expect(messages).toContain('Plain [redacted]');
  expect(messages).toContain('Encoded [redacted]');
  expect(failsOf(report).map((finding) => finding.selector)).toContain('#btn-[redacted]');
  expect((JSON.parse(texts.sarif) as { runs: { results: unknown[] }[] }).runs[0]!.results.length).toBeGreaterThan(4);

  // The baseline holds the replaced selector, and the next run finds its entries again.
  expect(texts.baseline).toContain('#btn-[redacted]');
  const again = await cli(testInfo, ...args, '-o', out('again.json'));
  expect(again.code).toBe(0);
  expect((await json<PageReport>(out('again.json'))).a11yVision.baseline).toMatchObject({ new: 0, baselined: 2, stale: 0 });
});

test('credentials and tokens in an address reach the browser and nothing that is written', async ({ baseURL }, testInfo) => {
  const out = (name: string): string => testInfo.outputPath(name);
  const { host } = new URL(baseURL!);
  const withSecrets = `http://e2e-user:e2e-PASSWORD-9999@${host}/_ci/basic-auth.html?token=QUERYTOKEN777&view=full&Access_Token=OTHERTOKEN888`;
  const args = ['scan', withSecrets, `${baseURL}/noop/basic.html`, '--checks', 'focus-indicator', '--baseline', out('baseline.json')];
  const scanned = await cli(testInfo, ...args, '--update-baseline', '-o', out('report.json'), '--html', out('report.html'), '--sarif', out('report.sarif'), '--crops', out('crops'));
  expect(scanned.code).toBe(0);
  const report = await json<RunReport>(out('report.json'));
  // The page behind the credentials was the one that was read.
  expect(failsOf(report.pages[0]!)).toHaveLength(1);
  const shown = `${baseURL}/_ci/basic-auth.html?token=redacted&view=full&Access_Token=redacted`;
  expect(report.pages[0]!.a11yVision.requestedUrl).toBe(shown);
  expect(report.pages[0]!.url).toBe(shown);
  const baseline = await json<BaselineFile>(out('baseline.json'));
  expect(baseline.pages.map((entry) => entry.url)).toEqual([`${baseURL}/_ci/basic-auth.html?view=full`]);

  const written = [scanned.stderr, ...(await Promise.all(['report.json', 'report.html', 'report.sarif', 'baseline.json'].map((name) => readFile(out(name), 'utf8')))), (await readdir(out('crops'))).join('\n')];
  for (const text of written) {
    for (const secret of ['e2e-PASSWORD-9999', 'e2e-user', 'QUERYTOKEN777', 'OTHERTOKEN888']) expect(text).not.toContain(secret);
  }
  // Another token is the same page.
  const again = await cli(testInfo, 'scan', withSecrets.replace('QUERYTOKEN777', 'QUERYTOKEN999'), '--checks', 'focus-indicator', '--baseline', out('baseline.json'), '-o', out('again.json'));
  expect(again.code).toBe(0);
  expect((await json<PageReport>(out('again.json'))).a11yVision.baseline).toMatchObject({ new: 0, baselined: 1 });

  // A wrong password: not scanned, and the password is in no message.
  const wrong = await cli(testInfo, 'scan', `http://e2e-user:WRONG-password-1@${host}/_ci/basic-auth.html`, '--checks', 'focus-indicator');
  expect(wrong.code).toBe(2);
  expect(wrong.stderr).toContain('HTTP status 401');
  expect(wrong.stderr).not.toContain('WRONG-password-1');
});

// eslint-disable-next-line no-empty-pattern -- Playwright wants the fixtures destructured, and this test uses none.
test('scan takes http(s) addresses only, and a file only when that is asked for', async ({}, testInfo) => {
  const local = pathToFileURL(join(root, 'fixtures/noop/basic.html')).href;
  for (const address of [local, 'data:text/html,<button>x</button>', 'view-source:http://127.0.0.1:1/', 'chrome://version', 'javascript:alert(1)', 'ftp://example.test/', 'about:blank']) {
    const refused = await cli(testInfo, 'scan', address, '--checks', 'noop');
    expect(refused.code, address).toBe(2);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('not an http(s) address');
  }
  expect((await cli(testInfo, 'scan', local, '--checks', 'noop')).stderr).toContain('--allow-file-urls');
  const allowed = await cli(testInfo, 'scan', local, '--checks', 'noop', '--allow-file-urls');
  expect(allowed.code).toBe(0);
  expect((JSON.parse(allowed.stdout) as PageReport).url).toBe(local);
  // The switch is for files, and for nothing else.
  expect((await cli(testInfo, 'scan', 'data:text/html,<button>x</button>', '--checks', 'noop', '--allow-file-urls')).code).toBe(2);
});

test('--sitemap: the origin is the one the sitemap was served from, and a page that ends on another origin is not scanned', async ({ baseURL }, testInfo) => {
  const out = (name: string): string => testInfo.outputPath(name);
  const other = baseURL!.replace('127.0.0.1', 'localhost');
  expect(other).not.toBe(baseURL);

  // The sitemap address answers with a redirect to another origin: that origin is the one its entries are held to.
  const redirected = await cli(testInfo, 'scan', '--sitemap', `${baseURL}/_ci/sm-redirect.xml`, '--checks', 'noop', '-o', out('a.json'));
  expect(redirected.code).toBe(0);
  const first = await json<RunReport>(out('a.json'));
  expect(first.pages.map((page) => page.a11yVision.requestedUrl)).toEqual([`${other}/noop/basic.html`]);
  expect(first.a11yVision.input).toMatchObject({ otherOrigin: 1 });
  expect(redirected.stderr).toContain(`on another origin than ${other}`);

  // A page of the sitemap that sends the browser to another origin is not scanned there.
  const left = await cli(testInfo, 'scan', '--sitemap', `${baseURL}/_ci/sm-out.xml`, '--checks', 'focus-indicator', '-o', out('b.json'));
  expect(left.code).toBe(2);
  const second = await json<RunReport>(out('b.json'));
  expect(second.pages.map((page) => page.a11yVision.requestedUrl)).toEqual([`${baseURL}/noop/basic.html`]);
  expect(second.a11yVision.errors).toEqual([{ url: `${baseURL}/_ci/redir-out.html`, message: expect.stringContaining(`ended on another origin (${other})`) }]);
  expect(second.a11yVision.errors[0]!.message).toContain('--any-origin');

  const any = await cli(testInfo, 'scan', '--sitemap', `${baseURL}/_ci/sm-out.xml`, '--checks', 'focus-indicator', '--any-origin', '-o', out('c.json'));
  expect(any.code).toBe(1);
  expect((await json<RunReport>(out('c.json'))).pages.map((page) => page.url)).toEqual([`${baseURL}/noop/basic.html`, `${other}/focus-indicator/outline-none.html`]);
});

test('a sitemap cut at the limit of pages is said in every report', async ({ baseURL }, testInfo) => {
  const out = (name: string): string => testInfo.outputPath(name);
  const cut = await cli(testInfo, 'scan', '--sitemap', `${baseURL}/_ci/sitemap-index.xml`, '--checks', 'noop', '--max-urls', '1', '-o', out('r.json'), '--html', out('r.html'), '--sarif', out('r.sarif'));
  expect(cut.code).toBe(0);
  expect(cut.stderr).toContain('were NOT scanned');
  const report = await json<RunReport>(out('r.json'));
  expect(report.a11yVision.input!.overLimit).toBeGreaterThan(0);
  const count = report.a11yVision.input!.overLimit;
  expect(await readFile(out('r.html'), 'utf8')).toContain(`${count} page(s) of the sitemap were NOT scanned`);
  const sarif = await json<{ runs: { properties: { input?: { overLimit: number } }; invocations: { toolExecutionNotifications: { level: string; message: { text: string } }[] }[] }[] }>(out('r.sarif'));
  expect(sarif.runs[0]!.properties.input).toMatchObject({ overLimit: count });
  expect(sarif.runs[0]!.invocations[0]!.toolExecutionNotifications).toEqual([{ level: 'warning', message: { text: expect.stringContaining(`${count} page(s) of the sitemap were NOT scanned`) } }]);
});
