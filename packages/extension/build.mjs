// Builds the unpacked extension into packages/extension/dist: two bundles (the side panel and the
// service worker), the static files, the manifest and the icons. Run after `tsc -b`: the bundles
// are made from the built packages of the workspace.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

async function bundle(entry, file) {
  await build({
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
  const code = await readFile(`${dist}${file}`, 'utf8');
  // What must never be in the extension: Node built-ins, and code made from strings.
  const banned = [/from\s*["']node:/, /\brequire\(["']node:/, /\beval\(/, /new Function\(/];
  for (const pattern of banned) {
    if (pattern.test(code)) throw new Error(`${file} contains ${pattern}: it would not load, or not be allowed, in an extension.`);
  }
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
console.log(`extension built in ${dist}`);
