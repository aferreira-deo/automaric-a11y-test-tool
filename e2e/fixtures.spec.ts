import { A11yVision } from '@a11y-vision/playwright';
import { expect, test } from '@playwright/test';
import { compareToManifest, loadFixtures } from './support/manifest.js';

for (const fixture of loadFixtures()) {
  test(`fixture ${fixture.name}`, async ({ page }) => {
    await page.goto(fixture.path);
    const analyze = () => new A11yVision({ page }).withChecks(fixture.manifest.checks).analyze();

    const first = await analyze();
    expect(compareToManifest(first.findings, fixture.manifest), fixture.manifest.description).toEqual({
      missing: [],
      unexpected: [],
    });

    // Two consecutive runs must agree on everything.
    const second = await analyze();
    expect(second.findings).toEqual(first.findings);
  });
}
