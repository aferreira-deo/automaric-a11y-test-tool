import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, chromium } from '@playwright/test';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import type { CheckId, Finding } from '@a11y-vision/core';

/**
 * The unpacked extension (packages/extension/dist) in a Chromium of its own, one per worker.
 *
 * An extension needs a persistent context and the full Chromium (`channel: 'chromium'`): the
 * headless shell the other tests run in has no extensions, and Google Chrome and Edge no longer
 * take `--load-extension` (https://playwright.dev/docs/chrome-extensions).
 *
 * The side panel itself cannot be opened by a test: `chrome.sidePanel.open()` needs a user
 * gesture on the browser's own UI, which automation has no way to give. The tests open the same
 * page, `panel.html`, in a window of its own with the tab to work on named in its address
 * (`?tabId=`). Everything else is the real thing: the extension's own context, `chrome.debugger`,
 * `chrome.storage.local`, the service worker.
 */

export const extensionDir = fileURLToPath(new URL('../../packages/extension/dist', import.meta.url));

/** Where Playwright keeps its browsers, for the fallback below. */
function browsersDir(): string {
  const set = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  if (set && set !== '0') return set;
  if (process.platform === 'win32') return join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  return join(process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'), 'ms-playwright');
}

/** Other Chromium builds Playwright has downloaded, newest first. */
function otherChromiums(): string[] {
  const dir = browsersDir();
  if (!existsSync(dir)) return [];
  const sub = process.platform === 'win32' ? ['chrome-win64', 'chrome.exe'] : process.platform === 'darwin' ? ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'] : ['chrome-linux64', 'chrome'];
  return readdirSync(dir)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
    .map((name) => join(dir, name, ...sub))
    .filter((path) => existsSync(path));
}

/**
 * Launches Chromium with the extension. The Chromium of this Playwright version comes first, or
 * the one named in A11Y_VISION_EXTENSION_CHROMIUM. A machine can refuse to run the first (Windows
 * Smart App Control blocks an unsigned chrome.dll it has not seen before): then an older build
 * that Playwright downloaded earlier is used, and the run says which, on stderr.
 */
async function launch(): Promise<BrowserContext> {
  const options = {
    channel: 'chromium',
    viewport: null,
    // A11Y_VISION_EXTENSION_HEADED=1 shows the windows: the bar of Chrome and the page during a scan can then be watched.
    headless: !process.env['A11Y_VISION_EXTENSION_HEADED'],
    // A screen large enough for a window whose page is 1280 CSS px wide (headless Chromium has a screen of 800 by 600 otherwise).
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--screen-info={1920x1200}'],
  };
  const named = process.env['A11Y_VISION_EXTENSION_CHROMIUM'];
  if (named) return chromium.launchPersistentContext('', { ...options, executablePath: named });
  try {
    return await chromium.launchPersistentContext('', options);
  } catch (first) {
    for (const executablePath of otherChromiums()) {
      try {
        const context = await chromium.launchPersistentContext('', { ...options, executablePath });
        console.warn(`[extension tests] The Chromium of this Playwright version did not start; using ${executablePath} instead.`);
        return context;
      } catch {
        // The next one.
      }
    }
    throw first;
  }
}

export interface Extension {
  context: BrowserContext;
  id: string;
  worker: Worker;
  /**
   * Opens `url` in a new tab, in front, and gives the page with the id Chrome knows the tab by.
   * With `viewport`, the window is first resized so that the page has that viewport.
   */
  openTab(url: string, viewport?: { width: number; height: number }): Promise<{ page: Page; tabId: number }>;
  /** Opens the panel page in a window of its own, for the tab `tabId`. */
  openPanel(tabId: number): Promise<Page>;
  /** Whether the extension has a debugger attached to the tab. */
  attached(tabId: number): Promise<boolean>;
}

export interface ExtensionReport {
  testEngine: { name: string; version: string };
  url: string;
  timestamp: string;
  violations: unknown[];
  incomplete: unknown[];
  passes: unknown[];
  inapplicable: unknown[];
  a11yVision: {
    findings: Finding[];
    review: { source: string; decisions: { findingId: string; signature: string; decision: string | null; note: string; at: string }[] };
  };
}

export const test = base.extend<{ panelFor: (path: string, viewport?: { width: number; height: number }) => Promise<{ page: Page; panel: Page; tabId: number }> }, { extension: Extension }>({
  extension: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const context = await launch();
      let [worker] = context.serviceWorkers();
      worker ??= await context.waitForEvent('serviceworker');
      const id = worker.url().split('/')[2]!;
      let frame: { width: number; height: number } | undefined;
      const extension: Extension = {
        context,
        id,
        worker,
        async openTab(url, viewport) {
          const [page, tab] = await Promise.all([
            context.waitForEvent('page'),
            worker.evaluate(async (address) => {
              const created = await (globalThis as unknown as { chrome: { tabs: { create(o: object): Promise<{ id: number; windowId: number }> } } }).chrome.tabs.create({ url: address, active: true });
              return { id: created.id, windowId: created.windowId };
            }, url),
          ]);
          await page.waitForLoadState('load');
          if (viewport) {
            // What the window has around the page, measured once on a blank page: a fixture can
            // lie about its own sizes.
            frame ??= await (context.pages().find((other) => other.url() === 'about:blank') ?? page).evaluate(() => ({ width: window.outerWidth - window.innerWidth, height: window.outerHeight - window.innerHeight }));
            const bounds = { windowId: tab.windowId, width: Math.round(viewport.width + frame.width), height: Math.round(viewport.height + frame.height) };
            await worker.evaluate(async ({ windowId, width, height }) => {
              const windows = (globalThis as unknown as { chrome: { windows: { update(id: number, o: object): Promise<unknown>; get(id: number): Promise<{ width: number; height: number }> } } }).chrome.windows;
              await windows.update(windowId, { left: 0, top: 0, width, height });
              for (let tries = 0; tries < 100; tries++) {
                const now = await windows.get(windowId);
                if (now.width === width && now.height === height) return;
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
              throw new Error(`The window did not take the size ${width} by ${height}.`);
            }, bounds);
          }
          return { page, tabId: tab.id };
        },
        async openPanel(tabId) {
          const [panel] = await Promise.all([
            context.waitForEvent('page'),
            worker.evaluate(
              (address) => (globalThis as unknown as { chrome: { windows: { create(o: object): Promise<unknown> } } }).chrome.windows.create({ url: address, type: 'popup', focused: false, width: 480, height: 900 }),
              `panel.html?tabId=${tabId}`,
            ),
          ]);
          await panel.waitForSelector('html[data-ready="true"]');
          return panel;
        },
        // `getTargets()` says `attached` for any client, Playwright's own included: asking the tab
        // something through the extension's session tells whether the extension has one.
        attached: (tabId) =>
          worker.evaluate(
            (wanted) =>
              (globalThis as unknown as { chrome: { debugger: { sendCommand(t: object, m: string, p: object): Promise<unknown> } } }).chrome.debugger
                .sendCommand({ tabId: wanted }, 'Runtime.evaluate', { expression: '1' })
                .then(
                  () => true,
                  () => false,
                ),
            tabId,
          ),
      };
      await use(extension);
      await context.close();
    },
    { scope: 'worker' },
  ],
  panelFor: async ({ extension, baseURL }, use) => {
    const opened: Page[] = [];
    // One profile per worker: what an earlier test stored (settings, decisions, a key) is not this test's.
    await extension.worker.evaluate(() => (globalThis as unknown as { chrome: { storage: { local: { clear(): Promise<void> } } } }).chrome.storage.local.clear());
    await use(async (path, viewport) => {
      const { page, tabId } = await extension.openTab(new URL(path, baseURL).href, viewport);
      const panel = await extension.openPanel(tabId);
      opened.push(panel, page);
      return { page, panel, tabId };
    });
    for (const page of opened) await page.close().catch(() => undefined);
  },
});

