import { A11yVision } from '@a11y-vision/playwright';
import { expect, test } from '@playwright/test';
import { loadFixtures } from './support/manifest.js';

/**
 * Mutation test of the lists check: well-marked pages with the list semantics stripped and the
 * styles kept. Every `ul`, `ol` and `li` of the `lists/source-*` fixtures is replaced by a `div`
 * with the same attributes and children (their styles are set by class), and the check has to
 * find each list again from what is rendered: its bullets, numbers and icons.
 *
 * Every stripped list has to come back as `likely`, and nothing else may be `likely`.
 */
const sources = loadFixtures().filter((fixture) => fixture.name.startsWith('lists/source-'));

test('stripped lists are found again', async ({ page }) => {
  expect(sources.length).toBeGreaterThanOrEqual(1);
  for (const fixture of sources) {
    await page.goto(fixture.path);
    const stripped = await page.evaluate(() => {
      const ids: string[] = [];
      // Items first, so that a list is replaced with its items already replaced.
      for (const element of [...document.querySelectorAll('li'), ...document.querySelectorAll('ul,ol')]) {
        const div = document.createElement('div');
        for (const attribute of element.attributes) div.setAttribute(attribute.name, attribute.value);
        div.append(...element.childNodes);
        if (element.localName !== 'li') ids.push(element.id);
        element.replaceWith(div);
      }
      return ids;
    });
    expect(stripped.length).toBeGreaterThanOrEqual(7);
    const { findings } = await new A11yVision({ page }).withChecks(['lists']).analyze();
    const likely = findings.filter((finding) => finding.status === 'likely');
    expect(likely.map((finding) => finding.selector).sort(), fixture.name).toEqual(stripped.map((id) => `#${id}`).sort());
    for (const finding of likely) expect(finding.rule).toBe('lists/glyph-list');
    // Nothing is left of the inventory of real lists: there are none.
    expect(findings.filter((finding) => finding.rule === 'lists/list-style-none')).toEqual([]);
  }
});
