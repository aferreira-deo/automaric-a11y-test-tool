import { colorDifference, contrastRatio } from './color.js';
import type { Rgb } from './color.js';
import { connectedComponents } from './diff.js';
import type { PixelBox, RgbImage } from './image.js';
import { dominantColors } from './indicator.js';
import type { ColorCluster } from './indicator.js';

/** All lengths are device pixels of the image being measured. */
export interface IconMeasureOptions {
  /** Skipped between the graphic box and the band sampled for its background. */
  backgroundGapPx: number;
  backgroundBandPx: number;
  clusterDeltaE: number;
  uniformBackgroundMinShare: number;
  minBackgroundShare: number;
  minInkShare: number;
  minPartShare: number;
  /** Below `minPartShare`, a colour is still a part from this share if it forms a solid block. */
  minSolidPartShare: number;
  blendToleranceRgb: number;
  /** Share of a colour's pixels that must be interior for it to be a true colour, not a blend. */
  minInteriorShare: number;
  /** Fewest interior pixels for the same, whatever the share. */
  minInteriorPixels: number;
  /**
   * Side of the solid square from which a colour is a flat area of its own even when it lies
   * between two others: a gradient, or a second tone of the same hue. Anti-aliasing never is.
   */
  flatBlockPx: number;
  maxParts: number;
  complexResidualShare: number;
  declaredBlendMinShare: number;
}

export interface IconPart {
  color: Rgb;
  /** Share of the ink (the pixels that are not background). 0 for a declared colour too thin to show. */
  share: number;
  /** The colour has interior pixels, or comes from computed styles: it is not an anti-aliasing blend. */
  solid: boolean;
  /** Lowest contrast against the background colours. */
  ratio: number;
  /** The background colour that gives `ratio`. */
  against: Rgb;
}

export interface IconMeasurement {
  /** `no-ink`: nothing in the graphic box differs from its background. */
  outcome: 'measured' | 'no-ink';
  /** Where the background was sampled: just outside the graphic box, or just inside its edge. */
  ring: 'outside' | 'inside';
  /** The colours the icon is compared with: one when the background is uniform. */
  background: Rgb[];
  uniformBackground: boolean;
  /** Colours of the icon, the main one first. Anti-aliasing blends are not parts. */
  parts: IconPart[];
  /** Where the main colour comes from. */
  colourFrom: 'declared' | 'pixels';
  /** A declared colour was given but the pixels do not show it. */
  declaredMismatch: boolean;
  /** The main colour was read from pixels that all touch the background: the true colour may be stronger. */
  thin: boolean;
  /** Too many colours for an icon: a picture, a photo, a detailed logo. */
  complex: boolean;
  /** Share of the graphic box that is ink. */
  inkShare: number;
  /** Highest contrast against the background among the colours that hold a noticeable share of the ink. */
  bestRatio: number;
}

