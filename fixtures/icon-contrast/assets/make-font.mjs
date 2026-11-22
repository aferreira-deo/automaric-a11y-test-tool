// Writes fixture-icons.ttf, the icon font of the icon-contrast fixtures: a TrueType file with
// two glyphs in the Private Use Area. It is generated, not downloaded, so it carries no
// third-party licence. Run again only to change the glyphs:
//   node fixtures/icon-contrast/assets/make-font.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const UNITS_PER_EM = 1000;
const ASCENT = 800;
const DESCENT = 200;

/** Outlines in font units, y up, one closed contour each. */
const GLYPHS = [
  { code: null, points: [] }, // .notdef
  {
    // U+E001: a plus sign with arms 240 units thick (4.8 px at a 20 px font size).
    code: 0xe001,
    points: [
      [380, 750], [620, 750], [620, 470], [900, 470], [900, 230], [620, 230],
      [620, -50], [380, -50], [380, 230], [100, 230], [100, 470], [380, 470],
    ],
  },
  {
    // U+E002: a square.
    code: 0xe002,
    points: [[150, 700], [850, 700], [850, 0], [150, 0]],
  },
];

class Writer {
  bytes = [];
  u8(v) { this.bytes.push(v & 0xff); return this; }
  u16(v) { return this.u8(v >> 8).u8(v); }
  i16(v) { return this.u16(v < 0 ? v + 0x10000 : v); }
  u32(v) { return this.u16(Math.floor(v / 0x10000)).u16(v % 0x10000); }
  tag(text) { for (const char of text) this.u8(char.charCodeAt(0)); return this; }
  pad(multiple) { while (this.bytes.length % multiple) this.u8(0); return this; }
  get length() { return this.bytes.length; }
}

function bounds(points) {
  if (points.length === 0) return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { xMin: Math.min(...xs), yMin: Math.min(...ys), xMax: Math.max(...xs), yMax: Math.max(...ys) };
}

const allBounds = bounds(GLYPHS.flatMap((g) => g.points));

function glyf() {
  const data = new Writer();
  const offsets = [];
  for (const { points } of GLYPHS) {
    offsets.push(data.length);
    if (points.length === 0) continue;
    const box = bounds(points);
    data.i16(1).i16(box.xMin).i16(box.yMin).i16(box.xMax).i16(box.yMax);
    data.u16(points.length - 1); // endPtsOfContours
    data.u16(0); // no instructions
    for (let i = 0; i < points.length; i++) data.u8(0x01); // on curve, 16-bit deltas
    let previous = 0;
    for (const [x] of points) { data.i16(x - previous); previous = x; }
    previous = 0;
    for (const [, y] of points) { data.i16(y - previous); previous = y; }
    data.pad(4);
  }
  offsets.push(data.length);
  return { data, offsets };
}

const { data: glyfTable, offsets } = glyf();

const loca = new Writer();
for (const offset of offsets) loca.u16(offset / 2);

const head = new Writer()
  .u32(0x00010000).u32(0x00010000).u32(0).u32(0x5f0f3cf5)
  .u16(0x0003).u16(UNITS_PER_EM)
  .u32(0).u32(0).u32(0).u32(0) // created, modified
  .i16(allBounds.xMin).i16(allBounds.yMin).i16(allBounds.xMax).i16(allBounds.yMax)
  .u16(0).u16(8).i16(2).i16(0).i16(0);

const hhea = new Writer()
  .u32(0x00010000).i16(ASCENT).i16(-DESCENT).i16(0)
  .u16(UNITS_PER_EM).i16(0).i16(UNITS_PER_EM - allBounds.xMax).i16(allBounds.xMax)
  .i16(1).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0)
  .u16(GLYPHS.length);

const maxp = new Writer()
  .u32(0x00010000).u16(GLYPHS.length)
  .u16(Math.max(...GLYPHS.map((g) => g.points.length))).u16(1)
  .u16(0).u16(0).u16(2).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0);

const hmtx = new Writer();
for (const { points } of GLYPHS) hmtx.u16(UNITS_PER_EM).i16(bounds(points).xMin);

