import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Rgb } from '../measure/color.js';
import { createImage, encodePng, fillRect } from '../measure/image.js';
import type { RgbImage } from '../measure/image.js';
import { runChecks } from '../run.js';
import type { Finding, IconCandidate, Snapshot } from '../types.js';

const hex = (value: string): Rgb => ({
  r: parseInt(value.slice(1, 3), 16),
  g: parseInt(value.slice(3, 5), 16),
  b: parseInt(value.slice(5, 7), 16),
});

const SCALE = 2;
// Capture of 60 by 60 CSS px at page 100,200. The control is 40 by 40 at 110,210, its padding
// box 38 by 38 at 111,211 and the graphic 24 by 24 at 118,218.
const CLIP = { x: 100, y: 200, width: 60, height: 60 };
const BOX = { x: 110, y: 210, width: 40, height: 40 };
const ROOM = { x: 111, y: 211, width: 38, height: 38 };
const GRAPHIC = { x: 118, y: 218, width: 24, height: 24 };
const CROP = 'icon-contrast/x.png';

const css = (x: number, y: number, width: number, height: number) => ({
  x: (x - CLIP.x) * SCALE,
  y: (y - CLIP.y) * SCALE,
  width: width * SCALE,
  height: height * SCALE,
});

/** A button with a border, a fill and three bars of the icon colour. */
function button(icon: string, fill = '#ffffff', page = '#ffffff'): RgbImage {
  const image = createImage(CLIP.width * SCALE, CLIP.height * SCALE, hex(page));
  fillRect(image, css(BOX.x, BOX.y, BOX.width, BOX.height), hex('#595959'));
  fillRect(image, css(ROOM.x, ROOM.y, ROOM.width, ROOM.height), hex(fill));
  for (const y of [221, 228, 235]) fillRect(image, css(121, y, 18, 3), hex(icon));
  return image;
}

/** A field with a 1 CSS px border. */
function field(border: string, fill = '#ffffff', page = '#ffffff'): RgbImage {
  const image = createImage(CLIP.width * SCALE, CLIP.height * SCALE, hex(page));
  fillRect(image, css(BOX.x, BOX.y, BOX.width, BOX.height), hex(border));
  fillRect(image, css(BOX.x + 1, BOX.y + 1, BOX.width - 2, BOX.height - 2), hex(fill));
  return image;
}

const iconCandidate = (over: Partial<IconCandidate> = {}, icon: Partial<NonNullable<IconCandidate['icon']>> = {}): IconCandidate => ({
  selector: '#target',
  frame: '',
  box: BOX,
  kind: 'icon',
  disabled: false,
  icon: { sources: ['svg'], box: GRAPHIC, boxFrom: 'graphic', room: ROOM, declaredColor: null, ...icon },
  crop: CROP,
  ...over,
});

const boundaryCandidate = (
  over: Partial<IconCandidate> = {},
  boundary: Partial<NonNullable<IconCandidate['boundary']>> = {},
): IconCandidate => ({
  selector: '#target',
  frame: '',
  box: BOX,
  kind: 'boundary',
  disabled: false,
  boundary: { control: 'text-field', authorModified: true, boxes: [BOX], ...boundary },
  crop: CROP,
  ...over,
});

function snapshotWith(candidates: IconCandidate[], image: RgbImage | null, skipped: Record<string, number> = {}): Snapshot {
  return {
    environment: {
      url: 'http://example.test/',
      devicePixelRatio: SCALE,
      viewport: { width: 1280, height: 720 },
      colorScheme: 'light',
    },
    nodes: [],
    axTree: [],
    screenshots: { tiles: [], clips: image ? { [CROP]: { box: CLIP, scale: SCALE, png: encodePng(image) } } : {} },
    icons: { candidates, total: candidates.length, skipped },
  };
}

const config = resolveConfig({ checks: ['icon-contrast'] });

function evaluate(candidate: IconCandidate, image: RgbImage | null): Finding {
  const findings = runChecks(snapshotWith([candidate], image), config).filter((finding) => finding.selector === '#target');
  expect(findings).toHaveLength(1);
  return findings[0]!;
}

