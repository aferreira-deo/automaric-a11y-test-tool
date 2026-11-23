// Builds the unpacked extension into packages/extension/dist: two bundles (the side panel and the
// service worker), the static files, the manifest, the icons and the notices of the packages of
// others that are in the bundles. Run after `tsc -b`: the bundles are made from the built
// packages of the workspace.
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImage, encodePng, fillRect, TOOL_NAME } from '@a11y-vision/core';
import { build } from 'rolldown';

const root = fileURLToPath(new URL('.', import.meta.url));
const dist = `${root}dist/`;
const { version } = JSON.parse(await readFile(new URL('../core/package.json', import.meta.url), 'utf8'));

// The adjudicator layer has a transport for Node (no proxy, loopback addresses only), loaded on
// first use and only in Node. It cannot run in a browser and is not shipped: what is bundled in
// its place throws, should anything ever ask for it.
const NODE_ONLY = /[\\/]adjudicators[\\/]dist[\\/]loopback-fetch\.js$/;
const withoutNodeTransport = {
  name: 'without-node-transport',
  load(id) {
    if (!NODE_ONLY.test(id)) return null;
    return "export function createLoopbackFetch() { throw new Error('The Node transport is not part of the extension.'); }\n";
  },
};

/** Every file that went into a bundle, by its path on disk. */
const bundled = new Set();

async function bundle(entry, file) {
  const { output } = await build({
    input: `${root}src/${entry}`,
    platform: 'browser',
    plugins: [withoutNodeTransport],
    // One file per entry: an extension page and a service worker load nothing from elsewhere.
    output: { file: `${dist}${file}`, format: 'esm', codeSplitting: false, minify: false, sourcemap: false },
    logLevel: 'warn',
    onLog(level, log, handler) {
      // Anything Node-only that found its way into a bundle is an error, not a warning.
      if (log.code === 'UNRESOLVED_IMPORT') throw new Error(log.message);
      handler(level, log);
    },
  });
  for (const chunk of output) {
    if (chunk.type !== 'chunk') continue;
    // Only the modules of which something is left in the bundle: one that was shaken out whole ships nothing.
    for (const [id, module] of Object.entries(chunk.modules)) if (module.renderedLength > 0) bundled.add(id);
  }
  const code = await readFile(`${dist}${file}`, 'utf8');
  // What must never be in the extension: Node built-ins, and code made from strings.
  const banned = [/from\s*["']node:/, /\brequire\(["']node:/, /\beval\(/, /new Function\(/];
  for (const pattern of banned) {
    if (pattern.test(code)) throw new Error(`${file} contains ${pattern}: it would not load, or not be allowed, in an extension.`);
  }
}

/**
 * The packages of others whose code is in the bundles, found from the files that were bundled:
 * for each file under a node_modules directory, the nearest package.json above it that has a
 * name. The packages of this workspace are not under one: pnpm links them, and the bundler
 * follows the links to packages/*.
 */
async function thirdPartyPackages() {
  const found = new Map();
  for (const id of bundled) {
    // An id a plugin made up is not a file.
    if (!id.split(/[\\/]/).includes('node_modules') || !existsSync(id)) continue;
    for (let dir = dirname(id); dir.split(sep).includes('node_modules'); dir = dirname(dir)) {
      const manifestPath = join(dir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      // A package.json without a name only sets the module type of a directory inside a package.
      if (typeof manifest.name !== 'string') continue;
      found.set(`${manifest.name}@${manifest.version}`, { dir, manifest });
      break;
    }
  }
  return [...found.values()].sort((a, b) => (a.manifest.name < b.manifest.name ? -1 : a.manifest.name > b.manifest.name ? 1 : 0));
}

/**
 * The notices that go with the bundles: for each bundled package of others its name, version
 * and licence, and the text of its own licence file, which is what its licence asks of whoever
 * passes the code on. Made from what was really bundled and from the files really installed, so
 * it cannot fall behind the bundles. A bundled package without a licence file stops the build:
 * its code would be shipped without the text that allows that.
 */
async function thirdPartyNotices() {
  const packages = await thirdPartyPackages();
  const rule = '='.repeat(78);
  const parts = [
    `${TOOL_NAME} extension: third-party notices`,
    '',
    'panel.js and background.js contain code of the packages below. Each is listed with the',
    'licence text that came with it. Written by build.mjs from the installed packages.',
  ];
  for (const { dir, manifest } of packages) {
    const files = (await readdir(dir)).filter((name) => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(name)).sort();
    if (files.length === 0) {
      throw new Error(`${manifest.name}@${manifest.version} is bundled into the extension and has no licence file in ${dir}: the notices cannot be written.`);
    }
    const licence = typeof manifest.license === 'string' ? manifest.license : 'see the text below';
    const source = typeof manifest.homepage === 'string' ? manifest.homepage : typeof manifest.repository === 'string' ? manifest.repository : (manifest.repository?.url ?? '');
    parts.push('', rule, `${manifest.name} ${manifest.version}`, `Licence: ${licence}`, ...(source ? [`Source: ${source}`] : []), rule);
    for (const name of files) parts.push('', (await readFile(join(dir, name), 'utf8')).replace(/\r\n/g, '\n').trim());
  }
  return { text: `${parts.join('\n')}\n`, names: packages.map(({ manifest }) => `${manifest.name}@${manifest.version} (${manifest.license ?? 'no licence field'})`) };
}

/** A square icon: a dark tile with a ring set in from its edge, the picture of a focus indicator. */
function icon(size) {
  const image = createImage(size, size, { r: 0x15, g: 0x15, b: 0x15 });
  const inset = Math.max(1, Math.round(size / 8));
  const ring = Math.max(1, Math.round(size / 10));
  const outer = { x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset };
  fillRect(image, outer, { r: 0x8c, g: 0xc8, b: 0xff });
  fillRect(image, { x: outer.x + ring, y: outer.y + ring, width: outer.width - 2 * ring, height: outer.height - 2 * ring }, { r: 0x15, g: 0x15, b: 0x15 });
  const dot = Math.max(1, Math.round(size / 4));
  const at = Math.round((size - dot) / 2);
  fillRect(image, { x: at, y: at, width: dot, height: dot }, { r: 0xff, g: 0xff, b: 0xff });
  return encodePng(image);
}

await rm(dist, { recursive: true, force: true });
await mkdir(`${dist}icons`, { recursive: true });
await bundle('panel.ts', 'panel.js');
await bundle('background.ts', 'background.js');
await cp(`${root}static/panel.html`, `${dist}panel.html`);
await cp(`${root}static/panel.css`, `${dist}panel.css`);

const sizes = [16, 32, 48, 128];
for (const size of sizes) await writeFile(`${dist}icons/icon-${size}.png`, icon(size));
const icons = Object.fromEntries(sizes.map((size) => [String(size), `icons/icon-${size}.png`]));

const manifest = JSON.parse(await readFile(`${root}static/manifest.json`, 'utf8'));
manifest.name = TOOL_NAME;
// Chrome wants one to four numbers, not all of them zero-length; the version of the tool is that.
manifest.version = version;
manifest.icons = icons;
manifest.action = { ...manifest.action, default_icon: icons };
await writeFile(`${dist}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

const notices = await thirdPartyNotices();
await writeFile(`${dist}THIRD-PARTY-NOTICES.txt`, notices.text);
console.log(`extension built in ${dist}`);
console.log(`bundled packages of others: ${notices.names.join(', ') || 'none'}`);
