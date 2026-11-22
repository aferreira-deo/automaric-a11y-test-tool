import { describe, expect, it } from 'vitest';
import { contrastRatio, toHex } from './color.js';
import type { Rgb } from './color.js';
import { hasSolidSquare, isBlendOf, isChannelBlendOf, measureBoundary, measureIcon } from './icon.js';
import type { BoundaryMeasureOptions, IconMeasureOptions, IconTarget } from './icon.js';
import { createImage, fillRect } from './image.js';
import type { PixelBox, RgbImage } from './image.js';

const hex = (value: string): Rgb => ({
  r: parseInt(value.slice(1, 3), 16),
  g: parseInt(value.slice(3, 5), 16),
  b: parseInt(value.slice(5, 7), 16),
});
const mix = (a: Rgb, b: Rgb, t: number): Rgb => ({
  r: Math.round(a.r + (b.r - a.r) * t),
  g: Math.round(a.g + (b.g - a.g) * t),
  b: Math.round(a.b + (b.b - a.b) * t),
});
const WHITE = hex('#ffffff');
const DARK = hex('#1a1a1a');
const PALE = hex('#c0c0c0');

// Device pixels of a capture at scale 2, as the check derives them from the default config.
const OPTIONS: IconMeasureOptions = {
  backgroundGapPx: 1,
  backgroundBandPx: 3,
  clusterDeltaE: 5,
  uniformBackgroundMinShare: 0.6,
  minBackgroundShare: 0.05,
  minInkShare: 0.004,
  minPartShare: 0.12,
  minSolidPartShare: 0.01,
  blendToleranceRgb: 14,
  minInteriorShare: 0.1,
  flatBlockPx: 4,
  maxParts: 3,
  complexResidualShare: 0.25,
  declaredBlendMinShare: 0.9,
};

// An 80 by 80 capture: the control's padding box is 60 by 60 at 10,10 and the graphic 40 by 40 at 20,20.
const ROOM: PixelBox = { x: 10, y: 10, width: 60, height: 60 };
const GRAPHIC: PixelBox = { x: 20, y: 20, width: 40, height: 40 };
const target = (over: Partial<IconTarget> = {}): IconTarget => ({
  box: GRAPHIC,
  room: ROOM,
  declared: null,
  subpixelText: false,
  ...over,
});

function scene(page: Rgb, fill: Rgb): RgbImage {
  const image = createImage(80, 80, page);
  fillRect(image, ROOM, fill);
  return image;
}

/** Three bars, 8 px thick, well inside the graphic box. */
function bars(image: RgbImage, color: Rgb): void {
  for (const y of [26, 36, 46]) fillRect(image, { x: 24, y, width: 32, height: 8 }, color);
}

/** A one-pixel diagonal line: every pixel of it touches the background. */
function hairline(image: RgbImage, color: Rgb): void {
  for (let i = 0; i < 30; i++) fillRect(image, { x: 25 + i, y: 25 + i, width: 1, height: 1 }, color);
}

describe('colour helpers', () => {
  it('recognises a blend on the line between two colours', () => {
    expect(isBlendOf(mix(WHITE, DARK, 0.4), WHITE, DARK, 14)).toBe(true);
    expect(isBlendOf(hex('#b00020'), WHITE, DARK, 14)).toBe(false);
    // Beyond the end of the segment is not between the two.
    expect(isBlendOf(hex('#000000'), WHITE, hex('#808080'), 14)).toBe(false);
  });
  it('recognises a per-channel blend, as subpixel text rendering makes', () => {
    const fringe = { r: 200, g: 120, b: 40 };
    expect(isChannelBlendOf(fringe, WHITE, DARK, 14)).toBe(true);
    expect(isBlendOf(fringe, WHITE, DARK, 14)).toBe(false);
    expect(isChannelBlendOf(hex('#ff0000'), hex('#808080'), hex('#a0a0a0'), 14)).toBe(false);
  });
  it('finds a solid square only when one exists', () => {
    const image = createImage(10, 10, WHITE);
    fillRect(image, { x: 2, y: 2, width: 3, height: 5 }, DARK);
    const box = { x: 0, y: 0, width: 10, height: 10 };
    expect(hasSolidSquare(image, box, DARK, 5, 3)).toBe(true);
    expect(hasSolidSquare(image, box, DARK, 5, 4)).toBe(false);
  });
});

