import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { A11yVision } from '@a11y-vision/playwright';
import { expect, test } from '@playwright/test';
import type { TestInfo } from '@playwright/test';
import { completion, dataOf, imageParts, startMockModel, verdict } from './support/mock-model.js';
import type { MockHandler, MockModel, MockRequest } from './support/mock-model.js';

/**
 * The adjudicator layer end to end: the CLI and the Playwright API on heading fixtures, against
 * a mocked OpenAI-compatible endpoint on this machine. No test here calls a real model.
 */

const run = promisify(execFile);
const bin = fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url));
const KEY = 'sk-e2e-0123456789-SECRET';
const KEY_ENV = 'E2E_MODEL_KEY';

interface AiPart {
  provider: string;
  model: string;
  promptVersion: string;
  votes: string[];
  verdict: string;
  confidence: string;
  rationale: string;
  statusBefore: string;
  inputs: string;
  fromCache: boolean;
  problems?: string[];
}

interface ReportFinding {
  id: string;
  rule: string;
  status: string;
  selector: string;
  message: string;
  evidence: { crops: string[]; flags: string[]; values?: Record<string, unknown> };
  ai?: AiPart;
}

interface Report {
  timestamp: string;
  violations: unknown[];
  incomplete: { id: string; nodes: { target: string[] }[] }[];
  a11yVision: { findings: ReportFinding[] };
}

/** Variables that could configure a model by themselves are taken out: a test says what it configures. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('A11Y_VISION_')) delete env[name];
  return { ...env, ...extra };
}

/**
 * stderr without the summary of the run (counts by status, added in M7; e2e/ci.spec.ts tests it):
 * the tests here are about what is said of a model, and about nothing else being said.
 */
function withoutSummary(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !line.startsWith('[a11y-vision] '))
    .join('\n');
}

async function cli(testInfo: TestInfo, args: string[], env: Record<string, string> = {}) {
  // Its own working directory: the default cache file is relative to it.
  const cwd = testInfo.outputPath('cwd');
  await mkdir(cwd, { recursive: true });
  try {
    const { stdout, stderr } = await run(process.execPath, [bin, ...args], { maxBuffer: 64 * 1024 * 1024, cwd, env: cleanEnv(env) });
    return { code: 0, stdout, stderr: withoutSummary(stderr), cwd };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: withoutSummary(failed.stderr), cwd };
  }
}

const parse = (stdout: string): Report => JSON.parse(stdout) as Report;
const withoutTime = (stdout: string): unknown => ({ ...parse(stdout), timestamp: '' });
/** A finding without the one thing that tells a verdict read from the cache from one that was asked for. */
const asAsked = <T extends { message: string; ai?: unknown }>(finding: T): T =>
  finding.ai ? { ...finding, message: finding.message.replace(', read from the cache', ''), ai: { ...(finding.ai), fromCache: false } } : finding;
/** A report without the time of the scan and without what tells cached verdicts from fresh ones. */
function withoutTimeOrCache(stdout: string): unknown {
  // The message of a finding is also in the axe-shaped part of the report, so the text is taken out of all of it.
  return withoutTime(stdout.replaceAll(', read from the cache', '').replaceAll('"fromCache": true', '"fromCache": false'));
}
const about = (request: MockRequest): string => dataOf(request.body)['text'] as string;
const byText =
  (answers: Record<string, ReturnType<typeof verdict>>): MockHandler =>
  (request) =>
    answers[about(request)] ?? verdict('yes');
const candidates = (report: Report): ReportFinding[] => report.a11yVision.findings.filter((finding) => finding.rule !== 'headings/survey');

let mock: MockModel;
test.beforeEach(async () => {
  mock = await startMockModel();
});
test.afterEach(async () => {
  await mock.close();
});

