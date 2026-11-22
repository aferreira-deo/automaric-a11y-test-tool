import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Rgb } from '../measure/color.js';
import { createImage, encodePng, fillRect } from '../measure/image.js';
import type { RgbImage } from '../measure/image.js';
import { runChecks } from '../run.js';
import type { FocusStop, Snapshot } from '../types.js';

const hex = (value: string): Rgb => ({
  r: parseInt(value.slice(1, 3), 16),
  g: parseInt(value.slice(3, 5), 16),
  b: parseInt(value.slice(5, 7), 16),
});

const SCALE = 2;
// Clip of 100 by 60 CSS px at page 0,0; the element is 60 by 20 CSS px at 20,20.
const CLIP = { x: 0, y: 0, width: 100, height: 60 };
const BOX = { x: 20, y: 20, width: 60, height: 20 };

function page(background: string, ring?: { color: string; offsetCss: number; widthCss: number }): RgbImage {
  const image = createImage(CLIP.width * SCALE, CLIP.height * SCALE, hex(background));
  if (ring) {
    const outer = (ring.offsetCss + ring.widthCss) * SCALE;
    const inner = ring.offsetCss * SCALE;
    const x = BOX.x * SCALE;
    const y = BOX.y * SCALE;
    const w = BOX.width * SCALE;
    const h = BOX.height * SCALE;
    fillRect(image, { x: x - outer, y: y - outer, width: w + 2 * outer, height: h + 2 * outer }, hex(ring.color));
    fillRect(image, { x: x - inner, y: y - inner, width: w + 2 * inner, height: h + 2 * inner }, hex(background));
  }
  return image;
}

function snapshotWith(stop: Partial<FocusStop>, focused: RgbImage, unfocused: RgbImage): Snapshot {
  const crops = { focused: 'f.png', unfocused: 'u.png' };
  return {
    environment: {
      url: 'http://example.test/',
      devicePixelRatio: SCALE,
      viewport: { width: 1280, height: 720 },
      colorScheme: 'light',
    },
    nodes: [],
    axTree: [],
    screenshots: {
      tiles: [],
      clips: {
        'f.png': { box: CLIP, scale: SCALE, png: encodePng(focused) },
        'u.png': { box: CLIP, scale: SCALE, png: encodePng(unfocused) },
      },
    },
    focus: {
      stoppedBy: 'cycle',
      unreached: 0,
      forced: 0,
      stops: [
        {
          selector: '#target',
          frame: '',
          box: BOX,
          reachedBy: 'tab',
          textEntry: false,
          authorModified: true,
          opaqueFrame: false,
          obscured: null,
          geometryChanged: false,
          crops,
          ...stop,
        },
      ],
    },
  };
}

const config = resolveConfig({ checks: ['focus-indicator'] });

function verdicts(stop: Partial<FocusStop>, focused: RgbImage, unfocused: RgbImage) {
  return runChecks(snapshotWith(stop, focused, unfocused), config)
    .filter((finding) => finding.selector === '#target')
    .map((finding) => ({ rule: finding.rule.replace('focus-indicator/', ''), status: finding.status, sc: finding.wcag?.sc }));
}

const ring = (color: string) => ({ color, offsetCss: 2, widthCss: 2 });
const plain = page('#ffffff');

