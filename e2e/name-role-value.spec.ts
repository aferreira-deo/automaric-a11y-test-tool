import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { A11yVision } from '@a11y-vision/playwright';
import type { Finding } from '@a11y-vision/core';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The name-role-value check beyond its manifests: that probing cannot write anything off the
 * page, that the page is put back, what the options change, and the reports.
 */

const run = promisify(execFile);
const bin = fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url));

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [bin, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

const nrv = (page: Page) => new A11yVision({ page }).withChecks(['name-role-value']);
const survey = (findings: Finding[]) => findings.find((finding) => finding.rule === 'name-role-value/survey')!.evidence.values!;
const hits = async (baseURL: string | undefined, session: string): Promise<string[]> => (await (await fetch(`${baseURL}/_nrv/log/${session}`)).json()) as string[];

test.describe('probing is safe', () => {
  test.slow();

  test('a real click on each control writes to the server: the fixture is armed', async ({ page, baseURL }) => {
    const session = `control-${test.info().workerIndex}-${Date.now()}`;
    page.on('dialog', (dialog) => void dialog.accept());
    await page.goto(`/name-role-value/safety.html?s=${session}`);
    // The service worker takes control of the page.
    await page.evaluate(() => navigator.serviceWorker.ready);
    const ids = ['fetch-post', 'xhr-delete', 'beacon', 'keepalive', 'get-api', 'jsonp', 'pixel', 'confirm', 'frame-message', 'sw-message', 'worker', 'websocket', 'push-and-post', 'div-post', 'link-post', 'popup'];
    for (const id of ids) {
      await page.click(`#${id}`);
      await page.waitForTimeout(100);
    }
    await expect
      .poll(async () => (await hits(baseURL, session)).length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(ids.length - 1);
    const recorded = await hits(baseURL, session);
    for (const expected of ['POST write/fetch-post', 'DELETE write/xhr-delete', 'POST write/beacon', 'POST write/keepalive', 'GET write/jsonp', 'GET write/pixel', 'POST write/frame-post', 'POST write/worker', 'GET ws', 'PUT write/div-post', 'GET nav/popup']) {
      expect(recorded, expected).toContain(expected);
    }
  });

  test('a scan that probes the page sends none of it, and puts storage and the address back', async ({ page, baseURL }) => {
    const session = `scan-${test.info().workerIndex}-${Date.now()}`;
    const address = `${baseURL}/name-role-value/safety.html?s=${session}`;
    await page.goto(address);
    await page.evaluate(() => navigator.serviceWorker.ready);
    const { findings } = await nrv(page).analyze();
    const values = survey(findings);
    expect(values['probe']).toBe('safe');
    expect(Number(values['probesDone'])).toBeGreaterThanOrEqual(20);
    expect(values['unsafeRequests']).toBe(0);
    expect(values['popupsClosed']).toBe(0);
    expect(String(values['blockedRequests'])).toContain('POST XHR');
    expect(String(values['guarded'])).toContain('websocket');
    // Writes the page would send after a reload, from what a click had stored, are not sent either.
    await page.waitForTimeout(1500);
    expect(await hits(baseURL, session)).toEqual([]);
    expect(page.url()).toBe(address);
    expect(await page.evaluate(() => [localStorage.getItem('nrv-cart'), document.cookie.includes('nrv-remember')])).toEqual([null, false]);
    // The frame of another origin that was emptied while probing is there again.
    await expect.poll(() => page.frames().some((frame) => frame.url().includes('/_nrv/frame/'))).toBe(true);
  });

  test('the CLI probes the same page and nothing reaches the server', async ({ baseURL }) => {
    const session = `cli-${Date.now()}`;
    const { code, stdout } = await cli('scan', `${baseURL}/name-role-value/safety.html?s=${session}`, '--checks', 'name-role-value');
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as { a11yVision: { findings: Finding[] } };
    expect(Number(survey(report.a11yVision.findings)['probesDone'])).toBeGreaterThanOrEqual(20);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await hits(baseURL, session)).toEqual([]);
  });
});

test.describe('the page is put back', () => {
  test.slow();

  test('a page whose links navigate ends on its own address, as it was loaded', async ({ page }) => {
    await page.goto('/name-role-value/link-button.html');
    const address = page.url();
    const { findings } = await nrv(page).analyze();
    expect(Number(survey(findings)['reloads'])).toBeGreaterThan(0);
    expect(page.url()).toBe(address);
    // Nothing a probe opened is left open: no dialog, no panel.
    expect(await page.evaluate(() => [document.querySelector('dialog[open]'), (document.getElementById('details-1') as HTMLElement).hidden, document.title])).toEqual([null, true, 'Links and buttons by what they do']);
  });

  test('probing reloads the page; without it the page keeps what was done to it', async ({ page }) => {
    await page.goto('/name-role-value/states.html');
    await page.evaluate(() => document.body.setAttribute('data-before-scan', 'yes'));
    await nrv(page).options({ nameRoleValue: { probe: 'off' } }).analyze();
    expect(await page.evaluate(() => document.body.getAttribute('data-before-scan'))).toBe('yes');
    await nrv(page).analyze();
    expect(await page.evaluate(() => document.body.getAttribute('data-before-scan'))).toBeNull();
  });
});

test.describe('options', () => {
  test.slow();

  test('probe off: nothing is activated, and only what the markup says is reported', async ({ page }) => {
    await page.goto('/name-role-value/link-button.html');
    const { findings } = await nrv(page).options({ nameRoleValue: { probe: 'off' } }).analyze();
    expect(survey(findings)).toMatchObject({ probe: 'off', probesDone: 0, reloads: 0 });
    expect(findings.filter((finding) => finding.evidence.flags.includes('measured'))).toEqual([]);
    // What the markup says of a link that points nowhere is still there, as advisory.
    const toggle = findings.find((finding) => finding.selector === '#link-toggle')!;
    expect(toggle).toMatchObject({ rule: 'name-role-value/link-acts-as-button', status: 'advisory' });
  });

  test('includeAxeCovered: false leaves out what axe-core reports, and says how many', async ({ page }) => {
    await page.goto('/name-role-value/names.html');
    const all = await nrv(page).analyze();
    const covered = all.findings.filter((finding) => finding.evidence.flags.includes('axeCovered'));
    expect(covered.length).toBeGreaterThan(5);
    for (const finding of covered) expect(typeof finding.evidence.values?.['axeRule']).toBe('string');
    const without = await nrv(page).options({ nameRoleValue: { includeAxeCovered: false } }).analyze();
    expect(without.findings.filter((finding) => finding.evidence.flags.includes('axeCovered'))).toEqual([]);
    expect(survey(without.findings)['axeCoveredLeftOut']).toBe(covered.length);
    // What axe does not report stays: an empty tab, names that do not name.
    expect(without.findings.map((finding) => finding.selector)).toEqual(expect.arrayContaining(['#t-empty', '#b-generic', '#f-placeholder']));
  });

  test('behaviourRoleStatus: fail raises the measured link and button cases, and only those', async ({ page }) => {
    await page.goto('/name-role-value/link-button.html');
    const { findings } = await nrv(page).options({ nameRoleValue: { behaviourRoleStatus: 'fail' } }).analyze();
    const measured = findings.filter((finding) => finding.evidence.flags.includes('measured'));
    expect(measured.map((finding) => [finding.selector, finding.status]).sort()).toEqual([
      ['#button-nav', 'fail'],
      ['#link-modal', 'fail'],
      ['#link-terms', 'fail'],
      ['#link-toggle', 'fail'],
    ]);
  });

  test('the walk of the focus check is reused when it runs in the same scan', async ({ page }) => {
    await page.goto('/name-role-value/names.html');
    const alone = await nrv(page).analyze();
    expect(survey(alone.findings)['walk']).toBe('own');
    const both = await new A11yVision({ page }).withChecks(['focus-indicator', 'name-role-value']).analyze();
    expect(survey(both.findings)['walk']).toBe('focus');
    const names = (findings: Finding[]) => findings.filter((finding) => finding.check === 'name-role-value' && finding.status !== 'info').map((finding) => finding.id).sort();
    expect(names(both.findings)).toEqual(names(alone.findings));
  });
});

test.describe('reports', () => {
  test.slow();

  test('a fail exits 1; the HTML shows the captures before and after and the accessibility properties; SARIF and baseline take the findings', async ({ baseURL }, testInfo) => {
    const html = testInfo.outputPath('report.html');
    const sarif = testInfo.outputPath('report.sarif');
    const baseline = testInfo.outputPath('baseline.json');
    const url = `${baseURL}/name-role-value/formulaire-fr.html`;
    const first = await cli('scan', url, '--checks', 'name-role-value', '--html', html, '--sarif', sarif);
    expect(first.code).toBe(1);
    const report = JSON.parse(first.stdout) as { violations: { id: string; tags: string[] }[]; a11yVision: { findings: Finding[] } };
    expect(report.violations.map((rule) => rule.id).sort()).toEqual(['name-role-value/missing-name', 'name-role-value/no-role']);
    expect(report.violations[0]!.tags).toEqual(['wcag412']);
    const page = await readFile(html, 'utf8');
    expect(page).toContain('Before activation');
    expect(page).toContain('After activation');
    expect(page).toContain('axBefore');
    expect(page).toContain('role=button; name=&quot;Horaires d’ouverture&quot;');
    const sarifReport = JSON.parse(await readFile(sarif, 'utf8')) as { runs: { tool: { driver: { rules: { id: string }[] } }; results: { ruleId: string; level: string }[] }[] };
    expect(sarifReport.runs[0]!.tool.driver.rules.map((rule) => rule.id)).toContain('name-role-value/link-acts-as-button');
    expect(sarifReport.runs[0]!.results.filter((result) => result.ruleId === 'name-role-value/no-role')[0]!.level).toBe('error');
    for (const finding of report.a11yVision.findings) if (finding.selector !== 'html') expect(finding.signature).toMatch(/^[a-z-]+\|[a-z]*\|[0-9a-f]{16}$/);

    // A baseline records the fails (writing it marks them as in it), and the next run, without probing, finds the same fails in it.
    expect((await cli('scan', url, '--checks', 'name-role-value', '--baseline', baseline, '--update-baseline')).code).toBe(0);
    expect(JSON.parse(await readFile(baseline, 'utf8'))).toBeTruthy();
    const again = await cli('scan', url, '--checks', 'name-role-value', '--baseline', baseline, '--no-probe');
    expect(again.code).toBe(0);
    const quiet = JSON.parse(again.stdout) as { a11yVision: { findings: Finding[] } };
    expect(survey(quiet.a11yVision.findings)['probe']).toBe('off');
    const withoutAxe = JSON.parse((await cli('scan', url, '--checks', 'name-role-value', '--no-probe', '--no-axe-overlap')).stdout) as { a11yVision: { findings: Finding[] } };
    expect(withoutAxe.a11yVision.findings.some((finding) => finding.selector === '#lien-vide')).toBe(false);
    expect(withoutAxe.a11yVision.findings.some((finding) => finding.selector === '#voir-detail' && finding.status === 'fail')).toBe(true);
  });

  test('two runs give the same report', async ({ page }) => {
    await page.goto('/name-role-value/well-built.html');
    const first = await nrv(page).analyze();
    const second = await nrv(page).analyze();
    expect(second.findings).toEqual(first.findings);
  });
});