describe('measureIcon', () => {
  it('measures a solid icon against the fill of its control, not against the page', () => {
    const fill = hex('#0b5fff');
    const image = scene(WHITE, fill);
    bars(image, WHITE);
    const result = measureIcon(image, target(), OPTIONS);
    expect(result).toMatchObject({ outcome: 'measured', ring: 'outside', uniformBackground: true, colourFrom: 'pixels', thin: false, complex: false });
    expect(result.parts).toHaveLength(1);
    expect(toHex(result.parts[0]!.color)).toBe('#ffffff');
    expect(toHex(result.parts[0]!.against)).toBe('#0b5fff');
    expect(result.parts[0]!.ratio).toBeCloseTo(contrastRatio(WHITE, fill), 5);
  });

  it('does not take anti-aliased edges for a second colour', () => {
    const image = scene(WHITE, WHITE);
    for (const y of [26, 36, 46]) fillRect(image, { x: 23, y: y - 1, width: 34, height: 10 }, mix(WHITE, PALE, 0.5));
    bars(image, PALE);
    const result = measureIcon(image, target(), OPTIONS);
    expect(result.parts).toHaveLength(1);
    expect(toHex(result.parts[0]!.color)).toBe('#c0c0c0');
    expect(result.parts[0]!.ratio).toBeCloseTo(1.82, 2);
    expect(result.parts[0]!.solid).toBe(true);
  });

  it('flags a hairline read from pixels as thin: its colour is a lower bound', () => {
    const image = scene(WHITE, WHITE);
    // The true colour is #707070 (4.95:1); at half coverage the screen shows a colour at 2.1:1.
    hairline(image, mix(WHITE, hex('#707070'), 0.5));
    const result = measureIcon(image, target(), OPTIONS);
    expect(result.thin).toBe(true);
    expect(result.parts[0]!.solid).toBe(false);
    expect(result.parts[0]!.ratio).toBeLessThan(3);
  });

  it('takes a declared colour when the pixels are a blend of it with the background', () => {
    const image = scene(WHITE, WHITE);
    hairline(image, mix(WHITE, hex('#707070'), 0.5));
    const result = measureIcon(image, target({ declared: hex('#707070') }), OPTIONS);
    expect(result).toMatchObject({ colourFrom: 'declared', declaredMismatch: false, thin: false });
    expect(result.parts[0]!.ratio).toBeCloseTo(4.95, 2);
  });

  it('takes a declared colour when pixels of it exist', () => {
    const image = scene(WHITE, WHITE);
    bars(image, PALE);
    const result = measureIcon(image, target({ declared: PALE }), OPTIONS);
    expect(result.colourFrom).toBe('declared');
    expect(result.parts).toHaveLength(1);
  });

  it('falls back to pixels when the declared colour is nowhere in the capture', () => {
    const image = scene(WHITE, WHITE);
    bars(image, DARK);
    const result = measureIcon(image, target({ declared: hex('#b00020') }), OPTIONS);
    expect(result).toMatchObject({ colourFrom: 'pixels', declaredMismatch: true });
    expect(toHex(result.parts[0]!.color)).toBe('#1a1a1a');
  });

  it('reports each colour of a multi-colour icon with its own ratio', () => {
    const image = scene(WHITE, WHITE);
    fillRect(image, { x: 24, y: 24, width: 14, height: 32 }, DARK);
    fillRect(image, { x: 42, y: 24, width: 14, height: 32 }, hex('#ffe08a'));
    const result = measureIcon(image, target(), OPTIONS);
    expect(result.parts.map((part) => toHex(part.color)).sort()).toEqual(['#1a1a1a', '#ffe08a']);
    expect(Math.min(...result.parts.map((part) => part.ratio))).toBeCloseTo(1.29, 1);
    expect(result.complex).toBe(false);
  });

  it('keeps a small solid detail as a part: a dark glyph on a pale disc', () => {
    const image = scene(WHITE, WHITE);
    fillRect(image, { x: 22, y: 22, width: 36, height: 36 }, hex('#e6e6e6'));
    fillRect(image, { x: 36, y: 30, width: 6, height: 12 }, DARK); // 5.6% of the ink
    const result = measureIcon(image, target(), OPTIONS);
    expect(result.parts.map((part) => toHex(part.color))).toEqual(['#e6e6e6', '#1a1a1a']);
  });

  it('treats a flat lighter tone of the same hue as a part, not as anti-aliasing', () => {
    const image = scene(WHITE, WHITE);
    fillRect(image, { x: 24, y: 24, width: 14, height: 32 }, DARK);
    fillRect(image, { x: 42, y: 24, width: 14, height: 32 }, mix(WHITE, DARK, 0.3));
    const result = measureIcon(image, target(), OPTIONS);
    expect(result.parts).toHaveLength(2);
  });

  it('compares with every colour of a varied background and keeps the lowest ratio', () => {
    const image = scene(WHITE, WHITE);
    for (let y = 10; y < 70; y++) {
      const shade = mix(DARK, hex('#e6e6e6'), (y - 10) / 59);
      fillRect(image, { x: 10, y, width: 60, height: 1 }, shade);
    }
    bars(image, WHITE);
    const result = measureIcon(image, target({ declared: WHITE }), OPTIONS);
    expect(result.uniformBackground).toBe(false);
    expect(result.background.length).toBeGreaterThan(1);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]!.ratio).toBeLessThan(2);
  });

  it('measures a shape that fills its whole box against what is outside the box', () => {
    const image = createImage(80, 80, WHITE);
    fillRect(image, GRAPHIC, PALE);
    // No padding around the graphic: the band inside the box only sees the shape itself.
    const result = measureIcon(image, target({ room: GRAPHIC }), OPTIONS);
    expect(result).toMatchObject({ outcome: 'measured', ring: 'outside' });
    expect(result.parts[0]!.ratio).toBeCloseTo(1.82, 2);
  });

  it('ignores what touches the edge when the box is the padding box of the control', () => {
    const image = createImage(80, 80, WHITE);
    // A rounded border showing in the corners of the padding box.
    for (const [x, y] of [[20, 20], [56, 20], [20, 56], [56, 56]] as const) fillRect(image, { x, y, width: 4, height: 4 }, DARK);
    fillRect(image, { x: 30, y: 30, width: 20, height: 20 }, PALE);
    const result = measureIcon(image, target({ room: null }), OPTIONS);
    expect(result.ring).toBe('inside');
    expect(result.parts.map((part) => toHex(part.color))).toEqual(['#c0c0c0']);
  });

  it('reports no ink when nothing differs from the background', () => {
    const result = measureIcon(scene(WHITE, hex('#eeeeee')), target(), OPTIONS);
    expect(result.outcome).toBe('no-ink');
    expect(toHex(result.background[0]!)).toBe('#eeeeee');
  });

  it('calls a graphic of many colours complex', () => {
    const image = scene(WHITE, WHITE);
    const colours = ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51', '#3a0ca3', '#7209b7', '#f72585', '#4cc9f0'];
    colours.forEach((colour, index) => {
      fillRect(image, { x: 22 + (index % 3) * 12, y: 22 + Math.floor(index / 3) * 12, width: 12, height: 12 }, hex(colour));
    });
    const result = measureIcon(image, target(), OPTIONS);
    expect(result.complex).toBe(true);
    expect(result.bestRatio).toBeGreaterThan(3);
  });

  it('accepts the coloured fringes of subpixel text only for text', () => {
    const draw = (): RgbImage => {
      const image = scene(WHITE, WHITE);
      for (let x = 24; x < 56; x += 8) {
        fillRect(image, { x, y: 24, width: 4, height: 32 }, DARK);
        fillRect(image, { x: x - 1, y: 24, width: 1, height: 32 }, { r: 205, g: 125, b: 45 });
        fillRect(image, { x: x + 4, y: 24, width: 1, height: 32 }, { r: 40, g: 110, b: 215 });
      }
      return image;
    };
    const asText = measureIcon(draw(), target({ subpixelText: true, declared: DARK }), OPTIONS);
    expect(asText).toMatchObject({ complex: false, colourFrom: 'declared' });
    expect(asText.parts).toHaveLength(1);
    const asShape = measureIcon(draw(), target({ declared: DARK }), OPTIONS);
    expect(asShape.complex || asShape.parts.length > 1).toBe(true);
  });

  it('copes with a box that reaches outside the image', () => {
    const image = createImage(30, 30, WHITE);
    fillRect(image, { x: 8, y: 8, width: 12, height: 12 }, DARK);
    const result = measureIcon(image, target({ box: { x: -10, y: -10, width: 60, height: 60 }, room: null }), OPTIONS);
    expect(result.outcome).toBe('measured');
    expect(measureIcon(image, target({ box: { x: 100, y: 100, width: 10, height: 10 } }), OPTIONS).outcome).toBe('no-ink');
  });
});

