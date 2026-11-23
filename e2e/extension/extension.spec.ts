import { A11yVision } from '@a11y-vision/playwright';
import { expect } from '@playwright/test';
import type { Finding } from '@a11y-vision/core';
import type { Dialog, Page } from '@playwright/test';
import { exported, exportedJson, scan, scanEnded, scansEnded, startScan, test } from '../support/extension.js';
import { compareToManifest, loadFixtures } from '../support/manifest.js';
import { startMockModel, verdict } from '../support/mock-model.js';
import type { MockRequest } from '../support/mock-model.js';

/**
 * The extension end to end, in Chromium with the unpacked extension loaded: the panel page, the
 * debugger session, storage, the service worker and the exports are the real ones. What is not:
 * the panel is opened in a window of its own instead of the side panel, and nobody clicks the
 * bar of Chrome (see e2e/support/extension.ts and the README).
 */

const all = loadFixtures();
/** At least one fixture per check, and those that go through shadow roots, iframes, a page that fakes its environment and a strict CSP. */
const chosen = [
  'focus-indicator/outline-none',
  'focus-indicator/low-contrast-outline',
  'focus-indicator/shadow-dom',
  'focus-indicator/iframe',
  'focus-indicator/sticky-header-obscured',
  'focus-indicator/spoofed-environment',
  'focus-indicator/csp-style-nonce',
  'icon-contrast/svg-currentcolor',
  'icon-contrast/input-boundaries',
  'headings/baseline',
  'lists/glyph-lists',
  'grouping/choice-sets',
];
// With A11Y_VISION_EXTENSION_ALL_FIXTURES set: every fixture but the one of the check the panel does not offer.
const fixtures = process.env['A11Y_VISION_EXTENSION_ALL_FIXTURES'] ? all.filter((fixture) => !fixture.manifest.checks.includes('noop')) : all.filter((fixture) => chosen.includes(fixture.name));

/**
 * Findings as two scans of one page can be compared: as JSON, and without the box of the findings
 * about the page as a whole, which is the viewport. Its height is not the same in the two scans:
 * Chrome's bar ("... is debugging this browser") takes room above the page from some moment
 * after the extension attaches until some moment after it detaches.
 */
function comparable(findings: Finding[]): unknown {
  return JSON.parse(JSON.stringify(findings.map((finding) => (finding.selector === 'html' ? { ...finding, box: null } : finding))));
}

/**
 * The manifests were written for the viewport of the other browser tests, 1280 by 720, and a few
 * fixtures depend on it. Chrome's bar takes 56 CSS px above the page while the debugger is
 * attached (measured in Chromium 153), so the window is made that much taller.
 */
const FIXTURE_WINDOW = { width: 1280, height: 720 + 56 };

test.describe('a scan from the panel', () => {
  for (const fixture of fixtures) {
    test(`fixture ${fixture.name}`, async ({ panelFor }) => {
      const { page, panel } = await panelFor(fixture.path, FIXTURE_WINDOW);
      await scan(panel, fixture.manifest.checks);
      const report = await exportedJson(panel);
      const findings = report.a11yVision.findings;
      // The same page through the Playwright target, in the same browser and, Chrome's bar still
      // showing, the same viewport: the two targets share one core and one collector, and have
      // to say the same thing.
      const viaPlaywright = await new A11yVision({ page }).withChecks(fixture.manifest.checks).analyze();
      expect(comparable(findings)).toEqual(comparable(viaPlaywright.findings));
      expect(compareToManifest(findings, fixture.manifest), fixture.manifest.description).toEqual({ missing: [], unexpected: [] });
      // What the panel shows is what was found: one card per finding.
      await expect(panel.locator('article.finding')).toHaveCount(findings.length);
    });
  }
});

/** What a scan changes while it runs and has to put back. */
function pageState(page: Page) {
  return page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    active: document.activeElement?.id ?? '',
    windowScroll: [window.scrollX, window.scrollY],
    adoptedSheets: document.adoptedStyleSheets.length,
    styleElements: document.querySelectorAll('style').length,
    html: document.documentElement.outerHTML.length,
  }));
}

test('the page is put back after a scan and the debugger is detached', async ({ panelFor, extension }) => {
  const { page, panel, tabId } = await panelFor('/focus-indicator/restore-state.html');
  await page.evaluate(() => {
    window.scrollTo(0, 120);
    document.getElementById('field')?.focus({ preventScroll: true });
  });
  const before = await pageState(page);
  expect(before.windowScroll[1]).toBe(120);
  await scan(panel, ['focus-indicator', 'icon-contrast', 'headings', 'lists', 'grouping']);
  expect(await pageState(page)).toEqual(before);
  expect(await extension.attached(tabId)).toBe(false);
});

