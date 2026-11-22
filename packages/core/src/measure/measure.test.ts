import { describe, expect, it } from 'vitest';
import { colorDifference, contrastRatio, deltaE2000, relativeLuminance, rgbToLab, toHex } from './color.js';
import type { Rgb } from './color.js';
import { connectedComponents, diffMask, unionBox } from './diff.js';
import { createImage, decodePng, encodePng, fillRect } from './image.js';
import type { Mask, RgbImage } from './image.js';
import { dominantColors, measureComponent } from './indicator.js';
import type { MeasureOptions } from './indicator.js';

const hex = (value: string): Rgb => ({
  r: parseInt(value.slice(1, 3), 16),
  g: parseInt(value.slice(3, 5), 16),
  b: parseInt(value.slice(5, 7), 16),
});
const WHITE = hex('#ffffff');
const BLACK = hex('#000000');

describe('contrastRatio', () => {
  // Reference pairs that are common knowledge among auditors.
  it.each([
    ['#000000', '#ffffff', 21],
    ['#ffffff', '#ffffff', 1],
    ['#767676', '#ffffff', 4.54],
    ['#777777', '#ffffff', 4.48],
    ['#949494', '#ffffff', 3.03],
    ['#959595', '#ffffff', 2.995],
    ['#0000ff', '#ffffff', 8.59],
    ['#ff0000', '#ffffff', 4.0],
    ['#00ff00', '#000000', 15.3],
  ])('%s on %s is %d:1', (a, b, expected) => {
    expect(contrastRatio(hex(a), hex(b))).toBeCloseTo(expected, 2);
  });
  it('is symmetric', () => {
    expect(contrastRatio(hex('#123456'), hex('#fedcba'))).toBe(contrastRatio(hex('#fedcba'), hex('#123456')));
  });
  it('has luminance 0 for black and 1 for white', () => {
    expect(relativeLuminance(BLACK)).toBe(0);
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 10);
  });
});

describe('colour difference', () => {
  it('converts white to L* 100 with no chroma', () => {
    const lab = rgbToLab(WHITE);
    expect(lab.l).toBeCloseTo(100, 3);
    expect(lab.a).toBeCloseTo(0, 2);
    expect(lab.b).toBeCloseTo(0, 2);
  });
  // Test data published with Sharma, Wu and Dalal (2005).
  it.each([
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [61, -5, 29], 22.8977],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ] as const)('deltaE2000 %j vs %j = %d', (a, b, expected) => {
    const first = { l: a[0], a: a[1], b: a[2] };
    const second = { l: b[0], a: b[1], b: b[2] };
    expect(deltaE2000(first, second)).toBeCloseTo(expected, 4);
    expect(deltaE2000(second, first)).toBeCloseTo(expected, 4);
  });
  it('is 0 for identical colours and large for black against white', () => {
    expect(colorDifference(hex('#336699'), hex('#336699'))).toBe(0);
    expect(colorDifference(BLACK, WHITE)).toBeCloseTo(100, 0);
  });
  it('keeps a one-step grey change under a threshold of 2', () => {
    expect(colorDifference(hex('#808080'), hex('#818181'))).toBeLessThan(1);
    expect(colorDifference(hex('#ffffff'), hex('#f4f4f4'))).toBeGreaterThan(2);
  });
});

describe('png round trip', () => {
  it('decodes what it encodes', () => {
    const image = createImage(5, 3, hex('#102030'));
    fillRect(image, { x: 1, y: 1, width: 2, height: 1 }, hex('#ff8000'));
    const decoded = decodePng(encodePng(image));
    expect(decoded.width).toBe(5);
    expect(decoded.height).toBe(3);
    expect([...decoded.data]).toEqual([...image.data]);
  });
});

function maskFrom(rows: string[]): Mask {
  const width = rows[0]!.length;
  return { width, height: rows.length, data: Uint8Array.from(rows.join(''), (c) => (c === '#' ? 1 : 0)) };
}

describe('diffMask', () => {
  it('is empty for identical images', () => {
    const a = createImage(8, 8, WHITE);
    expect(diffMask(a, createImage(8, 8, WHITE), 2).data.some((v) => v === 1)).toBe(false);
  });
  it('marks exactly the changed pixels', () => {
    const a = createImage(8, 8, WHITE);
    const b = createImage(8, 8, WHITE);
    fillRect(b, { x: 2, y: 3, width: 4, height: 1 }, hex('#005fcc'));
    const mask = diffMask(a, b, 2);
    expect(mask.data.reduce((sum, v) => sum + v, 0)).toBe(4);
    expect(mask.data[3 * 8 + 2]).toBe(1);
    expect(mask.data[3 * 8 + 6]).toBe(0);
  });
  it('ignores differences below the threshold', () => {
    const a = createImage(4, 4, hex('#808080'));
    const b = createImage(4, 4, hex('#818181'));
    expect(diffMask(a, b, 2).data.some((v) => v === 1)).toBe(false);
  });
  it('rejects images of different sizes', () => {
    expect(() => diffMask(createImage(2, 2, WHITE), createImage(3, 2, WHITE), 2)).toThrow(/different sizes/);
  });
});