test('the CLI has a model judge the heading candidates, keeps ids and evidence, and never fails on a verdict', async ({ baseURL }, testInfo) => {
  const url = `${baseURL}/headings/unmarked-headings.html`;
  const plain = await cli(testInfo, ['scan', url, '--checks', 'headings']);
  expect(plain.code).toBe(0);
  expect(plain.stderr).toBe('');
  const before = parse(plain.stdout);
  expect(candidates(before).map((finding) => finding.status)).toEqual(Array(7).fill('likely'));
  expect(mock.requests).toHaveLength(0);

  mock.respond(
    byText({
      'Does a question count?': verdict('no', 'high', 'It is a question put to the reader, not the title of a section.'),
      'A span displayed as a block': verdict('no', 'high', 'It reads as a note.'),
    }),
  );
  const html = testInfo.outputPath('out', 'report.html');
  const crops = testInfo.outputPath('out', 'crops');
  const args = ['scan', url, '--checks', 'headings', '--ai-base-url', mock.baseUrl, '--ai-model', 'some-vision-model', '--ai-key-env', KEY_ENV, '--ai-label', 'Mock endpoint'];
  const judged = await cli(testInfo, [...args, '--html', html, '--crops', crops], { [KEY_ENV]: KEY });
  // No candidate left the list on a no, none became a fail: the exit code is that of deterministic code.
  expect(judged.code).toBe(0);
  const after = parse(judged.stdout);
  expect(after.violations).toEqual([]);
  const status = Object.fromEntries(candidates(after).map((finding) => [finding.selector, finding.status]));
  expect(status).toEqual({
    '#br-title': 'likely',
    '#div-title': 'likely',
    '#p-bold': 'likely',
    '#presentational': 'likely',
    '#question': 'likely',
    '#same-as-h3': 'likely',
    '#span-block': 'likely',
  });
  expect(after.incomplete).toEqual([expect.objectContaining({ id: 'headings/unmarked-heading' })]);
  expect(after.incomplete[0]!.nodes).toHaveLength(7);

  for (const finding of candidates(after)) {
    const original = before.a11yVision.findings.find((entry) => entry.selector === finding.selector)!;
    // Same id, same evidence, the message of deterministic code with a sentence added.
    expect(finding.id).toBe(original.id);
    expect(finding.evidence).toEqual(original.evidence);
    expect(finding.message.startsWith(original.message)).toBe(true);
    expect(finding.ai).toMatchObject({ provider: 'Mock endpoint', model: 'some-vision-model', promptVersion: 'p1/headings-1', statusBefore: 'likely', inputs: 'text+image', confidence: 'high', fromCache: false });
  }
  // The no is recorded with the finding, which stays where a tester will see it.
  const question = candidates(after).find((finding) => finding.selector === '#question')!;
  expect(question).toMatchObject({ rule: 'headings/unmarked-heading', ai: { verdict: 'no', votes: ['no', 'no'], rationale: 'It is a question put to the reader, not the title of a section.' } });
  expect(question.message).toContain('It stays likely');
  // The survey is not a candidate: no model was asked about it.
  expect(after.a11yVision.findings.find((finding) => finding.rule === 'headings/survey')!.ai).toBeUndefined();

  // What was sent: two votes per candidate, each with the outlined capture as a PNG data URL, and the key in the header only.
  expect(mock.requests).toHaveLength(14);
  for (const request of mock.requests) {
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request.raw).not.toContain(KEY);
    expect(request.body).toMatchObject({ model: 'some-vision-model', temperature: 0, stream: false });
    const [image] = imageParts(request.body) as { image_url: { url: string } }[];
    expect(image!.image_url.url.startsWith('data:image/png;base64,iVBORw0KGgo')).toBe(true);
  }
  // One line that says a model is asked, which one and on which host; one line of counts. Nothing of it on stdout.
  expect(judged.stderr).toBe(
    'A model is asked: Text and captures of the page go to the model some-vision-model on 127.0.0.1 (this machine). Endpoint from --ai-base-url, model from --ai-model.\n' +
      'Model some-vision-model (Mock endpoint): 7 candidate(s), 7 judged with 14 call(s), 0 from the cache, 0 left out by the limit of calls, 0 status change(s).\n',
  );

  const page = await readFile(html, 'utf8');
  expect(page).toContain('<dt>Model</dt><dd>some-vision-model (Mock endpoint), prompt p1/headings-1</dd>');
  expect(page).toContain('<dt>Model verdict</dt><dd>no, high confidence, from the text and the capture</dd>');
  expect(page).toContain('<dt>Status without the model</dt><dd>likely</dd>');
  // What the model said is beside the status, for a tester who skims the list.
  expect(page.match(/<span class="verdict">Model: no<\/span>/g)).toHaveLength(2);
  expect(page.match(/<span class="verdict">Model: yes<\/span>/g)).toHaveLength(5);
  expect(page).toContain('2 finding(s) under Likely carry &quot;Model: no&quot;');
  // The captures kept as evidence are the ones that were taken, without the outline drawn for the model.
  expect((await readdir(join(crops, 'headings'))).length).toBe(7);

  // The key is in nothing that was written or printed; neither is the name of its variable.
  const cacheFile = join(judged.cwd, '.a11y-vision', 'verdicts.json');
  const cache = await readFile(cacheFile, 'utf8');
  for (const output of [judged.stdout, judged.stderr, page, cache]) {
    expect(output).not.toContain(KEY);
    expect(output).not.toContain(KEY_ENV);
  }
  expect(cache).not.toContain(String(mock.port));

  // An unchanged page is not judged again: the cache answers, the report is the same, and each finding says so.
  const cachedHtml = testInfo.outputPath('out', 'cached.html');
  const again = await cli(testInfo, [...args, '--html', cachedHtml], { [KEY_ENV]: KEY });
  expect(again.code).toBe(0);
  expect(mock.requests).toHaveLength(14);
  expect(withoutTimeOrCache(again.stdout)).toEqual(withoutTime(judged.stdout));
  expect(candidates(parse(again.stdout)).map((finding) => finding.ai!.fromCache)).toEqual(Array(7).fill(true));
  expect(again.stderr).toContain('0 judged with 0 call(s), 7 from the cache');
  expect((await readFile(cachedHtml, 'utf8')).match(/read from the cache \(no model was asked in this run\)/g)).toHaveLength(7);

  // Lowering on a no is there for who wants it, behind an option; the verdicts are the cached ones.
  const lowered = await cli(testInfo, [...args, '--ai-lower-on-disagree'], { [KEY_ENV]: KEY });
  expect(lowered.code).toBe(0);
  expect(mock.requests).toHaveLength(14);
  const loweredReport = parse(lowered.stdout);
  expect(candidates(loweredReport).filter((finding) => finding.status === 'info').map((finding) => finding.selector)).toEqual(['#question', '#span-block']);
  expect(candidates(loweredReport).find((finding) => finding.selector === '#question')).toMatchObject({ rule: 'headings/heading-candidate', ai: { verdict: 'no', statusBefore: 'likely', fromCache: true } });
  expect(candidates(loweredReport).find((finding) => finding.selector === '#question')!.message).toContain('Lowered from likely to info');
  expect(loweredReport.incomplete[0]!.nodes).toHaveLength(5);
  expect(lowered.stderr).toContain('2 status change(s)');
  // The former name of the option does the same.
  const formerName = await cli(testInfo, [...args, '--ai-lower-on-no'], { [KEY_ENV]: KEY });
  expect(formerName.code).toBe(0);
  expect(mock.requests).toHaveLength(14);
  expect(candidates(parse(formerName.stdout)).map((finding) => [finding.selector, finding.status])).toEqual(candidates(loweredReport).map((finding) => [finding.selector, finding.status]));

  // Without the cache, it is.
  const uncached = await cli(testInfo, [...args, '--no-ai-cache'], { [KEY_ENV]: KEY });
  expect(mock.requests).toHaveLength(28);
  expect(withoutTime(uncached.stdout)).toEqual(withoutTime(judged.stdout));
});