const EDGE: BoundaryMeasureOptions = {
  reachPx: 6,
  depthPx: 8,
  sideShare: 0.3,
  minSidePx: 12,
  clusterDeltaE: 2,
  minShare: 0.06,
};
// A field of 200 by 60 px at 30,30 in a capture of 260 by 120.
const FIELD: PixelBox = { x: 30, y: 30, width: 200, height: 60 };

function field(page: Rgb, fill: Rgb, border?: { color: Rgb; width: number; sides?: ('top' | 'right' | 'bottom' | 'left')[] }): RgbImage {
  const image = createImage(260, 120, page);
  fillRect(image, FIELD, fill);
  if (border) {
    const { color, width } = border;
    const sides = border.sides ?? ['top', 'right', 'bottom', 'left'];
    if (sides.includes('top')) fillRect(image, { ...FIELD, height: width }, color);
    if (sides.includes('bottom')) fillRect(image, { ...FIELD, y: FIELD.y + FIELD.height - width, height: width }, color);
    if (sides.includes('left')) fillRect(image, { ...FIELD, width }, color);
    if (sides.includes('right')) fillRect(image, { ...FIELD, x: FIELD.x + FIELD.width - width, width }, color);
  }
  return image;
}

describe('measureBoundary', () => {
  it.each([
    ['#cccccc', 1.61],
    ['#999999', 2.85],
    ['#949494', 3.03],
    ['#595959', 7.0],
  ])('measures a 1 CSS px border %s on white at %d:1', (colour, expected) => {
    const result = measureBoundary(field(WHITE, WHITE, { color: hex(colour), width: 2 }), FIELD, EDGE);
    expect(result!.ratio).toBeCloseTo(expected, 2);
    expect(result!.side).toBe('top');
  });

  it('still sees a half-pixel border', () => {
    const result = measureBoundary(field(WHITE, WHITE, { color: hex('#595959'), width: 1 }), FIELD, EDGE);
    expect(result!.ratio).toBeCloseTo(7.0, 1);
  });

  it('measures a fill against the page when there is no border', () => {
    expect(measureBoundary(field(hex('#4a4a4a'), WHITE), FIELD, EDGE)!.ratio).toBeCloseTo(8.86, 2);
    expect(measureBoundary(field(WHITE, hex('#f2f2f2')), FIELD, EDGE)!.ratio).toBeLessThan(1.2);
  });

  it('finds an underline on the one side that has it', () => {
    const result = measureBoundary(field(WHITE, WHITE, { color: DARK, width: 4, sides: ['bottom'] }), FIELD, EDGE);
    expect(result).toMatchObject({ side: 'bottom' });
    expect(result!.ratio).toBeCloseTo(17.4, 1);
  });

  it('keeps a pale fill and a white page apart: the line counts against either', () => {
    // #8b8b8b is 2.99:1 against #f0f0f0 and 3.41:1 against white.
    const image = field(WHITE, hex('#f0f0f0'), { color: hex('#8b8b8b'), width: 2, sides: ['bottom'] });
    expect(measureBoundary(image, FIELD, EDGE)!.ratio).toBeCloseTo(3.41, 2);
  });

  it('sees a ring drawn just outside the box', () => {
    const image = createImage(260, 120, WHITE);
    fillRect(image, { x: 28, y: 28, width: 204, height: 64 }, hex('#595959'));
    fillRect(image, FIELD, WHITE);
    expect(measureBoundary(image, FIELD, EDGE)!.ratio).toBeCloseTo(7.0, 1);
  });

  it('is not fooled by blended pixels along a curved edge', () => {
    // A ring whose rows are offset as on a circle: the true colour still holds a share of the zone.
    const image = createImage(120, 120, WHITE);
    const box: PixelBox = { x: 40, y: 40, width: 40, height: 40 };
    const ring = hex('#767676');
    for (let x = 40; x < 80; x++) {
      const sag = Math.abs(x - 60) > 4 ? 1 : 0;
      fillRect(image, { x, y: 40 + sag, width: 1, height: 2 }, ring);
      fillRect(image, { x, y: 39 + sag, width: 1, height: 1 }, mix(WHITE, ring, 0.4));
    }
    expect(measureBoundary(image, box, EDGE)!.ratio).toBeCloseTo(4.54, 1);
  });

  it('skips sides cut by the capture and returns null when none is left', () => {
    const image = field(WHITE, WHITE, { color: DARK, width: 2 });
    const cut = measureBoundary(image, { x: 30, y: 2, width: 200, height: 88 }, EDGE);
    expect(cut!.side).not.toBe('top');
    expect(measureBoundary(image, { x: 400, y: 400, width: 50, height: 50 }, EDGE)).toBeNull();
  });
});
