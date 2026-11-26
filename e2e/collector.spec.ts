import { A11yVision } from '@a11y-vision/playwright';
import { toHtmlReport } from '@a11y-vision/reporters';
import { devices, expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Everything the scan changes while it runs and promises to put back. */
function pageState(page: Page) {
  return page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    moreContrast: matchMedia('(prefers-contrast: more)').matches,
    forcedColors: matchMedia('(forced-colors: active)').matches,
    print: matchMedia('print').matches,
    touchPoints: navigator.maxTouchPoints,
    active: document.activeElement?.id ?? '',
    windowScroll: [window.scrollX, window.scrollY],
    untouchedScroller: document.getElementById('scroller')!.scrollTop,
    scrolledScroller: document.getElementById('prescrolled')!.scrollTop,
    frameScroll: (document.getElementById('frame') as HTMLIFrameElement).contentWindow!.scrollY,
    frameTabindex: document.getElementById('opaque')!.getAttribute('tabindex'),
    styleElements: document.querySelectorAll('style').length,
    adoptedSheets: document.adoptedStyleSheets.length,
    html: document.documentElement.outerHTML.length,
  }));
}

const contexts = {
  'an emulated desktop context': {
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1.5,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    contrast: 'more',
  },
  // The device pixel ratio the tool captures at: nothing to change, and still everything to put back.
  'a context at the capture scale': { viewport: { width: 900, height: 650 }, deviceScaleFactor: 2 },
  'an emulated mobile context': devices['Pixel 5'],
  'a context with the default emulation': {},
} as const;

for (const [name, options] of Object.entries(contexts)) {
  test(`the page is left as it was found: ${name}`, async ({ browser, baseURL }) => {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    await page.goto(`${baseURL}/focus-indicator/restore-state.html`);
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => {
      document.getElementById('prescrolled')!.scrollTop = 40;
      (document.getElementById('frame') as HTMLIFrameElement).contentWindow!.scrollTo(0, 30);
      window.scrollTo(0, 100);
      document.getElementById('field')!.focus({ preventScroll: true });
    });
    const before = await pageState(page);
    expect(before).toMatchObject({ active: 'field', windowScroll: [0, 100], scrolledScroller: 40, frameScroll: 30, print: true });

    const result = await new A11yVision({ page }).analyze();
    // The walk did scroll the inner containers, so there was something to restore.
    expect(result.findings.map((finding) => finding.selector)).toEqual(
      expect.arrayContaining(['#inner', '#deep', '#in-frame', '#opaque', '#last']),
    );

    expect(await pageState(page)).toEqual(before);
    await context.close();
  });
}

test('the page is left as it was found by the icon-contrast check alone', async ({ page }) => {
  await page.goto('/focus-indicator/restore-state.html');
  await page.evaluate(() => {
    document.getElementById('prescrolled')!.scrollTop = 40;
    (document.getElementById('frame') as HTMLIFrameElement).contentWindow!.scrollTo(0, 30);
    window.scrollTo(0, 100);
    document.getElementById('field')!.focus({ preventScroll: true });
  });
  const before = await pageState(page);
  expect(before).toMatchObject({ active: 'field', windowScroll: [0, 100], scrolledScroller: 40, frameScroll: 30 });

  const result = await new A11yVision({ page }).withChecks(['icon-contrast']).analyze();
  // The fields were scrolled to, in the page and in the frame, so there was something to restore.
  expect(result.findings.filter((finding) => finding.rule === 'icon-contrast/boundary-measured').map((finding) => finding.selector)).toEqual(
    expect.arrayContaining(['#field', '#frame-field']),
  );

  expect(await pageState(page)).toEqual(before);
});