describe('icon-contrast: icons', () => {
  it('fails a solid single-colour icon clearly under 3:1, with its evidence', () => {
    const finding = evaluate(iconCandidate(), button('#c0c0c0'));
    expect(finding).toMatchObject({
      check: 'icon-contrast',
      rule: 'icon-contrast/icon-low-contrast',
      status: 'fail',
      wcag: { sc: '1.4.11', level: 'AA' },
      box: BOX,
      evidence: {
        crops: [CROP],
        colors: { icon: '#c0c0c0', background: '#ffffff' },
        ratios: { contrast: 1.82 },
        flags: ['svg', 'pixelColour'],
      },
    });
    expect(finding.message).toContain('1.82:1');
  });

  it('is likely, not fail, in the band just under 3:1', () => {
    const finding = evaluate(iconCandidate(), button('#999999'));
    expect(finding).toMatchObject({ rule: 'icon-contrast/icon-low-contrast', status: 'likely', evidence: { ratios: { contrast: 2.85 } } });
    expect(finding.message).toContain('measurement error');
  });

  it('records an icon at 3:1 or more as info', () => {
    expect(evaluate(iconCandidate(), button('#949494'))).toMatchObject({ rule: 'icon-contrast/icon-measured', status: 'info' });
    expect(evaluate(iconCandidate(), button('#ffffff', '#1a1a1a'))).toMatchObject({
      status: 'info',
      evidence: { colors: { icon: '#ffffff', background: '#1a1a1a' }, ratios: { contrast: 17.4 } },
    });
  });

  it('measures against the fill of the control, not the page behind it', () => {
    // A pale icon on a dark button on a white page.
    const finding = evaluate(iconCandidate(), button('#e6e6e6', '#1a1a1a', '#ffffff'));
    expect(finding.status).toBe('info');
    expect(finding.evidence.colors['background']).toBe('#1a1a1a');
  });

  it('uses the declared colour and says so', () => {
    const finding = evaluate(iconCandidate({}, { declaredColor: '#c0c0c0' }), button('#c0c0c0'));
    expect(finding.status).toBe('fail');
    expect(finding.evidence.flags).toContain('declaredColour');
    expect(finding.message).toContain('declared colour');
  });

  it('downgrades to likely when the declared colour is not what was painted', () => {
    const finding = evaluate(iconCandidate({}, { declaredColor: '#1a1a1a' }), button('#c0c0c0'));
    expect(finding).toMatchObject({ rule: 'icon-contrast/icon-low-contrast', status: 'likely' });
    expect(finding.evidence.flags).toEqual(expect.arrayContaining(['pixelColour', 'declaredMismatch']));
  });

  it.each([
    ['unstabilised', { unstabilised: true }],
    ['clippedByViewport', { clippedByViewport: true }],
  ] as const)('downgrades to likely when the capture is in doubt: %s', (flag, over) => {
    const finding = evaluate(iconCandidate(over), button('#c0c0c0'));
    expect(finding.status).toBe('likely');
    expect(finding.evidence.flags).toContain(flag);
  });

  it.each([
    ['inactive', 'maybeInactive', 'an inactive control is exempt'],
    ['logo', 'maybeLogo', 'a logotype is exempt'],
  ] as const)('downgrades to likely when the control may be exempt: %s', (hint, flag, reason) => {
    const finding = evaluate(iconCandidate({ hints: [hint] }), button('#c0c0c0'));
    expect(finding).toMatchObject({ rule: 'icon-contrast/icon-low-contrast', status: 'likely' });
    expect(finding.evidence.flags).toContain(flag);
    expect(finding.message).toContain(reason);
  });

  it('downgrades to likely when the strokes are too thin to show their colour', () => {
    const image = button('#ffffff');
    for (let i = 0; i < 30; i++) fillRect(image, { x: 44 + i, y: 44 + i, width: 1, height: 1 }, hex('#c8c8c8'));
    const finding = evaluate(iconCandidate(), image);
    expect(finding).toMatchObject({ rule: 'icon-contrast/icon-low-contrast', status: 'likely' });
    expect(finding.evidence.flags).toContain('thin');
  });

  it('never fails a multi-colour icon: likely when a part is low, info when none is', () => {
    const low = button('#ffffff');
    fillRect(low, css(120, 220, 9, 20), hex('#1a1a1a'));
    fillRect(low, css(131, 220, 9, 20), hex('#ffe08a'));
    const finding = evaluate(iconCandidate(), low);
    expect(finding).toMatchObject({
      rule: 'icon-contrast/icon-multi-colour',
      status: 'likely',
      evidence: { colors: { icon: '#1a1a1a', part2: '#ffe08a' }, ratios: { contrast: 17.4, part2: 1.29 } },
    });

    const good = button('#ffffff');
    fillRect(good, css(120, 220, 9, 20), hex('#1a1a1a'));
    fillRect(good, css(131, 220, 9, 20), hex('#b00020'));
    expect(evaluate(iconCandidate(), good)).toMatchObject({ rule: 'icon-contrast/icon-measured', status: 'info' });
  });

  it('never fails on a varied background', () => {
    const image = button('#ffffff');
    for (let y = 0; y < 38 * SCALE; y++) {
      const shade = Math.round(26 + (204 * y) / (38 * SCALE - 1));
      fillRect(image, { x: (ROOM.x - CLIP.x) * SCALE, y: (ROOM.y - CLIP.y) * SCALE + y, width: ROOM.width * SCALE, height: 1 }, { r: shade, g: shade, b: shade });
    }
    for (const y of [221, 228, 235]) fillRect(image, css(121, y, 18, 3), hex('#ffffff'));
    const finding = evaluate(iconCandidate({}, { declaredColor: '#ffffff' }), image);
    expect(finding).toMatchObject({ rule: 'icon-contrast/icon-varied-background', status: 'likely' });
    expect(finding.evidence.flags).toContain('variedBackground');
  });

  it('records a picture as info, and as likely only when nothing in it reaches 3:1', () => {
    const picture = (colours: string[]): RgbImage => {
      const image = button('#ffffff');
      colours.forEach((colour, index) => fillRect(image, css(119 + (index % 3) * 7, 219 + Math.floor(index / 3) * 7, 7, 7), hex(colour)));
      return image;
    };
    const vivid = ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51', '#3a0ca3', '#7209b7', '#f72585', '#4cc9f0'];
    expect(evaluate(iconCandidate({}, { sources: ['img'] }), picture(vivid))).toMatchObject({ rule: 'icon-contrast/icon-complex', status: 'info' });
    const pale = ['#ffe08a', '#caffbf', '#9bf6ff', '#ffd6a5', '#fdffb6', '#e0e0e0', '#ffc6ff', '#d0f4de', '#fcf6bd'];
    const finding = evaluate(iconCandidate({}, { sources: ['img'] }), picture(pale));
    expect(finding).toMatchObject({ rule: 'icon-contrast/icon-low-contrast', status: 'likely' });
    expect(finding.evidence.flags).toContain('complex');
  });

  it('is likely when the declared colour cannot be told from the background, info when nothing is declared', () => {
    const blank = button('#ffffff');
    for (const y of [221, 228, 235]) fillRect(blank, css(121, y, 18, 3), hex('#ffffff'));
    expect(evaluate(iconCandidate({}, { declaredColor: '#fafafa' }), blank)).toMatchObject({
      rule: 'icon-contrast/icon-not-distinguishable',
      status: 'likely',
    });
    expect(evaluate(iconCandidate(), blank)).toMatchObject({ rule: 'icon-contrast/not-measured', status: 'info' });
  });

  it('ignores a rounded border when the graphic box is the padding box of the control', () => {
    const image = button('#c0c0c0');
    // The border curving into the corners of the padding box.
    for (const [x, y] of [[111, 211], [147, 211], [111, 247], [147, 247]] as const) fillRect(image, css(x, y, 2, 2), hex('#595959'));
    const finding = evaluate(iconCandidate({}, { sources: ['background-image'], box: ROOM, boxFrom: 'control' }), image);
    expect(finding).toMatchObject({ status: 'fail', evidence: { colors: { icon: '#c0c0c0' } } });
    expect(finding.evidence.flags).not.toContain('multiColour');
  });
});