test('the exports are the reports of the CLI, with the decisions in the JSON', async ({ panelFor }) => {
  const { panel } = await panelFor('/focus-indicator/outline-none.html');
  await scan(panel, ['focus-indicator']);
  const card = panel.locator('article.finding', { has: panel.locator('code', { hasText: '#none-button' }) }).first();
  await card.locator('button.confirm').click();
  await card.locator('textarea').fill('Checked by hand: nothing changes on focus.');
  await card.locator('textarea').blur();
  await expect(panel.locator('#action-status')).toHaveText('Note saved.');

  const json = await exported(panel, 'json');
  expect(json.name).toMatch(/^a11y-vision_127\.0\.0\.1_[0-9TZ-]+\.json$/);
  const report = JSON.parse(json.text) as Awaited<ReturnType<typeof exportedJson>>;
  expect(report.testEngine.name).toBe('a11y-vision');
  expect(report.url).toContain('/focus-indicator/outline-none.html');
  expect(report.passes).toEqual([]);
  expect(report.violations.length).toBeGreaterThan(0);
  const confirmed = report.a11yVision.findings.find((finding) => finding.selector === '#none-button' && finding.status === 'fail')!;
  expect(report.a11yVision.review).toEqual({
    source: 'extension',
    decisions: [{ findingId: confirmed.id, signature: confirmed.signature, decision: 'confirmed', note: 'Checked by hand: nothing changes on focus.', at: expect.any(String) as unknown as string }],
  });

  const html = await exported(panel, 'html');
  expect(html.text).toMatch(/^<!doctype html>/i);
  expect(html.text).toContain('data:image/png;base64,');
  expect(html.text).toContain('#none-button');
  expect(html.text).not.toMatch(/passes WCAG|conforms/i);

  const sarif = JSON.parse((await exported(panel, 'sarif')).text) as { version: string; runs: { tool: { driver: { name: string } }; results: { level: string }[] }[] };
  expect(sarif.version).toBe('2.1.0');
  expect(sarif.runs[0]!.tool.driver.name).toBe('a11y-vision');
  expect(sarif.runs[0]!.results.filter((result) => result.level === 'error').length).toBe(report.violations.reduce((sum: number, rule) => sum + (rule as { nodes: unknown[] }).nodes.length, 0));
});

test('a decision is kept for the page, the finding and the element, across a reload of the panel', async ({ panelFor, extension }) => {
  const { panel, tabId } = await panelFor('/focus-indicator/outline-none.html');
  await scan(panel, ['focus-indicator']);
  const cardOf = (on: Page, selector: string) => on.locator('article.finding[data-status="fail"]', { has: on.locator('code', { hasText: selector }) }).first();
  await cardOf(panel, '#none-button').locator('button.dismiss').click();
  await expect(panel.locator('#action-status')).toHaveText('Decision saved: Dismissed.');
  await cardOf(panel, '#none-link').locator('button.confirm').click();
  await expect(cardOf(panel, '#none-link').locator('.decision-state')).toHaveText('Decision: Confirmed');

  // Where it is kept: storage.local of the extension, under the address of the page.
  const stored = await panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: { storage: { local: { get(): Promise<Record<string, unknown>> }; sync: { get(): Promise<Record<string, unknown>> } } } }).chrome.storage;
    return { local: await api.local.get(), sync: await api.sync.get() };
  });
  const key = Object.keys(stored.local).find((name) => name.startsWith('decisions:'))!;
  expect(key).toMatch(/^decisions:http:\/\/127\.0\.0\.1:\d+\/focus-indicator\/outline-none\.html$/);
  expect(Object.values((stored.local[key] as { entries: Record<string, { decision: string }> }).entries).map((entry) => entry.decision).sort()).toEqual(['confirmed', 'dismissed']);
  expect(stored.sync).toEqual({});

  // A panel opened anew knows nothing until the page is scanned again; then the decisions are back.
  await panel.close();
  const again = await extension.openPanel(tabId);
  await scan(again, ['focus-indicator']);
  await expect(cardOf(again, '#none-button').locator('.decision-state')).toHaveText('Decision: Dismissed');
  await expect(cardOf(again, '#none-button').locator('button.dismiss')).toHaveAttribute('aria-pressed', 'true');
  await expect(cardOf(again, '#none-link').locator('button.confirm')).toHaveAttribute('aria-pressed', 'true');
  // "Show" narrows the queue to what was decided.
  await again.locator('#show').selectOption('dismissed');
  await expect(again.locator('article.finding')).toHaveCount(1);
  // Taking a decision back removes it.
  await again.locator('article.finding button.dismiss').click();
  await expect(again.locator('#action-status')).toHaveText('Decision saved: Not decided.');
  expect((await exportedJson(again)).a11yVision.review.decisions.map((entry) => entry.decision)).toEqual(['confirmed']);
  await again.close();
});

const storedDecisions = async (panel: Page): Promise<{ decision: string | null; note: string }[]> => {
  const stored = await panel.evaluate(() => (globalThis as unknown as { chrome: { storage: { local: { get(): Promise<Record<string, unknown>> } } } }).chrome.storage.local.get());
  const key = Object.keys(stored).find((name) => name.startsWith('decisions:'));
  return key ? Object.values((stored[key] as { entries: Record<string, { decision: string | null; note: string }> }).entries).map(({ decision, note }) => ({ decision, note })) : [];
};

test('a note followed at once by a decision keeps both', async ({ panelFor }) => {
  const { panel } = await panelFor('/focus-indicator/outline-none.html');
  await scan(panel, ['focus-indicator']);
  // In one task, as a click on Confirm that also takes focus out of the note does it.
  await panel.locator('article.finding[data-status="fail"]').first().evaluate((node: HTMLElement) => {
    const note = node.querySelector('textarea')!;
    note.value = 'Seen with the keyboard.';
    note.dispatchEvent(new Event('change', { bubbles: true }));
    node.querySelector<HTMLElement>('button.confirm')!.click();
  });
  await expect(panel.locator('#action-status')).toHaveText('Decision saved: Confirmed.');
  await expect.poll(() => storedDecisions(panel)).toEqual([{ decision: 'confirmed', note: 'Seen with the keyboard.' }]);
  expect((await exportedJson(panel)).a11yVision.review.decisions.map(({ decision, note }) => ({ decision, note }))).toEqual([{ decision: 'confirmed', note: 'Seen with the keyboard.' }]);
});

