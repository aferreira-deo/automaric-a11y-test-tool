import { A11yVision } from '@a11y-vision/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { dataOf, startMockModel, verdict } from './support/mock-model.js';
import type { MockModel } from './support/mock-model.js';

test.use({ viewport: { width: 900, height: 600 } });

const lists = (page: Page) => new A11yVision({ page }).withChecks(['lists']);

test('the lists check leaves the page as it found it', async ({ page }) => {
  await page.goto('/lists/shadow-and-iframe.html');
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
    // Long enough to scroll whatever the size of the window is while the scan changes its emulation,
    // and a frame low enough for its content to scroll.
    document.body.style.paddingBottom = '3000px';
    const frame = document.getElementById('frame') as HTMLIFrameElement;
    frame.height = '60';
    window.scrollTo(0, 30);
    frame.contentWindow!.scrollTo(0, 20);
  });
  const before = await state();
  expect(before).toMatchObject({ scroll: [0, 30], frameScroll: 20 });

  const { result, crops } = await lists(page).analyzeWithEvidence();
  // Both lists were scrolled to and captured, in the shadow tree and in the frame.
  const likely = result.findings.filter((finding) => finding.status === 'likely');
  expect(likely).toHaveLength(2);
  for (const finding of likely) expect(crops[finding.evidence.crops[0]!]).toBeDefined();

  expect(await state()).toEqual(before);
});

test('a capture shows the whole series, and a series under a fixed banner has none', async ({ page }) => {
  await page.goto('/lists/covered.html');
  const { result, crops } = await lists(page).analyzeWithEvidence();
  const visible = result.findings.find((finding) => finding.selector === '#visible')!;
  const png = crops[visible.evidence.crops[0]!]!;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // Scale 2: two lines of 24 CSS px with a margin of 16 on each side.
  expect(view.getUint32(20) / 2).toBeGreaterThanOrEqual(72);
  expect(view.getUint32(20) / 2).toBeLessThan(120);
  const covered = result.findings.find((finding) => finding.selector === '#under-banner')!;
  expect(covered.status).toBe('likely');
  expect(covered.evidence.crops).toEqual([]);
  expect(covered.evidence.flags).toContain('covered');
  expect(Object.keys(crops)).toHaveLength(1);
});

test('the id of a series does not depend on its status', async ({ page }) => {
  await page.goto('/lists/near-threshold.html');
  const idOf = async () => {
    const { findings } = await lists(page).analyze();
    const finding = findings.find((entry) => entry.selector === '#two-dashes')!;
    return { id: finding.id, status: finding.status, rule: finding.rule };
  };
  const info = await idOf();
  await page.evaluate(() => {
    const line = document.createElement('div');
    line.textContent = '- jam';
    document.getElementById('two-dashes')!.append(line);
  });
  const likely = await idOf();
  expect(info).toMatchObject({ status: 'info', rule: 'lists/glyph-list-candidate' });
  expect(likely).toMatchObject({ status: 'likely', rule: 'lists/glyph-list' });
  expect(likely.id).toBe(info.id);
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
  await page.goto('/lists/glyph-controls.html');
  withoutAccessibilityTree(page);
  const { findings } = await lists(page).analyze();
  expect(findings.length).toBeGreaterThan(5);
  expect(findings.filter((finding) => finding.status !== 'info')).toEqual([]);
  // Real lists cannot be told apart either: their items are listed as candidates, with the reason.
  expect(findings.find((finding) => finding.selector === '#real-ul')?.evidence.flags).toContain('axIncomplete');
  expect(findings.find((finding) => finding.rule === 'lists/survey')?.evidence.flags).toContain('axIncomplete');
});

test('the status of card grids is an option that never gives a fail', async ({ page }) => {
  await page.goto('/lists/repeated-structure.html');
  const statuses = async (cardListStatus: string) => {
    const { findings } = await lists(page).options({ lists: { cardListStatus: cardListStatus as never } }).analyze();
    return Object.fromEntries(findings.filter((finding) => finding.rule === 'lists/repeated-structure').map((finding) => [finding.selector, finding.status]));
  };
  const links = { '#nav-links': 'advisory', '#tags': 'advisory', '#pages': 'advisory', '#crumbs': 'advisory' };
  expect(await statuses('advisory')).toEqual({ '#cards': 'advisory', '#results': 'advisory', ...links });
  expect(await statuses('likely')).toEqual({ '#cards': 'likely', '#results': 'likely', ...links });
  expect(await statuses('fail')).toEqual({ '#cards': 'likely', '#results': 'likely', ...links });
});

test('work is bounded on a page with hundreds of lists, and the report says what was left out', async ({ page }) => {
  await page.setContent('<!doctype html><html lang="en"><body style="font: 16px Arial"><main id="main"><p>A page with many short lists.</p></main></body></html>');
  await page.evaluate(() => {
    const main = document.getElementById('main')!;
    for (let index = 0; index < 400; index++) {
      const section = document.createElement('section');
      section.id = `list-${index}`;
      section.innerHTML = '<div>• first</div><div>• second</div><div>• third</div>';
      main.append(section);
      const real = document.createElement('ul');
      real.style.listStyle = 'none';
      real.innerHTML = '<li>one</li><li>two</li>';
      main.append(real);
    }
  });
  const scan = () => lists(page).options({ lists: { maxCandidates: 40, maxUnstyledLists: 10, maxCaptures: 6 } }).analyzeWithEvidence();
  const { result, crops } = await scan();
  const byRule = (rule: string) => result.findings.filter((finding) => finding.rule === rule);
  expect(byRule('lists/glyph-list')).toHaveLength(40);
  expect(byRule('lists/list-style-none')).toHaveLength(10);
  expect(Object.keys(crops)).toHaveLength(6);
  // In document order, and the ones without a capture say so.
  expect(byRule('lists/glyph-list').map((finding) => finding.selector)).toContain('#list-39');
  expect(byRule('lists/glyph-list').filter((finding) => finding.evidence.flags.includes('notCaptured'))).toHaveLength(34);
  const survey = byRule('lists/survey')[0]!;
  expect(survey.evidence.flags).toContain('truncated');
  expect(survey.message).toContain('360 further finding(s) are not listed');
  expect(survey.message).toContain('390 further list(s) without markers are not listed');
  // The same again.
  expect((await scan()).result.findings).toEqual(result.findings);
});

