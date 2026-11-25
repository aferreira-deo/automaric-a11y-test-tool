import { describe, expect, it } from 'vitest';
import { defaultConfig, resolveConfig, resolveReflow } from '../config.js';
import { runChecks } from '../run.js';
import type { ReflowBox, ReflowClipBox, ReflowLayer, ReflowLayout, ReflowPassName, ReflowSurvey, ReflowText, ReflowViewport } from '../reflow-types.js';
import type { Screenshot, Snapshot } from '../types.js';
import { createImage, encodePng, fillRect } from './image.js';
import { beyondAxisOf, horizontalLayout, inkConfirms, reflowInk, reflowPassReport, reflowPixelPlan, unionArea } from './reflow.js';

const settings = defaultConfig.reflow;

function viewport(width: number, height: number, extra: Partial<ReflowViewport> = {}): ReflowViewport {
  return { width, height, clientWidth: width, clientHeight: height, scrollWidth: width, scrollHeight: height * 3, overflowX: 'visible', overflowY: 'visible', rtl: false, ...extra };
}

function layout(pass: ReflowPassName, width: number, height: number, parts: Partial<ReflowLayout> = {}): ReflowLayout {
  return {
    pass,
    requested: { width, height },
    viewport: viewport(width, height),
    settled: true,
    texts: [],
    boxes: [],
    clips: [],
    chains: [[]],
    beyond: [],
    beyondAxis: pass === 'short' ? null : 'x',
    disclosures: [],
    scrolls: [{ x: 0, y: 0, layers: [] }],
    maxScroll: { x: 0, y: height * 2 },
    elements: 10,
    truncated: false,
    textsBeyond: 0,
    boxesBeyond: 0,
    frames: { readable: 0, opaque: 0 },
    pixels: {},
    captures: {},
    ...parts,
  };
}

function text(key: number, span: [number, number], lines: [number, number, number, number][], extra: Partial<ReflowText> = {}): ReflowText {
  return { key, span, lines, chars: 40 * lines.length, fontSize: 16, chain: 0, sample: `text ${key}`, ...extra };
}

function clip(key: number, rect: [number, number, number, number], x: ReflowClipBox['x'], y: ReflowClipBox['y'], extra: Partial<ReflowClipBox> = {}): ReflowClipBox {
  return { key, rect, x, y, scroll: [rect[2], rect[3], 0, 0, rect[2], rect[3]], tag: 'div', role: '', ...extra };
}

function report(baseline: ReflowLayout, pass: ReflowLayout, clips: Record<string, Screenshot> = {}, config = settings) {
  return reflowPassReport(baseline, pass, config, clips).candidates;
}

describe('unionArea', () => {
  it('counts overlapping rectangles once', () => {
    expect(unionArea([[0, 0, 10, 10], [5, 5, 10, 10]])).toBe(175);
    expect(unionArea([[0, 0, 10, 10], [0, 0, 10, 10]])).toBe(100);
    expect(unionArea([[0, 0, 10, 10], [20, 0, 10, 10]])).toBe(200);
    expect(unionArea([[0, 0, 0, 10]])).toBe(0);
  });
});