test('with no provider nothing is sent and the report is the one of deterministic code', async ({ baseURL }, testInfo) => {
  const url = `${baseURL}/headings/unmarked-headings.html`;
  const plain = await cli(testInfo, ['scan', url, '--checks', 'headings']);
  expect(plain.stdout).not.toContain('"ai"');
  expect(existsSync(join(plain.cwd, '.a11y-vision'))).toBe(false);

  // A provider in the environment, switched off on the command line.
  const off = await cli(testInfo, ['scan', url, '--checks', 'headings', '--no-ai'], {
    A11Y_VISION_AI_BASE_URL: mock.baseUrl,
    A11Y_VISION_AI_MODEL: 'some-model',
    A11Y_VISION_AI_KEY_ENV: KEY_ENV,
    [KEY_ENV]: KEY,
  });
  expect(off.code).toBe(0);
  expect(off.stderr).toBe('');
  expect(withoutTime(off.stdout)).toEqual(withoutTime(plain.stdout));
  // Byte for byte, apart from the time of the scan.
  const stamp = /"timestamp": "[^"]+"/;
  expect(off.stdout.replace(stamp, '')).toBe(plain.stdout.replace(stamp, ''));
  expect(mock.requests).toHaveLength(0);
  expect(existsSync(join(off.cwd, '.a11y-vision'))).toBe(false);

  // The same variables without --no-ai do configure it.
  const on = await cli(testInfo, ['scan', url, '--checks', 'headings', '--no-ai-cache'], {
    A11Y_VISION_AI_BASE_URL: mock.baseUrl,
    A11Y_VISION_AI_MODEL: 'some-model',
    A11Y_VISION_AI_KEY_ENV: KEY_ENV,
    [KEY_ENV]: KEY,
  });
  expect(on.code).toBe(0);
  expect(mock.requests).toHaveLength(14);
  // stdout is the report and nothing else; that a model was asked, which and where, is said on stderr.
  expect(candidates(parse(on.stdout)).every((finding) => finding.ai?.verdict === 'yes' && finding.status === 'likely')).toBe(true);
  expect(on.stderr.split('\n')[0]).toBe(
    'A model is asked: Text and captures of the page go to the model some-model on 127.0.0.1 (this machine). ' +
      'Endpoint from the environment variable A11Y_VISION_AI_BASE_URL, model from the environment variable A11Y_VISION_AI_MODEL.',
  );
  expect(on.stderr).not.toContain(KEY);
  expect(on.stderr).not.toContain(KEY_ENV);
});

