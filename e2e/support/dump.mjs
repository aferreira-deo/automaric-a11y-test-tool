// Debug helper: prints the findings of fixtures next to their manifests.
//   node e2e/support/dump.mjs [name-substring] [--crops <dir>]
// Needs the fixture server: node e2e/support/fixture-server.mjs 4173
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { A11yVision } from '@a11y-vision/playwright';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const args = process.argv.slice(2);
const cropsAt = args.indexOf('--crops');
const cropsDir = cropsAt >= 0 ? args[cropsAt + 1] : null;
const filter = args[0] && !args[0].startsWith('--') ? args[0] : '';
const port = process.env.FIXTURE_PORT ?? 4173;

const names = readdirSync(root, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.expected.json'))
  .map((file) => file.replaceAll('\\', '/').replace('.expected.json', ''))
  .filter((name) => name.includes(filter))
  .sort();

const browser = await chromium.launch();
for (const name of names) {
  const manifest = JSON.parse(readFileSync(join(root, `${name}.expected.json`), 'utf8'));
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/${name}.html`);
  const scanner = new A11yVision({ page }).withChecks(manifest.checks);
  const { result, crops } = await scanner.analyzeWithEvidence();
  console.log(`\n== ${name}`);
  for (const f of result.findings) {
    const e = f.evidence;
    console.log(
      `  ${f.status.padEnd(8)} ${(f.wcag?.sc ?? '-').padEnd(6)} ${f.rule.replace(/^[^/]+\//, '').padEnd(22)} ${(f.frame ? f.frame + ' | ' : '') + f.selector}` +
        (e.ratios.contrast ? `  ${e.ratios.contrast}:1 ${Object.values(e.colors).join(' vs ')}` : '') +
        (e.flags.length ? `  [${e.flags.join(',')}]` : ''),
    );
  }
  for (const x of manifest.expected) {
    const hit = result.findings.some(
      (f) =>
        f.selector === x.selector &&
        f.status === x.status &&
        (!x.rule || f.rule === x.rule) &&
        (!x.wcag || f.wcag?.sc === x.wcag) &&
        (x.frame === undefined || f.frame === x.frame) &&
        (x.flags ?? []).every((flag) => f.evidence.flags.includes(flag)),
    );
    if (!hit) console.log(`  MISSING  ${x.status} ${x.wcag ?? '-'} ${x.rule} ${x.selector}`);
  }
  if (cropsDir) {
    for (const [id, png] of Object.entries(crops)) {
      const file = join(cropsDir, name.replaceAll('/', '_'), id.replace(/^[^/]+\//, ''));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, png);
    }
  }
  await page.close();
}
await browser.close();
