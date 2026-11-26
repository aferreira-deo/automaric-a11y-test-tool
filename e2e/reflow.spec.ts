import { resolveConfig } from '@a11y-vision/core';
import type { ConfigInput, Finding } from '@a11y-vision/core';
import { A11yVision } from '@a11y-vision/playwright';
import { devices, expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import type * as CollectorModule from '../packages/collector-cdp/src/index.js';

/**
 * The reflow check beyond its manifests: the page is given back as it was (viewport, scroll
 * positions, focus, style sheets), also after a scan that was stopped in the middle of a pass;
 * two scans agree; the passes and the status of `sticky-obscures` follow the configuration; the
 * evidence is taken at the viewport of the pass.
 */

const reflow = (page: Page, options: ConfigInput = {}) => new A11yVision({ page }).options({ ...options, checks: ['reflow'] });

/** Everything the reflow check changes while it runs and promises to put back. */
function pageState(page: Page) {
  return page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    screen: [screen.width, screen.height],
    visual: [Math.round(window.visualViewport!.width), Math.round(window.visualViewport!.height), window.visualViewport!.scale],
    windowScroll: [window.scrollX, window.scrollY],
    strip: document.getElementById('strip')!.scrollLeft,
    box: document.getElementById('box')!.scrollTop,
    frameScroll: (document.getElementById('frame') as HTMLIFrameElement).contentWindow!.scrollY,
    active: document.activeElement?.id ?? '',
    adoptedSheets: document.adoptedStyleSheets.length,
    styleElements: document.querySelectorAll('style').length,
    html: document.documentElement.outerHTML.length,
  }));
}

/** Puts the page of `restore-state.html` in a state that has something to restore everywhere. */
async function prepare(page: Page): Promise<void> {
  await page.goto('/reflow/restore-state.html');
  await page.evaluate(async () => {
    const frame = document.getElementById('frame') as HTMLIFrameElement;
    if (frame.contentDocument?.readyState !== 'complete') await new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
    document.getElementById('strip')!.scrollLeft = 4000;
    document.getElementById('box')!.scrollTop = 250;
    frame.contentWindow!.scrollTo(0, 30);
    window.scrollTo(0, 120);
    document.getElementById('field')!.focus({ preventScroll: true });
  });
}

const contexts = {
  'the default context': {},
  'an emulated desktop context': { viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1.5 },
  'an emulated mobile context': devices['Pixel 5'],
  'a context with a screen of its own': { viewport: { width: 1100, height: 700 }, screen: { width: 1600, height: 900 } },
} as const;

async function inContext<T>(browser: Browser, baseURL: string | undefined, options: object, body: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ ...options, ...(baseURL ? { baseURL } : {}) });
  try {
    return await body(await context.newPage());
  } finally {
    await context.close();
  }
}

for (const [name, options] of Object.entries(contexts)) {
  test(`the page is left as it was found: ${name}`, async ({ browser, baseURL }) => {
    await inContext(browser, baseURL, options, async (page) => {
      await prepare(page);
      const viewport = page.viewportSize();
      const before = await pageState(page);
      expect(before).toMatchObject({ strip: expect.any(Number), box: 250, frameScroll: 30, windowScroll: [0, 120], active: 'field' });
      expect(before.strip).toBeGreaterThan(1000);

      const result = await reflow(page).analyze();
      // The narrow pass did lay the page out again: the block pushes out and the columns collide.
      expect(result.findings.filter((finding) => finding.status === 'fail').map((finding) => finding.rule)).toEqual(
        expect.arrayContaining(['reflow/two-dimensional-scroll', 'reflow/text-overlap']),
      );

      expect(page.viewportSize()).toEqual(viewport);
      expect(await pageState(page)).toEqual(before);
    });
  });
}

/**
 * A default scan (every check of the default configuration) gives back exactly the emulation it found: the
 * size, device pixel ratio, screen and visual viewport, and every scroll position, also in a mobile context and
 * after `page.setViewportSize`, which Playwright would not send again by itself.
 */