test('more lists than can be marked in the page count as an accessibility tree that was not read', async ({ page }) => {
  await page.goto('/lists/glyph-controls.html');
  const { findings } = await lists(page).options({ lists: { maxAxMarks: 2 } }).analyze();
  expect(findings.filter((finding) => finding.status !== 'info')).toEqual([]);
  expect(findings.find((finding) => finding.rule === 'lists/survey')?.evidence.flags).toContain('axIncomplete');
});

test.describe('with a model', () => {
  let mock: MockModel;
  test.beforeEach(async () => {
    mock = await startMockModel();
  });
  test.afterEach(async () => {
    await mock.close();
  });
  const judged = (page: Page, settings: Record<string, unknown> = {}) =>
    lists(page).withAdjudication({ baseUrl: mock.baseUrl, model: 'm', maxRetries: 0, ...settings }).analyzeWithEvidence();
  const statusOf = (findings: { rule: string; selector: string; status: string }[]) =>
    Object.fromEntries(findings.filter((finding) => finding.rule.startsWith('lists/glyph')).map((finding) => [finding.selector, finding.status]));

  test('a model judges the series of lines with bullets or numbers, and nothing else', async ({ page }) => {
    await page.goto('/lists/near-threshold.html');
    const plain = await lists(page).analyze();
    // "no" for the two hyphens and for numbers from 4, "yes" for everything else.
    mock.respond((request) => {
      const first = (dataOf(request.body)['itemStarts'] as string[])[0]!;
      return verdict(first.startsWith('- bread') || first.startsWith('4)') ? 'no' : 'yes');
    });
    const { result, adjudication } = await judged(page);
    const before = statusOf(plain.findings);
    expect(statusOf(result.findings)).toEqual({ ...before, '#steps': 'likely', '#image-pair': 'likely' });
    expect(before['#steps']).toBe('info');
    // A "no" keeps the likely by default: it is recorded, not acted on.
    const dashes = result.findings.find((finding) => finding.selector === '#three-dashes')!;
    expect(dashes).toMatchObject({ status: 'likely', ai: { verdict: 'no', statusBefore: 'likely' } });
    // Ten series, two votes each.
    expect(mock.requests).toHaveLength(20);
    expect(adjudication).toMatchObject({ judged: 10 });
    // Ids, selectors and evidence are those of deterministic code, and nothing is a fail.
    for (const finding of result.findings) {
      const was = plain.findings.find((entry) => entry.id === finding.id)!;
      expect(was).toBeDefined();
      expect(finding.selector).toBe(was.selector);
      expect(finding.evidence).toEqual(was.evidence);
      expect(finding.status).not.toBe('fail');
    }
  });

  test('a "no" lowers a likely only when the configuration says so', async ({ page }) => {
    await page.goto('/lists/near-threshold.html');
    mock.respond(() => verdict('no'));
    const { result } = await judged(page, { listNoStatus: 'info' });
    expect(new Set(Object.values(statusOf(result.findings)))).toEqual(new Set(['info']));
    expect(result.findings.find((finding) => finding.selector === '#two-bullets')).toMatchObject({ rule: 'lists/glyph-list-candidate', ai: { statusBefore: 'likely' } });
  });

  test('advisory findings, lists with a removed role and the inventory are not sent to a model', async ({ page }) => {
    for (const fixture of ['repeated-structure', 'key-value', 'presentational-list', 'unstyled-lists']) {
      await page.goto(`/lists/${fixture}.html`);
      const plain = await lists(page).analyze();
      const { result } = await judged(page);
      expect(result.findings, fixture).toEqual(plain.findings);
    }
    expect(mock.requests).toHaveLength(0);
  });
});

test('rendering that the browser skips is switched on for the scan only', async ({ page }) => {
  await page.goto('/lists/content-visibility.html');
  const state = () =>
    page.evaluate(() => ({
      adoptedSheets: document.adoptedStyleSheets.length,
      footer: getComputedStyle(document.querySelector('footer')!).contentVisibility,
      closed: getComputedStyle(document.querySelector('.closed')!).contentVisibility,
      // Off screen and skipped: the real list in the footer is not rendered.
      rendered: document.getElementById('real-list')!.checkVisibility({ contentVisibilityAuto: true }),
      scroll: window.scrollY,
    }));
  const before = await state();
  expect(before).toEqual({ adoptedSheets: 0, footer: 'auto', closed: 'hidden', rendered: false, scroll: 0 });
  const { findings } = await lists(page).analyze();
  // The real list was read as a list, so its lines are not reported; the hidden panel was not read.
  expect(findings.filter((finding) => finding.status === 'likely').map((finding) => finding.selector).sort()).toEqual(['#footer-list', '#top-list']);
  expect(await state()).toEqual(before);
});