test('a note is saved while it is typed, without moving focus or replacing the field', async ({ panelFor }) => {
  const { panel } = await panelFor('/focus-indicator/outline-none.html');
  await scan(panel, ['focus-indicator']);
  const note = panel.locator('article.finding[data-status="fail"]').first().locator('textarea');
  await note.evaluate((field) => ((field as unknown as { marked: boolean }).marked = true));
  await note.focus();
  await panel.keyboard.type('Typed and left');
  // No blur: the note is in storage a moment after the last key.
  await expect.poll(() => storedDecisions(panel)).toEqual([{ decision: null, note: 'Typed and left' }]);
  await expect(note).toBeFocused();
  expect(await note.evaluate((field) => (field as unknown as { marked?: boolean }).marked === true && (field as HTMLTextAreaElement).selectionStart === 14)).toBe(true);
  // Saving while typing is not announced: the announcement comes when the field is left.
  await expect(panel.locator('#action-status')).toHaveText('');
  await panel.keyboard.type(' there');
  await panel.keyboard.press('Tab');
  await expect(panel.locator('#action-status')).toHaveText('Note saved.');
  await expect.poll(() => storedDecisions(panel)).toEqual([{ decision: null, note: 'Typed and left there' }]);
});

test.describe('highlight', () => {
  for (const [name, path, selector] of [
    ['an element of the page', '/focus-indicator/taller-than-viewport.html', null],
    ['an element in an open shadow root', '/focus-indicator/shadow-dom.html', '#host >>> #bad'],
    ['an element in a same-origin iframe', '/focus-indicator/iframe.html', '#bad'],
  ] as const) {
    test(`shows ${name} and goes away`, async ({ panelFor, extension }) => {
      const { page, panel, tabId } = await panelFor(path);
      await scan(panel, ['focus-indicator']);
      const cards = panel.locator('article.finding').filter({ has: panel.locator('.rule', { hasNotText: 'focus-indicator/walk' }) });
      const card = selector ? cards.filter({ has: panel.locator('.where code', { hasText: selector }) }).first() : cards.last();
      const button = card.locator('button.highlight');
      const before = await page.screenshot();
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await expect(panel.locator('#action-status')).toContainText('highlighted');
      // Chrome draws its overlay over the element: the picture of the page changes.
      const during = await page.screenshot();
      expect(during.equals(before)).toBe(false);
      expect(await extension.attached(tabId)).toBe(true);
      // Nothing was put into the document for it.
      expect(await page.evaluate(() => document.querySelectorAll('[style*="outline"], [data-a11y-vision]').length)).toBe(0);

      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'false');
      await expect(panel.locator('#action-status')).toHaveText('The highlight was removed.');
      expect(await extension.attached(tabId)).toBe(false);
      // The overlay is gone. The scroll position stays where the highlight put it.
      const scroll = await page.evaluate(() => window.scrollY);
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'false');
      expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
      const after = await page.screenshot();
      expect(after.equals(during)).toBe(false);
    });
  }

  test('scrolls the element into view, and says so when it is gone', async ({ panelFor }) => {
    const { page, panel } = await panelFor('/_ci/ext-many.html?n=8');
    // The last button far below the first screen.
    await page.evaluate(() => {
      const last = document.getElementById('b7')!;
      last.style.display = 'block';
      last.style.marginTop = '3000px';
    });
    const inView = () =>
      page.evaluate(() => {
        const box = document.getElementById('b7')!.getBoundingClientRect();
        return box.top >= 0 && box.bottom <= window.innerHeight;
      });
    expect(await inView()).toBe(false);
    await scan(panel, ['focus-indicator']);
    await page.evaluate(() => window.scrollTo(0, 0));
    const card = panel.locator('article.finding', { has: panel.locator('.where code', { hasText: /^#b7$/ }) }).first();
    await card.locator('button.highlight').click();
    await expect(card.locator('button.highlight')).toHaveAttribute('aria-pressed', 'true');
    expect(await inView()).toBe(true);
    await card.locator('button.highlight').click();

    await page.evaluate(() => document.getElementById('b6')!.remove());
    const gone = panel.locator('article.finding', { has: panel.locator('.where code', { hasText: /^#b6$/ }) }).first();
    await gone.locator('button.highlight').click();
    await expect(panel.locator('#action-status')).toContainText('no longer on the page');
    await expect(gone.locator('button.highlight')).toHaveAttribute('aria-pressed', 'false');
  });

  test('is refused when the tab shows another document than the one that was scanned', async ({ panelFor, extension, baseURL }) => {
    const { page, panel, tabId } = await panelFor('/focus-indicator/outline-none.html');
    await scan(panel, ['focus-indicator']);
    const button = panel.locator('article.finding[data-status="fail"]', { has: panel.locator('code', { hasText: '#none-button' }) }).first().locator('button.highlight');
    // The same document under another address (a fragment) is still the page that was scanned.
    await page.evaluate(() => history.pushState(null, '', '#later'));
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'false');

    // Another document, with an element the selector of the finding names.
    await page.goto(new URL('/_ci/ext-hostile.html', baseURL).href);
    await page.evaluate(() => document.body.insertAdjacentHTML('afterbegin', '<button id="none-button">another page</button>'));
    const picture = await page.screenshot();
    await button.click();
    await expect(panel.locator('#action-status')).toHaveText(/no longer shows the page that was scanned.*Scan again/);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(await extension.attached(tabId)).toBe(false);
    expect((await page.screenshot()).equals(picture)).toBe(true);
  });

  test('is refused while another tab is in front of the one that was scanned', async ({ panelFor, extension, baseURL }) => {
    const { panel, tabId } = await panelFor('/focus-indicator/outline-none.html');
    await scan(panel, ['focus-indicator']);
    const other = await extension.openTab(new URL('/focus-indicator/outline-none.html', baseURL).href);
    const button = panel.locator('article.finding[data-status="fail"]').first().locator('button.highlight');
    await button.click();
    await expect(panel.locator('#action-status')).toHaveText(/not the tab in front/);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(await extension.attached(tabId)).toBe(false);
    expect(await extension.attached(other.tabId)).toBe(false);
    await other.page.close();
  });
});

test.describe('a scan that is disturbed stops, puts the page back and reports nothing', () => {
  const begin = async (panel: Page): Promise<number> => {
    const before = await scansEnded(panel);
    await startScan(panel, ['focus-indicator']);
    await expect(panel.locator('#status')).toHaveText(/Reading the page/);
    // Well into the walk.
    await expect(panel.locator('#counts')).toHaveText(/[1-9]\d* Tab presses/);
    return before;
  };
  /**
   * The state of the page, without the height of its viewport: Chrome's bar ("... is debugging
   * this browser") takes room above the page while it shows and is taken away by Chrome some
   * time after the debugger is detached, which is not the page's doing nor the scan's.
   */
  const settled = async (page: Page) => ({ ...(await pageState(page)), height: 0 });
  const restored = async (page: Page, before: Awaited<ReturnType<typeof pageState>>): Promise<void> => {
    await expect.poll(() => settled(page)).toEqual({ ...before, height: 0 });
  };

  test('the Stop button', async ({ panelFor, extension }) => {
    const { page, panel, tabId } = await panelFor('/_ci/ext-many.html');
    const state = await pageState(page);
    const before = await begin(panel);
    await expect(panel.locator('#scan')).toHaveText('Stop the scan');
    await panel.locator('#scan').click();
    await scanEnded(panel, before);
    await expect(panel.locator('#error')).toHaveText(/^The scan was stopped\. The page was put back/);
    await expect(panel.locator('#results')).toBeHidden();
    await restored(page, state);
    expect(await extension.attached(tabId)).toBe(false);
    // And the next scan runs as if nothing had happened.
    await scan(panel, ['icon-contrast']);
    await expect(panel.locator('#results')).toBeVisible();
  });

  test('the pointer moving over the page', async ({ panelFor, extension }) => {
    const { page, panel, tabId } = await panelFor('/_ci/ext-many.html');
    const state = await pageState(page);
    const before = await begin(panel);
    await page.mouse.move(200, 200);
    await page.mouse.move(210, 205);
    await scanEnded(panel, before);
    await expect(panel.locator('#error')).toHaveText(/because (the page was used|the pointer is over the page)/);
    await expect(panel.locator('#results')).toBeHidden();
    await page.mouse.move(0, 0);
    await restored(page, state);
    expect(await extension.attached(tabId)).toBe(false);
  });

  test('a key pressed in the page', async ({ panelFor, extension }) => {
    const { page, panel, tabId } = await panelFor('/_ci/ext-many.html');
    const before = await begin(panel);
    await page.keyboard.press('a');
    await scanEnded(panel, before);
    await expect(panel.locator('#error')).toHaveText(/because the page was used/);
    expect(await extension.attached(tabId)).toBe(false);
  });

  test('the tab going to another page', async ({ panelFor, extension, baseURL }) => {
    const { page, panel, tabId } = await panelFor('/_ci/ext-many.html');
    const before = await begin(panel);
    await page.goto(new URL('/noop/basic.html', baseURL).href);
    await scanEnded(panel, before);
    await expect(panel.locator('#error')).toHaveText(/because the tab went to another page/);
    await expect(panel.locator('#results')).toBeHidden();
    expect(await extension.attached(tabId)).toBe(false);
    // The page it went to is as a page is: nothing of the scan is left on it.
    expect(await page.evaluate(() => [window.devicePixelRatio, document.adoptedStyleSheets.length])).toEqual([1, 0]);
  });

  test('another tab coming to the front', async ({ panelFor, extension, baseURL }) => {
    const { page, panel, tabId } = await panelFor('/_ci/ext-many.html');
    const state = await pageState(page);
    const before = await begin(panel);
    const other = await extension.openTab(new URL('/noop/basic.html', baseURL).href);
    await scanEnded(panel, before);
    await expect(panel.locator('#error')).toHaveText(/because the tab was hidden/);
    expect(await extension.attached(tabId)).toBe(false);
    await other.page.close();
    await page.bringToFront();
    await restored(page, state);
  });

  test('the debugger being detached from outside', async ({ panelFor, extension }) => {
    const { panel, tabId } = await panelFor('/_ci/ext-many.html');
    const before = await begin(panel);
    // The bar's Cancel cannot be clicked from a test; this ends the session from the service worker instead.
    await extension.worker.evaluate((id) => (globalThis as unknown as { chrome: { debugger: { detach(t: object): Promise<void> } } }).chrome.debugger.detach({ tabId: id }), tabId);
    await scanEnded(panel, before);
    await expect(panel.locator('#error')).toHaveText(/because (the debugger was detached|debugging was cancelled)/);
    await expect(panel.locator('#results')).toBeHidden();
    expect(await extension.attached(tabId)).toBe(false);
  });

  test('the tab being closed', async ({ panelFor }) => {
    const { page, panel } = await panelFor('/_ci/ext-many.html');
    const before = await begin(panel);
    await page.close();
    await scanEnded(panel, before);
    // Whatever notices first (the session ending, the tab being removed, a command that fails), the panel says the one thing that happened.
    await expect(panel.locator('#error')).toHaveText('The scan was stopped because the tab was closed.');
  });

  test('the panel being closed: the service worker puts focus, scroll and style sheets back, then detaches', async ({ panelFor, extension }) => {
    const { page, panel, tabId } = await panelFor('/_ci/ext-many.html');
    await page.evaluate(() => {
      window.scrollTo(0, 120);
      document.getElementById('b3')?.focus({ preventScroll: true });
    });
    const state = await pageState(page);
    expect([state.active, state.windowScroll[1]]).toEqual(['b3', 120]);
    await begin(panel);
    expect(await extension.attached(tabId)).toBe(true);
    await panel.close();
    await expect.poll(() => extension.attached(tabId)).toBe(false);
    // Detaching ends the overrides of the scan; what the scan did inside the page was undone before that.
    await restored(page, state);
  });

  test('a page that stops answering (a dialog of its own) does not hold a stopped scan', async ({ panelFor, extension }) => {
    const { page, panel, tabId } = await panelFor('/_ci/ext-many.html');
    const before = await begin(panel);
    // A listener that leaves the dialog open: the page answers nothing while it shows.
    const dialogs: Dialog[] = [];
    page.on('dialog', (dialog) => dialogs.push(dialog));
    await page.evaluate(() => void setTimeout(() => alert('The page asks something.'), 0));
    await expect.poll(() => dialogs.length).toBe(1);
    await panel.locator('#scan').click();
    await scanEnded(panel, before);
    // It says that the page may not be as it was: nothing could be put back through a page that does not answer.
    await expect(panel.locator('#error')).toHaveText(/^The scan was stopped\..*did not answer.*[Rr]eload/);
    await expect(panel.locator('#scan')).toHaveText('Scan this page');
    await dialogs[0]!.dismiss().catch(() => undefined);
    await expect.poll(() => extension.attached(tabId)).toBe(false);
  });

  test('Scan activated twice in a row starts one scan, and Stop stops it', async ({ panelFor, extension }) => {
    const { panel, tabId } = await panelFor('/_ci/ext-many.html');
    await panel.evaluate(() => {
      const button = document.getElementById('scan')!;
      button.click();
      button.click();
    });
    await expect(panel.locator('#counts')).toHaveText(/[1-9]\d* Tab presses/);
    // The scan is this panel's, and the button still stops it.
    await expect(panel.locator('#scan')).toHaveText('Stop the scan');
    await expect(panel.locator('#error')).toHaveText('');
    expect(await extension.attached(tabId)).toBe(true);
    await panel.locator('#scan').click();
    await expect.poll(() => scansEnded(panel)).toBe(1);
    await expect(panel.locator('#error')).toHaveText(/^The scan was stopped\. The page was put back/);
    await expect(panel.locator('#scan')).toHaveText('Scan this page');
    expect(await extension.attached(tabId)).toBe(false);
  });
});

test('a page of Chrome itself cannot be scanned, and the panel says why', async ({ extension }) => {
  const { page, tabId } = await extension.openTab('chrome://version/');
  const panel = await extension.openPanel(tabId);
  const before = await scansEnded(panel);
  await startScan(panel, ['focus-indicator']);
  await scanEnded(panel, before);
  await expect(panel.locator('#error')).toHaveText(/^The debugger could not be attached to this tab/);
  await expect(panel.locator('#results')).toBeHidden();
  await panel.close();
  await page.close();
});

test('text of the page is shown as text, never as markup', async ({ panelFor }) => {
  const { panel } = await panelFor('/_ci/ext-hostile.html');
  await scan(panel, ['focus-indicator', 'icon-contrast', 'headings']);
  const texts = await panel.locator('article.finding').allInnerTexts();
  // The hostile strings are there, as characters.
  expect(texts.some((text) => text.includes('<img src=x onerror='))).toBe(true);
  expect(texts.some((text) => text.includes('<script>window.__pwned=1</script>'))).toBe(true);
  // And made nothing: no element of theirs, no script run, no picture that is not a capture.
  expect(await panel.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await panel.locator('#findings script, #findings b, #findings img:not([src^="blob:"])').count()).toBe(0);
  for (const kind of ['html', 'json', 'sarif'] as const) {
    const file = await exported(panel, kind);
    expect(file.text.length).toBeGreaterThan(100);
    if (kind === 'html') expect(file.text).not.toMatch(/<img src=x|<script>window\.__pwned/);
  }
});

test.describe('the model', () => {
  const KEY = 'sk-ext-e2e-0123456789-SECRET';
  /** The mock answers the preflight and allows the extension, as a local server is told to (CORS): no host permission can be granted from a test. */
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' };
  const answer = (request: MockRequest) => (request.method === 'OPTIONS' ? { status: 204, headers: cors, body: '' } : { ...verdict('yes'), headers: cors });

  const configure = async (panel: Page, values: { baseUrl: string; model: string; key?: string; enabled?: boolean; allowRemote?: boolean }): Promise<void> => {
    await panel.locator('#settings > summary').click();
    await panel.locator('#model-enabled').setChecked(values.enabled ?? true);
    await panel.locator('#base-url').fill(values.baseUrl);
    await panel.locator('#model-name').fill(values.model);
    if (values.key !== undefined) await panel.locator('#api-key').fill(values.key);
    await panel.locator('#allow-remote').setChecked(values.allowRemote ?? false);
    await panel.locator('#save-settings').click();
  };

  test('is off by default, and nothing is sent', async ({ panelFor }) => {
    const mock = await startMockModel(answer);
    try {
      const { panel } = await panelFor('/headings/baseline.html');
      await expect(panel.locator('#model-enabled')).not.toBeChecked();
      await expect(panel.locator('#model-notice')).toBeHidden();
      await scan(panel, ['headings']);
      expect(mock.requests).toEqual([]);
      expect((await exportedJson(panel)).a11yVision.findings.every((finding) => finding.ai === undefined)).toBe(true);
    } finally {
      await mock.close();
    }
  });

  test('is asked from the extension, with the key from local storage, which appears nowhere else', async ({ panelFor, extension }) => {
    const mock = await startMockModel(answer);
    try {
      const { page, panel } = await panelFor('/headings/baseline.html');
      const pageRequests: string[] = [];
      page.on('request', (request) => pageRequests.push(request.url()));
      const logs: string[] = [];
      panel.on('console', (message) => logs.push(message.text()));
      await configure(panel, { baseUrl: mock.baseUrl, model: 'mock-model', key: KEY });
      await expect(panel.locator('#settings-status')).toHaveText('Model settings saved.');
      await expect(panel.locator('#api-key')).toHaveValue('');
      await expect(panel.locator('#api-key-state')).toHaveText(/A key is stored/);
      await expect(panel.locator('#model-notice')).toHaveText(/text and captures of the page go to the model mock-model on 127\.0\.0\.1 \(this machine\)/);
      // Chrome is asked for this origin and no other.
      await expect(panel.locator('#permission-status')).toContainText(`http://127.0.0.1:${mock.port}/*`);

      await scan(panel, ['headings']);
      const posts = mock.requests.filter((request) => request.method === 'POST');
      expect(posts.length).toBeGreaterThan(0);
      for (const request of posts) {
        expect(request.path).toBe('/v1/chat/completions');
        expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
        // Sent by the extension, not by the page under test, and without the page's cookies.
        expect(request.headers.origin).toBe(`chrome-extension://${extension.id}`);
        expect(request.headers.cookie).toBeUndefined();
        expect(request.headers.referer).toBeUndefined();
      }
      expect(pageRequests.filter((url) => url.includes(`:${mock.port}/`))).toEqual([]);

      const report = await exportedJson(panel);
      const judged = report.a11yVision.findings.filter((finding) => finding.ai);
      expect(judged.length).toBeGreaterThan(0);
      expect(judged.every((finding) => finding.status !== 'fail' && finding.ai!.model === 'mock-model')).toBe(true);
      await expect(panel.locator('#results-note')).toContainText('candidates judged now');
      await expect(panel.locator('article.finding .verdict').first()).toHaveText('Model: yes');

      // The key: in storage.local under its own name, and in no export, no text of the panel, no log.
      const stored = await panel.evaluate(async () => {
        const api = (globalThis as unknown as { chrome: { storage: { local: { get(): Promise<Record<string, unknown>> }; sync: { get(): Promise<Record<string, unknown>> } } } }).chrome.storage;
        return { local: await api.local.get(), sync: await api.sync.get() };
      });
      expect(stored.local['secret.apiKey']).toBe(KEY);
      expect(JSON.stringify(stored.local['settings'])).not.toContain(KEY);
      expect(JSON.stringify({ ...stored.local, 'secret.apiKey': '' })).not.toContain(KEY);
      expect(stored.sync).toEqual({});
      for (const kind of ['json', 'html', 'sarif'] as const) {
        const text = (await exported(panel, kind)).text;
        expect(text).not.toContain(KEY);
        expect(text).not.toContain(mock.baseUrl);
      }
      expect(await panel.locator('body').innerText()).not.toContain(KEY);
      expect(await panel.content()).not.toContain(KEY);
      expect(logs.join('\n')).not.toContain(KEY);
      // The page under test cannot read the storage of the extension.
      expect(await page.evaluate(() => typeof (globalThis as unknown as { chrome?: { storage?: unknown } }).chrome?.storage)).toBe('undefined');

      // An unchanged page is not judged again: the verdicts come from the cache kept in storage.local.
      const sent = mock.requests.length;
      await scan(panel, ['headings']);
      expect(mock.requests.length).toBe(sent);
      await expect(panel.locator('#results-note')).toContainText('0 candidates judged now');

      // Removing the key removes it from storage.
      await panel.locator('#remove-key').click();
      await expect(panel.locator('#settings-status')).toHaveText('The stored key was removed.');
      expect(await panel.evaluate(async () => Object.keys(await (globalThis as unknown as { chrome: { storage: { local: { get(): Promise<Record<string, unknown>> } } } }).chrome.storage.local.get()))).not.toContain('secret.apiKey');
    } finally {
      await mock.close();
    }
  });

  test('an endpoint on another machine is refused unless allowed, and never over plain http', async ({ panelFor }) => {
    const { panel } = await panelFor('/headings/baseline.html');
    await configure(panel, { baseUrl: 'https://models.example.test/v1', model: 'm' });
    await expect(panel.locator('#settings-error')).toHaveText(/not on this machine.*allowed explicitly/);
    await expect(panel.locator('#model-notice')).toBeHidden();
    await panel.locator('#settings > summary').click();
    await configure(panel, { baseUrl: 'http://models.example.test/v1', model: 'm', allowRemote: true });
    await expect(panel.locator('#settings-error')).toHaveText(/has to be an https URL/);
    await panel.locator('#settings > summary').click();
    await configure(panel, { baseUrl: 'https://user:pw@localhost/v1', model: 'm' });
    await expect(panel.locator('#settings-error')).toHaveText(/must not carry a user name or a password/);
    await panel.locator('#settings > summary').click();
    await configure(panel, { baseUrl: 'http://localhost:1/v1', model: '' });
    await expect(panel.locator('#settings-error')).toHaveText(/Give the name of the model/);
    // None of it was saved: the model is still off.
    expect(
      await panel.evaluate(async () => (await (globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, { model?: { enabled?: boolean } }>> } } } }).chrome.storage.local.get('settings'))['settings']?.model?.enabled ?? false),
    ).toBe(false);
    // Allowed, over https: saved, and the panel says where the page will go.
    await panel.locator('#settings > summary').click();
    await configure(panel, { baseUrl: 'https://models.example.test/v1', model: 'm', allowRemote: true });
    await expect(panel.locator('#settings-status')).toHaveText('Model settings saved.');
    await expect(panel.locator('#model-notice')).toHaveText(/on models\.example\.test, which is NOT this machine/);
  });

  test('Stop while the model is asked: nothing more is sent', async ({ panelFor }) => {
    const mock = await startMockModel((request) => {
      if (request.method === 'OPTIONS') return { status: 204, headers: cors, body: '' };
      return { ...verdict('yes'), headers: cors, delayMs: 700 };
    });
    try {
      const { panel } = await panelFor('/headings/baseline.html');
      await configure(panel, { baseUrl: mock.baseUrl, model: 'slow' });
      await expect(panel.locator('#settings-status')).toHaveText('Model settings saved.');
      const before = await scansEnded(panel);
      await startScan(panel, ['headings']);
      await expect(panel.locator('#status')).toHaveText(/Asking the model/);
      const posts = (): number => mock.requests.filter((request) => request.method === 'POST').length;
      await expect.poll(posts).toBeGreaterThan(0);
      await panel.locator('#scan').click();
      await scanEnded(panel, before);
      await expect(panel.locator('#results-note')).toContainText('Asking the model was stopped');
      const atStop = posts();
      // Long enough for several more rounds of requests, had they gone on.
      await panel.waitForTimeout(2500);
      expect(posts()).toBe(atStop);
      // The findings are those of deterministic code.
      expect((await exportedJson(panel)).a11yVision.findings.every((finding) => finding.ai === undefined)).toBe(true);
    } finally {
      await mock.close();
    }
  });

  test('a loopback address the extension cannot reach over http is refused with the reason', async ({ panelFor }) => {
    const { panel } = await panelFor('/headings/baseline.html');
    await panel.locator('#settings > summary').click();
    const save = async (baseUrl: string): Promise<void> => {
      await panel.locator('#model-enabled').setChecked(true);
      await panel.locator('#base-url').fill(baseUrl);
      await panel.locator('#model-name').fill('m');
      await panel.locator('#save-settings').click();
    };
    for (const baseUrl of ['http://[::1]:11434/v1', 'http://127.0.0.2:11434/v1', 'http://localhost.:11434/v1']) {
      await save(baseUrl);
      await expect(panel.locator('#settings-error'), baseUrl).toHaveText(/Over plain http this extension can only reach localhost, a name under \.localhost, or 127\.0\.0\.1/);
      await expect(panel.locator('#model-notice')).toBeHidden();
    }
    // The forms it can reach.
    for (const baseUrl of ['http://localhost:11434/v1', 'http://ai.localhost:11434/v1', 'http://127.0.0.1:11434/v1', 'https://[::1]:8443/v1']) {
      await save(baseUrl);
      await expect(panel.locator('#settings-error'), baseUrl).toHaveText('');
      await expect(panel.locator('#settings-status'), baseUrl).toHaveText('Model settings saved.');
      await expect(panel.locator('#model-notice')).toHaveText(/\(this machine\)/);
    }
  });

  test('an endpoint that does not answer leaves the findings of deterministic code', async ({ panelFor }) => {
    const { panel } = await panelFor('/headings/baseline.html');
    // A port nothing listens on.
    await configure(panel, { baseUrl: 'http://127.0.0.1:9/v1', model: 'gone' });
    await scan(panel, ['headings']);
    const report = await exportedJson(panel);
    const title = report.a11yVision.findings.find((finding) => finding.selector === '#title')!;
    expect(title.status).toBe('likely');
    expect(title.ai?.verdict).toBe('unsure');
  });
});

test.describe('the panel itself', () => {
  test('holds up against the checks of the tool, in the light and in the dark scheme', async ({ panelFor }) => {
    test.slow();
    const { panel } = await panelFor('/focus-indicator/outline-none.html');
    await scan(panel, ['focus-indicator', 'icon-contrast']);
    await panel.locator('#settings > summary').click();
    for (const scheme of ['light', 'dark'] as const) {
      await panel.emulateMedia({ colorScheme: scheme });
      const result = await new A11yVision({ page: panel }).analyze();
      const serious = result.findings.filter((finding) => finding.status === 'fail' || finding.status === 'likely').map(({ rule, selector, status, message }) => ({ rule, selector, status, message }));
      expect(serious, `${scheme} scheme`).toEqual([]);
      // Every control was reached by Tab and shows where focus is.
      const walk = result.findings.find((finding) => finding.rule === 'focus-indicator/walk')!;
      expect(walk.evidence.flags).toContain('cycle');
    }
  });

  test('is operable with the keyboard alone, and says what it does', async ({ panelFor }) => {
    const { panel } = await panelFor('/focus-indicator/outline-none.html');
    await expect(panel).toHaveTitle('a11y-vision');
    await expect(panel.locator('html')).toHaveAttribute('lang', 'en');
    // Every control has a name.
    const unnamed = await panel.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('button, input, select, textarea')].filter((control) => {
        const labelled = (control as HTMLInputElement).labels?.length || control.getAttribute('aria-label') || control.getAttribute('aria-labelledby');
        return !(control.tagName === 'BUTTON' ? control.textContent?.trim() : labelled);
      }).length,
    );
    expect(unnamed).toBe(0);
    // Start a scan from the keyboard; the result is announced, and focus goes to the findings.
    await panel.locator('#check-focus-indicator').focus();
    for (const id of ['check-icon-contrast', 'check-headings', 'check-lists', 'check-grouping']) {
      await panel.keyboard.press('Tab');
      await expect(panel.locator(`#${id}`)).toBeFocused();
      await panel.keyboard.press('Space');
      await expect(panel.locator(`#${id}`)).not.toBeChecked();
    }
    await panel.keyboard.press('Tab');
    await expect(panel.locator('#scan')).toBeFocused();
    const before = await scansEnded(panel);
    await panel.keyboard.press('Enter');
    await scanEnded(panel, before);
    await expect(panel.locator('#status')).toHaveAttribute('role', 'status');
    await expect(panel.locator('#status')).toHaveText(/^Scan finished: \d+ findings\. 2 fail, /);
    await expect(panel.locator('#results-heading')).toBeFocused();
    // A status is a word, not a colour.
    await expect(panel.locator('article.finding[data-status="fail"] .status').first()).toHaveText('Fail');
    // Decide from the keyboard.
    const confirm = panel.locator('article.finding[data-status="fail"] button.confirm').first();
    await confirm.focus();
    await panel.keyboard.press('Space');
    await expect(confirm).toHaveAttribute('aria-pressed', 'true');
    await expect(confirm).toBeFocused();
    await expect(panel.locator('#action-status')).toHaveAttribute('aria-live', 'polite');
    // No wording that a page passes or conforms.
    expect(await panel.locator('body').innerText()).not.toMatch(/\bpass(es|ed)?\b|\bcompliant\b|is accessible/i);
  });

  test('ties the controls of a card to its finding, and announces what a filter shows', async ({ panelFor }) => {
    const { panel } = await panelFor('/focus-indicator/outline-none.html');
    await scan(panel, ['focus-indicator']);
    const total = await panel.locator('article.finding').count();
    const cards = panel.locator('article.finding[data-status="fail"]');
    const descriptions = new Set<string>();
    for (const card of [cards.nth(0), cards.nth(1)]) {
      const selector = (await card.locator('.where code').first().textContent())!;
      const rule = (await card.locator('.rule').textContent())!;
      const expected = `Fail ${rule} Selector: ${selector}`;
      descriptions.add(expected);
      // The name is the visible label; the finding is the description, read after name, role and state.
      await expect(card.getByRole('button', { name: 'Confirm', exact: true })).toHaveAccessibleDescription(expected);
      await expect(card.getByRole('button', { name: 'Dismiss', exact: true })).toHaveAccessibleDescription(expected);
      await expect(card.getByRole('button', { name: 'Show on the page', exact: true })).toHaveAccessibleDescription(expected);
      await expect(card.getByRole('textbox', { name: 'Note (optional)', exact: true })).toHaveAccessibleDescription(expected);
    }
    expect(descriptions.size).toBe(2);

    await cards.nth(0).locator('button.confirm').click();
    await panel.locator('#show').selectOption('confirmed');
    await expect(panel.locator('#action-status')).toHaveText(`Showing 1 of ${total} findings.`);
    await panel.locator('#show').selectOption('dismissed');
    await expect(panel.locator('#action-status')).toHaveText(`Showing 0 of ${total} findings.`);
    await panel.locator('#show').selectOption('all');
    await expect(panel.locator('#action-status')).toHaveText(`Showing ${total} of ${total} findings.`);
  });

  test('reflows without a horizontal scroll bar in a 360 px panel, at 100% and at 400% zoom', async ({ panelFor }) => {
    const { panel } = await panelFor('/focus-indicator/outline-none.html');
    await scan(panel, ['focus-indicator', 'icon-contrast']);
    await panel.locator('#settings > summary').click();
    await panel.locator('article.finding details > summary').first().click();
    // 400% zoom of a panel 360 px wide leaves the page 90 CSS px.
    for (const width of [360, 90]) {
      await panel.setViewportSize({ width, height: 800 });
      const measured = await panel.evaluate(() => {
        const root = document.scrollingElement!;
        const beyond = [...document.querySelectorAll<HTMLElement>('body *')]
          .filter((element) => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && (box.right > window.innerWidth + 0.5 || box.left < -0.5);
          })
          .map((element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.className ? `.${element.className}` : ''}`);
        return { viewport: window.innerWidth, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, beyond: [...new Set(beyond)] };
      });
      expect(measured.viewport, `${width} px`).toBe(width);
      expect(measured.beyond, `${width} px`).toEqual([]);
      expect(measured.scrollWidth, `${width} px`).toBeLessThanOrEqual(measured.clientWidth);
      // The text column of a card is not squeezed to nothing by the boxes around it.
      expect(await panel.locator('article.finding .message').first().evaluate((node) => node.getBoundingClientRect().width), `${width} px`).toBeGreaterThanOrEqual(width * 0.75);
    }
  });
});