test('half a model in the environment is a usage error that names the variable', async ({ baseURL }, testInfo) => {
  const url = `${baseURL}/headings/unmarked-headings.html`;
  const onlyModel = await cli(testInfo, ['scan', url, '--checks', 'headings'], { A11Y_VISION_AI_MODEL: 'left-over-model' });
  expect(onlyModel.code).toBe(2);
  expect(onlyModel.stdout).toBe('');
  expect(onlyModel.stderr).toBe(
    'A11Y_VISION_AI_MODEL is set in the environment, which asks for a model, but no endpoint is given. ' +
      'Set A11Y_VISION_AI_BASE_URL or pass --ai-base-url <url> as well, or pass --no-ai to scan without a model.\n',
  );

  const onlyUrl = await cli(testInfo, ['scan', url, '--checks', 'headings'], { A11Y_VISION_AI_BASE_URL: mock.baseUrl });
  expect(onlyUrl.code).toBe(2);
  expect(onlyUrl.stdout).toBe('');
  expect(onlyUrl.stderr).toContain('A11Y_VISION_AI_BASE_URL is set in the environment');
  expect(onlyUrl.stderr).toContain('Set A11Y_VISION_AI_MODEL or pass --ai-model <name>');

  // The way out the message names works, and gives the plain report.
  const off = await cli(testInfo, ['scan', url, '--checks', 'headings', '--no-ai'], { A11Y_VISION_AI_MODEL: 'left-over-model' });
  expect(off.code).toBe(0);
  expect(off.stderr).toBe('');
  expect(off.stdout).not.toContain('"ai"');
  // The other half given on the command line completes it, and the line says where each came from.
  const completed = await cli(testInfo, ['scan', url, '--checks', 'headings', '--no-ai-cache', '--ai-base-url', mock.baseUrl], { A11Y_VISION_AI_MODEL: 'left-over-model' });
  expect(completed.code).toBe(0);
  expect(completed.stderr).toContain('the model left-over-model on 127.0.0.1 (this machine). Endpoint from --ai-base-url, model from the environment variable A11Y_VISION_AI_MODEL.');
  expect(mock.requests.length).toBeGreaterThan(0);
});