describe('reflow/two-dimensional-scroll', () => {
  const base = layout('baseline', 1280, 720, { texts: [text(2, [2, 3], [[16, 100, 600, 24]])] });

  it('is a failure when running text lies beyond the right edge and the document scrolls to it, named on what pushes it out', () => {
    const narrow = layout('narrow', 320, 800, {
      viewport: viewport(320, 800, { scrollWidth: 616 }),
      texts: [text(2, [2, 3], [[16, 100, 600, 24], [16, 124, 580, 24]])],
      beyond: [{ key: 1, span: [1, 4], rect: [16, 100, 600, 48], tag: 'div' }],
    });
    const [found] = report(base, narrow);
    expect(found).toMatchObject({ rule: 'reflow/two-dimensional-scroll', status: 'fail', key: 1, values: { linesBeyond: 2, axis: 'x', overflowCssPx: 296 } });
    expect(found?.flags).toContain('documentScrollsBothAxes');
  });

  it('is info when the same text lay beyond the edge at the baseline viewport', () => {
    const wideBase = layout('baseline', 1280, 720, { viewport: viewport(1280, 720, { scrollWidth: 2000 }), texts: [text(2, [2, 3], [[16, 100, 1900, 24]])] });
    const narrow = layout('narrow', 320, 800, { viewport: viewport(320, 800, { scrollWidth: 2000 }), texts: [text(2, [2, 3], [[16, 100, 1900, 24]])] });
    expect(report(wideBase, narrow)).toMatchObject([{ status: 'info', flags: expect.arrayContaining(['atBaseline']) }]);
  });

  it('is info when only content that may need two dimensions lies beyond', () => {
    const narrow = layout('narrow', 320, 800, {
      viewport: viewport(320, 800, { scrollWidth: 916 }),
      texts: [text(3, [3, 4], [[20, 100, 120, 24]], { except: 'table' })],
      boxes: [{ key: 2, span: [2, 5], rect: [16, 90, 900, 60], kind: 'table', chain: 0, paints: false, tag: 'table' }],
    });
    const [found] = report(base, narrow);
    expect(found).toMatchObject({ status: 'info', key: 2, values: { exceptedKinds: 'table' } });
    expect(found?.flags).toEqual(expect.arrayContaining(['exceptedOnly', 'excepted']));
  });

  it('does not count what a scroller clips, nor a document that does not scroll horizontally', () => {
    const scrolled = layout('narrow', 320, 800, {
      viewport: viewport(320, 800, { scrollWidth: 320 }),
      clips: [clip(9, [16, 90, 288, 100], 'auto', 'hidden', { scroll: [600, 100, 0, 0, 288, 100], holdsTable: true })],
      chains: [[], [9]],
      texts: [text(2, [2, 3], [[16, 100, 600, 24]], { chain: 1 })],
    });
    expect(report(base, scrolled)).toEqual([]);
  });

  it('reports an inner scroller whose lines are wider than it shows as likely', () => {
    const inner = layout('narrow', 320, 800, {
      clips: [clip(9, [16, 90, 288, 100], 'auto', 'hidden', { scroll: [600, 100, 0, 0, 288, 100] })],
      chains: [[], [9]],
      texts: [text(2, [2, 3], [[16, 100, 600, 24]], { chain: 1 })],
    });
    expect(report(base, inner)).toMatchObject([{ status: 'likely', key: 9, flags: ['innerScroller'] }]);
  });

  it('applies on the vertical axis to a page laid out horizontally, at the short pass only', () => {
    const horizontal = layout('baseline', 1280, 720, { viewport: viewport(1280, 720, { scrollWidth: 1800, scrollHeight: 720 }) });
    expect(horizontalLayout(horizontal, settings)).toBe(true);
    expect(beyondAxisOf('narrow', horizontal, settings)).toBeNull();
    expect(beyondAxisOf('short', horizontal, settings)).toBe('y');
    expect(beyondAxisOf('short', base, settings)).toBeNull();
  });
});