describe('icon-contrast: disabled and not captured', () => {
  it('records a disabled control as info without measuring it', () => {
    for (const candidate of [iconCandidate({ disabled: true }), boundaryCandidate({ disabled: true })]) {
      const finding = evaluate(candidate, button('#c0c0c0'));
      expect(finding).toMatchObject({ rule: 'icon-contrast/disabled', status: 'info', evidence: { colors: {}, ratios: {} } });
      expect(finding.evidence.flags).toContain('disabled');
    }
  });

  it.each(['no-box', 'outside-viewport', 'covered'] as const)('records a control that was not captured (%s) as info', (reason) => {
    const finding = evaluate(iconCandidate({ crop: null, notCaptured: reason }), null);
    expect(finding).toMatchObject({ rule: 'icon-contrast/not-measured', status: 'info', box: BOX, evidence: { crops: [] } });
  });

  it('reports no box for a control that kept moving', () => {
    const finding = evaluate(iconCandidate({ crop: null, notCaptured: 'moving' }), null);
    expect(finding).toMatchObject({ rule: 'icon-contrast/not-measured', status: 'info', box: null });
  });

  it('throws when a crop is referenced but missing', () => {
    expect(() => runChecks(snapshotWith([iconCandidate()], null), config)).toThrow(/missing the crop/);
  });

  it('needs the icon survey', () => {
    const snapshot = snapshotWith([], null);
    delete snapshot.icons;
    expect(() => runChecks(snapshot, config)).toThrow(/icon survey/);
  });
});