test('output that is not the JSON asked for degrades to unsure, and a dead endpoint does not lose the scan', async ({ baseURL }, testInfo) => {
  const url = `${baseURL}/headings/unmarked-headings.html`;
  const plain = parse((await cli(testInfo, ['scan', url, '--checks', 'headings'])).stdout);
  const config = testInfo.outputPath('config.json');
  await writeFile(config, JSON.stringify({ checks: ['headings'], adjudication: { baseUrl: mock.baseUrl, model: 'm', maxRetries: 0, timeoutMs: 5000 } }));

  mock.respond(() => ({ body: completion(`I think this is a heading. My key is ${KEY}. <script>alert(1)</script>`) }));
  const html = testInfo.outputPath('out', 'invalid.html');
  const invalid = await cli(testInfo, ['scan', url, '--config', config, '--no-ai-cache', '--html', html], { [KEY_ENV]: KEY });
  expect(invalid.code).toBe(0);
  const report = parse(invalid.stdout);
  for (const finding of candidates(report)) {
    const original = plain.a11yVision.findings.find((entry) => entry.id === finding.id)!;
    expect(finding.status).toBe(original.status);
    expect(finding.rule).toBe(original.rule);
    expect(finding.ai).toMatchObject({ verdict: 'unsure', votes: ['unsure'], confidence: 'low', rationale: '', problems: ['invalid-output'], statusBefore: 'likely' });
    expect(finding.message).toContain('gave no verdict');
  }
  expect(invalid.stderr).toContain('failed calls: invalid-output: 7');
  // What the endpoint said in place of an answer goes nowhere.
  const page = await readFile(html, 'utf8');
  for (const output of [invalid.stdout, invalid.stderr, page]) {
    expect(output).not.toContain(KEY);
    expect(output).not.toContain('alert(1)');
  }

  // The endpoint goes away. (The config file names no key: none is sent, none is needed.)
  await mock.close();
  const dead = await cli(testInfo, ['scan', url, '--config', config, '--no-ai-cache']);
  expect(dead.code).toBe(0);
  const deadReport = parse(dead.stdout);
  // It is not asked seven times: after three requests in a row without an answer the rest is left alone, and says so.
  const problems = candidates(deadReport).map((finding) => finding.ai!.problems!.join());
  expect(candidates(deadReport).every((finding) => finding.status === 'likely' && finding.ai!.verdict === 'unsure')).toBe(true);
  expect(problems.filter((problem) => problem === 'network').length).toBeGreaterThanOrEqual(3);
  expect(problems.filter((problem) => problem === 'network').length).toBeLessThanOrEqual(4);
  expect(problems.filter((problem) => problem === 'stopped').length).toBe(7 - problems.filter((problem) => problem === 'network').length);
  expect(dead.stderr).toContain('stopped after 3 call(s) in a row got no answer');
  expect(dead.stderr).toMatch(/[34] candidate\(s\) were not asked about/);
  mock = await startMockModel();
});