describe('reflow/content-lost', () => {
  const card = clip(5, [16, 100, 288, 96], 'hidden', 'hidden');
  const base = layout('baseline', 1280, 720, { clips: [clip(5, [16, 100, 600, 96], 'hidden', 'hidden')], chains: [[], [5]], texts: [text(6, [6, 7], [[24, 116, 580, 24], [24, 140, 300, 24]], { chain: 1 })] });
  const narrowWith = (box: ReflowClipBox, extra: Partial<ReflowLayout> = {}): ReflowLayout =>
    layout('narrow', 320, 800, { clips: [box], chains: [[], [5]], texts: [text(6, [6, 7], [[24, 116, 270, 24], [24, 140, 270, 24], [24, 164, 270, 24], [24, 188, 270, 24], [24, 212, 200, 24]], { chain: 1 })], ...extra });

  it('is a failure when lines shown in full at the baseline are cut off by an element that clips', () => {
    expect(report(base, narrowWith(card))).toMatchObject([{ rule: 'reflow/content-lost', status: 'fail', key: 5, values: { linesCut: 2 }, flags: ['clippedByAncestor'] }]);
  });

  it('is advisory for an ellipsis, likely with a control that may reveal, info for a carousel', () => {
    expect(report(base, narrowWith({ ...card, truncates: 'ellipsis' }))[0]).toMatchObject({ status: 'advisory', flags: ['clippedByAncestor', 'ellipsis'] });
    expect(report(base, narrowWith({ ...card, revealControl: true }))[0]).toMatchObject({ status: 'likely', flags: ['clippedByAncestor', 'revealControl'] });
    expect(report(base, narrowWith({ ...card, carousel: true }))[0]).toMatchObject({ status: 'info', flags: ['carousel', 'clippedByAncestor'] });
  });

  it('is info when the element already hid part of what it holds at the baseline', () => {
    const slides = layout('baseline', 1280, 720, {
      clips: [clip(5, [16, 100, 600, 96], 'hidden', 'hidden')],
      chains: [[], [5]],
      texts: [text(6, [6, 7], [[24, 116, 580, 24]], { chain: 1 }), text(8, [8, 9], [[700, 116, 200, 24]], { chain: 1 })],
    });
    expect(report(slides, narrowWith(card))[0]).toMatchObject({ status: 'info', flags: ['clippedByAncestor', 'clipsAtBaseline'] });
  });

  it('names the element that pushes text beyond a viewport that does not scroll horizontally', () => {
    const plain = layout('baseline', 1280, 720, { texts: [text(6, [6, 7], [[16, 100, 600, 24]])] });
    const hidden = layout('narrow', 320, 800, {
      viewport: viewport(320, 800, { overflowX: 'hidden', overflowY: 'auto', scrollWidth: 656 }),
      texts: [text(6, [6, 7], [[16, 100, 600, 24]])],
      beyond: [{ key: 4, span: [4, 8], rect: [16, 100, 640, 24], tag: 'div' }],
    });
    expect(report(plain, hidden)).toMatchObject([{ status: 'fail', key: 4, flags: ['rootOverflowHidden'] }]);
  });

  it('takes a body that clips for the viewport', () => {
    const plain = layout('baseline', 1280, 720, { texts: [text(6, [6, 7], [[16, 100, 600, 24]])] });
    const body = layout('narrow', 320, 800, {
      clips: [clip(2, [16, 0, 288, 2000], 'hidden', 'auto', { tag: 'body' })],
      chains: [[], [2]],
      texts: [text(6, [6, 7], [[16, 100, 600, 24]], { chain: 1 })],
      beyond: [{ key: 4, span: [4, 8], rect: [16, 100, 640, 24], tag: 'div' }],
    });
    expect(report(plain, body)).toMatchObject([{ status: 'fail', key: 4, flags: ['rootOverflowHidden'] }]);
  });

  it('reports text no longer displayed as info, and not at all when a disclosure control appeared', () => {
    const shown = layout('baseline', 1280, 720, { texts: [text(6, [6, 7], [[16, 100, 600, 24]], { chars: 300 })] });
    const gone = layout('narrow', 320, 800);
    expect(report(shown, gone)).toMatchObject([{ status: 'info', flags: ['notDisplayed'], values: { charsNotDisplayed: 300 } }]);
    expect(report(shown, { ...gone, disclosures: [12] })).toEqual([]);
  });
});