function clampBox(box: PixelBox, image: RgbImage): PixelBox {
  const x0 = Math.max(0, Math.min(image.width, box.x));
  const y0 = Math.max(0, Math.min(image.height, box.y));
  const x1 = Math.max(x0, Math.min(image.width, box.x + box.width));
  const y1 = Math.max(y0, Math.min(image.height, box.y + box.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function boxPixels(image: RgbImage, box: PixelBox): number[] {
  const pixels: number[] = [];
  for (let y = box.y; y < box.y + box.height; y++) {
    for (let x = box.x; x < box.x + box.width; x++) pixels.push(y * image.width + x);
  }
  return pixels;
}

/** Pixels of `outer` that are not in `inner`. Both must lie inside the image. */
function framePixels(image: RgbImage, outer: PixelBox, inner: PixelBox): number[] {
  const pixels: number[] = [];
  for (let y = outer.y; y < outer.y + outer.height; y++) {
    const insideRows = y >= inner.y && y < inner.y + inner.height;
    for (let x = outer.x; x < outer.x + outer.width; x++) {
      if (insideRows && x >= inner.x && x < inner.x + inner.width) continue;
      pixels.push(y * image.width + x);
    }
  }
  return pixels;
}

function inflate(box: PixelBox, by: number): PixelBox {
  return { x: box.x - by, y: box.y - by, width: box.width + 2 * by, height: box.height + 2 * by };
}

function within(inner: PixelBox, outer: PixelBox): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * True when `color` lies on the straight line between `a` and `b` in 8-bit RGB, within
 * `tolerance`. Anti-aliasing mixes two colours channel by channel in that space, so the
 * blended pixels of an edge all sit on that line.
 */
export function isBlendOf(color: Rgb, a: Rgb, b: Rgb, tolerance: number): boolean {
  const dr = b.r - a.r;
  const dg = b.g - a.g;
  const db = b.b - a.b;
  const lengthSquared = dr * dr + dg * dg + db * db;
  let t = lengthSquared === 0 ? 0 : ((color.r - a.r) * dr + (color.g - a.g) * dg + (color.b - a.b) * db) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  const distance = Math.hypot(color.r - (a.r + t * dr), color.g - (a.g + t * dg), color.b - (a.b + t * db));
  return distance <= tolerance;
}

/**
 * True when every channel of `color` lies between the same channel of `a` and of `b`, within
 * `tolerance`. That is what subpixel anti-aliasing of text between those two colours produces.
 */
export function isChannelBlendOf(color: Rgb, a: Rgb, b: Rgb, tolerance: number): boolean {
  const between = (value: number, from: number, to: number): boolean =>
    value >= Math.min(from, to) - tolerance && value <= Math.max(from, to) + tolerance;
  return between(color.r, a.r, b.r) && between(color.g, a.g, b.g) && between(color.b, a.b, b.b);
}

/** True when `box` contains a `side` by `side` square made only of pixels within `deltaE` of `color`. */
export function hasSolidSquare(image: RgbImage, box: PixelBox, color: Rgb, deltaE: number, side: number): boolean {
  const verdicts = new Map<number, boolean>();
  let previous = new Uint16Array(box.width);
  let current = new Uint16Array(box.width);
  for (let y = 0; y < box.height; y++) {
    current.fill(0);
    for (let x = 0; x < box.width; x++) {
      const i = ((box.y + y) * image.width + box.x + x) * 3;
      const r = image.data[i]!;
      const g = image.data[i + 1]!;
      const b = image.data[i + 2]!;
      const key = (r << 16) | (g << 8) | b;
      let matches = verdicts.get(key);
      if (matches === undefined) {
        matches = colorDifference({ r, g, b }, color) <= deltaE;
        verdicts.set(key, matches);
      }
      if (!matches) continue;
      const size = x === 0 ? 1 : 1 + Math.min(previous[x]!, previous[x - 1]!, current[x - 1]!);
      if (size >= side) return true;
      current[x] = size;
    }
    [previous, current] = [current, previous];
  }
  return false;
}

export interface IconTarget {
  /** Box of the graphic, in pixels of the image. */
  box: PixelBox;
  /**
   * Padding box of the control when the graphic has a box of its own inside it; null when
   * `box` is the padding box of the control itself.
   */
  room: PixelBox | null;
  /** Colour read from computed styles, when there is one. */
  declared: Rgb | null;
  /**
   * The graphic is text (an icon-font glyph). Text may be drawn with subpixel anti-aliasing,
   * which blends each colour channel by a different amount and leaves coloured fringes.
   */
  subpixelText: boolean;
}

/**
 * Ink without the regions that touch the edge of the box. When the box is the padding box of
 * a control, those are its rounded border and the page showing in the corners, not the graphic.
 */
function withoutEdgeInk(image: RgbImage, box: PixelBox, ink: number[]): number[] {
  const data = new Uint8Array(box.width * box.height);
  for (const p of ink) {
    const x = p % image.width;
    const y = (p - x) / image.width;
    data[(y - box.y) * box.width + (x - box.x)] = 1;
  }
  const kept: number[] = [];
  for (const component of connectedComponents({ width: box.width, height: box.height, data }, 1)) {
    const { bbox } = component;
    if (bbox.x === 0 || bbox.y === 0 || bbox.x + bbox.width === box.width || bbox.y + bbox.height === box.height) continue;
    for (const local of component.pixels) {
      const x = local % box.width;
      const y = (local - x) / box.width;
      kept.push((y + box.y) * image.width + x + box.x);
    }
  }
  return kept.sort((a, b) => a - b);
}

/** Ink pixels whose eight neighbours are ink too. Neighbours beyond the box count as ink. */
function interiorPixels(image: RgbImage, box: PixelBox, ink: number[]): number[] {
  const set = new Set(ink);
  const x1 = box.x + box.width;
  const y1 = box.y + box.height;
  return ink.filter((p) => {
    const x = p % image.width;
    const y = (p - x) / image.width;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < box.x || ny < box.y || nx >= x1 || ny >= y1) continue;
        if (!set.has(ny * image.width + nx)) return false;
      }
    }
    return true;
  });
}

