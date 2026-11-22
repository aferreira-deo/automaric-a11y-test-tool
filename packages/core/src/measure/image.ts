import { decode, encode } from 'fast-png';
import type { Png } from '../types.js';
import type { Rgb } from './color.js';

/** Opaque 8-bit RGB raster, 3 bytes per pixel, rows top to bottom. Sizes are device pixels. */
export interface RgbImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Binary raster: 1 where set. */
export interface Mask {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Rectangle in device pixels of an image. */
export interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function createImage(width: number, height: number, fill: Rgb): RgbImage {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < data.length; i += 3) {
    data[i] = fill.r;
    data[i + 1] = fill.g;
    data[i + 2] = fill.b;
  }
  return { width, height, data };
}

export function fillRect(image: RgbImage, box: PixelBox, color: Rgb): void {
  const x1 = Math.min(image.width, box.x + box.width);
  const y1 = Math.min(image.height, box.y + box.height);
  for (let y = Math.max(0, box.y); y < y1; y++) {
    for (let x = Math.max(0, box.x); x < x1; x++) {
      const i = (y * image.width + x) * 3;
      image.data[i] = color.r;
      image.data[i + 1] = color.g;
      image.data[i + 2] = color.b;
    }
  }
}

/** Decodes a screenshot. Alpha is dropped: screenshots are opaque. */
export function decodePng(png: Png): RgbImage {
  const decoded = decode(png);
  const { width, height, channels, depth } = decoded;
  if (channels !== 3 && channels !== 4) {
    throw new Error(`Unsupported PNG: ${channels} channel(s), expected RGB or RGBA`);
  }
  if (depth !== 8 && depth !== 16) throw new Error(`Unsupported PNG bit depth: ${depth}`);
  const shift = depth === 16 ? 8 : 0;
  const data = new Uint8Array(width * height * 3);
  const source = decoded.data;
  for (let p = 0, s = 0, d = 0; p < width * height; p++, s += channels, d += 3) {
    data[d] = (source[s] ?? 0) >> shift;
    data[d + 1] = (source[s + 1] ?? 0) >> shift;
    data[d + 2] = (source[s + 2] ?? 0) >> shift;
  }
  return { width, height, data };
}

export function encodePng(image: RgbImage): Png {
  return encode({ width: image.width, height: image.height, data: image.data, channels: 3, depth: 8 });
}
