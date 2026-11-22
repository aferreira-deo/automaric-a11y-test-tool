import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';

const run = promisify(execFile);
const bin = fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url));

interface Report {
  violations: unknown[];
  a11yVision: { findings: { check: string; status: string; selector: string }[] };
}

async function cli(...args: string[]) {
  try {
    const { stdout, stderr } = await run(process.execPath, [bin, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

test('scan prints an axe-shaped JSON report and exits 0', async ({ baseURL }) => {
  const { code, stdout } = await cli('scan', `${baseURL}/noop/basic.html`);
  expect(code).toBe(0);
  const report = JSON.parse(stdout) as Report;
  expect(report.violations).toEqual([]);
  expect(report.a11yVision.findings).toEqual([
    expect.objectContaining({ check: 'noop', status: 'info', selector: 'html' }),
  ]);
});

test('scan --output writes the report to a file', async ({ baseURL }, testInfo) => {
  const file = testInfo.outputPath('report.json');
  const { code, stdout } = await cli('scan', `${baseURL}/noop/basic.html`, '--output', file);
  expect(code).toBe(0);
  expect(stdout).toBe('');
  const report = JSON.parse(await readFile(file, 'utf8')) as Report;
  expect(report.a11yVision.findings).toHaveLength(1);
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