describe('icon-contrast: boundaries', () => {
  it('is likely, never fail, when no edge reaches 3:1', () => {
    const finding = evaluate(boundaryCandidate(), field('#cccccc'));
    expect(finding).toMatchObject({
      rule: 'icon-contrast/boundary-low-contrast',
      status: 'likely',
      wcag: { sc: '1.4.11', level: 'AA' },
      evidence: { ratios: { contrast: 1.61 }, flags: ['text-field', 'top'] },
    });
    expect(Object.values(finding.evidence.colors).sort()).toEqual(['#cccccc', '#ffffff']);
  });

  it.each(['#999999', '#000000'])('has no fail at any ratio: border %s', (border) => {
    expect(evaluate(boundaryCandidate(), field(border)).status).not.toBe('fail');
  });

  it('records an edge at 3:1 or more as info', () => {
    expect(evaluate(boundaryCandidate(), field('#949494'))).toMatchObject({
      rule: 'icon-contrast/boundary-measured',
      status: 'info',
      evidence: { ratios: { contrast: 3.03 } },
    });
  });

  it('accepts a fill that stands out from the page without any border', () => {
    expect(evaluate(boundaryCandidate(), field('#ffffff', '#ffffff', '#4a4a4a'))).toMatchObject({ rule: 'icon-contrast/boundary-measured', status: 'info' });
  });

  it('accepts the edge of a wrapper and flags it', () => {
    // The field itself is 30 by 30 inside, with nothing drawn; the wrapper has the border.
    const inner = { x: 115, y: 215, width: 30, height: 30 };
    const finding = evaluate(boundaryCandidate({ box: inner }, { boxes: [inner, BOX] }), field('#595959'));
    expect(finding).toMatchObject({ rule: 'icon-contrast/boundary-measured', status: 'info' });
    expect(finding.evidence.flags).toContain('wrapper');
    const low = evaluate(boundaryCandidate({ box: inner }, { boxes: [inner, BOX] }), field('#dddddd'));
    expect(low.status).toBe('likely');
    expect(low.message).toContain('1 element(s) wrapped tightly around it');
  });

  it('exempts a native control the author did not restyle', () => {
    const finding = evaluate(boundaryCandidate({}, { authorModified: false }), field('#cccccc'));
    expect(finding).toMatchObject({ rule: 'icon-contrast/boundary-default', status: 'info', evidence: { ratios: {} } });
    expect(finding.evidence.flags).toContain('browserDefault');
  });

  it('records a low select as info: its arrow may identify it', () => {
    const finding = evaluate(boundaryCandidate({}, { control: 'select' }), field('#cccccc'));
    expect(finding).toMatchObject({ rule: 'icon-contrast/boundary-low-contrast', status: 'info' });
    expect(finding.evidence.flags).toContain('otherCue');
  });

  it('records a boundary outside the capture as not measured', () => {
    const outside = { x: 500, y: 500, width: 40, height: 40 };
    expect(evaluate(boundaryCandidate({}, { boxes: [outside] }), field('#cccccc'))).toMatchObject({ rule: 'icon-contrast/not-measured', status: 'info' });
  });
});

describe('icon-contrast: survey and determinism', () => {
  it('summarises what was looked at and what was left out', () => {
    const snapshot = snapshotWith([iconCandidate(), boundaryCandidate({ selector: '#field' })], button('#1a1a1a'), { hidden: 3, large: 1, small: 0 });
    snapshot.icons!.total = 5;
    const survey = runChecks(snapshot, config).find((finding) => finding.rule === 'icon-contrast/survey')!;
    expect(survey).toMatchObject({ status: 'info', selector: 'html', wcag: null });
    expect(survey.evidence.flags).toEqual(['truncated']);
    expect(survey.message).toBe(
      'Looked at 1 control(s) without visible text that show a graphic and 1 form control(s) identified by a boundary. 3 more were found and not measured (limit of 300). Left out: 3 hidden, 1 large.',
    );
  });

  it('gives identical findings on two runs', () => {
    const snapshot = snapshotWith([iconCandidate()], button('#c0c0c0'));
    expect(runChecks(snapshot, config)).toEqual(runChecks(snapshot, config));
  });

  it('is in the default check list', () => {
    expect(resolveConfig().checks).toContain('icon-contrast');
    expect(resolveConfig({ icon: { contrastThreshold: 4.5 } }).icon).toMatchObject({ contrastThreshold: 4.5, likelyBandFloor: 2.7 });
  });

  it('reads its thresholds from the config', () => {
    const strict = resolveConfig({ checks: ['icon-contrast'], icon: { likelyBandFloor: 3 } });
    const finding = runChecks(snapshotWith([iconCandidate()], button('#999999')), strict).find((f) => f.selector === '#target')!;
    expect(finding.status).toBe('fail');
  });
});
