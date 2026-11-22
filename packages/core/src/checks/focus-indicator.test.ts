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
    expect(verdicts({ obscured: { covered: 25, sampled: 25, by: 'header', opaque: 25 } }, good, plain)).toContainEqual({
      rule: 'obscured',
      status: 'fail',
      sc: '2.4.11',
    });
    expect(verdicts({ obscured: { covered: 10, sampled: 25, by: 'header', opaque: 10 } }, good, plain)).toContainEqual({
      rule: 'partly-obscured',
      status: 'info',
      sc: '2.4.11',
    });
    expect(verdicts({ obscured: { covered: 0, sampled: 25, by: '', opaque: 0 } }, good, plain)).toEqual([
      { rule: 'measured', status: 'info', sc: '1.4.11' },
    ]);
  });
  it('reports an element that stays covered once, not also as having no indicator', () => {
    expect(
      verdicts({ obscured: { covered: 25, sampled: 25, by: 'header', opaque: 25 }, crops: null, notCaptured: 'obscured' }, plain, plain),
    ).toEqual([{ rule: 'obscured', status: 'fail', sc: '2.4.11' }]);
  });
  it('never fails 2.4.11 on a cover that is not known to be opaque', () => {
    const good = page('#ffffff', ring('#005fcc'));
    const cover = { covered: 25, sampled: 25, by: '#backdrop', opaque: 0 };
    // Still covered while captured, and the focus change shows through: covered, not hidden.
    expect(verdicts({ obscured: cover, coveredAtCapture: true }, good, plain)).toEqual([
      { rule: 'covered-not-hidden', status: 'info', sc: '2.4.11' },
      { rule: 'measured', status: 'info', sc: '1.4.11' },
    ]);
    // Captured elsewhere: the captures say nothing about what the cover hid.
    expect(verdicts({ obscured: cover }, good, plain)).toEqual([
      { rule: 'measured', status: 'info', sc: '1.4.11' },
      { rule: 'obscured', status: 'likely', sc: '2.4.11' },
    ]);
    // Nothing shows through: one likely, and no 2.4.7 failure on top of it.
    expect(verdicts({ obscured: cover, coveredAtCapture: true, outsideChange: null }, plain, plain)).toEqual([
      { rule: 'obscured', status: 'likely', sc: '2.4.11' },
    ]);
    expect(verdicts({ obscured: { ...cover, opaque: 24 }, crops: null, notCaptured: 'obscured' }, plain, plain)).toEqual([
      { rule: 'obscured', status: 'likely', sc: '2.4.11' },
    ]);
  });
  it('downgrades low contrast measured through a cover', () => {
    const cover = { covered: 25, sampled: 25, by: '#backdrop', opaque: 0 };
    expect(verdicts({ obscured: cover, coveredAtCapture: true }, page('#ffffff', ring('#c8c8c8')), plain)).toEqual([
      { rule: 'covered-not-hidden', status: 'info', sc: '2.4.11' },
      { rule: 'low-contrast', status: 'likely', sc: '1.4.11' },
    ]);
  });
  it('says so when an element became covered only after it was scrolled for capture', () => {
    expect(
      verdicts({ obscured: { covered: 0, sampled: 25, by: '', opaque: 0 }, crops: null, notCaptured: 'obscured' }, plain, plain),
    ).toEqual([{ rule: 'not-captured', status: 'info', sc: undefined }]);
    expect(verdicts({ obscured: null, crops: null, notCaptured: 'obscured' }, plain, plain)).toEqual([
      { rule: 'not-captured', status: 'info', sc: undefined },
    ]);
  });
  it('does not judge an element whose unfocused state could not be captured', () => {
    expect(verdicts({ unfocusedNotCaptured: true }, plain, plain)).toEqual([
      { rule: 'unfocused-not-captured', status: 'info', sc: '2.4.7' },
    ]);
    expect(verdicts({ unfocusedNotCaptured: true }, page('#ffffff', ring('#c8c8c8')), plain)).toEqual([
      { rule: 'unfocused-not-captured', status: 'info', sc: '2.4.7' },
    ]);
  });
  it('downgrades no change to likely when the element is cut off by the viewport', () => {
    expect(verdicts({ clippedByViewport: true, outsideChange: null }, plain, plain)).toEqual([
      { rule: 'no-visible-change', status: 'likely', sc: '2.4.7' },
    ]);
  });
  it('never fails a capture taken without the stabilising styles', () => {
    expect(verdicts({ unstabilised: true, outsideChange: null }, plain, plain)).toEqual([
      { rule: 'no-visible-change', status: 'likely', sc: '2.4.7' },
    ]);
    const low = page('#ffffff', ring('#c8c8c8'));
    expect(verdicts({ unstabilised: true }, low, plain)).toEqual([{ rule: 'low-contrast', status: 'likely', sc: '1.4.11' }]);
    const finding = runChecks(snapshotWith({ unstabilised: true }, low, plain), config).find((f) => f.selector === '#target');
    expect(finding!.evidence.flags).toContain('unstabilised');
  });
  it('does not claim that no part reaches 3:1 when some parts were not measured', () => {
    const focused = page('#ffffff');
    for (const x of [10, 40, 70]) {
      fillRect(focused, { x: x * SCALE, y: 5 * SCALE, width: 12 * SCALE, height: 3 * SCALE }, hex('#c8c8c8'));
    }
    const run = (maxComponents: number) =>
      runChecks(snapshotWith({}, focused, plain), resolveConfig({ checks: ['focus-indicator'], focus: { maxComponents } }))
        .filter((finding) => finding.selector === '#target')
        .map((finding) => ({ rule: finding.rule, status: finding.status, message: finding.message }));
    expect(run(3)).toEqual([expect.objectContaining({ rule: 'focus-indicator/low-contrast', status: 'fail' })]);
    const capped = run(2);
    expect(capped).toEqual([expect.objectContaining({ rule: 'focus-indicator/low-contrast', status: 'likely' })]);
    expect(capped[0]!.message).toContain('only the 2 largest of 3 changed regions were measured');
    expect(capped[0]!.message).not.toContain('no part of it reaches');
  });
  it('explains a forced state by the reason the walk did not reach the element', () => {
    const message = (stoppedBy: 'cycle' | 'limit' | 'opaque-frame'): string => {
      const snapshot = snapshotWith({ reachedBy: 'forced' }, plain, plain);
      snapshot.focus!.stoppedBy = stoppedBy;
      return runChecks(snapshot, config).find((finding) => finding.selector === '#target')!.message;
    };
    expect(message('cycle')).toContain('completed without reaching');
    expect(message('limit')).toContain('stopped at a configured limit');
    expect(message('opaque-frame')).toContain('could not get past a cross-origin iframe');
    for (const reason of ['cycle', 'limit', 'opaque-frame'] as const) {
      expect(message(reason)).not.toContain('not in the Tab order');
    }
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
