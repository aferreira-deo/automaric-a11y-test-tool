import { createImage, encodePng } from '@a11y-vision/core';
import { describe, expect, it } from 'vitest';
import { captureScale } from './page.js';

const white = { r: 255, g: 255, b: 255 };
const capture = (width: number, height: number) => encodePng(createImage(width, height, white));
const clip = { x: 10, y: 20, width: 100, height: 50 };

describe('captureScale', () => {
  it('confirms the expected scale', () => {
    expect(captureScale(capture(200, 100), clip, 2, 1)).toBe(2);
  });
  it('allows for the rounding of clip edges to device pixels', () => {
    expect(captureScale(capture(151, 75), { ...clip, width: 100.4 }, 1.5, 1)).toBe(1.5);
  });
  it('reports the real scale of a capture that ignored the device scale factor', () => {
    // What a Playwright context with deviceScaleFactor 2 gave before the override was always sent.
    expect(captureScale(capture(100, 50), clip, 2, 1)).toBe(1);
    expect(captureScale(capture(300, 150), clip, 2, 1)).toBe(3);
  });
  it('refuses a capture whose size fits no scale', () => {
    expect(() => captureScale(capture(200, 50), clip, 2, 1)).toThrow(/fits no scale/);
  });
});
