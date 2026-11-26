import { describe, expect, it } from 'vitest';
import { defaultConfig, resolveConfig, resolveReflow } from '../config.js';
import { runChecks } from '../run.js';
import type { ReflowClipBox, ReflowLayer, ReflowLayout, ReflowPassName, ReflowRect, ReflowSurvey, ReflowText, ReflowViewport } from '../reflow-types.js';
import type { Screenshot, Snapshot } from '../types.js';
import { createImage, encodePng, fillRect } from './image.js';
import { beyondAxisOf, horizontalLayout, inkConfirms, reflowInk, reflowPassReport, reflowPixelPlan, reflowPixelRoles, unionArea } from './reflow.js';

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
    const [found] = report(wideBase, narrow);
    expect(found?.status).toBe('info');
    expect(found?.flags).toContain('atBaseline');
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

  it('looks beyond the left edge of a page laid out right to left, where its overflow goes', () => {
    const rtl = layout('narrow', 320, 800, {
      viewport: viewport(320, 800, { scrollWidth: 616, rtl: true }),
      texts: [text(2, [2, 3], [[-280, 100, 584, 24]])],
    });
    expect(report(base, rtl)).toMatchObject([{ status: 'fail', key: 2, values: { reachBeyondCssPx: 279 } }]);
    // Beyond the right edge, which is its start edge, nothing scrolls to it.
    const start = layout('narrow', 320, 800, { viewport: viewport(320, 800, { rtl: true }), texts: [text(2, [2, 3], [[100, 100, 400, 24]])] });
    expect(report(base, start)).toMatchObject([{ rule: 'reflow/content-lost', status: 'fail', flags: ['beforeStartEdge'] }]);
  });

  it('applies on the vertical axis to a page laid out horizontally, at the short pass only', () => {
    const horizontal = layout('baseline', 1280, 720, {
      viewport: viewport(1280, 720, { scrollWidth: 1800, scrollHeight: 720 }),
      texts: [text(2, [2, 3], [[16, 100, 400, 24]]), text(4, [4, 5], [[1400, 100, 380, 24]])],
    });
    expect(horizontalLayout(horizontal, settings)).toBe(true);
    // The narrow pass always looks at the horizontal axis.
    expect(beyondAxisOf('narrow', horizontal, settings)).toBe('x');
    expect(beyondAxisOf('short', horizontal, settings)).toBe('y');
    expect(beyondAxisOf('short', base, settings)).toBeNull();
  });

  it('takes a page for one laid out horizontally on positive evidence of the reference layout only: most running text in the flow beyond the inline end, a vertical writing mode, a horizontal track', () => {
    // A short page with a ribbon that sticks out by 40 px: no text beyond the edge.
    const ribbon = layout('baseline', 800, 256, {
      viewport: viewport(800, 256, { scrollWidth: 840, scrollHeight: 256 }),
      texts: [text(2, [2, 3], [[16, 20, 700, 24]]), text(4, [4, 5], [[16, 60, 700, 24]])],
      boxes: [{ key: 9, span: [9, 10], rect: [680, 10, 160, 24], kind: 'box', chain: 0, paints: true, tag: 'div' }],
    });
    expect(horizontalLayout(ribbon, settings)).toBe(false);
    expect(beyondAxisOf('short', ribbon, settings)).toBeNull();
    const vertical = layout('baseline', 1280, 720, { viewport: viewport(1280, 720, { vertical: true }) });
    expect(horizontalLayout(vertical, settings)).toBe(true);
    // Panels side by side whose text mostly fits at the baseline: not one; the narrow pass is no evidence.
    const panels = layout('baseline', 1280, 720, { viewport: viewport(1280, 720, { scrollWidth: 1500, scrollHeight: 720 }), texts: [text(2, [2, 3], [[16, 20, 400, 24]]), text(4, [4, 5], [[1016, 20, 200, 24]])] });
    const narrowPanels = layout('narrow', 320, 800, { viewport: viewport(320, 800, { scrollWidth: 1500, scrollHeight: 800 }), texts: [text(2, [2, 3], [[16, 20, 400, 24]]), text(4, [4, 5], [[1016, 20, 200, 24]])] });
    expect(horizontalLayout(panels, settings)).toBe(false);
    expect(beyondAxisOf('short', panels, settings, narrowPanels)).toBeNull();
    // The root (or body) is a flex row that does not wrap, or snaps horizontally: a track.
    expect(horizontalLayout({ ...panels, viewport: { ...panels.viewport, track: 'flex' } }, settings)).toBe(true);
    // A page that scrolls vertically at the reference is never one.
    expect(horizontalLayout({ ...panels, viewport: { ...panels.viewport, track: 'snap', scrollHeight: 2000 } }, settings)).toBe(false);
  });

  it('takes no off-canvas navigation parked beyond the edge for evidence of a page laid out horizontally (n1b)', () => {
    // A short page: a navigation positioned at right: -320px, no overflow-x: hidden, a form 620 px wide.
    const nav = [0, 1, 2, 3].map((i) => text(20 + 2 * i, [20 + 2 * i, 21 + 2 * i], [[1300, 10 + 24 * i, 280, 24]], { placed: 'absolute' as const, chars: 30 }));
    const form = text(4, [4, 5], [[24, 250, 600, 24]], { chars: 80 });
    const base = layout('baseline', 1280, 720, { viewport: viewport(1280, 720, { scrollWidth: 1600, scrollHeight: 720 }), texts: [...nav, form] });
    expect(horizontalLayout(base, settings)).toBe(false);
    expect(beyondAxisOf('short', base, settings)).toBeNull();
    // At 320 px the form needs horizontal scrolling: a failure, which classing the page as horizontal hid.
    const narrow = layout('narrow', 320, 800, {
      viewport: viewport(320, 800, { scrollWidth: 660, scrollHeight: 800 }),
      texts: [...nav.map((item) => ({ ...item, lines: [[340, item.lines[0]![1], 280, 24] as ReflowRect] })), { ...form, lines: [[24, 250, 600, 24]] }],
      beyond: [{ key: 3, span: [3, 6], rect: [16, 240, 620, 60], tag: 'div' }, { key: 19, span: [19, 30], rect: [340, 0, 300, 100], tag: 'nav' }],
    });
    expect(report(base, narrow).filter((candidate) => candidate.status === 'fail')).toMatchObject([{ rule: 'reflow/two-dimensional-scroll', key: 3 }]);
  });

  it('fails the vertical axis of the short pass only when running text still needs horizontal scrolling there', () => {
    const horizontal = layout('baseline', 1280, 720, {
      viewport: viewport(1280, 720, { scrollWidth: 3600, scrollHeight: 720 }),
      texts: [text(2, [2, 3], [[16, 100, 400, 24]]), text(4, [4, 5], [[1400, 100, 380, 24]]), text(6, [6, 7], [[2400, 100, 380, 24]])],
    });
    const below = text(8, [8, 9], [[16, 300, 400, 24]]);
    // It grew downwards at 256 px: one direction of scrolling, nothing to fail.
    const vertical = layout('short', 800, 256, { beyondAxis: 'y', viewport: viewport(800, 256, { scrollWidth: 800, scrollHeight: 900 }), texts: [text(2, [2, 3], [[16, 100, 400, 24]]), below] });
    expect(report({ ...horizontal, texts: [...horizontal.texts, below] }, vertical).filter((candidate) => candidate.rule === 'reflow/two-dimensional-scroll')).toEqual([]);
    // Still wide, and taller than the viewport: two dimensions.
    const both = layout('short', 800, 256, {
      beyondAxis: 'y',
      viewport: viewport(800, 256, { scrollWidth: 3600, scrollHeight: 900 }),
      texts: [text(2, [2, 3], [[16, 100, 400, 24]]), text(4, [4, 5], [[1400, 100, 380, 24]]), below],
      beyond: [{ key: 8, span: [8, 9], rect: [16, 300, 400, 24], tag: 'p' }],
    });
    expect(report({ ...horizontal, texts: [...horizontal.texts.slice(0, 2)] }, both).filter((candidate) => candidate.rule === 'reflow/two-dimensional-scroll')).toMatchObject([{ status: 'fail', values: { axis: 'y' } }]);
  });

  it('reaches what a page laid out from the right (vertical-rl) has beyond its left edge (k1)', () => {
    const base = layout('baseline', 1280, 720, { viewport: viewport(1280, 720, { vertical: true, rtl: true, scrollWidth: 2000 }), texts: [text(2, [2, 3], [[1200, 16, 24, 600]]), text(4, [4, 5], [[600, 16, 24, 600]])] });
    const narrow = layout('narrow', 320, 800, {
      viewport: viewport(320, 800, { vertical: true, rtl: true, scrollWidth: 2600, overflowX: 'auto' }),
      texts: [text(2, [2, 3], [[280, 16, 24, 700]]), text(4, [4, 5], [[-600, 16, 24, 700]]), text(6, [6, 7], [[-12, 16, 24, 700]])],
    });
    expect(report({ ...base, texts: [...base.texts, text(6, [6, 7], [[900, 16, 24, 600]])] }, narrow).filter((candidate) => candidate.rule === 'reflow/content-lost')).toEqual([]);
  });

  it('reports nothing beyond the right edge of a page laid out horizontally in the narrow pass, unless it scrolls vertically as well', () => {
    const wideBase = layout('baseline', 1280, 720, {
      viewport: viewport(1280, 720, { scrollWidth: 3000, scrollHeight: 720 }),
      texts: [text(2, [2, 3], [[16, 100, 400, 24]]), text(4, [4, 5], [[1400, 100, 380, 24]])],
    });
    const narrow = layout('narrow', 320, 800, {
      viewport: viewport(320, 800, { scrollWidth: 3000, scrollHeight: 800 }),
      texts: [text(2, [2, 3], [[16, 100, 400, 24]]), text(4, [4, 5], [[1400, 100, 380, 24]])],
    });
    expect(report(wideBase, narrow)).toEqual([]);
    const taller = { ...narrow, viewport: viewport(320, 800, { scrollWidth: 3000, scrollHeight: 2400 }) };
    expect(report(wideBase, taller).filter((candidate) => candidate.status === 'fail')).toMatchObject([{ rule: 'reflow/two-dimensional-scroll' }]);
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

  it('is advisory for an ellipsis and with a control that may reveal, info for a carousel', () => {
    expect(report(base, narrowWith({ ...card, truncates: 'ellipsis' }))[0]).toMatchObject({ status: 'advisory', flags: ['clippedByAncestor', 'ellipsis'] });
    expect(report(base, narrowWith({ ...card, revealControl: true }))[0]).toMatchObject({ status: 'advisory', flags: ['clippedByAncestor', 'revealControl'] });
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

  it('takes text in the flow moved wholly off screen for lost, as text cut at the start edge is', () => {
    const shown = layout('baseline', 1280, 720, { texts: [text(6, [6, 7], [[16, 100, 200, 24]], { chars: 300 })] });
    const away = layout('narrow', 320, 800, { texts: [text(6, [6, 7], [[-300, 100, 200, 24]], { chars: 300 })] });
    expect(report(shown, away)).toMatchObject([{ status: 'fail', key: 6, flags: ['beforeStartEdge'] }]);
    const half = layout('narrow', 320, 800, { texts: [text(6, [6, 7], [[-100, 100, 200, 24]], { chars: 300 })] });
    expect(report(shown, half)).toMatchObject([{ status: 'fail', key: 6, flags: ['beforeStartEdge'] }]);
  });

  it('fails a column in the flow wholly beyond the reach of a root that clips, whether or not a menu button appeared or an ancestor straddles the edge (a1b, a5b)', () => {
    const hidden = { overflowX: 'hidden' as const, overflowY: 'auto' as const };
    const column = [0, 1, 2].map((i) => text(30 + 2 * i, [30 + 2 * i, 31 + 2 * i], [[346, 40 + 30 * i, 428, 24]], { chars: 60 }));
    const base = layout('baseline', 1280, 720, { texts: column });
    const a1b = layout('narrow', 320, 800, { viewport: viewport(320, 800, hidden), texts: column, beyond: [{ key: 3, span: [3, 40], rect: [0, 0, 790, 200], tag: 'div' }, { key: 29, span: [29, 37], rect: [330, 0, 460, 200], tag: 'section' }] });
    // Named on the outermost element beyond the edge, the row that pushes it out; failed all the same when nothing straddles.
    expect(report(base, a1b)).toMatchObject([{ rule: 'reflow/content-lost', status: 'fail', key: 3, flags: ['rootOverflowHidden'] }]);
    expect(report(base, { ...a1b, disclosures: [99] })).toMatchObject([{ status: 'fail' }]);
    expect(report(base, { ...a1b, beyond: [{ key: 29, span: [29, 37], rect: [330, 0, 460, 200], tag: 'section' }] })).toMatchObject([{ status: 'fail', key: 29 }]);
  });

  it('is likely for content positioned out of the flow wholly beyond the reach of the root that nothing names (a4b)', () => {
    const hidden = { overflowX: 'hidden' as const, overflowY: 'auto' as const };
    const column = [0, 1].map((i) => text(30 + 2 * i, [30 + 2 * i, 31 + 2 * i], [[346, 40 + 30 * i, 428, 24]], { chars: 60, placed: 'absolute' as const }));
    const base = layout('baseline', 1280, 720, { texts: column });
    expect(report(base, layout('narrow', 320, 800, { viewport: viewport(320, 800, hidden), texts: column }))).toMatchObject([{ status: 'likely', flags: ['outOfFlow', 'rootOverflowHidden'] }]);
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

  it('is likely from boxes alone between two texts that could not be captured, info beyond the limit of tests and for a text under a box, and nothing once pixels clear it', () => {
    const [pair] = reflowPixelPlan(base, narrow, settings);
    const unseen = { ...narrow, pixels: { [pair!.id]: { region: pair!.region, top: 'unknown' as const, crops: null, reason: 'not-in-view' as const } } };
    expect(report(base, unseen)).toMatchObject([{ rule: 'reflow/text-overlap', status: 'likely', key: 2, flags: ['geometryOnly', 'notInView', 'textOnText'] }]);
    expect(report(base, narrow)).toMatchObject([{ rule: 'reflow/text-overlap', status: 'info', key: 2, flags: ['geometryOnly', 'notTested', 'textOnText'] }]);
    const boxed = layout('narrow', 320, 800, {
      texts: [text(2, [2, 3], [[0, 100, 240, 24]])],
      boxes: [{ key: 7, span: [7, 8], rect: [0, 90, 320, 60], kind: 'box', chain: 0, paints: true, tag: 'div' }],
    });
    const boxBase = layout('baseline', 1280, 720, { texts: [text(2, [2, 3], [[0, 100, 500, 24]])], boxes: [{ key: 7, span: [7, 8], rect: [0, 400, 320, 60], kind: 'box', chain: 0, paints: true, tag: 'div' }] });
    expect(report(boxBase, boxed)).toMatchObject([{ status: 'info', flags: ['geometryOnly', 'notTested', 'textUnderBox'] }]);
    // The hit test found the text over the box: nothing to report.
    const [candidate] = reflowPixelPlan(boxBase, boxed, settings);
    expect(report(boxBase, { ...boxed, pixels: { [candidate!.id]: { region: candidate!.region, top: 'a', crops: null } } })).toEqual([]);
    // An inline box (a link with an icon that wraps over two lines) paints over no text.
    const inline = { ...boxed, boxes: boxed.boxes.map((box) => ({ ...box, inline: true })) };
    expect(reflowPixelPlan(boxBase, inline, settings)).toEqual([]);
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
    const banner = layer(3, [0, 156, 800, 100], { landmark: false, buttons: 2, controls: 2, dismissControl: true });
    const [found] = report(base, short([layer(1, [0, 0, 800, 60]), banner]));
    expect(found).toMatchObject({ status: 'advisory', key: 3, flags: ['dismissible', 'loweredDismissible'] });
  });

  it('does not take buttons alone for a way to dismiss: a bar with Menu and Search is not a banner', () => {
    const bar = layer(3, [0, 156, 800, 100], { landmark: false, buttons: 2, controls: 3 });
    const [found] = report(base, short([layer(1, [0, 0, 800, 60]), bar]));
    expect(found).toMatchObject({ status: 'likely', key: 3, flags: [] });
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

  it('is info when the document locks content out at the baseline too (a dialog, a consent wall)', () => {
    const lockedBase = layout('baseline', 1280, 720, {
      viewport: viewport(1280, 720, { overflowX: 'hidden', overflowY: 'hidden', scrollHeight: 2000 }),
      texts: [text(2, [2, 3], [[16, 300, 600, 24]]), text(3, [3, 4], [[16, 1000, 600, 24]])],
    });
    expect(report(lockedBase, locked())).toMatchObject([{ status: 'info', flags: ['atBaseline'] }]);
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
    // Half the viewport at the baseline as well: a smaller scroller of the page by design.
    const half = scroller({ scroll: [320, 3000, 0, 0, 320, 500] });
    expect(report(same, holding(half))).toMatchObject([{ status: 'info', flags: ['atBaseline'] }]);
  });

  it('is likely, with atBaseline in its values, for a shell as tall as the viewport that the baseline has as well; info when so configured', () => {
    const same = layout('baseline', 1280, 720, { clips: [clip(9, [0, 60, 1280, 720], 'hidden', 'auto', { scroll: [1280, 3000, 0, 0, 1280, 720] })], chains: [[], [9]], texts: [text(2, [2, 3], [[0, 120, 600, 24]], { chain: 1, chars: 900 })] });
    expect(report(same, holding(scroller()))).toMatchObject([{ status: 'likely', flags: ['atBaseline'], values: { atBaseline: true } }]);
    expect(report(same, holding(scroller()), {}, resolveReflow({ doubleScrollbarAtBaselineStatus: 'info' }))).toMatchObject([{ status: 'info', flags: ['atBaseline'] }]);
  });
});

describe('reachability through scroll containers, from the inside out', () => {
  const lostOf = (base: ReflowLayout, pass: ReflowLayout) => report(base, pass).filter((candidate) => candidate.rule === 'reflow/content-lost');
  // A row of cards that scrolls horizontally, in a body that clips horizontally (html and body overflow-x: hidden).
  const row = clip(7, [16, 100, 288, 120], 'auto', 'hidden', { scroll: [1100, 120, 0, 0, 288, 120] });
  const body = clip(2, [0, 0, 320, 2000], 'hidden', 'visible', { tag: 'body' });
  const cards = [text(10, [10, 11], [[28, 112, 236, 24]], { chain: 1 }), text(12, [12, 13], [[304, 112, 236, 24]], { chain: 1 }), text(14, [14, 15], [[580, 112, 236, 24]], { chain: 1 })];
  const base = layout('baseline', 1280, 720, { texts: cards.map((card, i) => ({ ...card, chain: 0, lines: [[28 + 276 * i, 112, 236, 24]] })) });

  it('does not take the cards of a horizontal scroller for lost when an outer element or the root clips', () => {
    const q1 = layout('narrow', 320, 800, { viewport: viewport(320, 800, { overflowX: 'hidden', overflowY: 'auto' }), clips: [row, body], chains: [[], [7, 2]], texts: cards });
    expect(lostOf(base, q1)).toEqual([]);
    // In a card that clips (overflow: hidden, rounded corners) around the scroller.
    const card = clip(3, [8, 92, 304, 136], 'hidden', 'hidden');
    const q4 = layout('narrow', 320, 800, { clips: [row, card], chains: [[], [7, 3]], texts: cards });
    expect(lostOf(base, q4)).toEqual([]);
  });

  it('still finds a scroller that is itself pushed out of reach', () => {
    const away = clip(7, [400, 100, 288, 120], 'auto', 'hidden', { scroll: [1100, 120, 0, 0, 288, 120] });
    const out = layout('narrow', 320, 800, { viewport: viewport(320, 800, { overflowX: 'hidden', overflowY: 'auto' }), clips: [away, body], chains: [[], [7, 2]], texts: [text(10, [10, 11], [[412, 112, 236, 24]], { chain: 1 })] });
    // Wholly out of reach through the scroller, and in the flow: lost.
    expect(lostOf(base, out)).toMatchObject([{ status: 'fail', flags: ['rootOverflowHidden'] }]);
    const half = clip(7, [200, 100, 288, 120], 'auto', 'hidden', { scroll: [1100, 120, 0, 0, 288, 120] });
    const cut = layout('narrow', 320, 800, { viewport: viewport(320, 800, { overflowX: 'hidden', overflowY: 'auto' }), clips: [half, body], chains: [[], [7, 2]], texts: [text(10, [10, 11], [[212, 112, 236, 24]], { chain: 1 })] });
    expect(lostOf(base, cut)).toMatchObject([{ status: 'fail', flags: ['rootOverflowHidden'] }]);
  });

  it('carries the positions a scroller can give a line and intersects them with the clips around it: cards a cut scroller never shows are lost (b2)', () => {
    // A row 700 px wide (five cards of 200 px) that scrolls horizontally, inside an element with overflow: hidden that shows 288 px.
    const row700 = clip(7, [16, 100, 700, 120], 'auto', 'hidden', { scroll: [1096, 120, 0, 0, 700, 120] });
    const outer = clip(3, [16, 92, 288, 136], 'hidden', 'hidden');
    const five = [0, 1, 2, 3, 4].map((i) => text(40 + 2 * i, [40 + 2 * i, 41 + 2 * i], [[16 + 216 * i, 112, 200, 24]], { chain: 1 }));
    const wide = layout('baseline', 1280, 720, { texts: five.map((card) => ({ ...card, chain: 0 })) });
    const b2 = layout('narrow', 320, 800, { clips: [row700, outer], chains: [[], [7, 3]], texts: five });
    expect(lostOf(wide, b2)).toMatchObject([{ status: 'fail', key: 3, flags: ['clippedByAncestor'], values: { textsCut: 2 } }]);
    // A scroller with nothing to scroll (a clearfix) reaches nothing beyond what its box shows through the body (b1b).
    const clearfix = clip(7, [0, 0, 700, 400], 'auto', 'auto', { scroll: [700, 400, 0, 0, 700, 400] });
    const column = text(50, [50, 51], [[346, 40, 340, 24]], { chain: 1 });
    const b1b = layout('narrow', 320, 800, { viewport: viewport(320, 800, { overflowX: 'hidden', overflowY: 'auto' }), clips: [clearfix, body], chains: [[], [7, 2]], texts: [column] });
    expect(lostOf(layout('baseline', 1280, 720, { texts: [{ ...column, chain: 0 }] }), b1b)).toMatchObject([{ status: 'fail', flags: ['rootOverflowHidden'] }]);
  });

  const dialogLayer: ReflowLayer = { key: 20, position: 'fixed', rect: [16, 40, 288, 300], painted: [[16, 40, 288, 300]], buttons: 2, controls: 3, dialog: true, modal: true, dismissControl: true };
  const dialogTexts = (chain: number) => [
    text(21, [21, 22], [[32, 56, 256, 24]], { chain, layer: 20, popup: true }),
    text(23, [23, 24], [[32, 280, 256, 24]], { chain, layer: 20, popup: true }),
  ];
  const dialogBase = layout('baseline', 1280, 720, { texts: dialogTexts(0), boxes: [{ key: 25, span: [25, 26], rect: [32, 310, 100, 30], kind: 'control', chain: 0, layer: 20, popup: true, paints: true, tag: 'button' }] });

  it('reaches the content of a fixed dialog through its own scroller (max-height, overflow: auto)', () => {
    const scroller = clip(20, [16, 12, 288, 230], 'hidden', 'auto', { scroll: [288, 330, 0, 0, 288, 230], layer: 20 });
    const short = layout('short', 800, 256, {
      clips: [scroller],
      chains: [[], [20]],
      texts: dialogTexts(1),
      boxes: [{ key: 25, span: [25, 26], rect: [32, 310, 100, 30], kind: 'control', chain: 1, layer: 20, popup: true, paints: true, tag: 'button' }],
      scrolls: [{ x: 0, y: 0, layers: [{ ...dialogLayer, rect: [16, 12, 288, 230], painted: [[16, 12, 288, 230]] }] }],
    });
    expect(lostOf(dialogBase, short)).toEqual([]);
  });

  it('fails a fixed dialog whose fields and buttons lie below the viewport where nothing scrolls to them, which is then not dismissible', () => {
    const short = layout('short', 800, 256, {
      texts: dialogTexts(0),
      boxes: [{ key: 25, span: [25, 26], rect: [32, 310, 100, 30], kind: 'control', chain: 0, layer: 20, popup: true, paints: true, tag: 'button' }],
      scrolls: [{ x: 0, y: 0, layers: [{ ...dialogLayer, rect: [16, 40, 288, 300], painted: [[0, 0, 800, 256]] }] }],
    });
    const found = report(dialogBase, short);
    expect(found.find((candidate) => candidate.rule === 'reflow/content-lost')).toMatchObject({ status: 'fail', key: 20, flags: ['control', 'fixedBeyondViewport'], values: { controlsCut: 1, side: 'bottom' } });
    expect(found.find((candidate) => candidate.rule === 'reflow/sticky-obscures')).toMatchObject({ status: 'likely', values: { dismissibleLayers: 0 } });
  });
});

describe('content parked off screen', () => {
  const nav = (x: number, extra: Partial<ReflowText> = {}) => [0, 1, 2, 3, 4].map((i) => text(30 + 2 * i, [30 + 2 * i, 31 + 2 * i], [[x, 50 + 30 * i, 228, 24]], { chars: 60, ...extra }));
  const base = layout('baseline', 1280, 720, { texts: nav(700).map((item, i) => ({ ...item, lines: [[700 + 120 * i, 20, 100, 24]] })) });
  const hidden = { overflowX: 'hidden' as const, overflowY: 'auto' as const };

  it('is parked only when out of the flow and named: what a control names, a dialog, a popover, or what is hidden from assistive technology', () => {
    const away = (extra: Partial<ReflowText>) => report(base, layout('narrow', 320, 800, { viewport: viewport(320, 800, hidden), texts: nav(336, extra) }));
    expect(away({ placed: 'absolute', controlled: true })).toEqual([]);
    expect(away({ placed: 'fixed', controlled: true })).toEqual([]);
    expect(away({ placed: 'moved', hiddenFromAT: true })).toEqual([]);
    // Out of the flow, named by nothing: likely. In the flow: lost.
    expect(away({ placed: 'absolute' })).toMatchObject([{ rule: 'reflow/content-lost', status: 'likely', flags: ['outOfFlow', 'rootOverflowHidden'] }]);
    expect(away({ controlled: true })).toMatchObject([{ rule: 'reflow/content-lost', status: 'fail', flags: ['rootOverflowHidden'] }]);
    // A disclosure control that appeared names nothing.
    expect(report(base, layout('narrow', 320, 800, { viewport: viewport(320, 800, hidden), texts: nav(336, { placed: 'absolute' }), disclosures: [99] }))).toMatchObject([{ status: 'likely' }]);
  });

  it('is parked to the left in a page laid out right to left, and text cut in part is still lost, named by the side measured', () => {
    const p10 = layout('narrow', 320, 800, { viewport: viewport(320, 800, { ...hidden, rtl: true }), texts: nav(-260, { placed: 'moved', controlled: true }) });
    expect(report(base, p10)).toEqual([]);
    const cut = layout('narrow', 320, 800, { viewport: viewport(320, 800, { ...hidden, rtl: true }), texts: nav(-100, { placed: 'moved', controlled: true }) });
    expect(report(base, cut)).toMatchObject([{ rule: 'reflow/content-lost', status: 'fail', flags: ['rootOverflowHidden'], values: { side: 'left' } }]);
  });
});

describe('decorative and moving content', () => {
  it('tests text hidden from assistive technology by paint order: real text under it by hidden ink only; under real text, as the covered one when in the flow, never when placed behind', () => {
    const base = layout('baseline', 1280, 720, { texts: [text(2, [2, 3], [[0, 100, 500, 24]]), text(4, [4, 5], [[900, 60, 300, 160]], { hiddenFromAT: true })] });
    const narrow = layout('narrow', 320, 800, { texts: [text(2, [2, 3], [[0, 100, 240, 24]]), text(4, [4, 5], [[20, 60, 280, 160]], { hiddenFromAT: true })] });
    const [pair] = reflowPixelPlan(base, narrow, settings);
    expect(pair).toMatchObject({ a: 2, b: 4, coverOnly: true });
    expect(reflowPixelRoles(pair!, 'b')).toEqual({ victim: 2, cover: 4, coverOnly: true, hidden: false });
    // Real text over it, in the flow: it is the covered one, and what is found is advisory at most.
    expect(reflowPixelRoles(pair!, 'a')).toEqual({ victim: 4, cover: 2, coverOnly: false, hidden: true });
    expect(report(base, { ...narrow, pixels: { [pair!.id]: { region: pair!.region, top: 'a', crops: null, reason: 'capture-failed' } } })).toMatchObject([{ status: 'advisory', key: 4, flags: ['geometryOnly', 'hiddenFromAT', 'notCaptured', 'textOnText'] }]);
    // Placed out of the flow under real text: decoration laid out behind it, nothing (decorative letters behind a heading).
    const behind = { ...narrow, texts: [narrow.texts[0]!, { ...narrow.texts[1]!, placed: 'absolute' as const }] };
    const [laid] = reflowPixelPlan(base, behind, settings);
    expect(laid).toMatchObject({ behind: true });
    expect(reflowPixelRoles(laid!, 'a')).toBeNull();
    expect(report(base, { ...behind, pixels: { [laid!.id]: { region: laid!.region, top: 'a', crops: null } } })).toEqual([]);
    // Two texts hidden from assistive technology, and glyphs of decoration: no candidate at all.
    const both = layout('narrow', 320, 800, { texts: [text(2, [2, 3], [[0, 100, 240, 24]], { hiddenFromAT: true }), text(4, [4, 5], [[20, 60, 280, 160]], { hiddenFromAT: true })] });
    expect(reflowPixelPlan(base, both, settings)).toEqual([]);
    const glyph = layout('narrow', 320, 800, { texts: [text(2, [2, 3], [[0, 100, 240, 24]]), text(4, [4, 5], [[20, 60, 280, 160]], { decorative: true })] });
    expect(reflowPixelPlan(base, glyph, settings)).toEqual([]);
  });

  it('caps what is found about text hidden from assistive technology at advisory, and leaves glyphs of decoration out (m1)', () => {
    const base = layout('baseline', 1280, 720, { texts: [text(4, [4, 5], [[300, 10, 300, 120]], { hiddenFromAT: true })] });
    const beyond = layout('narrow', 320, 800, { viewport: viewport(320, 800, { scrollWidth: 627 }), texts: [text(4, [4, 5], [[300, 10, 326, 120]], { hiddenFromAT: true })] });
    expect(report(base, beyond)).toMatchObject([{ rule: 'reflow/two-dimensional-scroll', status: 'advisory', flags: ['documentScrollsBothAxes', 'hiddenFromAT'] }]);
    const hero = clip(5, [0, 0, 320, 220], 'hidden', 'hidden');
    const cut = layout('narrow', 320, 800, { clips: [hero], chains: [[], [5]], texts: [text(4, [4, 5], [[160, 0, 330, 160]], { hiddenFromAT: true, chain: 1 })] });
    expect(report(base, cut)).toMatchObject([{ rule: 'reflow/content-lost', status: 'advisory', flags: ['clippedByAncestor', 'hiddenFromAT'] }]);
    const glyphs = (layoutOf: ReflowLayout): ReflowLayout => ({ ...layoutOf, texts: layoutOf.texts.map((item) => ({ ...item, hiddenFromAT: false, decorative: true })) });
    expect(report(glyphs(base), glyphs(beyond))).toEqual([]);
    expect(report(glyphs(base), glyphs(cut))).toEqual([]);
  });

  it('takes text that moves through its clip by itself (a ticker) for info at most, and a clip whose track moves too', () => {
    const base = layout('baseline', 1280, 720, { clips: [clip(5, [0, 0, 1280, 36], 'hidden', 'hidden')], chains: [[], [5]], texts: [text(6, [6, 7], [[16, 6, 900, 24]], { chain: 1, moving: true })] });
    const narrow = layout('narrow', 320, 800, { clips: [clip(5, [0, 0, 320, 36], 'hidden', 'hidden')], chains: [[], [5]], texts: [text(6, [6, 7], [[16, 6, 900, 24]], { chain: 1, moving: true })] });
    expect(report(base, narrow)).toMatchObject([{ rule: 'reflow/content-lost', status: 'info', flags: ['clippedByAncestor', 'moving'] }]);
    const still = (layoutOf: ReflowLayout): ReflowLayout => ({ ...layoutOf, texts: layoutOf.texts.map((item) => ({ ...item, moving: false })) });
    const track = { ...narrow, clips: [clip(5, [0, 0, 320, 36], 'hidden', 'hidden', { moving: true })] };
    expect(report(still(base), still(track))).toMatchObject([{ status: 'info', flags: ['clippedByAncestor', 'moving'] }]);
  });

  it('lowers an overlap the pixels confirm to likely only when something that moves by itself is where the two meet (d2, d3)', () => {
    const base = layout('baseline', 1280, 720, { texts: [text(2, [2, 3], [[0, 100, 500, 24]]), text(4, [4, 5], [[900, 100, 300, 24]])] });
    const narrow = layout('narrow', 320, 800, { texts: [text(2, [2, 3], [[0, 100, 240, 24]]), text(4, [4, 5], [[20, 100, 280, 24]])] });
    const [pair] = reflowPixelPlan(base, narrow, settings);
    const shot = (id: string, inks: [number, number, number, number][]): [string, Screenshot] => {
      const image = createImage(40, 20, { r: 255, g: 255, b: 255 });
      for (const [x, y, w, h] of inks) fillRect(image, { x, y, width: w, height: h }, { r: 0, g: 0, b: 0 });
      return [id, { box: { x: 0, y: 0, width: 20, height: 10 }, scale: 2, png: encodePng(image) }];
    };
    const v: [number, number, number, number] = [0, 0, 25, 20];
    const o: [number, number, number, number] = [15, 0, 25, 20];
    const clips = Object.fromEntries([shot('n', [v, o]), shot('vc', [o]), shot('cc', [v]), shot('bc', []), shot('ch', [v]), shot('chvc', [])]);
    const tested = { ...narrow, pixels: { [pair!.id]: { region: pair!.region, top: 'b' as const, crops: { normal: 'n', victimClear: 'vc', coverClear: 'cc', bothClear: 'bc', coverHidden: 'ch', coverHiddenVictimClear: 'chvc' } } } };
    // A spinner in a corner, a caret elsewhere: whatever they did while this was captured, nothing changes.
    expect(report(base, { ...tested, motion: 2, motionBoxes: [[300, 780, 8, 8], [40, 400, 2, 16]] }, clips)).toMatchObject([{ status: 'fail', flags: ['glyphsOverlap', 'pixelConfirmed', 'textOnText'] }]);
    // Something that moves where the two meet: the pixels may show a passing moment.
    expect(report(base, { ...tested, motionBoxes: [[100, 96, 40, 30]] }, clips)).toMatchObject([{ status: 'likely', flags: ['glyphsOverlap', 'pixelConfirmed', 'textOnText', 'unsettled'] }]);
  });
});

describe('modal layers and application shells', () => {
  const base = layout('baseline', 1280, 720, { texts: [text(2, [2, 3], [[16, 300, 600, 24]]), text(3, [3, 4], [[16, 400, 600, 24]])] });
  const lockedVp = viewport(800, 256, { overflowX: 'hidden', overflowY: 'hidden', scrollHeight: 600 });

  it('takes a layer over the whole viewport for one that stops the page only when the hit test finds it over the page (e5)', () => {
    const background: ReflowLayer = { key: 21, position: 'fixed', rect: [0, 0, 800, 256], painted: [[0, 0, 800, 256]], buttons: 0, controls: 0, behind: true };
    const short = layout('short', 800, 256, { viewport: lockedVp, texts: [text(2, [2, 3], [[16, 100, 600, 24]]), text(3, [3, 4], [[16, 400, 600, 24]])], scrolls: [{ x: 0, y: 0, layers: [background] }] });
    // A background behind the page (z-index: -1): it stops nothing and hides nothing.
    expect(report(base, short)).toMatchObject([{ rule: 'reflow/scroll-locked', status: 'fail', flags: [] }]);
    const over: ReflowLayer = { ...background, behind: false, covers: true };
    expect(report(base, { ...short, scrolls: [{ x: 0, y: 0, layers: [over] }] }).find((candidate) => candidate.rule === 'reflow/scroll-locked')).toMatchObject({ status: 'info', flags: ['fullScreenLayer', 'modalOpen'] });
  });

  it('takes the readable part of an application shell for the box of the scroller that holds the page, less what sticks over it (g5b)', () => {
    // A header and a footer of 104 px each in a flex column, not sticky, around a scroller 48 px tall.
    const scroller = clip(9, [0, 104, 800, 48], 'hidden', 'auto', { scroll: [800, 2000, 0, 0, 800, 48] });
    const shell = layout('short', 800, 256, { viewport: lockedVp, clips: [scroller], scrolls: [{ x: 0, y: 0, scroller: 9, layers: [] }, { x: 0, y: 900, scroller: 9, layers: [] }] });
    const tall = clip(9, [0, 104, 1280, 512], 'hidden', 'auto', { scroll: [1280, 2000, 0, 0, 1280, 512] });
    const baseShell = layout('baseline', 1280, 720, { viewport: viewport(1280, 720, { overflowY: 'hidden' }), clips: [tall], scrolls: [{ x: 0, y: 0, scroller: 9, layers: [] }] });
    expect(report(baseShell, shell)).toMatchObject([{ rule: 'reflow/sticky-obscures', status: 'likely', key: 9, flags: ['mainScroller', 'scrollerBox'], values: { readableShare: 0.19 } }]);
  });

  it('is info (modalOpen) when an open modal locks the page behind it', () => {
    const modal: ReflowLayer = { key: 20, position: 'fixed', rect: [200, 20, 400, 200], painted: [[200, 20, 400, 200]], buttons: 2, controls: 2, dialog: true, modal: true, dismissControl: true };
    const short = layout('short', 800, 256, { viewport: lockedVp, texts: [text(2, [2, 3], [[16, 100, 600, 24]]), text(3, [3, 4], [[16, 400, 600, 24]])], scrolls: [{ x: 0, y: 0, layers: [modal] }] });
    expect(report(base, short)).toMatchObject([{ rule: 'reflow/scroll-locked', status: 'info', flags: ['modalOpen'] }]);
    // Without the modal: a failure, as before.
    expect(report(base, { ...short, scrolls: [{ x: 0, y: 0, layers: [] }] })).toMatchObject([{ rule: 'reflow/scroll-locked', status: 'fail' }]);
  });

  it('counts a sticky footer stuck to the bottom from the start, and layers stuck inside the scroller of an application shell', () => {
    const header = (y: number) => ({ key: 4, position: 'sticky' as const, rect: [0, y, 800, 78] as ReflowRect, painted: [[0, y, 800, 78]] as ReflowRect[], buttons: 0, controls: 0, landmark: true });
    const footer = { key: 5, position: 'sticky' as const, rect: [0, 184, 800, 72] as ReflowRect, painted: [[0, 184, 800, 72]] as ReflowRect[], buttons: 0, controls: 0, landmark: true };
    const shell = layout('short', 800, 256, {
      viewport: lockedVp,
      scrolls: [
        { x: 0, y: 0, scroller: 9, layers: [header(0), footer] },
        { x: 0, y: 500, scroller: 9, layers: [header(0), footer] },
        { x: 0, y: 1000, scroller: 9, layers: [header(0), { ...footer, rect: [0, 150, 800, 72], painted: [[0, 150, 800, 72]] }] },
      ],
    });
    const [found] = report(layout('baseline', 1280, 720), shell);
    expect(found).toMatchObject({ rule: 'reflow/sticky-obscures', status: 'likely', values: { readableShare: 0.41, scrollY: 0 }, flags: ['mainScroller'] });
  });
});

describe('what a pass measured', () => {
  const base = layout('baseline', 1280, 720, { texts: [text(2, [2, 3], [[16, 100, 600, 24]])] });
  const failing = layout('narrow', 320, 800, { viewport: viewport(320, 800, { scrollWidth: 616 }), texts: [text(2, [2, 3], [[16, 100, 600, 24]])] });

  it('is info when the viewport is not the one asked for, and likely at most when the layout did not settle', () => {
    const elsewhere = report(base, { ...failing, viewport: { ...failing.viewport, width: 1280 } })[0];
    expect(elsewhere?.status).toBe('info');
    expect(elsewhere?.flags).toContain('viewportNotApplied');
    const moving = report(base, { ...failing, settled: false })[0];
    expect(moving?.status).toBe('likely');
    expect(moving?.flags).toContain('notSettled');
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

  it('says why the survey stopped, with nothing else to report, when the page went elsewhere before the baseline', () => {
    const stopped: Snapshot = { ...snapshot, reflow: { baseline: null, passes: [], skipped: [], names: {}, original: { width: 1280, height: 720 }, stopped: { reason: 'navigated', detail: 'Inspected target navigated or closed' } } };
    const findings = runChecks(stopped, resolveConfig({ checks: ['reflow'] }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'reflow/survey', status: 'info', evidence: { values: { stopped: 'navigated' }, flags: ['stopped'] } });
    expect(findings[0]?.message).toContain('went to another document');
  });

  it('names the physical side measured: the left edge of a page laid out right to left', () => {
    const rtlBase = layout('baseline', 1280, 720, { texts: [text(2, [2, 3], [[600, 100, 600, 24]])] });
    const rtlPass = layout('narrow', 320, 800, { viewport: viewport(320, 800, { rtl: true, overflowX: 'hidden', overflowY: 'auto' }), texts: [text(2, [2, 3], [[-280, 100, 584, 24]])] });
    const findings = runChecks({ ...snapshot, reflow: { ...survey, baseline: rtlBase, passes: [rtlPass], names: { '2': { selector: '#rtl', frame: '' } } } }, resolveConfig({ checks: ['reflow'] }));
    const lost = findings.find((finding) => finding.rule === 'reflow/content-lost');
    expect(lost?.status).toBe('fail');
    expect(lost?.message).toContain('beyond the left edge');
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
