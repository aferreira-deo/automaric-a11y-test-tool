import { colorDifference } from './color.js';
import type { Mask, PixelBox, RgbImage } from './image.js';

/**
 * Pixels whose colour differs between two captures of the same region by more than `deltaE`
 * (CIEDE2000). The two captures come from the same stabilised page, so identical pixels are
 * the norm and take a fast path.
 */
export function diffMask(a: RgbImage, b: RgbImage, deltaE: number): Mask {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`Cannot diff images of different sizes: ${a.width}x${a.height} and ${b.width}x${b.height}`);
  }
  const data = new Uint8Array(a.width * a.height);
  const da = a.data;
  const db = b.data;
  for (let p = 0, i = 0; p < data.length; p++, i += 3) {
    const r1 = da[i]!;
    const g1 = da[i + 1]!;
    const b1 = da[i + 2]!;
    const r2 = db[i]!;
    const g2 = db[i + 1]!;
    const b2 = db[i + 2]!;
    if (r1 === r2 && g1 === g2 && b1 === b2) continue;
    if (colorDifference({ r: r1, g: g1, b: b1 }, { r: r2, g: g2, b: b2 }) > deltaE) data[p] = 1;
  }
  return { width: a.width, height: a.height, data };
}

export interface Component {
  /** Number of pixels. */
  area: number;
  bbox: PixelBox;
  /** Pixel indices (y * width + x), ascending. */
  pixels: Int32Array;
}

/**
 * 8-connected components of a mask, largest first (ties: topmost-leftmost first).
 * Components smaller than `minArea` are dropped: that is how anti-aliasing specks are removed.
 * Erosion is not used because it would erase one-pixel lines.
 */
export function connectedComponents(mask: Mask, minArea: number): Component[] {
  const { width, height, data } = mask;
  const seen = new Uint8Array(data.length);
  const stack: number[] = [];
  const components: Component[] = [];

  for (let start = 0; start < data.length; start++) {
    if (data[start] !== 1 || seen[start] === 1) continue;
    const pixels: number[] = [];
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      pixels.push(p);
      const x = p % width;
      const y = (p - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const n = ny * width + nx;
          if (data[n] === 1 && seen[n] === 0) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    if (pixels.length < minArea) continue;
    components.push({
      area: pixels.length,
      bbox: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
      pixels: Int32Array.from(pixels).sort(),
    });
  }
  return components.sort((a, b) => b.area - a.area || a.pixels[0]! - b.pixels[0]!);
}

/** Smallest box containing all components, or null when there are none. */
export function unionBox(components: Component[]): PixelBox | null {
  if (components.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const { bbox } of components) {
    x0 = Math.min(x0, bbox.x);
    y0 = Math.min(y0, bbox.y);
    x1 = Math.max(x1, bbox.x + bbox.width);
    y1 = Math.max(y1, bbox.y + bbox.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