describe('focus-indicator scoring', () => {
  it('fails 2.4.7 when nothing changes', () => {
    expect(verdicts({ outsideChange: null }, plain, plain)).toEqual([
      { rule: 'no-visible-change', status: 'fail', sc: '2.4.7' },
    ]);
  });
  it('downgrades no change to likely for a text field, a forced state, or a change elsewhere', () => {
    expect(verdicts({ textEntry: true }, plain, plain)).toEqual([{ rule: 'caret-only', status: 'likely', sc: '2.4.7' }]);
    expect(verdicts({ reachedBy: 'forced' }, plain, plain)).toEqual([
      { rule: 'no-visible-change', status: 'likely', sc: '2.4.7' },
    ]);
    expect(verdicts({ outsideChange: { x: 500, y: 300, width: 40, height: 40 } }, plain, plain)).toEqual([
      { rule: 'change-outside-element', status: 'likely', sc: '2.4.7' },
    ]);
  });
  it('fails 1.4.11 for an author ring clearly under 3:1', () => {
    expect(verdicts({}, page('#ffffff', ring('#c8c8c8')), plain)).toEqual([
      { rule: 'low-contrast', status: 'fail', sc: '1.4.11' },
    ]);
  });
  it('reports the band just under 3:1 as likely', () => {
    expect(verdicts({}, page('#ffffff', ring('#999999')), plain)).toEqual([
      { rule: 'low-contrast', status: 'likely', sc: '1.4.11' },
    ]);
  });
  it('never fails a simulated focus state', () => {
    expect(verdicts({ reachedBy: 'forced' }, page('#ffffff', ring('#c8c8c8')), plain)).toEqual([
      { rule: 'low-contrast', status: 'likely', sc: '1.4.11' },
    ]);
  });
  it('inventories a ring at or above 3:1', () => {
    expect(verdicts({}, page('#ffffff', ring('#949494')), plain)).toEqual([
      { rule: 'measured', status: 'info', sc: '1.4.11' },
    ]);
  });
  it('exempts an unmodified browser indicator, however faint', () => {
    expect(verdicts({ authorModified: false }, page('#ffffff', ring('#c8c8c8')), plain)).toEqual([
      { rule: 'browser-default', status: 'info', sc: '1.4.11' },
    ]);
  });
  it('does not exempt a change that reaches beyond a default ring', () => {
    const far = { color: '#c8c8c8', offsetCss: 12, widthCss: 2 };
    expect(verdicts({ authorModified: false }, page('#ffffff', far), plain)).toEqual([
      { rule: 'low-contrast', status: 'fail', sc: '1.4.11' },
    ]);
  });
  it('skips contrast when the element only appears on focus', () => {
    expect(verdicts({ geometryChanged: true }, page('#ffffff', ring('#c8c8c8')), plain)).toEqual([
      { rule: 'appears-on-focus', status: 'info', sc: '2.4.7' },
    ]);
  });
  it('fails 2.4.11 only when every sampled point is covered', () => {
    const good = page('#ffffff', ring('#005fcc'));
    expect(verdicts({ obscured: { covered: 25, sampled: 25, by: 'header' } }, good, plain)).toContainEqual({
      rule: 'obscured',
      status: 'fail',
      sc: '2.4.11',
    });
    expect(verdicts({ obscured: { covered: 10, sampled: 25, by: 'header' } }, good, plain)).toContainEqual({
      rule: 'partly-obscured',
      status: 'info',
      sc: '2.4.11',
    });
    expect(verdicts({ obscured: { covered: 0, sampled: 25, by: '' } }, good, plain)).toEqual([
      { rule: 'measured', status: 'info', sc: '1.4.11' },
    ]);
  });
  it('reports an element that stays covered once, not also as having no indicator', () => {
    expect(
      verdicts({ obscured: { covered: 25, sampled: 25, by: 'header' }, crops: null, notCaptured: 'obscured' }, plain, plain),
    ).toEqual([{ rule: 'obscured', status: 'fail', sc: '2.4.11' }]);
  });
  it('does not measure inside a cross-origin frame', () => {
    expect(verdicts({ opaqueFrame: true, crops: null }, plain, plain)).toEqual([
      { rule: 'frame-not-measured', status: 'info', sc: undefined },
    ]);
  });
  it('always adds one walk summary', () => {
    const findings = runChecks(snapshotWith({}, plain, plain), config);
    expect(findings.filter((finding) => finding.rule === 'focus-indicator/walk')).toHaveLength(1);
  });
});