interface Analysis {
  ring: 'outside' | 'inside';
  clusters: ColorCluster[];
  uniform: boolean;
  background: Rgb[];
  ink: number[];
  inkShare: number;
}

function analyse(
  image: RgbImage,
  box: PixelBox,
  ring: 'outside' | 'inside',
  ringPixels: number[],
  dropEdgeInk: boolean,
  options: IconMeasureOptions,
): Analysis | null {
  const clusters = dominantColors(image, ringPixels, options.clusterDeltaE);
  const top = clusters[0];
  if (!top) return null;
  const uniform = top.share >= options.uniformBackgroundMinShare;
  // On a uniform background the other colours of the band are the icon reaching its box, or
  // rounded corners. On a varied one (a gradient, a picture) every colour of the band is background.
  const removed = uniform ? [top.color] : clusters.map((cluster) => cluster.color);
  let background = uniform
    ? [top.color]
    : clusters.filter((cluster) => cluster.share >= options.minBackgroundShare).map((cluster) => cluster.color);
  if (background.length === 0) background = [top.color];

  const verdicts = new Map<number, boolean>();
  let ink: number[] = [];
  for (const p of boxPixels(image, box)) {
    const i = p * 3;
    const r = image.data[i]!;
    const g = image.data[i + 1]!;
    const b = image.data[i + 2]!;
    const key = (r << 16) | (g << 8) | b;
    let isBackground = verdicts.get(key);
    if (isBackground === undefined) {
      isBackground = removed.some((color) => colorDifference({ r, g, b }, color) <= options.clusterDeltaE);
      verdicts.set(key, isBackground);
    }
    if (!isBackground) ink.push(p);
  }
  if (dropEdgeInk) ink = withoutEdgeInk(image, box, ink);
  return { ring, clusters, uniform, background, ink, inkShare: ink.length / (box.width * box.height) };
}

/**
 * Colours of a graphic and their contrast against what surrounds it.
 *
 * The background is sampled in a band just outside the graphic when that band still lies inside
 * `room` (it is then the control's own fill), otherwise just inside the edge of the graphic box.
 * If nothing differs from that background, the other band is tried: a solid shape that fills
 * its whole box only stands out against what is outside it.
 *
 * A declared colour becomes the colour of the icon only when the pixels agree: pixels of that
 * colour exist, or the ink is a blend of it with the background.
 */
