import { A11yVision } from '@a11y-vision/playwright';
import { expect, test } from '@playwright/test';
import { compareToManifest, loadFixtures } from './support/manifest.js';

/**
 * The measurements are made at the capture scale of the tool, whatever device pixel ratio the
 * page comes with. `fixtures.spec.ts` runs every fixture in a context at 1; this runs the
 * fixtures of the checks that take captures in contexts at other ratios, among them the
 * capture scale itself (2), and expects the same manifests.
 */
const captureChecks = ['focus-indicator', 'icon-contrast', 'headings'];
const fixtures = loadFixtures().filter((fixture) => fixture.manifest.checks.some((check) => captureChecks.includes(check)));

for (const deviceScaleFactor of [1.5, 2]) {
  test.describe(`in a context with deviceScaleFactor ${deviceScaleFactor}`, () => {
    test.use({ deviceScaleFactor });
    for (const fixture of fixtures) {
      test(`fixture ${fixture.name}`, async ({ page }) => {
        await page.goto(fixture.path);
        // One fixture overwrites window.devicePixelRatio to test that the tool does not believe it.
        const ratio = (): Promise<boolean> => page.evaluate((dppx) => matchMedia(`(resolution: ${dppx}dppx)`).matches, deviceScaleFactor);
        expect(await ratio(), 'the context has this device pixel ratio').toBe(true);
        const { result, crops } = await new A11yVision({ page }).withChecks(fixture.manifest.checks).analyzeWithEvidence();
        expect(compareToManifest(result.findings, fixture.manifest), fixture.manifest.description).toEqual({
          missing: [],
          unexpected: [],
        });
        // Every capture is at the capture scale: its pixel size is the clip size times that scale.
        expect(result.environment.devicePixelRatio).toBe(2);
        for (const png of Object.values(crops)) {
          const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
          expect(view.getUint32(16) % 2, 'width of a capture at scale 2').toBe(0);
          expect(view.getUint32(20) % 2, 'height of a capture at scale 2').toBe(0);
        }
        expect(await ratio(), 'the page gets its own ratio back').toBe(true);
      });
    }
  });
}