/** Ticks exactly `checks` and starts a scan. */
export async function startScan(panel: Page, checks: readonly CheckId[]): Promise<void> {
  for (const box of await panel.locator('#checks input[type=checkbox]').all()) {
    await box.setChecked(checks.includes((await box.getAttribute('value')) as CheckId));
  }
  await panel.locator('#scan').click();
}

/** How many scans the panel has brought to an end, one way or another. */
export function scansEnded(panel: Page): Promise<number> {
  return panel.evaluate(() => Number(document.documentElement.dataset['scans'] ?? 0));
}

/** Waits until the panel has ended one more scan than `before`. */
export async function scanEnded(panel: Page, before: number): Promise<void> {
  await panel.waitForFunction((count) => Number(document.documentElement.dataset['scans'] ?? 0) > count, before, { timeout: 120000 });
}

/** Runs a scan to its end and fails with what the panel said when it ended in an error. */
export async function scan(panel: Page, checks: readonly CheckId[]): Promise<void> {
  const before = await scansEnded(panel);
  await startScan(panel, checks);
  await scanEnded(panel, before);
  const error = await panel.locator('#error').textContent();
  if (error) throw new Error(`The scan ended with: ${error}`);
}

/** Clicks an export button and gives the file that was downloaded. */
export async function exported(panel: Page, kind: 'json' | 'html' | 'sarif'): Promise<{ name: string; text: string }> {
  const [download] = await Promise.all([panel.waitForEvent('download'), panel.locator(`#export-${kind}`).click()]);
  return { name: download.suggestedFilename(), text: await readFile(await download.path(), 'utf8') };
}

export async function exportedJson(panel: Page): Promise<ExtensionReport> {
  return JSON.parse((await exported(panel, 'json')).text) as ExtensionReport;
}