export function measureIcon(image: RgbImage, target: IconTarget, options: IconMeasureOptions): IconMeasurement {
  const { room, declared } = target;
  const full: PixelBox = { x: 0, y: 0, width: image.width, height: image.height };
  const box = clampBox(target.box, image);
  const dropEdgeInk = room === null;
  const empty: IconMeasurement = {
    outcome: 'no-ink',
    ring: 'inside',
    background: [],
    uniformBackground: false,
    parts: [],
    colourFrom: 'pixels',
    declaredMismatch: false,
    thin: false,
    complex: false,
    inkShare: 0,
    bestRatio: 1,
  };
  if (box.width < 1 || box.height < 1) return empty;

  const reach = options.backgroundGapPx + options.backgroundBandPx;
  const outerBox = inflate(box, reach);
  const outsideAvailable = within(outerBox, full);
  const outsidePixels = (): number[] => framePixels(image, outerBox, inflate(box, options.backgroundGapPx));
  const band = Math.min(options.backgroundBandPx, Math.floor(Math.min(box.width, box.height) / 2));
  const insidePixels = (): number[] => (band >= 1 ? framePixels(image, box, inflate(box, -band)) : []);

  const preferOutside = outsideAvailable && room !== null && within(outerBox, room);
  const first = preferOutside
    ? analyse(image, box, 'outside', outsidePixels(), dropEdgeInk, options)
    : analyse(image, box, 'inside', insidePixels(), dropEdgeInk, options);
  let analysis = first;
  if (!analysis || analysis.inkShare < options.minInkShare) {
    const second = preferOutside
      ? analyse(image, box, 'inside', insidePixels(), dropEdgeInk, options)
      : outsideAvailable && !dropEdgeInk
        ? analyse(image, box, 'outside', outsidePixels(), dropEdgeInk, options)
        : null;
    if (second && second.inkShare >= options.minInkShare) analysis = second;
  }
  if (!analysis) return empty;
  const { background, uniform } = analysis;
  const against = (color: Rgb): { ratio: number; against: Rgb } => {
    let worst = { ratio: Infinity, against: background[0]! };
    for (const candidate of background) {
      const ratio = contrastRatio(color, candidate);
      if (ratio < worst.ratio) worst = { ratio, against: candidate };
    }
    return worst;
  };
  const base = { ...empty, ring: analysis.ring, background, uniformBackground: uniform, inkShare: analysis.inkShare };
  if (analysis.inkShare < options.minInkShare) return base;

  const ink = dominantColors(image, analysis.ink, options.clusterDeltaE);
  const same = (a: Rgb, b: Rgb): boolean => colorDifference(a, b) <= options.clusterDeltaE;
  const interior = interiorPixels(image, box, analysis.ink);
  /**
   * A pixel surrounded by ink is covered entirely by the shape, so it shows the shape's own
   * colour. A colour with enough such pixels is a true colour; one that only ever touches the
   * background (a hairline, the rim of a shape) may be a blend of a stronger colour with it.
   */
  const solid = (cluster: ColorCluster): boolean => {
    let count = 0;
    for (const p of interior) {
      const i = p * 3;
      if (same({ r: image.data[i]!, g: image.data[i + 1]!, b: image.data[i + 2]! }, cluster.color)) count++;
    }
    return count >= options.minInteriorPixels && count >= options.minInteriorShare * cluster.share * analysis.ink.length;
  };
  const blendWithBackground = (color: Rgb, other: Rgb): boolean =>
    background.some(
      (candidate) =>
        isBlendOf(color, candidate, other, options.blendToleranceRgb) ||
        (target.subpixelText && isChannelBlendOf(color, candidate, other, options.blendToleranceRgb)),
    );
  const flatCache = new Map<Rgb, boolean>();
  /** A flat area of this colour exists: it is painted as such, not produced by anti-aliasing. */
  const flat = (color: Rgb): boolean => {
    let known = flatCache.get(color);
    if (known === undefined) {
      known = hasSolidSquare(image, box, color, options.clusterDeltaE, options.flatBlockPx);
      flatCache.set(color, known);
    }
    return known;
  };

  // The main colour.
  let main: { color: Rgb; share: number; solid: boolean } | null = null;
  let colourFrom: IconMeasurement['colourFrom'] = 'pixels';
  let declaredMismatch = false;
  let thin = false;
  if (declared) {
    const present = ink.find((cluster) => same(cluster.color, declared));
    const blended = ink
      .filter((cluster) => same(cluster.color, declared) || (blendWithBackground(cluster.color, declared) && !flat(cluster.color)))
      .reduce((sum, cluster) => sum + cluster.share, 0);
    if (present || blended >= options.declaredBlendMinShare) {
      main = { color: declared, share: present?.share ?? 0, solid: true };
      colourFrom = 'declared';
    } else {
      declaredMismatch = true;
    }
  }
  if (!main) {
    const noticeable = ink.filter((cluster) => cluster.share >= options.minBackgroundShare);
    const solidOne = noticeable.find((cluster) => solid(cluster));
    if (solidOne) {
      main = { ...solidOne, solid: true };
    } else {
      // No colour is certain. The one that stands out most is the closest to the true colour.
      const pool = noticeable.length > 0 ? noticeable : ink.slice(0, 1);
      const strongest = [...pool].sort((a, b) => against(b.color).ratio - against(a.color).ratio)[0]!;
      main = { ...strongest, solid: false };
      thin = true;
    }
  }

  // The other parts: colours with a share of their own that no pair of known colours explains.
  const accepted: { color: Rgb; share: number; solid: boolean }[] = [main];
  const explained = (color: Rgb): boolean => {
    if (accepted.some((part) => same(part.color, color))) return true;
    if (flat(color)) return false;
    for (let i = 0; i < accepted.length; i++) {
      if (blendWithBackground(color, accepted[i]!.color)) return true;
      for (let j = i + 1; j < accepted.length; j++) {
        if (isBlendOf(color, accepted[i]!.color, accepted[j]!.color, options.blendToleranceRgb)) return true;
      }
    }
    return false;
  };
  for (const cluster of ink) {
    // Sorted by share. Past the limit the graphic is a picture and the rest does not matter.
    if (cluster.share < options.minSolidPartShare || accepted.length > options.maxParts) break;
    if (explained(cluster.color)) continue;
    // A small detail in a colour of its own can be the part that matters (a dark glyph on a
    // pale disc), so it counts as soon as it is solid.
    const isSolid = solid(cluster);
    if (cluster.share >= options.minPartShare || isSolid) accepted.push({ ...cluster, solid: isSolid });
  }
  const residual = ink.filter((cluster) => !explained(cluster.color)).reduce((sum, cluster) => sum + cluster.share, 0);

  const noticeableRatios = ink
    .filter((cluster) => cluster.share >= options.minBackgroundShare)
    .map((cluster) => against(cluster.color).ratio);
  const parts = accepted.map((part) => ({ ...part, ...against(part.color) }));
  return {
    ...base,
    outcome: 'measured',
    parts,
    colourFrom,
    declaredMismatch,
    thin,
    complex: accepted.length > options.maxParts || residual > options.complexResidualShare,
    bestRatio: Math.max(...parts.map((part) => part.ratio), ...noticeableRatios),
  };
}

