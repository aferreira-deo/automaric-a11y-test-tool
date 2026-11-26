import { resolveConfig } from '@a11y-vision/core';
import type { HeadingSurvey } from '@a11y-vision/core';
import { A11yVision } from '@a11y-vision/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type * as CollectorModule from '../packages/collector-cdp/src/index.js';

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

const NOT_A_HEADING = 'headings/heading-not-a-heading';

test('a heading that does not read as one comes with a capture of it in context', async ({ page }) => {
  await page.goto('/headings/not-a-heading.html');
  const { result, crops } = await new A11yVision({ page }).withChecks(['headings']).analyzeWithEvidence();
  const found = result.findings.filter((finding) => finding.rule === NOT_A_HEADING);
  expect(found.length).toBe(18);
  expect(found.some((finding) => finding.status === 'fail')).toBe(false);
  for (const finding of found) {
    expect(finding.wcag).toEqual({ sc: '1.3.1', level: 'A' });
    expect(crops[finding.evidence.crops[0]!], finding.selector).toBeDefined();
  }
  const paragraph = found.find((finding) => finding.selector === '#paragraph')!;
  expect(paragraph.evidence.values).toMatchObject({ level: 2, sentences: 3, fontSizePx: 24, fontWeight: 700, bodyFontSizePx: 16, bodyFontWeight: 400 });
  expect(paragraph.evidence.values!['followedBy']).toContain('Body text under the paragraph');
  const png = crops[paragraph.evidence.crops[0]!]!;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // Scale 2: the heading (several lines) with 48 CSS px above it and what follows it below.
  expect(view.getUint32(20) / 2).toBeGreaterThan(150);
  // French: three sentences, with the marks set apart by a space, and the heading that follows at once.
  expect(found.find((finding) => finding.selector === '#french')!.evidence.values).toMatchObject({ sentences: 3, words: 33, nextHeadingLevel: 3, followedBy: 'Nous contacter' });
  expect(result.findings.find((finding) => finding.rule === 'headings/survey')!.evidence.values).toMatchObject({ notHeadings: 18 });
});

test('which text is a heading comes from the accessibility tree: a role that removes it removes the finding', async ({ page }) => {
  await page.goto('/headings/not-a-heading.html');
  await page.evaluate(() => {
    document.getElementById('paragraph')!.setAttribute('role', 'presentation');
    document.getElementById('role-paragraph')!.removeAttribute('role');
    document.getElementById('plain-sentences')!.setAttribute('aria-hidden', 'true');
  });
  const { findings } = await new A11yVision({ page }).withChecks(['headings']).analyze();
  const reported = findings.filter((finding) => finding.rule === NOT_A_HEADING).map((finding) => finding.selector);
  expect(reported).not.toContain('#paragraph');
  expect(reported).not.toContain('#role-paragraph');
  expect(reported).not.toContain('#plain-sentences');
  expect(reported).toContain('#french');
});

test('what stands between two headings is what keeps them from being a run: pictures, closed panels, the pointer', async ({ page }) => {
  await page.goto('/headings/not-a-heading-controls.html');
  const reported = async () =>
    (await new A11yVision({ page }).withChecks(['headings']).analyze()).findings
      .filter((finding) => finding.rule === NOT_A_HEADING)
      .map((finding) => `${finding.selector} ${finding.status}`)
      .sort();
  expect(await reported()).toEqual([]);
  // Without the pictures the card titles follow each other in the document with nothing between
  // them. On the page they are side by side: each is the title of its card, and they are no run.
  await page.evaluate(() => document.querySelectorAll('.cards img').forEach((image) => image.remove()));
  expect(await reported()).toEqual([]);
  // One under the other, with the room cards take: still no run.
  await page.addStyleTag({ content: '.cards { display: block !important }' });
  expect(await reported()).toEqual([]);
  // One right under the other, they are three headings in a row up to the title of the next section, which is not counted.
  await page.addStyleTag({ content: '.cards article { border: 0 !important; padding: 0 !important }' });
  expect(await reported()).toEqual(['#card-1 advisory', '#card-2 advisory', '#card-3 advisory']);
  const cards = (await new A11yVision({ page }).withChecks(['headings']).analyze()).findings.filter((finding) => finding.rule === NOT_A_HEADING);
  expect(cards.map((finding) => finding.evidence.values!['headingsInRun'])).toEqual([3, 3, 3]);
  // Without the closed panels and the pointer, the steps are six headings in a row; the last one is over text.
  await page.evaluate(() => {
    document.querySelectorAll('.panel-closed').forEach((panel) => panel.remove());
    document.querySelectorAll('.clickable').forEach((heading) => heading.classList.remove('clickable'));
  });
  expect(await reported()).toEqual(['#card-1 advisory', '#card-2 advisory', '#card-3 advisory', '#step-1 advisory', '#step-2 advisory', '#step-3 advisory', '#step-4 advisory', '#step-5 advisory']);
  // Without the icons, the last title of the footer is the last text of the page; alone, that is not reported.
  await page.evaluate(() => document.querySelectorAll('.icon').forEach((icon) => icon.remove()));
  expect((await reported()).filter((entry) => entry.startsWith('#footer'))).toEqual([]);
});

