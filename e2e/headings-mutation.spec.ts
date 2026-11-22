import { A11yVision } from '@a11y-vision/playwright';
import { expect, test } from '@playwright/test';
import { loadFixtures } from './support/manifest.js';

/**
 * Mutation test of the headings check (milestone M3): well-marked pages with the heading
 * semantics stripped and the styles kept. Every `h1` to `h6` of the `headings/source-*` fixtures
 * is replaced by a `div` with the same attributes and children (their styles are set by class),
 * and the check has to find them again from what is rendered.
 *
 * Two numbers are checked over all source pages together: the share of stripped headings that
 * come back as candidates (any status), and the share that come back as `likely`. On these
 * pages nothing else may be `likely`.
 */
const sources = loadFixtures().filter((fixture) => fixture.name.startsWith('headings/source-'));
const MIN_CANDIDATE_RECALL = 0.9;
const MIN_LIKELY_RECALL = 0.9;

test('stripped headings are found again', async ({ page }) => {
  expect(sources.length).toBeGreaterThanOrEqual(3);
  let stripped = 0;
  let asCandidate = 0;
  let asLikely = 0;
  const strangers: string[] = [];
  const lines: string[] = [];
  for (const fixture of sources) {
    await page.goto(fixture.path);
    const total = await page.evaluate(() => {
      const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')];
      for (const heading of headings) {
        const div = document.createElement('div');
        for (const attribute of heading.attributes) div.setAttribute(attribute.name, attribute.value);
        div.setAttribute('data-was-heading', heading.localName);
        div.append(...heading.childNodes);
        heading.replaceWith(div);
      }
      return headings.length;
    });
    const { findings } = await new A11yVision({ page }).withChecks(['headings']).analyze();
    const candidates = findings.filter((finding) => finding.rule !== 'headings/survey');
    expect(candidates.every((finding) => finding.frame === '')).toBe(true);
    // Which stripped heading, if any, each finding points at.
    const targets = await page.evaluate(
      (selectors) =>
        selectors.map((selector) => {
          const element = document.querySelector(selector);
          const heading = element?.closest('[data-was-heading]') ?? element?.querySelector('[data-was-heading]');
          return heading ? heading.id : null;
        }),
      candidates.map((finding) => finding.selector),
    );
    const found = new Set<string>();
    const likely = new Set<string>();
    candidates.forEach((finding, index) => {
      const target = targets[index];
      if (target) {
        found.add(target);
        if (finding.status === 'likely') likely.add(target);
      } else if (finding.status !== 'info') {
        strangers.push(`${fixture.name}: ${finding.status} ${finding.selector}`);
      }
    });
    stripped += total;
    asCandidate += found.size;
    asLikely += likely.size;
    lines.push(`${fixture.name}: ${total} stripped, ${found.size} candidates, ${likely.size} likely`);
  }
  const summary = `${lines.join('\n')}\ncandidate recall ${asCandidate}/${stripped}, likely recall ${asLikely}/${stripped}`;
  console.log(summary);
  expect(strangers, 'nothing but stripped headings is likely').toEqual([]);
  expect(asCandidate / stripped, summary).toBeGreaterThanOrEqual(MIN_CANDIDATE_RECALL);
  expect(asLikely / stripped, summary).toBeGreaterThanOrEqual(MIN_LIKELY_RECALL);
});
