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