describe('connectedComponents', () => {
  it('separates regions, joins diagonals and sorts by area', () => {
    const components = connectedComponents(
      maskFrom([
        '##......',
        '..#.....',
        '........',
        '....####',
        '....####',
        '#.......',
      ]),
      1,
    );
    expect(components.map((c) => c.area)).toEqual([8, 3, 1]);
    expect(components[0]!.bbox).toEqual({ x: 4, y: 3, width: 4, height: 2 });
    expect(components[1]!.bbox).toEqual({ x: 0, y: 0, width: 3, height: 2 });
    expect(unionBox(components)).toEqual({ x: 0, y: 0, width: 8, height: 6 });
  });
  it('drops specks below the minimum area but keeps a one-pixel line', () => {
    const components = connectedComponents(maskFrom(['#.......', '........', '.######.', '........']), 4);
    expect(components).toHaveLength(1);
    expect(components[0]!.bbox).toEqual({ x: 1, y: 2, width: 6, height: 1 });
  });
  it('returns nothing for an empty mask', () => {
    expect(connectedComponents(maskFrom(['....', '....']), 1)).toEqual([]);
    expect(unionBox([])).toBeNull();
  });
  it('handles a ring as one component', () => {
    const components = connectedComponents(maskFrom(['#####', '#...#', '#...#', '#####']), 1);
    expect(components).toHaveLength(1);
    expect(components[0]!.area).toBe(14);
  });
});

describe('dominantColors', () => {
  it('merges near-identical colours and orders by share', () => {
    const image = createImage(10, 1, WHITE);
    fillRect(image, { x: 0, y: 0, width: 3, height: 1 }, hex('#005fcc'));
    fillRect(image, { x: 3, y: 0, width: 1, height: 1 }, hex('#fefefe'));
    const clusters = dominantColors(image, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5);
    expect(clusters).toHaveLength(2);
    expect(toHex(clusters[0]!.color)).toBe('#ffffff');
    expect(clusters[0]!.share).toBeCloseTo(0.7);
    expect(toHex(clusters[1]!.color)).toBe('#005fcc');
  });
});

const OPTIONS: MeasureOptions = {
  adjacentGapPx: 1,
  adjacentBandPx: 3,
  clusterDeltaE: 5,
  minIndicatorShare: 0.2,
  minorPartMinShare: 0.02,
  minorPartSolidPx: 2,
  minAdjacentShare: 0.1,
  strokeMaxThicknessPx: 16,
  fillMinCoverage: 0.5,
};

/** A page with a button, and the same page with a ring drawn around the button. */
function scene(page: Rgb, button: Rgb, ring: Rgb, ringWidth = 4, offset = 4): { before: RgbImage; after: RgbImage } {
  const draw = (withRing: boolean): RgbImage => {
    const image = createImage(120, 80, page);
    if (withRing) {
      const outer = offset + ringWidth;
      fillRect(image, { x: 30 - outer, y: 25 - outer, width: 60 + 2 * outer, height: 30 + 2 * outer }, ring);
      fillRect(image, { x: 30 - offset, y: 25 - offset, width: 60 + 2 * offset, height: 30 + 2 * offset }, page);
    }
    fillRect(image, { x: 30, y: 25, width: 60, height: 30 }, button);
    return image;
  };
  return { before: draw(false), after: draw(true) };
}

function measureScene(page: string, button: string, ring: string, offset = 4) {
  const { before, after } = scene(hex(page), hex(button), hex(ring), 4, offset);
  const mask = diffMask(after, before, 2);
  const components = connectedComponents(mask, 4);
  expect(components).toHaveLength(1);
  return measureComponent(after, mask, components[0]!, OPTIONS);
}

