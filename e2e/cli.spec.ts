import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';

const run = promisify(execFile);
const bin = fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url));

interface Report {
  timestamp: string;
  violations: { id: string; tags: string[]; nodes: { target: string[] }[] }[];
  incomplete: unknown[];
  a11yVision: {
    findings: { check: string; status: string; selector: string; evidence: { crops: string[] } }[];
  };
}

async function cli(...args: string[]) {
  try {
    const { stdout, stderr } = await run(process.execPath, [bin, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

test('scan prints an axe-shaped JSON report and exits 0 when nothing fails', async ({ baseURL }) => {
  const { code, stdout } = await cli('scan', `${baseURL}/noop/basic.html`, '--checks', 'noop');
  expect(code).toBe(0);
  const report = JSON.parse(stdout) as Report;
  expect(report.violations).toEqual([]);
  expect(report.a11yVision.findings).toEqual([
    expect.objectContaining({ check: 'noop', status: 'info', selector: 'html' }),
  ]);
});

test('scan --output writes the report to a file', async ({ baseURL }, testInfo) => {
  const file = testInfo.outputPath('report.json');
  const { code, stdout } = await cli('scan', `${baseURL}/noop/basic.html`, '--checks', 'noop', '--output', file);
  expect(code).toBe(0);
  expect(stdout).toBe('');
  const report = JSON.parse(await readFile(file, 'utf8')) as Report;
  expect(report.a11yVision.findings).toHaveLength(1);
});

test('the default check is focus-indicator: a fail exits 1 and lands in violations', async ({ baseURL }) => {
  const { code, stdout } = await cli('scan', `${baseURL}/focus-indicator/outline-none.html`);
  expect(code).toBe(1);
  const report = JSON.parse(stdout) as Report;
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toMatchObject({ id: 'focus-indicator/no-visible-change', tags: ['wcag247'] });
  expect(report.violations[0]!.nodes.map((node) => node.target[0]).sort()).toEqual(['#none-button', '#none-link']);
});

test('likely findings do not fail the run and land in incomplete', async ({ baseURL }) => {
  const { code, stdout } = await cli('scan', `${baseURL}/focus-indicator/text-input-caret-only.html`);
  expect(code).toBe(0);
  const report = JSON.parse(stdout) as Report;
  expect(report.violations).toEqual([]);
  expect(report.incomplete).toHaveLength(1);
});

test('scan --html and --crops write the evidence', async ({ baseURL }, testInfo) => {
  const html = testInfo.outputPath('out', 'report.html');
  const crops = testInfo.outputPath('out', 'crops');
  const { code, stdout } = await cli(
    'scan',
    `${baseURL}/focus-indicator/low-contrast-outline.html`,
    '--html',
    html,
    '--crops',
    crops,
  );
  expect(code).toBe(1);

  const report = JSON.parse(stdout) as Report;
  const ids = report.a11yVision.findings.flatMap((finding) => finding.evidence.crops);
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    const png = await readFile(`${crops}/${id}`);
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  }
  expect((await readdir(`${crops}/focus-indicator`)).length).toBe(new Set(ids).size);

  const page = await readFile(html, 'utf8');
  expect(page).toContain('focus-indicator/low-contrast');
  expect(page).toContain('1.67:1');
  expect(page).toContain('data:image/png;base64,');
});

test('two separate processes give the same report', async ({ baseURL }) => {
  const url = `${baseURL}/focus-indicator/gradient-background.html`;
  const strip = (stdout: string): unknown => ({ ...(JSON.parse(stdout) as Report), timestamp: '' });
  const first = await cli('scan', url);
  const second = await cli('scan', url);
  expect(strip(second.stdout)).toEqual(strip(first.stdout));
});

test('usage errors exit 2', async () => {
  expect((await cli()).code).toBe(2);
  expect((await cli('scan', 'not a url')).code).toBe(2);
  expect((await cli('scan', 'http://127.0.0.1:1/', '--checks', 'nope')).code).toBe(2);
});

test('an unreachable page exits 2', async () => {
  const { code, stderr } = await cli('scan', 'http://127.0.0.1:1/');
  expect(code).toBe(2);
  expect(stderr).toContain('Scan failed');
});