describe('reflow/text-overlap', () => {
  const base = layout('baseline', 1280, 720, {
    texts: [text(2, [2, 3], [[0, 100, 500, 24]]), text(4, [4, 5], [[900, 100, 300, 24]])],
  });
  const narrow = layout('narrow', 320, 800, {
    texts: [text(2, [2, 3], [[0, 100, 240, 24], [0, 124, 240, 24]]), text(4, [4, 5], [[20, 100, 280, 24], [20, 124, 280, 24]])],
  });

  it('finds lines of two elements that meet, which they did not at the baseline', () => {
    expect(reflowPixelPlan(base, narrow, settings)).toMatchObject([{ a: 2, b: 4, kind: 'text' }]);
    // Met at the baseline already: not a reflow problem.
    const met = layout('baseline', 1280, 720, { texts: [text(2, [2, 3], [[0, 100, 500, 24]]), text(4, [4, 5], [[200, 100, 500, 24]])] });
    expect(reflowPixelPlan(met, narrow, settings)).toEqual([]);
  });

  it('leaves out an element and what it holds, lines that only touch, and texts of one ruby', () => {
    const nested = layout('narrow', 320, 800, { texts: [text(2, [2, 9], [[0, 100, 240, 24]]), text(4, [4, 5], [[20, 100, 80, 24]])] });
    expect(reflowPixelPlan(base, nested, settings)).toEqual([]);
    const touching = layout('narrow', 320, 800, { texts: [text(2, [2, 3], [[0, 100, 240, 24]]), text(4, [4, 5], [[0, 120, 240, 24]])] });
    expect(reflowPixelPlan(base, touching, settings)).toEqual([]);
    const ruby = layout('narrow', 320, 800, { texts: [text(2, [2, 3], [[0, 100, 240, 24]], { ruby: 1 }), text(4, [4, 5], [[20, 100, 280, 24]], { ruby: 1 })] });
    expect(reflowPixelPlan(base, ruby, settings)).toEqual([]);
  });

  it('leaves out a pair of which one is in a fixed or sticky element', () => {
    const layered = layout('narrow', 320, 800, { texts: [text(2, [2, 3], [[0, 100, 240, 24]]), text(4, [4, 5], [[20, 100, 280, 24]], { layer: 3 })] });
    expect(reflowPixelPlan(base, layered, settings)).toEqual([]);
  });

  it('is likely from boxes alone between two texts, info for a text under a box, and nothing once pixels clear it', () => {
    expect(report(base, narrow)).toMatchObject([{ rule: 'reflow/text-overlap', status: 'likely', key: 2, flags: ['geometryOnly', 'notTested', 'textOnText'] }]);
    const boxed = layout('narrow', 320, 800, {
      texts: [text(2, [2, 3], [[0, 100, 240, 24]])],
      boxes: [{ key: 7, span: [7, 8], rect: [0, 90, 320, 60], kind: 'box', chain: 0, paints: true, tag: 'div' }],
    });
    const boxBase = layout('baseline', 1280, 720, { texts: [text(2, [2, 3], [[0, 100, 500, 24]])], boxes: [{ key: 7, span: [7, 8], rect: [0, 400, 320, 60], kind: 'box', chain: 0, paints: true, tag: 'div' }] });
    expect(report(boxBase, boxed)).toMatchObject([{ status: 'info', flags: ['geometryOnly', 'notTested', 'textUnderBox'] }]);
  });

  /** A capture of 40 by 20 device pixels with ink drawn where asked. */
  function shot(id: string, inks: [number, number, number, number][]): [string, Screenshot] {
    const image = createImage(40, 20, { r: 255, g: 255, b: 255 });
    for (const [x, y, w, h] of inks) fillRect(image, { x, y, width: w, height: h }, { r: 0, g: 0, b: 0 });
    return [id, { box: { x: 0, y: 0, width: 20, height: 10 }, scale: 2, png: encodePng(image) }];
  }

  it('is a failure when the ink of both texts coincides', () => {
    const [candidate] = reflowPixelPlan(base, narrow, settings);
    // The victim's ink is the left block, the other's the right block; they share 10 by 10 pixels.
    const victim: [number, number, number, number] = [0, 0, 25, 20];
    const other: [number, number, number, number] = [15, 0, 25, 20];
    const clips = Object.fromEntries([
      shot('n', [victim, other]),
      shot('vc', [other]),
      shot('cc', [victim]),
      shot('bc', []),
      shot('ch', [victim]),
      shot('chvc', []),
    ]);
    const tested = { ...narrow, pixels: { [candidate!.id]: { region: candidate!.region, top: 'b' as const, crops: { normal: 'n', victimClear: 'vc', coverClear: 'cc', bothClear: 'bc', coverHidden: 'ch', coverHiddenVictimClear: 'chvc' } } } };
    const ink = reflowInk(tested.pixels[candidate!.id]!, clips, settings)!;
    // Same colour for both: clearing one leaves the shared pixels inked by the other, so its
    // visible ink is 300; alone, each paints 500, and 200 of those pixels are the same.
    expect(ink).toEqual({ victim: 300, alone: 500, cover: 500, both: 200, revealed: 500, coveredShare: 0.4 });
    expect(inkConfirms(ink, settings)).toEqual({ glyphs: true, covered: false });
    expect(report(base, tested, clips)).toMatchObject([{ status: 'fail', key: 2, flags: ['glyphsOverlap', 'pixelConfirmed', 'textOnText'] }]);
  });

  it('is a failure when the ink of a text is missing until the other is hidden, and nothing when the pixels show both readable', () => {
    const [candidate] = reflowPixelPlan(base, narrow, settings);
    const pixels = (crops: Record<string, string>) => ({
      ...narrow,
      pixels: { [candidate!.id]: { region: candidate!.region, top: 'b' as const, crops: { normal: crops['n']!, victimClear: crops['vc']!, coverClear: crops['cc']!, bothClear: crops['bc']!, coverHidden: crops['ch']!, coverHiddenVictimClear: crops['chvc']! } } },
    });
    const ids = { n: 'n', vc: 'vc', cc: 'cc', bc: 'bc', ch: 'ch', chvc: 'chvc' };
    // Covered: an opaque box of the other paints over the victim's text; hidden, it shows.
    const covered = Object.fromEntries([shot('n', [[0, 0, 40, 20]]), shot('vc', [[0, 0, 40, 20]]), shot('cc', [[0, 0, 40, 20]]), shot('bc', [[0, 0, 40, 20]]), shot('ch', [[2, 2, 20, 6]]), shot('chvc', [])]);
    expect(report(base, pixels(ids), covered)).toMatchObject([{ status: 'fail', flags: ['inkCovered', 'pixelConfirmed', 'textOnText'] }]);
    // Side by side in the region: no pixel of both, nothing hidden.
    const apart = Object.fromEntries([shot('n', [[0, 0, 10, 20], [30, 0, 10, 20]]), shot('vc', [[30, 0, 10, 20]]), shot('cc', [[0, 0, 10, 20]]), shot('bc', []), shot('ch', [[0, 0, 10, 20]]), shot('chvc', [])]);
    expect(report(base, pixels(ids), apart)).toEqual([]);
  });
});