describe('measureComponent', () => {
  it('measures a ring against the page on both sides', () => {
    const result = measureScene('#ffffff', '#ffffff', '#005fcc');
    expect(result.kind).toBe('stroke');
    expect(result.noisy).toBe(false);
    expect(toHex(result.best!.indicator)).toBe('#005fcc');
    expect(toHex(result.best!.adjacent)).toBe('#ffffff');
    expect(result.best!.ratio).toBeCloseTo(contrastRatio(hex('#005fcc'), WHITE), 6);
  });
  it('reports a pale ring below 3:1', () => {
    expect(measureScene('#ffffff', '#ffffff', '#c8c8c8').best!.ratio).toBeCloseTo(1.67, 2);
  });
  it('takes the better side when the ring touches a dark component', () => {
    // Flush ring: page outside (1.67:1), dark button inside.
    const result = measureScene('#ffffff', '#1a1a1a', '#c8c8c8', 0);
    expect(toHex(result.best!.adjacent)).toBe('#1a1a1a');
    expect(result.best!.ratio).toBeGreaterThan(3);
  });
  it('works on a dark page', () => {
    expect(measureScene('#111111', '#222222', '#333333').best!.ratio).toBeLessThan(2);
    expect(measureScene('#111111', '#222222', '#ffdd00').best!.ratio).toBeGreaterThan(10);
  });
  it('classifies a changed background as a fill and compares it with what is outside it', () => {
    const before = createImage(120, 80, WHITE);
    fillRect(before, { x: 30, y: 25, width: 60, height: 30 }, hex('#f0f0f0'));
    fillRect(before, { x: 50, y: 35, width: 20, height: 10 }, BLACK); // stands in for the label text
    const after = createImage(120, 80, WHITE);
    fillRect(after, { x: 30, y: 25, width: 60, height: 30 }, hex('#fff8d6'));
    fillRect(after, { x: 50, y: 35, width: 20, height: 10 }, BLACK);
    const mask = diffMask(after, before, 2);
    const components = connectedComponents(mask, 4);
    expect(components).toHaveLength(1);
    const result = measureComponent(after, mask, components[0]!, OPTIONS);
    expect(result.kind).toBe('fill');
    expect(toHex(result.best!.adjacent)).toBe('#ffffff'); // not the black text inside
    expect(result.best!.ratio).toBeLessThan(1.2);
  });
  it('counts a solid minority part, such as a dark bar under a highlight', () => {
    const before = createImage(160, 80, WHITE);
    const after = createImage(160, 80, WHITE);
    fillRect(after, { x: 20, y: 20, width: 120, height: 36 }, hex('#ffdd00'));
    fillRect(after, { x: 20, y: 56, width: 120, height: 4 }, hex('#0b0c0c'));
    const mask = diffMask(after, before, 2);
    const components = connectedComponents(mask, 4);
    expect(components).toHaveLength(1);
    const result = measureComponent(after, mask, components[0]!, OPTIONS);
    expect(toHex(result.best!.indicator)).toBe('#0b0c0c');
    expect(result.best!.ratio).toBeGreaterThan(15);
  });
  it('does not count a scattered minority colour', () => {
    const before = createImage(160, 80, WHITE);
    const after = createImage(160, 80, WHITE);
    fillRect(after, { x: 20, y: 20, width: 120, height: 40 }, hex('#fff8d6'));
    // Isolated dark pixels, as the blended edges of glyphs would be: 5 percent of the region.
    for (let n = 0; n < 240; n++) fillRect(after, { x: 21 + (n % 40) * 3, y: 21 + Math.floor(n / 40) * 3, width: 1, height: 1 }, hex('#404040'));
    const mask = diffMask(after, before, 2);
    const result = measureComponent(after, mask, connectedComponents(mask, 4)[0]!, OPTIONS);
    expect(toHex(result.best!.indicator)).toBe('#fff8d6');
    expect(result.best!.ratio).toBeLessThan(1.2);
  });
  it('returns no measurement when the component fills the image', () => {
    const before = createImage(20, 20, WHITE);
    const after = createImage(20, 20, BLACK);
    const mask = diffMask(after, before, 2);
    const result = measureComponent(after, mask, connectedComponents(mask, 1)[0]!, OPTIONS);
    expect(result.best).toBeNull();
  });
  it('ignores anti-aliased edge pixels when picking the indicator colour', () => {
    const { before, after } = scene(WHITE, WHITE, hex('#005fcc'));
    // Blend the outermost row of the ring halfway to white, as a rasteriser would.
    fillRect(after, { x: 22, y: 17, width: 76, height: 1 }, hex('#80afe6'));
    const mask = diffMask(after, before, 2);
    const result = measureComponent(after, mask, connectedComponents(mask, 4)[0]!, OPTIONS);
    expect(toHex(result.best!.indicator)).toBe('#005fcc');
  });
});
