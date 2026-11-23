import { A11yVision } from '@a11y-vision/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { dataOf, startMockModel, verdict } from './support/mock-model.js';
import type { MockModel } from './support/mock-model.js';

test.use({ viewport: { width: 900, height: 600 } });

const grouping = (page: Page) => new A11yVision({ page }).withChecks(['grouping']);
const SET_RULES = ['grouping/unassociated-label', 'grouping/ungrouped-controls', 'grouping/group-candidate'];

test('the grouping check leaves the page as it found it, and touches no control', async ({ page }) => {
  await page.goto('/grouping/shadow-and-iframe.html');
  const state = () =>
    page.evaluate(() => {
      const frame = document.getElementById('frame') as HTMLIFrameElement;
      const inputs = [
        ...document.getElementById('host')!.shadowRoot!.querySelectorAll('input'),
        ...frame.contentDocument!.querySelectorAll('input'),
      ];
      return {
        scroll: [window.scrollX, window.scrollY],
        frameScroll: frame.contentWindow!.scrollY,
        active: document.activeElement?.localName,
        adoptedSheets: document.adoptedStyleSheets.length,
        html: document.documentElement.outerHTML.length,
        frameHtml: frame.contentDocument!.documentElement.outerHTML.length,
        devicePixelRatio: window.devicePixelRatio,
        width: window.innerWidth,
        checked: inputs.map((input) => input.checked),
      };
    });
  await page.evaluate(() => {
    document.body.style.paddingBottom = '3000px';
    const frame = document.getElementById('frame') as HTMLIFrameElement;
    frame.height = '60';
    window.scrollTo(0, 30);
    frame.contentWindow!.scrollTo(0, 20);
    // One answer is given: it must still be given afterwards.
    frame.contentDocument!.querySelector('input')!.checked = true;
  });
  const before = await state();
  expect(before).toMatchObject({ scroll: [0, 30], frameScroll: 20 });
  expect(before.checked.filter(Boolean)).toHaveLength(1);

  const { result, crops } = await grouping(page).analyzeWithEvidence();
  // Both sets were scrolled to and captured, in the shadow tree and in the frame.
  const likely = result.findings.filter((finding) => finding.status === 'likely');
  expect(likely).toHaveLength(2);
  for (const finding of likely) expect(crops[finding.evidence.crops[0]!]).toBeDefined();

  expect(await state()).toEqual(before);
});

test('a capture shows the text and the controls, and a set under a fixed banner has none', async ({ page }) => {
  await page.goto('/grouping/covered.html');
  const { result, crops } = await grouping(page).analyzeWithEvidence();
  const visible = result.findings.find((finding) => finding.selector === '#visible')!;
  const png = crops[visible.evidence.crops[0]!]!;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // Scale 2: a question and two answers, with a margin of 16 on each side.
  expect(view.getUint32(20) / 2).toBeGreaterThanOrEqual(100);
  expect(view.getUint32(20) / 2).toBeLessThan(160);
  const covered = result.findings.find((finding) => finding.selector === '#under-banner')!;
  expect(covered.status).toBe('likely');
  expect(covered.evidence.crops).toEqual([]);
  expect(covered.evidence.flags).toContain('covered');
  expect(Object.keys(crops)).toHaveLength(1);
});

test('names, descriptions and groups are those of the accessibility tree', async ({ page }) => {
  await page.goto('/grouping/choice-sets.html');
  const { findings } = await grouping(page).analyze();
  const values = (selector: string) => findings.find((finding) => finding.selector === selector)!.evidence.values!;
  expect(values('#q-car')).toMatchObject({ controls: 2, label: 'Do you have a car?', names: 'Yes | No' });
  // Custom radios are named from their content, hidden native ones from their labels.
  expect(values('#q-custom')).toMatchObject({ controls: 3, names: 'Basic | Pro | Team' });
  expect(values('#q-rating')).toMatchObject({ controls: 3, names: 'Poor | Fair | Good' });
  // A group that gets a name is a group: the finding goes away.
  await page.evaluate(() => document.getElementById('q-unnamed-group')!.setAttribute('aria-label', 'Size'));
  const named = await grouping(page).analyze();
  expect(named.findings.find((finding) => finding.selector === '#q-unnamed-group')).toBeUndefined();
  // And a fieldset whose role is taken away is none, whatever its legend says.
  await page.goto('/grouping/grouped-sets.html');
  await page.evaluate(() => document.getElementById('g-fieldset')!.setAttribute('role', 'presentation'));
  const stripped = await grouping(page).analyze();
  expect(stripped.findings.find((finding) => finding.selector === '#g-fieldset')).toMatchObject({ status: 'likely', rule: 'grouping/unassociated-label' });
});