test('without the accessibility tree a heading that does not read as one is info at most', async ({ page }) => {
  await page.goto('/headings/not-a-heading.html');
  const before = (await new A11yVision({ page }).withChecks(['headings']).analyze()).findings.filter((finding) => finding.rule === NOT_A_HEADING);
  expect(before.filter((finding) => finding.status === 'likely').length).toBe(5);
  // A page of its own: the scanner keeps one session per page, made when the page is first scanned.
  const other = await page.context().newPage();
  await other.goto('/headings/not-a-heading.html');
  withoutAccessibilityTree(other);
  const { findings } = await new A11yVision({ page: other }).withChecks(['headings']).analyze();
  expect(findings.filter((finding) => finding.status !== 'info')).toEqual([]);
});

test('the review cases are not reported, by what the document holds alone and by what the page shows alone', async ({ page }) => {
  await page.goto('/headings/not-a-heading-negatives.html');
  const reported = async (headings: Record<string, number> = {}) =>
    (await new A11yVision({ page }).withChecks(['headings']).options({ headings }).analyze()).findings
      .filter((finding) => finding.rule === NOT_A_HEADING)
      .map((finding) => `${finding.selector} ${finding.status}`)
      .sort();
  expect(await reported()).toEqual([]);
  // With any distance allowed between two headings, what was counted between them is all that
  // speaks: the rule, the lazy image, the pictures, the closed shadow root, the bars, the empty
  // container, the empty link over each card, and the headings without visible text.
  expect(await reported({ headsNothingMaxGapEm: 1000 })).toEqual([]);

  // Taken out of the document, the things between the numbers leave a run of headings...
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('.tight > :not(h3)')) element.remove();
  });
  const run = ['#over-background', '#over-bars', '#over-closed-root', '#over-contents-picture', '#over-lazy-image', '#over-rule', '#over-sized-container', '#over-wrapped-picture'];
  expect(await reported()).toEqual(run.map((selector) => `${selector} likely`).sort());
  // ...unless the page shows room between them, whatever takes it.
  await page.addStyleTag({ content: '.tight h3 { margin: 4px 0 40px !important }' });
  expect(await reported()).toEqual([]);

  // The same for the cards: without the links laid over them, their titles are one right under
  // the other in the document. Two sentences each: no running text, and three of them are a run.
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('.stretched')) element.remove();
  });
  await page.addStyleTag({ content: '.stretched-card { border: 0 !important; padding: 0 !important; margin: 0 !important } .stretched-card h3 { margin: 4px 0 !important }' });
  expect(await reported()).toEqual(['#stretched-1 advisory', '#stretched-2 advisory', '#stretched-3 advisory']);
});

/** The heading survey of the page as the collector reads it: what the check works from. */
async function surveyOf(page: Page): Promise<HeadingSurvey> {
  const { collectSnapshot } = (await import(new URL('../packages/collector-cdp/dist/index.js', import.meta.url).href)) as typeof CollectorModule;
  const session = await page.context().newCDPSession(page);
  try {
    const snapshot = await collectSnapshot(
      {
        send: (method, params) => session.send(method as never, params as never),
        on: (event, handler) => void session.on(event as never, handler as never),
        off: (event, handler) => void session.off(event as never, handler as never),
      },
      resolveConfig({ checks: ['headings'] }),
    );
    return snapshot.headings!;
  } finally {
    await session.detach();
  }
}

test('the survey lists every exposed heading, with or without visible text, and what stands before each', async ({ page }) => {
  await page.goto('/headings/not-a-heading-negatives.html');
  const survey = await surveyOf(page);
  const listed = survey.headings!;
  const of = (id: string) => listed.find((heading) => heading.selector === `#${id}`)!;
  // In document order, the ones without text in their place.
  const order = listed.map((heading) => heading.selector);
  expect(order.indexOf('#image-heading')).toBe(order.indexOf('#before-image-heading') + 1);
  expect(order.indexOf('#hidden-heading')).toBe(order.indexOf('#before-hidden-heading') + 1);
  expect(survey.blocks.some((block) => block.heading?.selector === '#image-heading' || block.heading?.selector === '#hidden-heading')).toBe(false);
  expect(of('image-heading')).toMatchObject({ level: 3, frame: '' });
  expect(of('image-heading').box!.height).toBeGreaterThan(30);
  // The picture and the hidden text inside a heading are the heading itself: not counted.
  expect(of('after-image-heading').contentBefore).toBe(of('image-heading').contentBefore);
  expect(of('after-hidden-heading').contentBefore).toBe(of('hidden-heading').contentBefore);
  // Something was counted between each of the numbers and the next, and none of it is hidden text.
  const tight = ['over-rule', 'over-lazy-image', 'over-contents-picture', 'over-wrapped-picture', 'over-closed-root', 'over-bars', 'over-sized-container', 'over-background', 'after-all'];
  for (let index = 1; index < tight.length; index++) {
    expect(of(tight[index]!).contentBefore - of(tight[index - 1]!).contentBefore, tight[index - 1]).toBeGreaterThanOrEqual(1);
    expect(of(tight[index]!).hiddenBefore, tight[index - 1]).toBe(of(tight[index - 1]!).hiddenBefore);
  }
  // A closed panel is content that does not show.
  expect(of('accordion-2').hiddenBefore - of('accordion-1').hiddenBefore).toBe(1);
  // Where each heading begins among the blocks: its own first block.
  for (const heading of listed) {
    const first = survey.blocks.findIndex((block) => block.heading?.selector === heading.selector);
    if (first >= 0) expect(heading.blocksBefore, heading.selector).toBe(first);
  }
});