const emulations: [string, object, ((page: Page) => Promise<void>) | null][] = [
  ['the default context', {}, null],
  ['a viewport set with page.setViewportSize', {}, (page) => page.setViewportSize({ width: 900, height: 600 })],
  ['a device scale factor of 1.5', { viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1.5 }, null],
  ['a mobile context', devices['Pixel 5'], null],
];
for (const [name, options, setup] of emulations) {
  test(`a default scan puts back the emulation and the scroll positions: ${name}`, async ({ browser, baseURL }) => {
    test.slow();
    await inContext(browser, baseURL, options, async (page) => {
      if (setup) await setup(page);
      await prepare(page);
      const viewport = page.viewportSize();
      const before = await pageState(page);
      await new A11yVision({ page }).options({ nameRoleValue: { probe: 'off' } }).analyze();
      expect(page.viewportSize()).toEqual(viewport);
      // The focus walk ends where it started; everything else is as it was.
      expect(await pageState(page)).toEqual(before);
      // A second scan finds the same page again.
      await new A11yVision({ page }).options({ checks: ['reflow'] }).analyze();
      expect(await pageState(page)).toEqual(before);
    });
  });
}

test('a caller whose viewport is already narrow is compared with a wide reference layout: the narrow pass still fails a fixed width', async ({ browser, baseURL }) => {
  await inContext(browser, baseURL, { viewport: { width: 375, height: 667 } }, async (page) => {
    await page.goto('/reflow/fixed-width.html');
    const { findings } = await reflow(page).analyze();
    expect(findings.filter((finding) => finding.status === 'fail').map((finding) => [finding.rule, finding.evidence.values?.['pass']])).toEqual([['reflow/two-dimensional-scroll', 'narrow']]);
    const survey = findings.find((finding) => finding.rule === 'reflow/survey')!;
    expect(survey.evidence.values).toMatchObject({ baselineViewport: '1280x720' });
    expect(survey.message).toContain('reference viewport of 1280 by 720');
    expect(page.viewportSize()).toEqual({ width: 375, height: 667 });
    expect(await page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([375, 667]);
  });
});

test('a page that reloads when the viewport changes stops the reflow survey only: the other checks report, and nothing fails', async ({ page }) => {
  await page.goto('/reflow/reload-on-resize.html');
  const { findings } = await new A11yVision({ page }).options({ checks: ['headings', 'reflow'] }).analyze();
  const survey = findings.find((finding) => finding.rule === 'reflow/survey')!;
  expect(survey.evidence.values).toMatchObject({ stopped: 'navigated' });
  expect(survey.message).toContain('stopped before its end');
  expect(findings.filter((finding) => finding.check === 'headings').length).toBeGreaterThan(0);
  expect(findings.filter((finding) => finding.status === 'fail')).toEqual([]);
  expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });
  // Putting the viewport back is one more resize: the page may be reloading once more.
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight]).catch(() => null)).toEqual([1280, 720]);
});

test('a page whose script moves text every frame is measured in bounded time, and the survey says so', async ({ page }) => {
  await page.goto('/reflow/js-motion.html');
  const started = Date.now();
  const { findings } = await reflow(page).analyze();
  // Without the motion bound every wait ran to its maximum: 23 s.
  expect(Date.now() - started).toBeLessThan(12000);
  const survey = findings.find((finding) => finding.rule === 'reflow/survey')!;
  expect(Number(survey.evidence.values?.['narrowUnsettled'])).toBeGreaterThan(0);
});

