import { colorDifference, contrastRatio } from './color.js';
import type { Rgb } from './color.js';
import type { Component } from './diff.js';
import type { Mask, PixelBox, RgbImage } from './image.js';

export interface ColorCluster {
  color: Rgb;
  /** Fraction of the sampled pixels, 0 to 1. */
  share: number;
}

/**
 * Dominant colours among the given pixels, most common first.
 * Pixels are binned at 5 bits per channel, then bins within `clusterDeltaE` of a more
 * populous bin are merged into it. A cluster's colour is the mean of its seed bin, so
 * anti-aliased edge pixels that get merged in do not shift it.
 */
export function dominantColors(image: RgbImage, pixels: ArrayLike<number>, clusterDeltaE: number): ColorCluster[] {
  if (pixels.length === 0) return [];
  const bins = new Map<number, { key: number; count: number; r: number; g: number; b: number }>();
  for (let n = 0; n < pixels.length; n++) {
    const i = pixels[n]! * 3;
    const r = image.data[i]!;
    const g = image.data[i + 1]!;
    const b = image.data[i + 2]!;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const bin = bins.get(key);
    if (bin) {
      bin.count++;
      bin.r += r;
      bin.g += g;
      bin.b += b;
    } else {
      bins.set(key, { key, count: 1, r, g, b });
    }
  }
  const sorted = [...bins.values()].sort((a, b) => b.count - a.count || a.key - b.key);
  const clusters: { color: Rgb; count: number }[] = [];
  for (const bin of sorted) {
    const color = {
      r: Math.round(bin.r / bin.count),
      g: Math.round(bin.g / bin.count),
      b: Math.round(bin.b / bin.count),
    };
    const home = clusters.find((cluster) => colorDifference(cluster.color, color) <= clusterDeltaE);
    if (home) home.count += bin.count;
    else clusters.push({ color, count: bin.count });
  }
  return clusters
    .map((cluster, order) => ({ color: cluster.color, share: cluster.count / pixels.length, order }))
    .sort((a, b) => b.share - a.share || a.order - b.order)
    .map(({ color, share }) => ({ color, share }));
}

/** All lengths are device pixels of the image being measured. */
export interface MeasureOptions {
  /** Pixels right next to the component that are skipped: they hold blended edge colours. */
  adjacentGapPx: number;
  /** Width of the band, beyond the gap, whose pixels count as adjacent. */
  adjacentBandPx: number;
  clusterDeltaE: number;
  /** A colour inside the component is considered only above this share of the component. */
  minIndicatorShare: number;
  /** Below that share, a colour still counts if it reaches this share and forms a solid block. */
  minorPartMinShare: number;
  /** Side of that solid block. */
  minorPartSolidPx: number;
  /** An adjacent colour is considered only above this share of the band. */
  minAdjacentShare: number;
  /** A component thicker than this in both directions, and covering its box, is a fill. */
  strokeMaxThicknessPx: number;
  fillMinCoverage: number;
}

export interface ComponentMeasurement {
  bbox: PixelBox;
  area: number;
  /** `stroke`: a line or ring. `fill`: a solid area, such as a changed background. */
  kind: 'stroke' | 'fill';
  /** The pair with the highest contrast among the dominant colours; null when nothing is adjacent. */
  best: { indicator: Rgb; adjacent: Rgb; ratio: number } | null;
  /** True when no colour was dominant on one side, so the measurement rests on a fallback. */
  noisy: boolean;
}

function adjacentPixels(mask: Mask, component: Component, options: MeasureOptions, outsideBoxOnly: boolean): number[] {
  const reach = options.adjacentGapPx + options.adjacentBandPx;
  const { bbox } = component;
  const x0 = Math.max(0, bbox.x - reach);
  const y0 = Math.max(0, bbox.y - reach);
  const x1 = Math.min(mask.width, bbox.x + bbox.width + reach);
  const y1 = Math.min(mask.height, bbox.y + bbox.height + reach);
  const w = x1 - x0;
  const h = y1 - y0;
  const UNSEEN = 255;
  const distance = new Uint8Array(w * h).fill(UNSEEN);

  let frontier: number[] = [];
  for (let n = 0; n < component.pixels.length; n++) {
    const p = component.pixels[n]!;
    const x = p % mask.width;
    const y = (p - x) / mask.width;
    const local = (y - y0) * w + (x - x0);
    distance[local] = 0;
    frontier.push(local);
  }

  // Breadth-first growth, one pixel of Chebyshev distance per round.
  const result: number[] = [];
  for (let d = 1; d <= reach && frontier.length > 0; d++) {
    const next: number[] = [];
    for (const local of frontier) {
      const lx = local % w;
      const ly = (local - lx) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = ly + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = lx + dx;
          if (nx < 0 || nx >= w) continue;
          const neighbour = ny * w + nx;
          if (distance[neighbour] !== UNSEEN) continue;
          distance[neighbour] = d;
          next.push(neighbour);
          if (d <= options.adjacentGapPx) continue;
          const gx = nx + x0;
          const gy = ny + y0;
          const global = gy * mask.width + gx;
          if (mask.data[global] === 1) continue; // changed pixels belong to an indicator, not to its surroundings
          if (
            outsideBoxOnly &&
            gx >= bbox.x &&
            gx < bbox.x + bbox.width &&
            gy >= bbox.y &&
            gy < bbox.y + bbox.height
          ) {
            continue;
          }
          result.push(global);
        }
      }
    }
    frontier = next;
  }
  return result.sort((a, b) => a - b);
}

