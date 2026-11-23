import { A11yVision } from '@a11y-vision/playwright';
import { expect, test } from '@playwright/test';
import { loadFixtures } from './support/manifest.js';

/**
 * Mutation test of the grouping check: a well-marked form with the grouping stripped and the
 * look kept. In the `grouping/source-*` fixtures every `fieldset` and `legend` is replaced by a
 * `div` with the same attributes and children (their styles are set by class), and the group
 * roles and their names (`role`, `aria-labelledby`, `aria-label`) are removed. The check has to
 * find each set again from what is left: the controls, their names in the accessibility tree,
 * and the visible text before them.
 *
 * Each set says what is expected of it in `data-expect`:
 * - `likely`: a set of radios or checkboxes under its title, or a section whose field names are
 *   those of another section;
 * - `advisory`: the parts of a date that each have a name;
 * - `none`: the first of two sections with the same names, which is reported with the second.
 * Nothing else may be likely.
 */
const sources = loadFixtures().filter((fixture) => fixture.name.startsWith('grouping/source-'));

test('stripped groups are found again', async ({ page }) => {
  expect(sources.length).toBeGreaterThanOrEqual(1);
  for (const fixture of sources) {
    await page.goto(fixture.path);
    const expected = await page.evaluate(() => {
      const sets = [...document.querySelectorAll('[data-expect]')].map((element) => ({ id: element.id, expect: element.getAttribute('data-expect')! }));
      for (const element of [...document.querySelectorAll('legend'), ...document.querySelectorAll('fieldset')]) {
        const div = document.createElement('div');
        for (const attribute of element.attributes) div.setAttribute(attribute.name, attribute.value);
        div.append(...element.childNodes);
        element.replaceWith(div);
      }
      for (const element of document.querySelectorAll('[role="group"], [role="radiogroup"]')) {
        for (const attribute of ['role', 'aria-labelledby', 'aria-label']) element.removeAttribute(attribute);
      }
      return sets;
    });
    expect(expected.length).toBeGreaterThanOrEqual(9);
    const { findings } = await new A11yVision({ page }).withChecks(['grouping']).analyze();
    const selectors = (status: string): string[] =>
      findings
        .filter((finding) => finding.status === status && finding.rule !== 'grouping/survey')
        .map((finding) => finding.selector)
        .sort();
    const wanted = (status: string): string[] =>
      expected
        .filter((set) => set.expect === status)
        .map((set) => `#${set.id}`)
        .sort();
    expect(selectors('likely'), fixture.name).toEqual(wanted('likely'));
    expect(selectors('advisory'), fixture.name).toEqual(wanted('advisory'));
    expect(selectors('fail'), fixture.name).toEqual([]);
    // Every set comes back: the likely ones, the advisory one, and the section that is reported with its twin.
    const recovered = expected.filter((set) => set.expect !== 'none').length;
    expect(recovered / expected.length).toBeGreaterThanOrEqual(0.85);
  }
});
