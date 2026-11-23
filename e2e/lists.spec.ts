import { A11yVision } from '@a11y-vision/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type * as AgentModule from '../packages/collector-cdp/src/agent.js';
import type * as PageModule from '../packages/collector-cdp/src/page.js';
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
    const { result } = await judged(page, { listDisagreeStatus: 'info' });
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

test('content the author keeps closed is neither read nor rendered, next to content the browser skips', async ({ page }) => {
  await page.goto('/lists/content-hidden.html');
  const state = () =>
    page.evaluate(() => {
      const first = document.querySelector('#after > div')!.getBoundingClientRect();
      return {
        top: Math.round(first.top + window.scrollY),
        closed: getComputedStyle(document.querySelector('.closed')!).contentVisibility,
        untilFound: getComputedStyle(document.querySelector('[hidden="until-found"]')!).contentVisibility,
        footer: getComputedStyle(document.querySelector('footer')!).contentVisibility,
        tagged: document.querySelectorAll('[data-a11y-vision-render]').length,
        adoptedSheets: document.adoptedStyleSheets.length,
        html: document.documentElement.outerHTML.length,
      };
    });
  const before = await state();
  expect(before).toMatchObject({ closed: 'hidden', untilFound: 'hidden', footer: 'auto', tagged: 0, adoptedSheets: 0 });

  // While the page is read, the closed panels stay closed: asked from the page itself, when the scan tags what it renders.
  const duringScan: string[] = [];
  await page.exposeFunction('reportClosed', (value: string) => void duringScan.push(value));
  await page.evaluate(() => {
    new MutationObserver(() => {
      const closed = [document.querySelector('.closed')!, document.querySelector('[hidden="until-found"]')!];
      const report = (window as unknown as { reportClosed: (value: string) => void }).reportClosed;
      report(closed.map((element) => `${getComputedStyle(element).contentVisibility} ${element.getBoundingClientRect().height}`).join(', '));
    }).observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['data-a11y-vision-render'] });
  });

  const { findings } = await lists(page).analyze();
  const after = findings.find((finding) => finding.selector === '#after')!;
  // The list under the panels is where the author put it: nothing above it was opened.
  expect(Math.abs(after.box!.y - before.top)).toBeLessThan(8);
  expect(findings.filter((finding) => finding.status === 'likely').map((finding) => finding.selector)).toEqual(['#after']);
  // The footer was tagged for the scan; the panels were closed and empty then.
  expect(duringScan.length).toBeGreaterThan(0);
  expect(new Set(duringScan)).toEqual(new Set(['hidden 0, hidden 0']));
  expect(await state()).toEqual(before);
});

test('two series in one block are two findings with two ids and two captures', async ({ page }) => {
  await page.goto('/lists/more-lists.html');
  const { result, crops } = await lists(page).analyzeWithEvidence();
  const both = result.findings.filter((finding) => finding.selector === '#two-runs');
  expect(both.map((finding) => finding.evidence.values?.['marker']).sort()).toEqual(['bullet', 'number']);
  expect(both[0]!.id).not.toBe(both[1]!.id);
  expect(both[0]!.evidence.crops[0]).not.toBe(both[1]!.evidence.crops[0]);
  for (const finding of both) expect(crops[finding.evidence.crops[0]!]).toBeDefined();
  expect(new Set(result.findings.map((finding) => finding.id)).size).toBe(result.findings.length);
  // A mark in a cell of its own is shown with the text beside it.
  expect(result.findings.find((finding) => finding.selector === '#flat-grid')?.evidence.values?.['firstItems']).toBe('✓ Unlimited projects | ✓ Priority support | ✓ Single sign-on');
  // The same ids on a second run.
  const again = await lists(page).analyze();
  expect(again.findings.map((finding) => finding.id)).toEqual(result.findings.map((finding) => finding.id));
});

/**
 * A page of `rows` blocks of three children each, inside a modal dialog when `modal` is set. The
 * dialog is as high as its content and scrolls with the page, so that all of it is read.
 */