/** True when the component contains a `side` by `side` square made only of pixels of `color`. */
function hasSolidBlock(image: RgbImage, component: Component, color: Rgb, clusterDeltaE: number, side: number): boolean {
  const { bbox } = component;
  const w = bbox.width;
  // Largest all-matching square whose bottom-right corner is each pixel, row by row.
  let previous = new Uint16Array(w);
  let current = new Uint16Array(w);
  const verdicts = new Map<number, boolean>();
  let cursor = 0;
  for (let y = 0; y < bbox.height; y++) {
    current.fill(0);
    const rowStart = (bbox.y + y) * image.width + bbox.x;
    const rowEnd = rowStart + w;
    while (cursor < component.pixels.length && component.pixels[cursor]! < rowEnd) {
      const p = component.pixels[cursor++]!;
      const i = p * 3;
      const r = image.data[i]!;
      const g = image.data[i + 1]!;
      const b = image.data[i + 2]!;
      const key = (r << 16) | (g << 8) | b;
      let matches = verdicts.get(key);
      if (matches === undefined) {
        matches = colorDifference({ r, g, b }, color) <= clusterDeltaE;
        verdicts.set(key, matches);
      }
      if (!matches) continue;
      const x = p - rowStart;
      const size = x === 0 ? 1 : 1 + Math.min(previous[x]!, previous[x - 1]!, current[x - 1]!);
      if (size >= side) return true;
      current[x] = size;
    }
    [previous, current] = [current, previous];
  }
  return false;
}

function kindOf(component: Component, options: MeasureOptions): 'stroke' | 'fill' {
  const { bbox, area } = component;
  const thick = Math.min(bbox.width, bbox.height) > options.strokeMaxThicknessPx;
  const solid = area / (bbox.width * bbox.height) >= options.fillMinCoverage;
  return thick && solid ? 'fill' : 'stroke';
}

/**
 * Contrast of one changed region of the focused capture against what surrounds it.
 *
 * The comparison is deliberately generous: it takes the best pair among the dominant
 * colours of the region and the dominant colours around it. That implements "3:1 on at
 * least one side is enough" without having to decide which side is inner and which is outer.
 *
 * For a fill, only pixels outside its bounding box count as adjacent: the text sitting
 * inside a changed background is not what the background has to stand out from.
 */
export function measureComponent(
  focused: RgbImage,
  mask: Mask,
  component: Component,
  options: MeasureOptions,
): ComponentMeasurement {
  const kind = kindOf(component, options);
  let noisy = false;

  const inside = dominantColors(focused, component.pixels, options.clusterDeltaE);
  // A colour counts as part of the indicator when it dominates the region, or when it is a
  // minority that forms a solid block: the dark bar under a highlighted link, a ring fused
  // with a changed fill. Anti-aliased glyph edges are a minority too, but never a solid block.
  let indicatorColors = inside.filter(
    (cluster) =>
      cluster.share >= options.minIndicatorShare ||
      (cluster.share >= options.minorPartMinShare &&
        hasSolidBlock(focused, component, cluster.color, options.clusterDeltaE, options.minorPartSolidPx)),
  );
  if (indicatorColors.length === 0) {
    indicatorColors = inside.slice(0, 1);
    noisy = true;
  }

  let around = adjacentPixels(mask, component, options, kind === 'fill');
  if (around.length === 0 && kind === 'fill') around = adjacentPixels(mask, component, options, false);
  const outside = dominantColors(focused, around, options.clusterDeltaE);
  let adjacentColors = outside.filter((cluster) => cluster.share >= options.minAdjacentShare);
  if (adjacentColors.length === 0 && outside.length > 0) {
    adjacentColors = outside.slice(0, 1);
    noisy = true;
  }

  let best: ComponentMeasurement['best'] = null;
  for (const indicator of indicatorColors) {
    for (const adjacent of adjacentColors) {
      const ratio = contrastRatio(indicator.color, adjacent.color);
      if (!best || ratio > best.ratio) best = { indicator: indicator.color, adjacent: adjacent.color, ratio };
    }
  }
  return { bbox: component.bbox, area: component.area, kind, best, noisy };
}
