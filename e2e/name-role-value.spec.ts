import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { resolveConfig } from '@a11y-vision/core';
import type { Finding } from '@a11y-vision/core';
import { A11yVision, playwrightProbeHost } from '@a11y-vision/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type * as CollectorModule from '../packages/collector-cdp/src/index.js';

/**
 * The name-role-value check beyond its manifests: that probing never touches the page under test
 * and nothing it activates reaches a server, what the options change, and the reports.
 *
 * The attack pages (`fixtures/name-role-value/attack-*.html`) hold controls that each write to the
 * fixture server when they are really clicked, by every way a review of the check found: APIs saved
 * before a guard, fresh frames, workers, frames of another origin, reads the server takes for an
 * action, timers, what a page sends as it goes away, `beforeunload`, client state. The server
 * records every request under `/_nrv/write/<session>/` and `/_nrv/nav/<session>/`, of any method,
 * and every WebSocket handshake (`/_nrv/log/<session>`).
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
const missing = (expected: string[], recorded: string[]) => expected.filter((entry) => !recorded.includes(entry));
const sessionOf = (name: string) => `${name}-${test.info().workerIndex}-${test.info().repeatEachIndex}-${Date.now()}`;
/** How long the server is watched after a scan for what a copy might still send. */
const AFTER_SCAN_MS = 5000;

