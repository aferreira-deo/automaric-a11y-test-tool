import type { Box, Png, Screenshot } from '../types.js';
import type { Rgb } from './color.js';
import { decodePng, encodePng, fillRect } from './image.js';
import type { RgbImage } from './image.js';

/** Side of the grid a capture is reduced to for its perceptual hash: 8 rows of 9 cells give 64 comparisons. */
const HASH_ROWS = 8;
const HASH_COLUMNS = HASH_ROWS + 1;

/**
 * Difference hash of an image, 16 hex digits: the image is reduced to 9 by 8 cells of mean
 * luminance and each cell is compared with the one to its right. Two captures of the same
 * unchanged component give the same hash although their pixels differ slightly (anti-aliasing,
 * one pixel of offset); it is not a proof that two images are equal, and is only ever used
 * together with the text and the measurements of the candidate.
 */
export function perceptualHash(image: RgbImage): string {
  const cells = new Float64Array(HASH_ROWS * HASH_COLUMNS);
  if (image.width > 0 && image.height > 0) {
    for (let row = 0; row < HASH_ROWS; row++) {
      const y0 = Math.floor((row * image.height) / HASH_ROWS);
      const y1 = Math.max(y0 + 1, Math.floor(((row + 1) * image.height) / HASH_ROWS));
      for (let column = 0; column < HASH_COLUMNS; column++) {
        const x0 = Math.floor((column * image.width) / HASH_COLUMNS);
        const x1 = Math.max(x0 + 1, Math.floor(((column + 1) * image.width) / HASH_COLUMNS));
        let sum = 0;
        let count = 0;
        for (let y = y0; y < y1 && y < image.height; y++) {
          for (let x = x0; x < x1 && x < image.width; x++) {
            const i = (y * image.width + x) * 3;
            // Rec. 601 luma on 8-bit values: only an ordering of cells is needed.
            sum += 0.299 * image.data[i]! + 0.587 * image.data[i + 1]! + 0.114 * image.data[i + 2]!;
            count++;
          }
        }
        cells[row * HASH_COLUMNS + column] = count > 0 ? sum / count : 0;
      }
    }
  }
  let hex = '';
  for (let row = 0; row < HASH_ROWS; row++) {
    let byte = 0;
    for (let column = 0; column < HASH_ROWS; column++) {
      // Rounded, so that noise of a fraction of a level does not flip a comparison of two flat cells.
      const left = Math.round(cells[row * HASH_COLUMNS + column]!);
      const right = Math.round(cells[row * HASH_COLUMNS + column + 1]!);
      byte = (byte << 1) | (left > right ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export function perceptualHashOfPng(png: Png): string {
  return perceptualHash(decodePng(png));
}

function parseHex(color: string): Rgb {
  const value = /^#([0-9a-f]{6})$/i.exec(color)?.[1] ?? 'ff00ff';
  return { r: parseInt(value.slice(0, 2), 16), g: parseInt(value.slice(2, 4), 16), b: parseInt(value.slice(4, 6), 16) };
}

/**
 * A copy of a capture with a rectangle drawn around `target` (CSS pixels from the top-left corner
 * of the capture), `gap` outside it so that none of the target is painted over. The copy is what
 * a model is shown; the capture kept as evidence is not touched.
 */
export function outlineCapture(capture: Screenshot, target: Box, outline: { color: string; widthCssPx: number; gapCssPx: number }): Png {
  const image = decodePng(capture.png);
  const scale = capture.scale;
  const width = Math.max(1, Math.round(outline.widthCssPx * scale));
  const x0 = Math.floor((target.x - outline.gapCssPx) * scale) - width;
  const y0 = Math.floor((target.y - outline.gapCssPx) * scale) - width;
  const x1 = Math.ceil((target.x + target.width + outline.gapCssPx) * scale) + width;
  const y1 = Math.ceil((target.y + target.height + outline.gapCssPx) * scale) + width;
  const color = parseHex(outline.color);
  // fillRect clips to the image: a target at the edge of the capture gets the sides that fit.
  fillRect(image, { x: x0, y: y0, width: x1 - x0, height: width }, color);
  fillRect(image, { x: x0, y: y1 - width, width: x1 - x0, height: width }, color);
  fillRect(image, { x: x0, y: y0, width, height: y1 - y0 }, color);
  fillRect(image, { x: x1 - width, y: y0, width, height: y1 - y0 }, color);
  return encodePng(image);
}