export interface BoundaryMeasureOptions {
  /** How far outside the box, and how far inside, the edge zone reaches. */
  reachPx: number;
  depthPx: number;
  /** Share of each side, around its middle, that is sampled. */
  sideShare: number;
  minSidePx: number;
  clusterDeltaE: number;
  /** A colour counts from this share of the zone. */
  minShare: number;
}

export type BoundarySide = 'top' | 'right' | 'bottom' | 'left';

export interface BoundaryMeasurement {
  side: BoundarySide;
  /** The two colours with the highest contrast found across that edge. Equal when the edge shows one colour. */
  a: Rgb;
  b: Rgb;
  ratio: number;
}

/**
 * The strongest edge of a box: for the middle stretch of each side, the colours found from just
 * outside the box to just inside it, and the highest contrast between two of them. That one
 * number covers a border against the page, a border against the fill, a fill against the page
 * and a ring drawn with box-shadow, without knowing which of them the author used.
 *
 * Returns null when no side could be sampled (the box lies outside the image).
 */
export function measureBoundary(image: RgbImage, box: PixelBox, options: BoundaryMeasureOptions): BoundaryMeasurement | null {
  const depthX = Math.max(1, Math.min(options.depthPx, Math.floor(box.width / 2)));
  const depthY = Math.max(1, Math.min(options.depthPx, Math.floor(box.height / 2)));
  const spanX = Math.min(box.width, Math.max(options.minSidePx, Math.round(box.width * options.sideShare)));
  const spanY = Math.min(box.height, Math.max(options.minSidePx, Math.round(box.height * options.sideShare)));
  const startX = box.x + Math.floor((box.width - spanX) / 2);
  const startY = box.y + Math.floor((box.height - spanY) / 2);
  const zones: [BoundarySide, PixelBox][] = [
    ['top', { x: startX, y: box.y - options.reachPx, width: spanX, height: options.reachPx + depthY }],
    ['right', { x: box.x + box.width - depthX, y: startY, width: depthX + options.reachPx, height: spanY }],
    ['bottom', { x: startX, y: box.y + box.height - depthY, width: spanX, height: depthY + options.reachPx }],
    ['left', { x: box.x - options.reachPx, y: startY, width: options.reachPx + depthX, height: spanY }],
  ];

  let best: BoundaryMeasurement | null = null;
  for (const [side, zone] of zones) {
    const visible = clampBox(zone, image);
    // A zone cut by the edge of the capture has lost its outside or its inside.
    if (visible.width !== zone.width || visible.height !== zone.height) continue;
    const clusters = dominantColors(image, boxPixels(image, visible), options.clusterDeltaE);
    const colours = clusters.filter((cluster) => cluster.share >= options.minShare);
    const top = clusters[0];
    if (!top) continue;
    let found: BoundaryMeasurement = { side, a: top.color, b: top.color, ratio: 1 };
    for (let i = 0; i < colours.length; i++) {
      for (let j = i + 1; j < colours.length; j++) {
        const ratio = contrastRatio(colours[i]!.color, colours[j]!.color);
        if (ratio > found.ratio) found = { side, a: colours[i]!.color, b: colours[j]!.color, ratio };
      }
    }
    if (!best || found.ratio > best.ratio) best = found;
  }
  return best;
}
