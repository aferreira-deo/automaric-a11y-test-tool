import { A11yVision } from '@a11y-vision/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.use({ viewport: { width: 900, height: 240 } });

test('the headings check leaves the page as it found it', async ({ page }) => {
  await page.goto('/headings/shadow-and-iframe.html');
  const state = () =>
    page.evaluate(() => ({
      scroll: [window.scrollX, window.scrollY],
      frameScroll: (document.getElementById('frame') as HTMLIFrameElement).contentWindow!.scrollY,
      active: document.activeElement?.localName,
      adoptedSheets: document.adoptedStyleSheets.length,
      html: document.documentElement.outerHTML.length,
      devicePixelRatio: window.devicePixelRatio,
      width: window.innerWidth,
    }));
  await page.evaluate(() => {
    // Low enough for its content to scroll.
    const frame = document.getElementById('frame') as HTMLIFrameElement;
    frame.height = '90';
    window.scrollTo(0, 40);
    frame.contentWindow!.scrollTo(0, 25);
  });
  const before = await state();
  expect(before).toMatchObject({ scroll: [0, 40], frameScroll: 25 });

  const { result, crops } = await new A11yVision({ page }).withChecks(['headings']).analyzeWithEvidence();
  // Both candidates were scrolled to and captured, in the page and in the frame.
  const likely = result.findings.filter((finding) => finding.status === 'likely');
  expect(likely).toHaveLength(2);
  for (const finding of likely) expect(crops[finding.evidence.crops[0]!]).toBeDefined();

  expect(await state()).toEqual(before);
});

test('a capture shows the block and what follows it', async ({ page }) => {
  await page.goto('/headings/unmarked-headings.html');
  const { result, crops } = await new A11yVision({ page }).withChecks(['headings']).analyzeWithEvidence();
  const finding = result.findings.find((entry) => entry.selector === '#div-title')!;
  const png = crops[finding.evidence.crops[0]!]!;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // Scale 2: the block (about 34 CSS px high) with 48 above and 96 below, and as wide as the paragraph under it.
  expect(view.getUint32(20) / 2).toBeGreaterThan(150);
  expect(view.getUint32(16) / 2).toBeGreaterThan(400);
});

/** Makes every `Accessibility.getFullAXTree` of the next scans fail, as on a target where the domain is not available. */
function withoutAccessibilityTree(page: Page): void {
  const context = page.context();
  const newSession = context.newCDPSession.bind(context);
  context.newCDPSession = async (target: Page) => {
    const session = await newSession(target);
    const send = session.send.bind(session) as (method: string, params?: object) => Promise<unknown>;
    (session as { send: unknown }).send = (method: string, params?: object) =>
      method === 'Accessibility.getFullAXTree' ? Promise.reject(new Error('not available')) : send(method, params);
    return session;
  };
}

test('without the accessibility tree nothing is reported above info', async ({ page }) => {
  await page.goto('/headings/unmarked-headings.html');
  withoutAccessibilityTree(page);
  const { findings } = await new A11yVision({ page }).withChecks(['headings']).analyze();
  expect(findings.length).toBeGreaterThan(7);
  expect(findings.filter((finding) => finding.status !== 'info')).toEqual([]);
  // Real headings cannot be told apart either: they are listed as candidates, with the reason.
  expect(findings.find((finding) => finding.selector === '#real-h2')?.evidence.flags).toContain('axIncomplete');
  expect(findings.find((finding) => finding.rule === 'headings/survey')?.evidence.flags).toContain('axIncomplete');
});

test('a title laid out in several boxes is read as one text, with spaces between its parts', async ({ page }) => {
  await page.goto('/headings/split-titles.html');
  const { findings } = await new A11yVision({ page }).withChecks(['headings']).analyze();
  const textOf = (selector: string) => findings.find((finding) => finding.selector === selector)?.evidence.values?.['text'];
  expect(textOf('#inline-blocks')).toBe('Split into inline blocks');
  expect(textOf('#flex-words')).toBe('Flex title words');
  expect(textOf('#br-title')).toBe('Title on two lines');
  // The link at the end of the row is not what the title heads.
  expect(findings.find((finding) => finding.selector === '#title-row')?.evidence.values?.['followedBy']).toContain('Body text under the row');
});

test('a likely candidate under a fixed banner has no capture', async ({ page }) => {
  await page.goto('/headings/covered-footer.html');
  const { result, crops } = await new A11yVision({ page }).withChecks(['headings']).analyzeWithEvidence();
  const likely = result.findings.filter((finding) => finding.status === 'likely');
  expect(likely.map((finding) => finding.selector).sort()).toEqual(['#footer-about', '#footer-help']);
  for (const finding of likely) {
    expect(finding.evidence.crops).toEqual([]);
    expect(finding.evidence.flags).toContain('covered');
  }
  expect(Object.keys(crops)).toEqual([]);
});

test('the id of a candidate does not depend on its status', async ({ page }) => {
  await page.goto('/headings/unmarked-headings.html');
  const idOf = async () => {
    const { findings } = await new A11yVision({ page }).withChecks(['headings']).analyze();
    const finding = findings.find((entry) => entry.selector === '#div-title')!;
    return { id: finding.id, status: finding.status, rule: finding.rule };
  };
  const likely = await idOf();
  // The same block, now all of it a link: info, under the other rule name.
  await page.evaluate(() => {
    const title = document.getElementById('div-title')!;
    const link = document.createElement('a');
    link.href = '/somewhere';
    link.append(...title.childNodes);
    title.append(link);
  });
  const info = await idOf();
  expect(likely).toMatchObject({ status: 'likely', rule: 'headings/unmarked-heading' });
  expect(info).toMatchObject({ status: 'info', rule: 'headings/heading-candidate' });
  expect(info.id).toBe(likely.id);
});