test('an endpoint that hangs costs a few timeouts, not one for every candidate', async ({ baseURL }, testInfo) => {
  const url = `${baseURL}/headings/unmarked-headings.html`;
  const config = testInfo.outputPath('config.json');
  await writeFile(config, JSON.stringify({ checks: ['headings'], adjudication: { baseUrl: mock.baseUrl, model: 'm', timeoutMs: 400, maxConsecutiveFailures: 2, concurrency: 1 } }));
  mock.respond(() => ({ hang: true }));
  const html = testInfo.outputPath('out', 'hang.html');
  const hung = await cli(testInfo, ['scan', url, '--config', config, '--html', html]);
  expect(hung.code).toBe(0);
  expect(mock.requests).toHaveLength(2);
  const report = parse(hung.stdout);
  expect(candidates(report).map((finding) => finding.status)).toEqual(Array(7).fill('likely'));
  expect(candidates(report).map((finding) => finding.ai!.problems!.join()).sort()).toEqual(['stopped', 'stopped', 'stopped', 'stopped', 'stopped', 'timeout', 'timeout']);
  expect(hung.stderr).toContain('stopped after 2 call(s) in a row got no answer; 5 candidate(s) were not asked about');
  expect(await readFile(html, 'utf8')).toContain('<dt>Model calls failed</dt><dd>stopped</dd>');
  // Nothing of it is kept: no verdict was given.
  expect(existsSync(join(hung.cwd, '.a11y-vision', 'verdicts.json'))).toBe(false);

  // The time allowed for the page does the same for an endpoint that is only slow.
  mock.requests.length = 0;
  await writeFile(config, JSON.stringify({ checks: ['headings'], adjudication: { baseUrl: mock.baseUrl, model: 'm', pageBudgetMs: 600, concurrency: 1, votes: 1 } }));
  mock.respond(() => ({ ...verdict('yes'), delayMs: 250 }));
  const slow = await cli(testInfo, ['scan', url, '--config', config, '--no-ai-cache']);
  expect(slow.code).toBe(0);
  // How many fit in the time depends on the machine; that it stopped well short of seven does not.
  expect(mock.requests.length).toBeGreaterThanOrEqual(1);
  expect(mock.requests.length).toBeLessThanOrEqual(3);
  expect(slow.stderr).toContain(`stopped when the time allowed for the page ran out; ${7 - mock.requests.length} candidate(s) were not asked about`);
  expect(candidates(parse(slow.stdout)).filter((finding) => finding.ai!.problems?.includes('stopped'))).toHaveLength(7 - mock.requests.length);
});

test('a provider that cannot be used stops the run before anything is scanned or sent', async ({ baseURL }, testInfo) => {
  const url = `${baseURL}/headings/unmarked-headings.html`;
  const remote = await cli(testInfo, ['scan', url, '--ai-base-url', 'https://models.example.com/v1', '--ai-model', 'm']);
  expect(remote.code).toBe(2);
  expect(remote.stdout).toBe('');
  expect(remote.stderr).toContain('models.example.com, which is not this machine');
  expect(remote.stderr).toContain('--ai-allow-remote');

  // Allowed, but over plain http: text, captures and the key would cross the network in the clear.
  const plain = await cli(testInfo, ['scan', url, '--ai-base-url', 'http://models.example.com/v1', '--ai-model', 'm', '--ai-allow-remote', '--ai-key-env', KEY_ENV], { [KEY_ENV]: KEY });
  expect(plain.code).toBe(2);
  expect(plain.stdout).toBe('');
  expect(plain.stderr).toContain('has to be an https URL');
  expect(plain.stderr).not.toContain(KEY);

  // A name that only claims to be this machine. What it resolves to depends on the system: where
  // it does not resolve, or resolves elsewhere, nothing is sent; where it resolves to loopback it is loopback.
  const named = await cli(testInfo, ['scan', url, '--checks', 'headings', '--no-ai-cache', '--ai-base-url', `http://not-this-machine.localhost:${mock.port}/v1`, '--ai-model', 'm']);
  if (named.code === 2) {
    expect(named.stdout).toBe('');
    expect(named.stderr).toMatch(/not-this-machine\.localhost, a name for this machine, but not-this-machine\.localhost (could not be resolved|resolves to \S+, which is not this machine)/);
    expect(mock.requests).toHaveLength(0);
  } else {
    expect(named.code).toBe(0);
    expect(mock.requests.length).toBeGreaterThan(0);
    mock.requests.length = 0;
  }

  const noModel = await cli(testInfo, ['scan', url, '--ai-base-url', mock.baseUrl]);
  expect(noModel.code).toBe(2);
  expect(noModel.stderr).toContain('without a model name');

  const noUrl = await cli(testInfo, ['scan', url, '--ai-model', 'm']);
  expect(noUrl.code).toBe(2);
  expect(noUrl.stderr).toContain('without a base URL');

  const noKey = await cli(testInfo, ['scan', url, '--ai-base-url', mock.baseUrl, '--ai-model', 'm', '--ai-key-env', KEY_ENV]);
  expect(noKey.code).toBe(2);
  expect(noKey.stderr).toContain(`The environment variable ${KEY_ENV}`);

  // The key itself given where the name of its variable belongs: refused, and not repeated.
  const keyAsName = await cli(testInfo, ['scan', url, '--ai-base-url', mock.baseUrl, '--ai-model', 'm', '--ai-key-env', KEY]);
  expect(keyAsName.code).toBe(2);
  expect(keyAsName.stderr).not.toContain(KEY);
  expect(mock.requests).toHaveLength(0);
});

