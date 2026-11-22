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

async function cli(testInfo: TestInfo, args: string[], env: Record<string, string> = {}) {
  // Its own working directory: the default cache file is relative to it.
  const cwd = testInfo.outputPath('cwd');
  await mkdir(cwd, { recursive: true });
  try {
    const { stdout, stderr } = await run(process.execPath, [bin, ...args], { maxBuffer: 64 * 1024 * 1024, cwd, env: cleanEnv(env) });
    return { code: 0, stdout, stderr, cwd };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr, cwd };
  }
}

const parse = (stdout: string): Report => JSON.parse(stdout) as Report;
const withoutTime = (stdout: string): unknown => ({ ...parse(stdout), timestamp: '' });
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
  // Two candidates went down to info, none became a fail: the exit code is that of deterministic code.
  expect(judged.code).toBe(0);
  const after = parse(judged.stdout);
  expect(after.violations).toEqual([]);
  const status = Object.fromEntries(candidates(after).map((finding) => [finding.selector, finding.status]));
  expect(status).toEqual({
    '#br-title': 'likely',
    '#div-title': 'likely',
    '#p-bold': 'likely',
    '#presentational': 'likely',
    '#question': 'info',
    '#same-as-h3': 'likely',
    '#span-block': 'info',
  });
  expect(after.incomplete).toEqual([expect.objectContaining({ id: 'headings/unmarked-heading' })]);
  expect(after.incomplete[0]!.nodes).toHaveLength(5);

  for (const finding of candidates(after)) {
    const original = before.a11yVision.findings.find((entry) => entry.selector === finding.selector)!;
    // Same id, same evidence, the message of deterministic code with a sentence added.
    expect(finding.id).toBe(original.id);
    expect(finding.evidence).toEqual(original.evidence);
    expect(finding.message.startsWith(original.message)).toBe(true);
    expect(finding.ai).toMatchObject({ provider: 'Mock endpoint', model: 'some-vision-model', promptVersion: 'p1/headings-1', statusBefore: 'likely', inputs: 'text+image', confidence: 'high' });
  }
  const question = candidates(after).find((finding) => finding.selector === '#question')!;
  expect(question).toMatchObject({ rule: 'headings/heading-candidate', ai: { verdict: 'no', votes: ['no', 'no'], rationale: 'It is a question put to the reader, not the title of a section.' } });
  expect(question.message).toContain('Lowered from likely to info');
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
  expect(judged.stderr).toBe(
    'Model some-vision-model (Mock endpoint): 7 candidate(s), 7 judged with 14 call(s), 0 from the cache, 0 left out by the limit of calls, 2 status change(s).\n',
  );

  const page = await readFile(html, 'utf8');
  expect(page).toContain('<dt>Model</dt><dd>some-vision-model (Mock endpoint), prompt p1/headings-1</dd>');
  expect(page).toContain('<dt>Model verdict</dt><dd>no, high confidence, from the text and the capture</dd>');
  expect(page).toContain('<dt>Status without the model</dt><dd>likely</dd>');
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

  // An unchanged page is not judged again: the cache answers, and the report is the same.
  const again = await cli(testInfo, args, { [KEY_ENV]: KEY });
  expect(again.code).toBe(0);
  expect(mock.requests).toHaveLength(14);
  expect(withoutTime(again.stdout)).toEqual(withoutTime(judged.stdout));
  expect(again.stderr).toContain('0 judged with 0 call(s), 7 from the cache');

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
  expect(candidates(parse(on.stdout)).every((finding) => finding.ai?.verdict === 'yes' && finding.status === 'likely')).toBe(true);
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
  expect(candidates(deadReport).map((finding) => [finding.status, finding.ai?.problems])).toEqual(Array(7).fill(['likely', ['network']]));
  expect(dead.stderr).toContain('failed calls: network: 7');
  mock = await startMockModel();
});

test('a provider that cannot be used stops the run before anything is scanned or sent', async ({ baseURL }, testInfo) => {
  const url = `${baseURL}/headings/unmarked-headings.html`;
  const remote = await cli(testInfo, ['scan', url, '--ai-base-url', 'https://models.example.com/v1', '--ai-model', 'm']);
  expect(remote.code).toBe(2);
  expect(remote.stdout).toBe('');
  expect(remote.stderr).toContain('models.example.com, which is not this machine');
  expect(remote.stderr).toContain('--ai-allow-remote');

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
  for (const option of ['--ai-base-url', '--ai-model', '--ai-key-env', '--ai-allow-remote', '--ai-text-only', '--ai-cache', '--no-ai-cache', '--no-ai', '--config', 'A11Y_VISION_AI_BASE_URL']) {
    expect(help.stdout).toContain(option);
  }
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
  expect(second.result.findings).toEqual(first.result.findings);
  expect(second.adjudication).toMatchObject({ judged: 0, cached: 2, calls: 0 });
});