test('a control removed from the page after its capture is not measured', async ({ page }) => {
  await page.goto('/icon-contrast/input-boundaries.html');
  // The page renders its controls again right after each capture, as a framework re-rendering a
  // keyed list does: the node the scan holds is then detached, and has no styles to read.
  const context = page.context();
  const newSession = context.newCDPSession.bind(context);
  context.newCDPSession = async (target: Page) => {
    const session = await newSession(target);
    const send = session.send.bind(session) as (method: string, params?: object) => Promise<unknown>;
    (session as { send: unknown }).send = async (method: string, params?: object) => {
      const response = await send(method, params);
      if (method === 'Page.captureScreenshot') {
        await page.evaluate(() => {
          for (const control of document.querySelectorAll('input, select, textarea')) control.replaceWith(control.cloneNode(true));
        });
      }
      return response;
    };
    return session;
  };

  const result = await new A11yVision({ page }).withChecks(['icon-contrast']).analyze();
  const boundaries = result.findings.filter((finding) => finding.rule !== 'icon-contrast/survey');
  expect(boundaries.length).toBeGreaterThan(3);
  expect(boundaries.filter((finding) => finding.rule === 'icon-contrast/boundary-default')).toEqual([]);
  for (const finding of boundaries) {
    expect(finding, finding.selector).toMatchObject({ status: 'info', rule: 'icon-contrast/not-measured' });
    expect(finding.evidence.flags).toContain('detached');
  }
});

test('environment values are measured, not read from the page', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.goto('/focus-indicator/spoofed-environment.html');
  expect(await page.evaluate(() => typeof window.innerWidth)).toBe('string');

  const { result, crops } = await new A11yVision({ page }).analyzeWithEvidence();
  expect(result.environment).toEqual({
    url: page.url(),
    devicePixelRatio: 2,
    viewport: page.viewportSize(),
    colorScheme: 'light',
  });

  const html = toHtmlReport(result, crops);
  expect(html).not.toContain('<img src=x');
  expect(html).not.toContain('alert(2)');
  expect(html).toContain('Viewport 1280 by 720 CSS px, device pixel ratio 2, light colour scheme.');

  // The report itself must be inert when opened.
  await page.setContent(html);
  expect(dialogs).toEqual([]);
});

/**
 * Sends the page to another document in the middle of a scan: each time the collector asks for
 * the accessibility tree, which it does once the page is prepared and before any text is read,
 * the page goes to the next of `paths`, for as long as there are any.
 */
function navigatingMidScan(page: Page, paths: string[]): void {
  const context = page.context();
  const newSession = context.newCDPSession.bind(context);
  const left = [...paths];
  context.newCDPSession = async (target: Page) => {
    const session = await newSession(target);
    const send = session.send.bind(session) as (method: string, params?: object) => Promise<unknown>;
    (session as { send: unknown }).send = async (method: string, params?: object) => {
      if (method === 'Accessibility.getFullAXTree' && left.length > 0) {
        const path = left.shift()!;
        // As a redirect by script does: the document is replaced under the scan.
        await target.evaluate((to) => void setTimeout(() => location.replace(to), 0), path);
        await target.waitForURL(`**${path}`, { waitUntil: 'commit' });
      }
      return send(method, params);
    };
    return session;
  };
}

test('a page that goes to another document while it is read is read again there, once', async ({ page, baseURL }) => {
  const scan = (target: Page) => new A11yVision({ page: target }).withChecks(['headings', 'lists']).analyze();
  await page.goto('/lists/near-threshold.html');
  const direct = await scan(page);
  expect(direct.environment.navigatedFrom).toBeUndefined();

  // A page of its own: the scanner keeps one session per page, made when the page is first scanned.
  const other = await page.context().newPage();
  await other.goto('/lists/plain-text.html');
  navigatingMidScan(other, ['/lists/near-threshold.html']);
  const redirected = await scan(other);
  // The findings are those of the page the browser ended on, as if it had been scanned directly.
  expect(redirected.url).toBe(`${baseURL}/lists/near-threshold.html`);
  expect(redirected.environment.navigatedFrom).toBe(`${baseURL}/lists/plain-text.html`);
  expect(redirected.findings).toEqual(direct.findings);
  expect(redirected.findings.filter((finding) => finding.status === 'likely').length).toBeGreaterThan(3);
  // The page is given back as any scanned page is.
  expect(await other.evaluate(() => ({ sheets: document.adoptedStyleSheets.length, ratio: window.devicePixelRatio }))).toEqual({ sheets: 0, ratio: 1 });
});

test('a page that navigates during the second reading as well is an error that says so', async ({ page }) => {
  await page.goto('/lists/plain-text.html');
  navigatingMidScan(page, ['/lists/near-threshold.html', '/lists/glyph-lists.html']);
  await expect(new A11yVision({ page }).withChecks(['lists']).analyze()).rejects.toThrow(
    /went from .*plain-text\.html to .*near-threshold\.html while it was being read, and on to .*glyph-lists\.html/,
  );
});