test('the id of a set does not depend on its status', async ({ page }) => {
  await page.goto('/grouping/near-threshold.html');
  const idOf = async () => {
    const { findings } = await grouping(page).analyze();
    const finding = findings.find((entry) => entry.selector === '#n-gap-in')!;
    return { id: finding.id, status: finding.status, rule: finding.rule };
  };
  const likely = await idOf();
  await page.evaluate(() => {
    (document.querySelector('#n-gap-in .q') as HTMLElement).style.marginBottom = '90px';
  });
  const info = await idOf();
  expect(likely).toMatchObject({ status: 'likely', rule: 'grouping/unassociated-label' });
  expect(info).toMatchObject({ status: 'info', rule: 'grouping/group-candidate' });
  expect(info.id).toBe(likely.id);
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

test('without the accessibility tree nothing is reported above info, and the survey says why', async ({ page }) => {
  await page.goto('/grouping/choice-sets.html');
  withoutAccessibilityTree(page);
  const { findings } = await grouping(page).analyze();
  expect(findings.filter((finding) => finding.status !== 'info')).toEqual([]);
  const survey = findings.find((finding) => finding.rule === 'grouping/survey')!;
  expect(survey.evidence.flags).toContain('axIncomplete');
  expect(survey.message).toContain('could not be read in full');
});

test('with more controls than are marked, what stands before the limit keeps its status and only the set that reaches it is info', async ({ page }) => {
  await page.goto('/grouping/choice-sets.html');
  const full = await grouping(page).analyze();
  const total = full.findings.find((finding) => finding.rule === 'grouping/survey')!.evidence.values!['totalControls'];
  // Four controls: the two radios of the first set, and two of the three checkboxes of the second.
  const { findings } = await grouping(page).options({ grouping: { maxAxMarks: 4 } }).analyze();
  const sets = findings.filter((finding) => finding.rule !== 'grouping/survey');
  expect(sets.map((finding) => [finding.selector, finding.status])).toEqual([
    ['#q-car', 'likely'],
    ['#q-contact', 'info'],
  ]);
  expect(sets[0]).toEqual(full.findings.find((finding) => finding.selector === '#q-car'));
  expect(sets[1]!.evidence.flags).toEqual(expect.arrayContaining(['axIncomplete', 'atReadLimit']));
  expect(sets[1]!.message).toContain('reach the point where reading stopped');
  const survey = findings.find((finding) => finding.rule === 'grouping/survey')!;
  expect(survey.evidence.flags).toEqual(expect.arrayContaining(['truncated', 'axLimited']));
  // The tree itself was read: this is not the case of a tree that could not be read.
  expect(survey.evidence.flags).not.toContain('axIncomplete');
  // The real number of controls, not the number that was marked.
  expect(Number(total)).toBeGreaterThan(20);
  expect(survey.evidence.values).toMatchObject({ controls: 4, totalControls: total, controlsBeyondAxLimit: Number(total) - 4, heldAtAxLimit: 1 });
  expect(survey.message).toContain(`${Number(total) - 4} control(s) after that point were not read, out of ${String(total)} in all`);
});

test('controls are marked in document order: questions deep in the page come before a long run of checkboxes after them', async ({ page }) => {
  // `Accessibility.getFullAXTree` lists nodes level by level: the checkboxes, which are children
  // of the form, come before the radios, which are six elements deep. Marked in that order, the
  // limit would be used up by the checkboxes and the three questions would not be read at all.
  await page.setContent('<!doctype html><html lang="en"><body style="font: 16px Arial"><main><form id="form"></form></main></body></html>');
  await page.evaluate(() => {
    const form = document.getElementById('form')!;
    for (let index = 0; index < 3; index++) {
      const set = document.createElement('div');
      set.style.margin = '0 0 24px';
      set.innerHTML = `<div><div><div><div id="q-${index}"><p style="margin: 0 0 4px">Question number ${index}</p><label><input type="radio" name="q${index}"> Yes</label> <label><input type="radio" name="q${index}"> No</label></div></div></div></div>`;
      form.append(set);
    }
    const title = document.createElement('p');
    title.textContent = 'Matrix';
    form.append(title);
    for (let index = 0; index < 200; index++) {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.setAttribute('aria-label', `cell ${index}`);
      form.append(box);
    }
  });
  const scan = () => grouping(page).options({ grouping: { maxAxMarks: 60 } }).analyze();
  const { findings } = await scan();
  const likely = findings.filter((finding) => finding.status === 'likely');
  expect(likely.map((finding) => finding.selector)).toEqual(['#q-0', '#q-1', '#q-2']);
  for (const finding of likely) expect(finding.evidence.flags).toEqual(['radios']);
  const survey = findings.find((finding) => finding.rule === 'grouping/survey')!;
  // 6 radios and 200 checkboxes, of which the first 60 controls were read; the run of checkboxes is longer than a set is.
  expect(survey.evidence.values).toMatchObject({ controls: 60, totalControls: 206, controlsBeyondAxLimit: 146, sets: 3, setsOverMaxSize: 1, likely: 3 });
  expect(survey.evidence.flags).toEqual(expect.arrayContaining(['truncated', 'axLimited']));
  expect(survey.message).toContain('146 control(s) after that point were not read, out of 206 in all');
  expect(survey.message).toContain('1 run(s) of more than 40 radio buttons or checkboxes were not looked at as a set');
  expect((await scan()).findings).toEqual(findings);
});

test('the status under a heading is an option that never gives a fail', async ({ page }) => {
  await page.goto('/grouping/advisory-sets.html');
  const statuses = async (headingLabelStatus: string) => {
    const { findings } = await grouping(page).options({ grouping: { headingLabelStatus: headingLabelStatus as never } }).analyze();
    return Object.fromEntries(findings.filter((finding) => SET_RULES.includes(finding.rule)).map((finding) => [finding.selector, finding.status]));
  };
  const others = { '#a-long': 'advisory', '#a-switches': 'advisory' };
  expect(await statuses('advisory')).toEqual({ '#a-heading': 'advisory', '#a-disclosure': 'advisory', ...others });
  expect(await statuses('likely')).toEqual({ '#a-heading': 'likely', '#a-disclosure': 'likely', ...others });
  expect(await statuses('fail')).toEqual({ '#a-heading': 'likely', '#a-disclosure': 'likely', ...others });
});

test('work is bounded on a page with hundreds of sets, and the report says what was left out', async ({ page }) => {
  await page.setContent('<!doctype html><html lang="en"><body style="font: 16px Arial"><main><form id="form"><p>A long survey.</p></form></main></body></html>');
  await page.evaluate(() => {
    const form = document.getElementById('form')!;
    for (let index = 0; index < 300; index++) {
      const set = document.createElement('div');
      set.id = `q-${index}`;
      set.style.margin = '0 0 24px';
      set.innerHTML = `<p style="margin: 0 0 4px">Question ${index}?</p><label><input type="radio" name="q${index}"> Yes</label> <label><input type="radio" name="q${index}"> No</label>`;
      form.append(set);
    }
  });
  const scan = () => grouping(page).options({ grouping: { maxCandidates: 30, maxCaptures: 5, maxControls: 200 } }).analyzeWithEvidence();
  const started = Date.now();
  const { result, crops } = await scan();
  expect(Date.now() - started).toBeLessThan(20000);
  const sets = result.findings.filter((finding) => finding.rule === 'grouping/unassociated-label');
  expect(sets).toHaveLength(30);
  // In document order, and the ones without a capture say so.
  expect(sets.map((finding) => finding.selector)).toContain('#q-29');
  expect(Object.keys(crops)).toHaveLength(5);
  expect(sets.filter((finding) => finding.evidence.flags.includes('notCaptured'))).toHaveLength(25);
  const survey = result.findings.find((finding) => finding.rule === 'grouping/survey')!;
  expect(survey.evidence.values).toMatchObject({ controls: 200, sets: 100, likely: 30 });
  expect(survey.evidence.flags).toContain('truncated');
  expect(survey.message).toContain('70 further finding(s) are not listed');
  expect(survey.message).toContain('400 more control(s) were not read');
  // The same again.
  expect((await scan()).result.findings).toEqual(result.findings);
});

test('the label of a control that is not exposed is still nobody else\'s label', async ({ page }) => {
  // A native select that is not displayed (a custom one is drawn in its place by script): the
  // label belongs to it, and the accessibility tree does not have it. It is not the label of the radios after it.
  const html = (select: string): string =>
    '<!doctype html><html lang="en"><body style="font: 16px Arial"><form>' +
    `<label for="country">Country</label>${select}` +
    '<div id="set"><label><input type="radio" name="r"> Yes</label> <label><input type="radio" name="r"> No</label></div>' +
    '</form></body></html>';
  await page.setContent(html('<select id="country" style="display: none"><option>France</option></select>'));
  const hidden = await grouping(page).analyze();
  expect(hidden.findings.filter((finding) => finding.rule !== 'grouping/survey')).toEqual([]);
  // Without a control behind it, the same label is text tied to nothing, and is reported.
  await page.setContent(html(''));
  const free = await grouping(page).analyze();
  expect(free.findings.filter((finding) => finding.status === 'likely')).toHaveLength(1);
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
    grouping(page).withAdjudication({ baseUrl: mock.baseUrl, model: 'm', maxRetries: 0, ...settings }).analyzeWithEvidence();
  const statusOf = (findings: { rule: string; selector: string; status: string }[]) =>
    Object.fromEntries(findings.filter((finding) => finding.rule !== 'grouping/survey').map((finding) => [finding.selector, finding.status]));

  test('a model judges the sets under a plain text, and nothing else', async ({ page }) => {
    await page.goto('/grouping/near-threshold.html');
    const plain = await grouping(page).analyze();
    // "no" for the question about drinking, which is far above its answers, "yes" for everything else.
    mock.respond((request) => verdict(String(dataOf(request.body)['visibleText']).startsWith('Do you drink') ? 'no' : 'yes'));
    const { result, adjudication } = await judged(page);
    const before = statusOf(plain.findings);
    expect(before).toMatchObject({ '#n-gap-out': 'info', '#n-long-out': 'info', '#n-beside-out': 'info', '#n-words-out': 'advisory', '#n-split-in': 'likely' });
    // The paragraph and the text far beside its set are raised by the "yes"; the question far above keeps its info on the "no".
    expect(statusOf(result.findings)).toEqual({ ...before, '#n-long-out': 'likely', '#n-beside-out': 'likely' });
    // Nine sets, two votes each: the six likely ones and the three held back. Not the advisory ones, not the split field.
    expect(mock.requests).toHaveLength(18);
    expect(adjudication).toMatchObject({ judged: 9 });
    const far = result.findings.find((finding) => finding.selector === '#n-gap-out')!;
    expect(far).toMatchObject({ status: 'info', ai: { verdict: 'no', statusBefore: 'info' } });
    // Ids, selectors and evidence are those of deterministic code, and nothing is a fail.
    for (const finding of result.findings) {
      const was = plain.findings.find((entry) => entry.id === finding.id)!;
      expect(was).toBeDefined();
      expect(finding.selector).toBe(was.selector);
      expect(finding.evidence).toEqual(was.evidence);
      expect(finding.status).not.toBe('fail');
    }
    // What is sent names the controls and the text, and holds a capture.
    const sent = dataOf(mock.requests[0]!.body);
    expect(sent).toMatchObject({ controls: 'radio buttons', count: 2, controlNames: ['Yes', 'No'] });
    expect(JSON.stringify(mock.requests[0]!.body)).toContain('data:image/png;base64,');
  });

  test('a "no" keeps a likely by default and lowers it only when the configuration says so', async ({ page }) => {
    await page.goto('/grouping/choice-sets.html');
    mock.respond(() => verdict('no'));
    const kept = await judged(page);
    expect(new Set(Object.values(statusOf(kept.result.findings)))).toEqual(new Set(['likely']));
    expect(kept.result.findings.find((finding) => finding.selector === '#q-car')).toMatchObject({ ai: { verdict: 'no', statusBefore: 'likely' } });
    const lowered = await judged(page, { groupNoStatus: 'info' });
    expect(new Set(Object.values(statusOf(lowered.result.findings)))).toEqual(new Set(['info']));
    expect(lowered.result.findings.find((finding) => finding.selector === '#q-car')).toMatchObject({ rule: 'grouping/group-candidate', ai: { statusBefore: 'likely' } });
  });

  test('advisory sets, split fields and sections with the same names are not sent to a model', async ({ page }) => {
    for (const fixture of ['advisory-sets', 'split-fields', 'duplicate-sections', 'grouped-sets', 'source-forms']) {
      await page.goto(`/grouping/${fixture}.html`);
      const plain = await grouping(page).analyze();
      const { result } = await judged(page);
      expect(result.findings, fixture).toEqual(plain.findings);
    }
    expect(mock.requests).toHaveLength(0);
  });
});