/** A scan through a bare CDP session, as the extension runs it, stopped when `when` holds in the page. */
async function stoppedScan(page: Page, when: string): Promise<void> {
  const { collectSnapshot } = (await import(new URL('../packages/collector-cdp/dist/index.js', import.meta.url).href)) as typeof CollectorModule;
  const session = await page.context().newCDPSession(page);
  const controller = new AbortController();
  const scan = collectSnapshot(
    {
      send: (method, params) => session.send(method as never, params as never),
      on: (event, handler) => void session.on(event as never, handler as never),
      off: (event, handler) => void session.off(event as never, handler as never),
    },
    resolveConfig({ checks: ['reflow'] }),
    { signal: controller.signal },
  );
  let reached = false;
  const outcome = scan.then(
    () => 'finished',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  // Polled from the page's own world, through Playwright's session: what the scan does is seen as it happens.
  for (let tries = 0; tries < 600 && !reached; tries++) {
    reached = await page.evaluate(when).catch(() => false) as boolean;
    if (!reached) await page.waitForTimeout(10);
  }
  expect(reached, `the scan reached: ${when}`).toBe(true);
  controller.abort(new Error('stopped by the test'));
  expect(await outcome).toBe('stopped by the test');
  await session.detach();
  // What the Playwright API does after any scan: Chrome holds one emulation per page, and the
  // collector can only clear it; Playwright sends its own again.
  const viewport = page.viewportSize();
  if (viewport) await page.setViewportSize(viewport);
}

for (const [moment, when] of [
  ['in the narrow pass', 'window.innerWidth === 320'],
  ['in the short pass', 'window.innerHeight === 256'],
  ['while a style sheet of a pixel test is adopted', 'window.innerWidth === 320 && document.adoptedStyleSheets.length > 1'],
] as const) {
  test(`a scan stopped ${moment} rejects and leaves the page as it was found`, async ({ page }) => {
    await prepare(page);
    const viewport = page.viewportSize();
    const before = await pageState(page);
    await stoppedScan(page, when);
    expect(page.viewportSize()).toEqual(viewport);
    // The bare session clears its emulation and the test sends Playwright's viewport again, which makes `screen`
    // the size of the viewport: Playwright's doing, not the scan's.
    const without = ({ screen: _screen, ...rest }: Awaited<ReturnType<typeof pageState>>) => rest;
    expect(without(await pageState(page))).toEqual(without(before));
  });
}

test('two scans of a page give the same report and the same captures', async ({ page }) => {
  await page.goto('/reflow/restore-state.html');
  const first = await reflow(page).analyzeWithEvidence();
  const second = await reflow(page).analyzeWithEvidence();
  expect(second.result.findings).toEqual(first.result.findings);
  expect(Object.keys(second.crops).sort()).toEqual(Object.keys(first.crops).sort());
  for (const [id, png] of Object.entries(first.crops)) expect(Buffer.from(second.crops[id]!).equals(Buffer.from(png)), id).toBe(true);
});

test('each finding says which viewport it was measured at, and its capture is of that viewport', async ({ page }) => {
  await page.goto('/reflow/fixed-width.html');
  const { result, crops } = await reflow(page).analyzeWithEvidence();
  const found = result.findings.find((finding) => finding.rule === 'reflow/two-dimensional-scroll')!;
  expect(found.evidence.values).toMatchObject({ pass: 'narrow', viewport: '320x800', innerWidth: 320, innerHeight: 800, clientWidth: 320, scrollWidth: 616 });
  const png = crops[found.evidence.crops[0]!]!;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // The viewport of the pass at the capture scale of 2.
  expect([view.getUint32(16), view.getUint32(20)]).toEqual([640, 1600]);
  expect(found.box).toMatchObject({ x: 16, width: 600 });
});

test('the scroll-locked page fails in both passes, each with its own id', async ({ page }) => {
  await page.goto('/reflow/scroll-locked.html');
  const { findings } = await reflow(page).analyze();
  const locked = findings.filter((finding) => finding.rule === 'reflow/scroll-locked');
  expect(locked.map((finding) => [finding.status, finding.evidence.values?.['viewport']]).sort()).toEqual([
    ['fail', '320x800'],
    ['fail', '800x256'],
  ]);
  expect(new Set(locked.map((finding) => finding.id)).size).toBe(2);
});

test('a pass can be switched off, the sizes changed, and the status of sticky-obscures set', async ({ page }) => {
  await page.goto('/reflow/sticky-40.html');
  const status = (findings: Finding[]) => findings.filter((finding) => finding.rule === 'reflow/sticky-obscures').map((finding) => finding.status);
  expect(status((await reflow(page, { reflow: { stickyObscuresStatus: 'fail' } }).analyze()).findings)).toEqual(['fail']);
  const without = await reflow(page, { reflow: { shortPass: false } }).analyze();
  expect(status(without.findings)).toEqual([]);
  expect(without.findings.find((finding) => finding.rule === 'reflow/survey')?.evidence.values).toMatchObject({ passes: 'narrow', passesSkipped: 'short' });
  // 320 px tall instead of 256: 48% of the viewport is taken, under the threshold no longer.
  expect(status((await reflow(page, { reflow: { shortHeightCssPx: 320 } }).analyze()).findings)).toEqual([]);
});

test('text that the narrow layout no longer displays, behind no menu button, is info', async ({ page }) => {
  await page.goto('/reflow/clean-responsive.html');
  // The menu button that the narrow layout shows is taken away: the navigation is then just gone.
  await page.addStyleTag({ content: '#menu-button { display: none !important; }' });
  await page.evaluate(() => {
    for (const link of document.querySelectorAll('#nav a')) link.textContent = `${link.textContent} — a section of the site with a long description of what it holds`;
  });
  const { findings } = await reflow(page).analyze();
  const hidden = findings.find((finding) => finding.evidence.flags.includes('notDisplayed'));
  expect(hidden).toMatchObject({ status: 'info', rule: 'reflow/content-lost' });
  expect(Number(hidden?.evidence.values?.['charsNotDisplayed'])).toBeGreaterThan(200);
});