describe('reflow/sticky-obscures', () => {
  const layer = (key: number, rect: [number, number, number, number], extra: Partial<ReflowLayer> = {}): ReflowLayer => ({ key, position: 'fixed', rect, painted: [rect], buttons: 0, controls: 0, landmark: true, ...extra });
  const base = layout('baseline', 1280, 720, { scrolls: [{ x: 0, y: 0, layers: [layer(1, [0, 0, 1280, 80]), layer(2, [0, 646, 1280, 74])] }] });
  const short = (layers: ReflowLayer[]): ReflowLayout => layout('short', 800, 256, { scrolls: [{ x: 0, y: 0, layers }] });

  it('is likely by default under the readable share, named on the layer that takes the most room', () => {
    const [found] = report(base, short([layer(1, [0, 0, 800, 80]), layer(2, [0, 182, 800, 74])]));
    expect(found).toMatchObject({ rule: 'reflow/sticky-obscures', status: 'likely', key: 1, values: { readableShare: 0.4 } });
    expect(report(base, short([layer(1, [0, 0, 800, 40]), layer(2, [0, 219, 800, 37])]))).toEqual([]);
  });

  it('takes the status from the configuration, and lowers it one level when what can be dismissed is the cause', () => {
    const config = resolveReflow({ stickyObscuresStatus: 'fail' });
    expect(report(base, short([layer(1, [0, 0, 800, 80]), layer(2, [0, 182, 800, 74])]), {}, config)[0]?.status).toBe('fail');
    const banner = layer(3, [0, 156, 800, 100], { landmark: false, buttons: 2, controls: 2 });
    const [found] = report(base, short([layer(1, [0, 0, 800, 60]), banner]));
    expect(found).toMatchObject({ status: 'advisory', key: 3, flags: ['dismissible', 'loweredDismissible'] });
  });

  it('counts a sticky element only once it is stuck, and is info when the baseline has the same problem', () => {
    const sticky = (y: number): ReflowLayer => layer(4, [0, y, 800, 140], { position: 'sticky' });
    const scrolled = layout('short', 800, 256, { scrolls: [{ x: 0, y: 0, layers: [sticky(400)] }, { x: 0, y: 800, layers: [sticky(0)] }] });
    expect(report(base, scrolled)).toMatchObject([{ status: 'likely', key: 4, flags: ['afterScroll'] }]);
    const atTop = layout('short', 800, 256, { scrolls: [{ x: 0, y: 0, layers: [sticky(0)] }] });
    expect(report(base, atTop)).toEqual([]);
    const crowded = layout('baseline', 1280, 720, { scrolls: [{ x: 0, y: 0, layers: [layer(1, [0, 0, 1280, 600])] }] });
    expect(report(crowded, short([layer(1, [0, 0, 800, 200])]))[0]).toMatchObject({ status: 'info', flags: ['atBaseline'] });
  });
});