async function largePage(page: Page, rows: number, modal: boolean): Promise<void> {
  await page.setContent('<!doctype html><html lang="en"><body style="font: 16px Arial"><main id="main"><p>A large page.</p></main><dialog id="dialog" style="position: absolute; top: 0; max-height: none; overflow: visible"><p>A dialog.</p></dialog></body></html>');
  await page.evaluate(
    ([count, open]) => {
      const dialog = document.getElementById('dialog') as HTMLDialogElement;
      const parts: string[] = [];
      for (let index = 0; index < count; index++) parts.push(`<div><span>Row ${index}</span> <em>some</em> <span>text that goes on</span></div>`);
      (open ? dialog : document.getElementById('main')!).insertAdjacentHTML('beforeend', parts.join(''));
      if (open) dialog.showModal();
    },
    [rows, modal] as const,
  );
}

test('the survey looks for modal dialogs once, however many elements the page has', async ({ page }) => {
  // The agent is run in the world of the page here, so that the page can count what it asks the DOM.
  const { agentFactory } = (await import(new URL('../packages/collector-cdp/dist/agent.js', import.meta.url).href)) as typeof AgentModule;
  const { agentOptions } = (await import(new URL('../packages/collector-cdp/dist/page.js', import.meta.url).href)) as typeof PageModule;
  const { defaultConfig } = await import('@a11y-vision/core');
  const options = agentOptions({ ...defaultConfig, lists: { ...defaultConfig.lists, maxGroupParents: 200 } });
  for (const modal of [false, true]) {
    await largePage(page, 1500, modal);
    const counts = await page.evaluate(
      ([source, settings]) => {
        let modalQueries = 0;
        const counted = (owner: { prototype: object }, name: string): void => {
          const proto = owner.prototype as Record<string, (this: unknown, selector: string) => unknown>;
          const original = proto[name]!;
          proto[name] = function (this: unknown, selector: string) {
            if (String(selector).includes(':modal')) modalQueries++;
            return original.call(this, selector);
          };
        };
        for (const owner of [Document, Element, DocumentFragment]) {
          counted(owner, 'querySelectorAll');
          counted(owner, 'querySelector');
        }
        counted(Element, 'matches');
        counted(Element, 'closest');
        const factory = (0, eval)(`(${source})`) as (given: unknown) => { listSurvey: () => { blocks: unknown[]; parents: number; totalParents: number } };
        const survey = factory(settings).listSurvey();
        return { modalQueries, blocks: survey.blocks.length, elements: document.querySelectorAll('*').length, parents: survey.parents, totalParents: survey.totalParents };
      },
      [agentFactory.toString(), options] as const,
    );
    expect(counts.elements).toBeGreaterThan(6000);
    expect(counts.blocks).toBeGreaterThan(500);
    // One question per dialog element, and no query of the whole document per element: it was thousands.
    expect(counts.modalQueries, `modal: ${modal}`).toBeLessThanOrEqual(2);
    // The parents looked at for series of siblings are bounded, and the survey says so.
    expect(counts.totalParents).toBeGreaterThan(1500);
    expect(counts.parents).toBe(200);
  }
});

test('the survey says how many parents were not looked at for series of siblings', async ({ page }) => {
  await largePage(page, 300, false);
  await page.evaluate(() => {
    const cards = document.createElement('section');
    cards.id = 'cards';
    cards.style.cssText = 'display: flex; gap: 16px';
    cards.innerHTML = '<div><p>Card one</p><p>Text of it.</p></div><div><p>Card two</p><p>Text of it.</p></div><div><p>Card three</p><p>Text of it.</p></div>';
    document.getElementById('main')!.append(cards);
  });
  const surveyOf = async (maxGroupParents: number) => {
    const { findings } = await lists(page).options({ lists: { maxGroupParents } }).analyze();
    return { survey: findings.find((finding) => finding.rule === 'lists/survey')!, cards: findings.some((finding) => finding.selector === '#cards') };
  };
  const all = await surveyOf(5000);
  expect(all.cards).toBe(true);
  expect(all.survey.evidence.flags).not.toContain('truncated');
  // The cards come after the limit: not looked at, and the survey says how many parents were not.
  const bounded = await surveyOf(100);
  expect(bounded.cards).toBe(false);
  expect(bounded.survey.evidence.flags).toContain('truncated');
  expect(bounded.survey.evidence.values?.['parentsNotRead']).toBe(202);
  expect(bounded.survey.message).toContain('202 more element(s) with 3 children or more were not looked at');
});