/** Everything of the page under test a scan could change: its document, address, history, cookies of every path, storage, IndexedDB, the Cache API, the private file system, globals. */
async function pageState(page: Page): Promise<unknown> {
  const session = await page.context().newCDPSession(page);
  const { cookies } = (await session.send('Storage.getCookies' as never)) as { cookies: { name: string; value: string; path: string; domain: string; partitionKey?: unknown }[] };
  await session.detach();
  const inPage = await page.evaluate(async () => {
    const global = window as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {
      marker: global['__nrvMarker'],
      url: location.href,
      history: history.length,
      local: { ...localStorage },
      session: { ...sessionStorage },
      guard: typeof global['__a11yVisionGuard'],
      cookie: document.cookie,
    };
    try {
      const directory = await navigator.storage.getDirectory();
      const names: string[] = [];
      for await (const name of (directory as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
      out['opfs'] = names.sort();
    } catch (error) {
      out['opfs'] = String(error);
    }
    out['caches'] = await caches.keys().catch((error: unknown) => String(error));
    const databases = (await indexedDB.databases()).map((database) => database.name ?? '').sort();
    out['indexedDB'] = databases;
    if (databases.includes('nrv-state')) {
      out['nrvState'] = await new Promise((resolve) => {
        const open = indexedDB.open('nrv-state');
        open.onsuccess = () => {
          try {
            const request = open.result.transaction('s', 'readonly').objectStore('s').getAllKeys();
            request.onsuccess = () => {
              resolve(request.result);
              open.result.close();
            };
          } catch (error) {
            resolve(String(error));
            open.result.close();
          }
        };
        open.onerror = () => resolve('error');
      });
    }
    // The page's own API still works: no guard was left in it.
    out['indexedDBOpens'] = await new Promise((resolve) => {
      try {
        const open = indexedDB.open('nrv-probe-check');
        open.onsuccess = () => {
          open.result.close();
          const removed = indexedDB.deleteDatabase('nrv-probe-check');
          removed.onsuccess = removed.onerror = () => resolve(true);
        };
        open.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
    return out;
  });
  return { cookies: cookies.map((cookie) => `${cookie.name}=${cookie.value}; ${cookie.domain}${cookie.path}; ${JSON.stringify(cookie.partitionKey ?? null)}`).sort(), inPage };
}

/** Real clicks on the controls of an attack page, and what the server records: the page is armed. */
async function clickAll(page: Page, ids: string[]): Promise<void> {
  for (const id of ids) {
    await page.click(`#${id}`);
    await page.waitForTimeout(150);
  }
}

test.describe('the attack pages are armed: real clicks write', () => {
  test.slow();

  test('channels: saved APIs, fresh frames, workers, frames of another origin', async ({ page, baseURL }) => {
    const session = sessionOf('armed-channels');
    await page.goto(`/name-role-value/attack-channels.html?s=${session}`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForTimeout(300);
    await clickAll(page, ['shared-port', 'sw-port', 'xframe-new', 'blob-worker', 'fresh-beacon', 'srcdoc-form', 'saved-open', 'ws-fresh']);
    const expected = ['POST write/shared-port', 'POST write/sw-port', 'POST write/autoframe-post', 'POST write/blob-worker', 'POST write/fresh-beacon', 'POST write/srcdoc-form', 'GET nav/saved-open', 'GET ws'];
    await expect.poll(async () => missing(expected, await hits(baseURL, session)), { timeout: 10_000 }).toEqual([]);
  });

  test('reads, timers and what a page sends as it goes', async ({ page, baseURL }) => {
    const session = sessionOf('armed-reads');
    await page.goto(`/name-role-value/attack-reads.html?s=${session}`);
    await clickAll(page, ['img-path', 'css-bg', 'script-path', 'import', 'stylesheet', 'font-query', 'delayed', 'breach', 'arm-pagehide']);
    await page.waitForTimeout(1000);
    await page.reload();
    const expected = ['GET write/img-path-like-42.png', 'GET write/css-bg.png', 'GET write/script-path-vote-7.js', 'GET write/import-path.js', 'GET write/stylesheet.css', 'GET write/font.woff2', 'GET write/delayed-get-300', 'GET write/breach', 'GET write/pagehide-get', 'POST write/pagehide-beacon', 'POST write/sync-on-load'];
    await expect.poll(async () => missing(expected, await hits(baseURL, session)), { timeout: 10_000 }).toEqual([]);
  });

  test('client state, beforeunload, and a page in the middle of a test', async ({ page, baseURL }) => {
    const session = sessionOf('armed-state');
    await page.goto(`/name-role-value/attack-state.html?s=${session}`);
    await clickAll(page, ['cookie-img', 'save-on-leave']);
    await page.reload();
    await page.goto(`/name-role-value/attack-beforeunload.html?s=${session}`);
    await clickAll(page, ['edit']);
    await page.waitForTimeout(800);
    await page.goto(`/name-role-value/attack-caller.html?s=${session}`);
    await clickAll(page, ['post', 'get']);
    const expected = ['GET write/setcookie.png', 'POST write/sync-on-load', 'POST write/autosave', 'POST write/caller-post', 'GET write/caller-get'];
    await expect.poll(async () => missing(expected, await hits(baseURL, session)), { timeout: 10_000 }).toEqual([]);
  });
});

test.describe('probing never touches the page under test, and nothing it activates reaches a server', () => {
  test.slow();

  for (const name of ['attack-channels', 'attack-reads', 'attack-state', 'attack-beforeunload', 'attack-caller', 'safety']) {
    test(`${name}: no request to an action, during the scan or ${AFTER_SCAN_MS / 1000} s after it; the page is the same document, with the same state`, async ({ page, baseURL }) => {
      const session = sessionOf(name);
      await page.goto(`/name-role-value/${name}.html?s=${session}`);
      if (name === 'attack-channels' || name === 'safety') await page.evaluate(() => navigator.serviceWorker.ready);
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        (window as unknown as Record<string, unknown>)['__nrvMarker'] = 'set before the scan';
      });
      const failed: string[] = [];
      page.on('requestfailed', (request) => failed.push(request.url()));
      const dialogs: string[] = [];
      page.on('dialog', (dialog) => {
        dialogs.push(dialog.type());
        void dialog.dismiss().catch(() => undefined);
      });
      const before = await pageState(page);
      const loaded = await hits(baseURL, session);
      const { findings } = await nrv(page).analyze();
      const values = survey(findings);
      expect(values['probe']).toBe('safe');
      expect(Number(values['probesDone'])).toBeGreaterThan(0);
      expect(values['unsafeRequests']).toBe(0);
      expect(values['probeStopped']).toBeUndefined();
      expect(await hits(baseURL, session)).toEqual(loaded);
      await page.waitForTimeout(AFTER_SCAN_MS);
      expect(await hits(baseURL, session)).toEqual(loaded);
      expect(await pageState(page)).toEqual(before);
      expect(failed).toEqual([]);
      expect(dialogs).toEqual([]);
    });
  }

  test('after a scan the page still downloads, keeps its own routes, and its history is as it was', async ({ page, baseURL }) => {
    const session = sessionOf('caller-after');
    let routed = 0;
    await page.route('**/_nrv/mock', (route) => {
      routed++;
      return route.fulfill({ body: 'mocked' });
    });
    await page.goto(`/name-role-value/attack-caller.html?s=${session}`);
    const entries = await page.evaluate(() => history.length);
    await nrv(page).analyze();
    expect(await page.evaluate(() => history.length)).toBe(entries);
    expect(await page.evaluate(() => fetch('/_nrv/mock').then((response) => response.text()))).toBe('mocked');
    expect(routed).toBe(1);
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), page.click('#dl')]);
    expect(await download.failure()).toBeNull();
    expect(await hits(baseURL, session)).toEqual([]);
  });

  test('the CLI probes the attack pages and nothing reaches the server', async ({ baseURL }) => {
    const names = ['attack-channels', 'attack-reads', 'attack-state', 'attack-beforeunload'];
    const sessions = names.map((name) => sessionOf(`cli-${name}`));
    const outputs = await Promise.all(names.map((name, index) => cli('scan', `${baseURL}/name-role-value/${name}.html?s=${sessions[index]}`, '--checks', 'name-role-value')));
    for (const { stdout } of outputs) {
      const report = JSON.parse(stdout) as { a11yVision: { findings: Finding[] } };
      expect(Number(survey(report.a11yVision.findings)['probesDone'])).toBeGreaterThan(0);
      expect(survey(report.a11yVision.findings)['unsafeRequests']).toBe(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    // The CLI loads each page itself: what the page does as it loads is not an action, and these pages do none.
    for (const session of sessions) expect(await hits(baseURL, session)).toEqual([]);
  });

  test('the test detects a breach: a read let through on purpose, in a test-only mode, reaches the server and is seen', async ({ page, baseURL }) => {
    const session = sessionOf('breach');
    await page.goto(`/name-role-value/attack-reads.html?s=${session}`);
    const { collectSnapshot } = (await import(new URL('../packages/collector-cdp/dist/index.js', import.meta.url).href)) as typeof CollectorModule;
    const cdpSession = await page.context().newCDPSession(page);
    try {
      const snapshot = await collectSnapshot(
        {
          send: (method, params) => cdpSession.send(method as never, params as never),
          on: (event, handler) => void cdpSession.on(event as never, handler as never),
          off: (event, handler) => void cdpSession.off(event as never, handler as never),
        },
        resolveConfig({ checks: ['name-role-value'] }),
        { probeHost: playwrightProbeHost(page), probeTestUnblock: /\/write\/[\w-]+\/breach\?/ },
      );
      expect(snapshot.nameRoleValue!.probe.probes.find((probe) => probe.selector === '#breach')?.outcome).toBe('done');
    } finally {
      await cdpSession.detach();
    }
    // The one read let through is seen, and nothing else got out.
    await expect.poll(() => hits(baseURL, session), { timeout: 5000 }).toEqual(['GET write/breach']);
  });

  test('a scan stopped while it probes rejects, and leaves the page working and nothing sent', async ({ page, baseURL }) => {
    const session = sessionOf('abort');
    await page.goto(`/name-role-value/attack-reads.html?s=${session}`);
    const { collectSnapshot } = (await import(new URL('../packages/collector-cdp/dist/index.js', import.meta.url).href)) as typeof CollectorModule;
    const cdpSession = await page.context().newCDPSession(page);
    const controller = new AbortController();
    let probing = false;
    const host = playwrightProbeHost(page);
    const watched = { start: async () => { probing = true; return host.start(); } };
    const scan = collectSnapshot(
      {
        send: (method, params) => cdpSession.send(method as never, params as never),
        on: (event, handler) => void cdpSession.on(event as never, handler as never),
        off: (event, handler) => void cdpSession.off(event as never, handler as never),
      },
      resolveConfig({ checks: ['name-role-value'] }),
      { probeHost: watched, signal: controller.signal },
    );
    await expect.poll(() => probing, { timeout: 30_000 }).toBe(true);
    await page.waitForTimeout(1500);
    controller.abort(new Error('stopped by the test'));
    await expect(scan).rejects.toThrow('stopped by the test');
    await cdpSession.detach().catch(() => undefined);
    expect(await page.evaluate(() => fetch('/name-role-value/reviews.txt').then((response) => response.status))).toBe(200);
    await page.waitForTimeout(2000);
    expect(await hits(baseURL, session)).toEqual([]);
  });

  test('a collection without a host that makes copies activates nothing, and says so', async ({ page }) => {
    await page.goto('/name-role-value/link-button.html');
    const { collectSnapshot } = (await import(new URL('../packages/collector-cdp/dist/index.js', import.meta.url).href)) as typeof CollectorModule;
    const cdpSession = await page.context().newCDPSession(page);
    try {
      const snapshot = await collectSnapshot(
        {
          send: (method, params) => cdpSession.send(method as never, params as never),
          on: (event, handler) => void cdpSession.on(event as never, handler as never),
          off: (event, handler) => void cdpSession.off(event as never, handler as never),
        },
        resolveConfig({ checks: ['name-role-value'] }),
      );
      const probe = snapshot.nameRoleValue!.probe;
      expect(probe).toMatchObject({ mode: 'safe', unavailable: true, clones: 0 });
      expect(probe.probes).toEqual([]);
    } finally {
      await cdpSession.detach();
    }
  });
});

/** Listens on this machine, on a port of its own, and on IPv6 too when it can: a name that resolves to either reaches it. */
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ port: number; close(): Promise<void> }> {
  const v4 = createServer(handler);
  await new Promise<void>((resolve) => v4.listen(0, '127.0.0.1', resolve));
  const { port } = v4.address() as AddressInfo;
  const v6: Server | null = await new Promise((resolve) => {
    const server = createServer(handler);
    server.once('error', () => resolve(null));
    server.listen(port, '::1', () => resolve(server));
  });
  return {
    port,
    close: async () => {
      for (const server of [v4, v6]) if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const profileFolders = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith('playwright_chromiumdev_profile-'));

test.describe('the reads of the copies go where the page under test reads, or nowhere', () => {
  test.slow();

  test('a page behind a session cookie (HttpOnly): its copy is sent the cookie, loads signed in, and is probed', async ({ page, baseURL }) => {
    const session = sessionOf('private');
    await page.context().addCookies([{ name: 'nrv-auth', value: session, url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
    await page.goto(`/_nrv/private/${session}/page.html`);
    const values = survey((await nrv(page).analyze()).findings);
    expect(values['probeStopped']).toBeUndefined();
    expect(Number(values['probesDone'])).toBeGreaterThan(0);
    // The page's own load, then the copy's, both signed in; nothing sent to the sign-in page.
    expect(await hits(baseURL, session)).toEqual(['GET private/page.html with-cookie', 'GET private/page.html with-cookie']);
  });

  test('host rules of the page browser: the copies read from the server the page reads from, and the one the name resolves to gets nothing', async ({ playwright, baseURL }) => {
    const realHits: string[] = [];
    const real = await listen((request, response) => {
      realHits.push(`${request.method} ${request.url}`);
      response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html lang="en"><title>Real</title><p>The server the name resolves to.</p></html>');
    });
    // The name of the page is localhost; the browser of the page sends it to the fixture server (a staging server).
    const staging = new URL(baseURL!).host;
    const rules = `MAP localhost:${real.port} ${staging}`;
    const browser = await playwright.chromium.launch({ args: [`--host-resolver-rules=${rules}`] });
    try {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${real.port}/name-role-value/link-button.html`);
      expect(realHits).toEqual([]);
      const values = survey((await nrv(page).analyze()).findings);
      expect(values['probeStopped']).toBeUndefined();
      expect(Number(values['probesDone'])).toBeGreaterThan(0);
      expect(String(values['copyReadsRoute'])).toContain(`host rules: ${rules}`);
      expect(realHits).toEqual([]);
    } finally {
      await browser.close();
      await real.close();
    }
  });

  test('what the page under test mocks (page.route) is never sent for its copies, and the route is not called for them', async ({ page, baseURL }) => {
    const session = sessionOf('mocked');
    let routed = 0;
    await page.route('**/_nrv/write/*/api-data', (route) => {
      routed++;
      return route.fulfill({ body: 'mocked' });
    });
    await page.goto(`/_nrv/mocked/${session}/page.html`);
    await expect(page.locator('#data')).toHaveText('mocked');
    const values = survey((await nrv(page).analyze()).findings);
    expect(values['probeStopped']).toBeUndefined();
    expect(Number(values['probesDone'])).toBeGreaterThan(0);
    expect(String(values['blockedRequests'])).toContain('/api-data (not sent: the page under test routes this address itself');
    await page.waitForTimeout(1000);
    expect(await hits(baseURL, session)).toEqual([]);
    expect(routed).toBe(1);
  });

  test('a page whose own address the test routes is not probed, and the survey says why', async ({ page }) => {
    await page.route('**/name-role-value/link-button.html', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><title>Mock</title><main><a href="#" id="x" onclick="event.preventDefault(); document.body.append(document.createElement(\'hr\'))">Mocked</a></main></html>' }));
    await page.goto('/name-role-value/link-button.html');
    const values = survey((await nrv(page).analyze()).findings);
    expect(values['probeStopped']).toBe('routing');
    expect(String(values['probeStoppedDetail'])).toContain('routes its own address');
    expect(String(values['probesNotDoneBy'])).toMatch(/^not-started \d+$/);
    expect(values['copiesLoaded']).toBe(0);
  });

  test('probeLoadDeny keeps the reads it lists from the server, for what is mocked where the collector cannot see', async ({ page, baseURL }) => {
    const session = sessionOf('deny');
    await page.goto(`/_nrv/mocked/${session}/page.html`);
    await expect(page.locator('#data')).toHaveText('cb && cb()');
    const loaded = await hits(baseURL, session);
    expect(loaded).toEqual(['GET write/api-data']);
    const values = survey((await nrv(page).options({ nameRoleValue: { probeLoadDeny: ['/api-data$'] } }).analyze()).findings);
    expect(Number(values['probesDone'])).toBeGreaterThan(0);
    expect(String(values['blockedRequests'])).toContain('/api-data (not sent: probeLoadDeny)');
    await page.waitForTimeout(1000);
    expect(await hits(baseURL, session)).toEqual(loaded);
  });

  test('an offline page is not probed: its copies would read what it cannot', async ({ page, baseURL }) => {
    const session = sessionOf('offline');
    await page.goto(`/_nrv/mocked/${session}/page.html`);
    await expect(page.locator('#data')).toHaveText('cb && cb()');
    const loaded = await hits(baseURL, session);
    await page.context().setOffline(true);
    try {
      const values = survey((await nrv(page).analyze()).findings);
      expect(values['probeStopped']).toBe('routing');
      expect(String(values['probeStoppedDetail'])).toContain('offline');
      expect(String(values['probesNotDoneBy'])).toMatch(/^not-started \d+$/);
    } finally {
      await page.context().setOffline(false);
    }
    expect(await hits(baseURL, session)).toEqual(loaded);
  });

  test('a page at a file address is not probed, and says why', async ({ page }) => {
    await page.goto(pathToFileURL(fileURLToPath(new URL('../fixtures/name-role-value/link-button.html', import.meta.url))).href);
    const values = survey((await nrv(page).analyze()).findings);
    expect(values['probeStopped']).toBe('routing');
    expect(String(values['probeStoppedDetail'])).toContain('file:');
  });

  test('a copy that does not load says what went wrong when its document was read', async ({ page, baseURL }) => {
    const session = sessionOf('once');
    await page.goto(`/_nrv/once/${session}/page.html`);
    const values = survey((await nrv(page).analyze()).findings);
    expect(values['probeStopped']).toBe('cloneFailed');
    expect(String(values['probeStoppedDetail'])).toMatch(new RegExp(`the read of ${baseURL!.replace(/[.]/g, '\\.')}/_nrv/once/${session}/page\\.html failed: (socket hang up|read ECONNRESET)`));
  });

  test('a page on HTTPS with a certificate its context accepts (ignoreHTTPSErrors): its copies accept it too', async ({ browser }, testInfo) => {
    const key = testInfo.outputPath('key.pem');
    const cert = testInfo.outputPath('cert.pem');
    const made = await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1']).then(
      () => true,
      () => false,
    );
    test.skip(!made, 'openssl is needed to make a self-signed certificate');
    const html = await readFile(fileURLToPath(new URL('../fixtures/name-role-value/link-button.html', import.meta.url)), 'utf8');
    const server = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, (_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end(html));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const page = await context.newPage();
      await page.goto(`https://127.0.0.1:${(server.address() as AddressInfo).port}/name-role-value/link-button.html`);
      const values = survey((await nrv(page).analyze()).findings);
      expect(values['probeStopped']).toBeUndefined();
      expect(Number(values['probesDone'])).toBeGreaterThan(0);
      expect(String(values['copyReadsRoute'])).toContain('certificate errors ignored');
    } finally {
      await context.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('a probing browser that does not start: the survey says so, and no profile folder is left behind', async ({ page }) => {
    await page.goto('/name-role-value/link-button.html');
    const before = new Set(profileFolders());
    const missing = join(tmpdir(), 'a11y-vision-no-such-chromium', 'chrome.exe');
    const values = survey((await new A11yVision({ page, probeContext: { executablePath: missing } }).withChecks(['name-role-value']).analyze()).findings);
    expect(values['probeStopped']).toBe('browserFailed');
    expect(String(values['probesNotDoneBy'])).toMatch(/^not-started \d+$/);
    // Other workers start browsers too: what is left of a failed launch is an empty folder that stays.
    await page.waitForTimeout(2000);
    const left = profileFolders().filter((name) => !before.has(name) && readdirSync(join(tmpdir(), name)).length === 0);
    expect(left).toEqual([]);
  });

  test('the dead proxy of the probing browser covers this machine whatever the environment of Playwright says', async ({ page, baseURL }) => {
    const session = sessionOf('loopback-env');
    await page.goto('/name-role-value/link-button.html');
    // With it, Playwright's proxy option leaves loopback out of the proxy: this machine would be within reach of the probing browser.
    process.env['PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK'] = '1';
    let probe: Awaited<ReturnType<ReturnType<typeof playwrightProbeHost>['start']>>;
    try {
      probe = await playwrightProbeHost(page).start();
    } finally {
      delete process.env['PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK'];
    }
    try {
      const copy = await probe.newPage({ url: `${baseURL}/`, viewport: { width: 800, height: 600 }, deviceScaleFactor: 1, userAgent: '', locale: '', colorScheme: 'light', timezoneId: '' });
      // Nothing holds its requests here (the collector is not running): only the dead proxy stands between it and this machine.
      await copy.cdp.send('Page.enable');
      await copy.cdp.send('Page.navigate', { url: `${baseURL}/_nrv/nav/${session}/direct` });
      await expect.poll(() => probe.refusedConnections(), { timeout: 5000 }).toBeGreaterThan(0);
    } finally {
      await probe.close();
    }
    expect(await hits(baseURL, session)).toEqual([]);
  });
});

test.describe('the copy must be the page', () => {
  test.slow();

  test('a page that no longer is what its address loads is not probed, and the survey says why', async ({ page }) => {
    await page.goto('/name-role-value/link-button.html');
    // What a test did to the page after it loaded (a panel opened, a form step): the copy, loaded from the address, has none of it.
    await page.evaluate(() => {
      for (let index = 0; index < 12; index++) {
        const added = document.createElement('button');
        added.id = `added-${index}`;
        added.textContent = `Added after load ${index}`;
        added.setAttribute('aria-expanded', 'false');
        added.addEventListener('click', () => added.setAttribute('aria-expanded', 'true'));
        document.querySelector('main')!.prepend(added);
      }
    });
    const values = survey((await nrv(page).analyze()).findings);
    expect(values['probeStopped']).toBe('cloneDiffers');
    expect(Number(values['probesDone'])).toBe(0);
    expect(String(values['copyComparedWithPage'])).toMatch(/interactive elements [0-9]+ in the copy, [0-9]+ in the page/);
  });

  test('an element of the page that is not in the copy is not probed, and is counted', async ({ page }) => {
    await page.goto('/name-role-value/many-controls.html');
    // After everything else, so that no other element moves (selectors that count siblings stay right): a link that points nowhere, probed first.
    await page.evaluate(() => {
      const added = document.createElement('a');
      added.id = 'added-after-load';
      added.textContent = 'Added after load';
      added.addEventListener('click', () => document.body.append(document.createElement('hr')));
      document.body.append(added);
    });
    // One of the 30 elements to probe is not in the copy: below the share that makes the copy another page.
    const values = survey((await nrv(page).options({ nameRoleValue: { probeBudgetMs: 6000 } }).analyze()).findings);
    expect(values['probeStopped']).toBe('budget');
    expect(String(values['copyComparedWithPage'])).toContain('29 of 30 elements to probe found alike, 1 not found');
    expect(String(values['probesNotDoneBy'])).toContain('not-found 1');
  });
});

test.describe('probing is bounded and spends its probes on open questions', () => {
  test.slow();

  test('a page of 300 controls: probing stops at its budget, says so, and spends nothing on native fields', async ({ page }) => {
    await page.goto('/name-role-value/many-controls.html');
    const off = Date.now();
    await nrv(page).options({ nameRoleValue: { probe: 'off' } }).analyze();
    const withoutProbing = Date.now() - off;
    const on = Date.now();
    const { findings } = await nrv(page).options({ nameRoleValue: { probeBudgetMs: 4000, maxProbes: 100 } }).analyze();
    const withProbing = Date.now() - on;
    const values = survey(findings);
    expect(values['probeStopped']).toBe('budget');
    expect(Number(values['probesDone'])).toBeGreaterThan(0);
    // The budget holds: probing adds the budget, and the start and the end of its browser, no more.
    expect(withProbing - withoutProbing).toBeLessThan(4000 + 8000);
    // The 100 toggle buttons; never the 100 checkboxes (native fields) nor the 100 links with an address and no handler.
    expect(Number(values['probesPlanned'])).toBe(100);
  });

  test('a probe that demonstrably changed nothing leaves its copy to the next probe', async ({ page }) => {
    await page.goto('/name-role-value/legit-patterns.html');
    const values = survey((await nrv(page).analyze()).findings);
    expect(Number(values['probesDone'])).toBeGreaterThan(3);
    expect(Number(values['copiesReused'])).toBeGreaterThan(0);
    expect(Number(values['copiesLoaded'])).toBeLessThan(Number(values['probesDone']));
  });
});

test.describe('the Tab walks go on past an element with stops of its own', () => {
  test('the walk of the focus check reaches what comes after a date input, and says why it ended', async ({ page }) => {
    await page.setContent('<main><h1>Walk</h1><label>When <input type="date" id="when"></label><button id="after">After</button><a href="#x" id="last">Last</a></main>');
    const { findings } = await new A11yVision({ page }).withChecks(['focus-indicator']).analyze();
    const walk = findings.find((finding) => finding.rule === 'focus-indicator/walk')!;
    expect(walk.evidence.flags).toEqual(['cycle']);
    // Nothing had to be forced: Tab reached all three.
    expect(walk.message).toMatch(/Tab walk: 3 stop\(s\)/);
    expect(findings.filter((finding) => finding.evidence.flags.includes('forced'))).toEqual([]);
  });
});

test.describe('options', () => {
  test.slow();

  test('probe off: nothing is activated, and only what the markup says is reported', async ({ page }) => {
    await page.goto('/name-role-value/link-button.html');
    const { findings } = await nrv(page).options({ nameRoleValue: { probe: 'off' } }).analyze();
    expect(survey(findings)).toMatchObject({ probe: 'off', probesDone: 0, copiesLoaded: 0 });
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

    // A baseline records the fails (writing it marks them as in it), and the next run, without probing, finds the empty link in it.
    expect((await cli('scan', url, '--checks', 'name-role-value', '--baseline', baseline, '--update-baseline')).code).toBe(0);
    expect(JSON.parse(await readFile(baseline, 'utf8'))).toBeTruthy();
    const again = await cli('scan', url, '--checks', 'name-role-value', '--baseline', baseline, '--no-probe');
    expect(again.code).toBe(0);
    const quiet = JSON.parse(again.stdout) as { a11yVision: { findings: Finding[] } };
    expect(survey(quiet.a11yVision.findings)['probe']).toBe('off');
    const withoutAxe = JSON.parse((await cli('scan', url, '--checks', 'name-role-value', '--no-probe', '--no-axe-overlap')).stdout) as { a11yVision: { findings: Finding[] } };
    expect(withoutAxe.a11yVision.findings.some((finding) => finding.selector === '#lien-vide')).toBe(false);
    // Without probing, a focusable div with a click listener is likely: a fail needs an effect the activation caused.
    expect(withoutAxe.a11yVision.findings.some((finding) => finding.selector === '#voir-detail' && finding.status === 'likely')).toBe(true);
  });

  test('two runs give the same report', async ({ page }) => {
    await page.goto('/name-role-value/well-built.html');
    const first = await nrv(page).analyze();
    const second = await nrv(page).analyze();
    expect(second.findings).toEqual(first.findings);
  });
});