test('--ai-text-only sends no capture, and --help lists the model options', async ({ baseURL }, testInfo) => {
  const { code, stdout } = await cli(testInfo, ['scan', `${baseURL}/headings/unmarked-headings.html`, '--checks', 'headings', '--ai-base-url', mock.baseUrl, '--ai-model', 'm', '--ai-text-only', '--no-ai-cache']);
  expect(code).toBe(0);
  expect(mock.requests).toHaveLength(14);
  for (const request of mock.requests) {
    expect(imageParts(request.body)).toEqual([]);
    expect(request.headers.authorization).toBeUndefined();
  }
  expect(candidates(parse(stdout)).every((finding) => finding.ai?.inputs === 'text')).toBe(true);

  const help = await cli(testInfo, ['--help']);
  for (const option of ['--ai-base-url', '--ai-model', '--ai-key-env', '--ai-allow-remote', '--ai-lower-on-disagree', '--ai-text-only', '--ai-cache', '--no-ai-cache', '--no-ai', '--config', 'A11Y_VISION_AI_BASE_URL']) {
    expect(help.stdout).toContain(option);
  }
  expect(help.stdout).toContain('--ai-lower-on-no      Deprecated name of --ai-lower-on-disagree');
});

test('the Playwright API: a yes raises a candidate that was held back, and only where a judgement counts', async ({ page }) => {
  await page.goto('/headings/false-positives.html');
  const plain = await new A11yVision({ page }).withChecks(['headings']).analyze();
  const colonText = plain.findings.find((finding) => finding.selector === '#colon')!.evidence.values!['text'] as string;

  mock.respond((request) => (about(request) === colonText ? verdict('yes', 'high', 'It introduces what follows.') : verdict('no')));
  const scanner = new A11yVision({ page }).withChecks(['headings']).withAdjudication({ baseUrl: mock.baseUrl, model: 'm', apiKeyEnv: KEY_ENV }, { env: { [KEY_ENV]: KEY } });
  const { result, adjudication } = await scanner.analyzeWithEvidence();
  const find = (selector: string) => result.findings.find((finding) => finding.selector === selector)!;

  expect(find('#colon')).toMatchObject({ status: 'likely', rule: 'headings/unmarked-heading', ai: { verdict: 'yes', statusBefore: 'info' } });
  expect(find('#colon').id).toBe(plain.findings.find((finding) => finding.selector === '#colon')!.id);
  // Held back for what it is, not for how it reads: never sent, whatever a model would say.
  for (const selector of ['#label', '#legend', '#price', '#aria-hidden', '#button']) {
    expect(find(selector).ai).toBeUndefined();
    expect(find(selector).status).toBe('info');
  }
  // Everything else stays where deterministic code put it: a no does not lower an info further.
  for (const finding of result.findings) {
    if (finding.selector === '#colon') continue;
    expect(finding.status).toBe(plain.findings.find((entry) => entry.id === finding.id)!.status);
  }
  expect(result.findings.some((finding) => finding.status === 'fail')).toBe(false);
  expect(adjudication).toMatchObject({ model: 'm', changed: 1, skipped: 0 });
  expect(adjudication!.judged).toBe(adjudication!.candidates);
  expect(JSON.stringify(result)).not.toContain(KEY);

  // Without withAdjudication, the same scanner settings ask nothing.
  const count = mock.requests.length;
  await new A11yVision({ page }).withChecks(['headings']).analyze();
  expect(mock.requests).toHaveLength(count);
});