const codes = GLYPHS.filter((g) => g.code !== null).map((g) => g.code);
const os2 = new Writer()
  .u16(0).i16(UNITS_PER_EM).u16(400).u16(5).u16(0)
  .i16(650).i16(600).i16(0).i16(75).i16(650).i16(600).i16(0).i16(350).i16(50).i16(250)
  .i16(0);
for (let i = 0; i < 10; i++) os2.u8(0); // panose
os2.u32(0).u32(0).u32(0).u32(0).tag('NONE').u16(0x0040)
  .u16(Math.min(...codes)).u16(Math.max(...codes))
  .i16(ASCENT).i16(-DESCENT).i16(0).u16(ASCENT).u16(DESCENT);

function cmap() {
  // Format 4, one segment per glyph plus the mandatory closing segment.
  const segments = GLYPHS.map((g, index) => ({ code: g.code, index })).filter((s) => s.code !== null);
  const segCount = segments.length + 1;
  const searchRange = 2 * 2 ** Math.floor(Math.log2(segCount));
  const sub = new Writer();
  sub.u16(4).u16(16 + segCount * 8).u16(0).u16(segCount * 2)
    .u16(searchRange).u16(Math.log2(searchRange / 2)).u16(segCount * 2 - searchRange);
  for (const s of segments) sub.u16(s.code);
  sub.u16(0xffff).u16(0);
  for (const s of segments) sub.u16(s.code);
  sub.u16(0xffff);
  for (const s of segments) sub.u16((s.index - s.code + 0x10000) % 0x10000);
  sub.u16(1);
  for (let i = 0; i < segCount; i++) sub.u16(0);
  const table = new Writer().u16(0).u16(1).u16(3).u16(1).u32(12);
  table.bytes.push(...sub.bytes);
  return table;
}

function name() {
  const records = [
    [1, 'Fixture Icons'], [2, 'Regular'], [3, 'Fixture Icons Regular'],
    [4, 'Fixture Icons'], [5, 'Version 1.0'], [6, 'FixtureIcons'],
  ];
  const strings = new Writer();
  const table = new Writer().u16(0).u16(records.length).u16(6 + records.length * 12);
  for (const [id, text] of records) {
    table.u16(3).u16(1).u16(0x0409).u16(id).u16(text.length * 2).u16(strings.length);
    for (const char of text) strings.u16(char.charCodeAt(0));
  }
  table.bytes.push(...strings.bytes);
  return table;
}

const post = new Writer().u32(0x00030000).u32(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0);

const tables = Object.entries({
  'OS/2': os2, cmap: cmap(), glyf: glyfTable, head, hhea, hmtx, loca, maxp, name: name(), post,
}).sort(([a], [b]) => (a < b ? -1 : 1));

function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const word = ((bytes[i] ?? 0) * 0x1000000) + ((bytes[i + 1] ?? 0) << 16) + ((bytes[i + 2] ?? 0) << 8) + (bytes[i + 3] ?? 0);
    sum = (sum + word) % 0x100000000;
  }
  return sum;
}

const searchRange = 16 * 2 ** Math.floor(Math.log2(tables.length));
const file = new Writer()
  .u32(0x00010000).u16(tables.length)
  .u16(searchRange).u16(Math.log2(searchRange / 16)).u16(tables.length * 16 - searchRange);
let offset = 12 + tables.length * 16;
let headOffset = 0;
for (const [tag, table] of tables) {
  table.pad(4);
  if (tag === 'head') headOffset = offset;
  file.tag(tag).u32(checksum(table.bytes)).u32(offset).u32(table.length);
  offset += table.length;
}
for (const [, table] of tables) file.bytes.push(...table.bytes);

const adjustment = (0xb1b0afba - checksum(file.bytes) + 0x100000000) % 0x100000000;
file.bytes[headOffset + 8] = Math.floor(adjustment / 0x1000000);
file.bytes[headOffset + 9] = (adjustment >> 16) & 0xff;
file.bytes[headOffset + 10] = (adjustment >> 8) & 0xff;
file.bytes[headOffset + 11] = adjustment & 0xff;

const target = fileURLToPath(new URL('./fixture-icons.ttf', import.meta.url));
writeFileSync(target, Uint8Array.from(file.bytes));
console.log(`${target}: ${file.bytes.length} bytes`);