describe('reflow/scroll-locked', () => {
  const base = layout('baseline', 1280, 720, { texts: [text(2, [2, 3], [[16, 300, 600, 24]]), text(3, [3, 4], [[16, 400, 600, 24]])] });
  const locked = (extra: Partial<ReflowLayout> = {}): ReflowLayout =>
    layout('narrow', 320, 800, { viewport: viewport(320, 800, { overflowX: 'hidden', overflowY: 'hidden', scrollHeight: 1400 }), texts: [text(2, [2, 3], [[16, 300, 288, 24]]), text(3, [3, 4], [[16, 1200, 288, 24]])], ...extra });

  it('is a failure when text lies below a viewport that does not scroll and no scroller brings it into view', () => {
    expect(report(base, locked())).toMatchObject([{ rule: 'reflow/scroll-locked', status: 'fail', key: 0, values: { unreachableTexts: 1 } }]);
  });

  it('is nothing when a scroller of the page brings it into view', () => {
    const app = locked({
      clips: [clip(9, [0, 0, 320, 800], 'hidden', 'auto', { scroll: [320, 1400, 0, 0, 320, 800] })],
      chains: [[], [9]],
      texts: [text(2, [2, 3], [[16, 300, 288, 24]], { chain: 1 }), text(3, [3, 4], [[16, 1200, 288, 24]], { chain: 1 })],
    });
    expect(report(base, app)).toEqual([]);
  });
});

describe('reflow/double-scrollbar', () => {
  const scroller = (extra: Partial<ReflowClipBox> = {}): ReflowClipBox => clip(9, [0, 100, 320, 720], 'hidden', 'auto', { scroll: [320, 3000, 0, 0, 320, 720], ...extra });
  const holding = (box: ReflowClipBox): ReflowLayout =>
    layout('narrow', 320, 800, { viewport: viewport(320, 800, { scrollHeight: 1500 }), clips: [box], chains: [[], [9]], texts: [text(2, [2, 3], [[0, 120, 300, 24]], { chain: 1, chars: 900 })] });
  const base = layout('baseline', 1280, 720);

  it('is likely for a scroller on the axis of the page that holds the main text', () => {
    expect(report(base, holding(scroller()))).toMatchObject([{ rule: 'reflow/double-scrollbar', status: 'likely', key: 9, values: { scrollerShareOfViewport: 0.9 } }]);
  });

  it('leaves out fields, code, logs, tables, small scrollers, and is info when the baseline has it', () => {
    for (const box of [scroller({ tag: 'textarea' }), scroller({ tag: 'pre' }), scroller({ role: 'log' }), scroller({ holdsTable: true }), scroller({ scroll: [320, 3000, 0, 0, 320, 300] }), scroller({ scroll: [320, 722, 0, 0, 320, 720] })]) {
      expect(report(base, holding(box)), box.tag + box.role).toEqual([]);
    }
    const same = layout('baseline', 1280, 720, { clips: [clip(9, [0, 100, 1280, 640], 'hidden', 'auto', { scroll: [1280, 3000, 0, 0, 1280, 640] })], chains: [[], [9]], texts: [text(2, [2, 3], [[0, 120, 600, 24]], { chain: 1, chars: 900 })] });
    expect(report(same, holding(scroller()))).toMatchObject([{ status: 'info', flags: ['atBaseline'] }]);
  });
});