test('the Playwright API: a candidate without a capture is judged from its text, and a cache file spares the calls', async ({ page }, testInfo) => {
  await page.goto('/headings/covered-footer.html');
  const cacheFile = testInfo.outputPath('cache', 'verdicts.json');
  mock.respond(byText({ Help: verdict('no') }));
  const scan = () => new A11yVision({ page }).withChecks(['headings']).withAdjudication({ baseUrl: mock.baseUrl, model: 'm' }, { cacheFile }).analyzeWithEvidence();
  const first = await scan();
  const judged = first.result.findings.filter((finding) => finding.ai);
  expect(judged.map((finding) => finding.selector).sort()).toEqual(['#footer-about', '#footer-help']);
  for (const finding of judged) {
    expect(finding.ai).toMatchObject({ inputs: 'text', statusBefore: 'likely' });
    expect(finding.evidence.crops).toEqual([]);
    expect(finding.message).toContain('from the text alone');
  }
  expect(mock.requests.length).toBeGreaterThan(0);
  for (const request of mock.requests) expect(imageParts(request.body)).toEqual([]);

  const calls = mock.requests.length;
  const second = await scan();
  expect(mock.requests).toHaveLength(calls);
  expect(second.result.findings.map(asAsked)).toEqual(first.result.findings);
  expect(second.result.findings.filter((finding) => finding.ai).every((finding) => finding.ai!.fromCache)).toBe(true);
  expect(second.adjudication).toMatchObject({ judged: 0, cached: 2, calls: 0 });

  // The file edited by hand, as anyone who can write to it could: every verdict a confident no.
  const stored = JSON.parse(await readFile(cacheFile, 'utf8')) as { version: number; entries: Record<string, unknown> };
  expect(Object.keys(stored.entries)).toHaveLength(2);
  for (const key of Object.keys(stored.entries)) stored.entries[key] = { votes: ['no', 'no'], verdict: 'no', confidence: 'high', rationale: 'Nothing to see here.', inputs: 'text' };
  await writeFile(cacheFile, JSON.stringify(stored));
  const forged = await scan();
  expect(mock.requests).toHaveLength(calls);
  // Read, since it is well formed, and shown as read from the cache; the findings stay on the list.
  for (const selector of ['#footer-about', '#footer-help']) {
    const finding = forged.result.findings.find((entry) => entry.selector === selector)!;
    expect(finding).toMatchObject({ status: 'likely', ai: { verdict: 'no', fromCache: true, statusBefore: 'likely' } });
  }

  // An entry with fewer votes than the settings ask for is not one this tool wrote: the model is asked again.
  for (const key of Object.keys(stored.entries)) stored.entries[key] = { votes: ['no'], verdict: 'no', confidence: 'high', rationale: 'One vote.', inputs: 'text' };
  await writeFile(cacheFile, JSON.stringify(stored));
  const asked = await scan();
  expect(mock.requests.length).toBeGreaterThan(calls);
  expect(asked.adjudication).toMatchObject({ judged: 2, cached: 0 });
  expect(asked.result.findings.filter((finding) => finding.ai).every((finding) => !finding.ai!.fromCache)).toBe(true);
});