describe('what a pass measured', () => {
  const base = layout('baseline', 1280, 720, { texts: [text(2, [2, 3], [[16, 100, 600, 24]])] });
  const failing = layout('narrow', 320, 800, { viewport: viewport(320, 800, { scrollWidth: 616 }), texts: [text(2, [2, 3], [[16, 100, 600, 24]])] });

  it('is info when the viewport is not the one asked for, and likely at most when the layout did not settle', () => {
    expect(report(base, { ...failing, viewport: { ...failing.viewport, width: 1280 } })[0]).toMatchObject({ status: 'info', flags: expect.arrayContaining(['viewportNotApplied']) });
    expect(report(base, { ...failing, settled: false })[0]).toMatchObject({ status: 'likely', flags: expect.arrayContaining(['notSettled']) });
  });

  it('lists at most maxFindingsPerRule findings of a rule', () => {
    const many = layout('narrow', 320, 800, {
      viewport: viewport(320, 800, { scrollWidth: 700 }),
      texts: Array.from({ length: 5 }, (_, i) => text(10 + i, [10 + 2 * i, 11 + 2 * i], [[16, 100 + 30 * i, 600, 24]])),
    });
    const many0 = layout('baseline', 1280, 720, { texts: many.texts });
    const result = reflowPassReport(many0, many, resolveReflow({ maxFindingsPerRule: 2 }), {});
    expect(result.candidates).toHaveLength(2);
    expect(result.omitted).toEqual({ 'reflow/two-dimensional-scroll': 3 });
  });
});

describe('the reflow check', () => {
  const base = layout('baseline', 1280, 720, { texts: [text(2, [2, 3], [[16, 100, 600, 24]])] });
  const pass = (name: ReflowPassName, width: number, height: number): ReflowLayout =>
    layout(name, width, height, { beyondAxis: 'x', viewport: viewport(width, height, { scrollWidth: 616 }), texts: [text(2, [2, 3], [[16, 100, 600, 24]])], captures: {} });
  const survey: ReflowSurvey = { baseline: base, passes: [pass('narrow', 320, 800), pass('short', 300, 256)], skipped: [], names: { '2': { selector: '#wide', frame: '' } }, original: { width: 1280, height: 720 } };
  const snapshot: Snapshot = { environment: { url: 'http://example.test/', devicePixelRatio: 2, viewport: { width: 1280, height: 720 }, colorScheme: 'light' }, reflow: survey, nodes: [], axTree: [], screenshots: { tiles: [], clips: {} } };

  it('gives one finding per pass, with distinct ids, the viewport in its values, and a survey', () => {
    const findings = runChecks(snapshot, resolveConfig({ checks: ['reflow'] }));
    const twoDimensional = findings.filter((finding) => finding.rule === 'reflow/two-dimensional-scroll');
    expect(twoDimensional.map((finding) => [finding.selector, finding.status, finding.evidence.values?.['viewport']])).toEqual([
      ['#wide', 'fail', '320x800'],
      ['#wide', 'fail', '300x256'],
    ]);
    expect(new Set(findings.map((finding) => finding.id)).size).toBe(findings.length);
    expect(twoDimensional[0]?.wcag).toEqual({ sc: '1.4.10', level: 'AA' });
    expect(twoDimensional[0]?.evidence.flags).toContain('notCaptured');
    const survey = findings.find((finding) => finding.rule === 'reflow/survey');
    expect(survey).toMatchObject({ status: 'info', wcag: null, evidence: { values: { passes: 'narrow short', findings: 2 } } });
  });
});

describe('reflow settings', () => {
  it('put back what is not a usable value', () => {
    const resolved = resolveReflow({ narrowWidthCssPx: -3, shortHeightCssPx: 1e9, minReadableViewportShare: 2, stickyObscuresStatus: 'error' as never, stickyScrollPositions: [1, 0.5, 2, 'x' as never, 0.5], narrowPass: 'no' as never, settleMaxMs: Infinity });
    expect(resolved).toMatchObject({
      narrowWidthCssPx: 1,
      shortHeightCssPx: 10000,
      minReadableViewportShare: defaultConfig.reflow.minReadableViewportShare,
      stickyObscuresStatus: 'likely',
      stickyScrollPositions: [0.5, 1],
      narrowPass: true,
      settleMaxMs: defaultConfig.reflow.settleMaxMs,
    });
    expect(resolveReflow({})).toEqual(defaultConfig.reflow);
    expect(resolveConfig({ reflow: { shortPass: false } }).reflow.shortPass).toBe(false);
  });
});
