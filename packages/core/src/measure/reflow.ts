import { diffMask } from './diff.js';
import { decodePng } from './image.js';
import type { Mask } from './image.js';
import type { Screenshot, Status, WcagRef } from '../types.js';
import type {
  ReflowBox,
  ReflowClipBox,
  ReflowConfig,
  ReflowExceptKind,
  ReflowLayer,
  ReflowLayout,
  ReflowOverflow,
  ReflowPassName,
  ReflowPixelTest,
  ReflowRect,
  ReflowScrollState,
  ReflowSurvey,
  ReflowText,
  ReflowViewport,
} from '../reflow-types.js';

/**
 * The reflow check (1.4.10), on the layouts the collector measured: the page at the viewport the
 * caller gave it (`baseline`) and at the viewports of the passes. Pure: same layouts, same
 * captures and same settings give the same candidates.
 *
 * A problem that exists identically at the baseline is not a reflow problem, and is not reported
 * above `info`: every rule compares the element (by its key, which is the same element in every
 * layout of one scan) with what it was at the baseline.
 */

export const REFLOW_SC: WcagRef = { sc: '1.4.10', level: 'AA' };

export const REFLOW_RULES = {
  twoDimensional: 'reflow/two-dimensional-scroll',
  lost: 'reflow/content-lost',
  overlap: 'reflow/text-overlap',
  sticky: 'reflow/sticky-obscures',
  locked: 'reflow/scroll-locked',
  double: 'reflow/double-scrollbar',
  survey: 'reflow/survey',
} as const;

export type ReflowRule = (typeof REFLOW_RULES)[Exclude<keyof typeof REFLOW_RULES, 'survey'>];

/** What an evidence capture shows: the viewport at a scroll position, or a region of the page (scrolled into view). */
export type ReflowCaptureRequest = { kind: 'viewport'; x: number; y: number } | { kind: 'region'; region: ReflowRect } | { kind: 'pixel' };

export interface ReflowCandidate {
  /** Names the candidate within its pass, whatever its selector: the key of its capture in `ReflowLayout.captures`. */
  id: string;
  rule: ReflowRule;
  pass: ReflowPassName;
  status: Status;
  /** Key of the element the finding is about (0: the document). */
  key: number;
  /** Other elements the evidence names, by role. */
  related: { role: string; key: number }[];
  box: ReflowRect | null;
  flags: string[];
  values: Record<string, string | number | boolean>;
  capture: ReflowCaptureRequest | null;
  /** Start of the text concerned, for the message. */
  sample: string;
}

/** A pair of a text and what may make it unreadable, for a test by pixels. */
export interface ReflowPixelCandidate {
  id: string;
  /** The text: always a text item. */
  a: number;
  /** The other: a text item (`text`) or a box that paints (`box`). */
  b: number;
  kind: 'text' | 'box';
  /** Where the two meet, page coordinates; what the captures show. */
  region: ReflowRect;
  /** Share of the smaller middle band of a line that the other covers. */
  share: number;
}

/** What the captures of a pixel test show (device pixels). */
export interface ReflowInk {
  /** Ink of the covered text as the page is: what making it transparent changes. */
  victim: number;
  /** Ink of the covered text alone, the other text transparent (with the other hidden, when it is no text). */
  alone: number;
  /** Ink of the other text alone, the covered one transparent; null when the other is not text. */
  cover: number | null;
  /** Pixels that each text alone paints. */
  both: number;
  /** Ink of the covered text with the other hidden. */
  revealed: number;
  /** Share of that ink missing as the page is: hidden under the other. */
  coveredShare: number;
}

export interface ReflowPassReport {
  candidates: ReflowCandidate[];
  /** Candidates left out at `maxFindingsPerRule`, by rule. */
  omitted: Record<string, number>;
  /** Overlap candidates that the pixels showed to be readable. */
  clearedByPixels: number;
  /** Overlap candidates by geometry, before the pixels. */
  overlapCandidates: number;
}

type R = ReflowRect;
const right = (r: R): number => r[0] + r[2];
const bottom = (r: R): number => r[1] + r[3];
const area = (r: R): number => r[2] * r[3];
const round = (value: number): number => Math.round(value * 100) / 100;
const roundRect = (r: R): R => [round(r[0]), round(r[1]), round(r[2]), round(r[3])];

export function intersectRects(a: R, b: R): R | null {
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  const w = Math.min(right(a), right(b)) - x;
  const h = Math.min(bottom(a), bottom(b)) - y;
  return w > 0 && h > 0 ? [x, y, w, h] : null;
}

function unionRect(a: R, b: R): R {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return [x, y, Math.max(right(a), right(b)) - x, Math.max(bottom(a), bottom(b)) - y];
}

function clampX(r: R, min: number, max: number): R | null {
  const x0 = Math.max(r[0], min);
  const x1 = Math.min(right(r), max);
  return x1 > x0 ? [x0, r[1], x1 - x0, r[3]] : null;
}

function clampY(r: R, min: number, max: number): R | null {
  const y0 = Math.max(r[1], min);
  const y1 = Math.min(bottom(r), max);
  return y1 > y0 ? [r[0], y0, r[2], y1 - y0] : null;
}

/** Area of the union of rectangles, exactly (coordinate compression). */
export function unionArea(rects: R[]): number {
  const boxes = rects.filter((r) => r[2] > 0 && r[3] > 0);
  if (boxes.length === 0) return 0;
  const xs = [...new Set(boxes.flatMap((r) => [r[0], right(r)]))].sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const x0 = xs[i]!;
    const x1 = xs[i + 1]!;
    const spans = boxes
      .filter((r) => r[0] <= x0 && right(r) >= x1)
      .map((r) => [r[1], bottom(r)] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let start = -Infinity;
    let end = -Infinity;
    for (const [s, e] of spans) {
      if (s > end) {
        if (end > start) covered += end - start;
        start = s;
        end = e;
      } else if (e > end) end = e;
    }
    if (end > start) covered += end - start;
    total += covered * (x1 - x0);
  }
  return total;
}

/** A holds B in the walk of one layout. */
function holds(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[0] && b[1] <= a[1];
}

/** The user can scroll the viewport on this axis. */
export function userScrollable(mode: ReflowOverflow): boolean {
  return mode !== 'hidden' && mode !== 'clip';
}

function clipsFor(mode: ReflowOverflow, which: 'all' | 'cut'): boolean {
  return which === 'all' ? mode !== 'visible' : mode === 'hidden' || mode === 'clip';
}

/** The layout of a pass, with what the rules ask of it worked out once. */
class Layout {
  readonly clipByKey = new Map<number, ReflowClipBox>();
  readonly textByKey = new Map<number, ReflowText>();
  readonly boxByKey = new Map<number, ReflowBox>();
  readonly fixedLayers = new Set<number>();
  constructor(
    readonly data: ReflowLayout,
    readonly config: ReflowConfig,
  ) {
    for (const clip of data.clips) this.clipByKey.set(clip.key, clip);
    for (const text of data.texts) this.textByKey.set(text.key, text);
    for (const box of data.boxes) this.boxByKey.set(box.key, box);
    for (const state of data.scrolls) for (const layer of state.layers) if (layer.position === 'fixed') this.fixedLayers.add(layer.key);
  }

  get viewport(): ReflowViewport {
    return this.data.viewport;
  }

  chain(index: number): ReflowClipBox[] {
    return (this.data.chains[index] ?? []).flatMap((key) => {
      const clip = this.clipByKey.get(key);
      return clip ? [clip] : [];
    });
  }

  /** What is shown of a rectangle through its clipping ancestors: all of them (`all`), or only those that do not scroll (`cut`). */
  through(rect: R, chain: number, which: 'all' | 'cut'): { rect: R | null; by: number | null; axis: 'x' | 'y' | null } {
    let current: R | null = rect;
    let by: number | null = null;
    let axis: 'x' | 'y' | null = null;
    for (const clip of this.chain(chain)) {
      if (!current) break;
      const before: R = current;
      if (clipsFor(clip.x, which)) current = clampX(current, clip.rect[0], right(clip.rect));
      const afterX = current;
      if (current && clipsFor(clip.y, which)) current = clampY(current, clip.rect[1], bottom(clip.rect));
      if (by === null && (!current || current[2] < before[2] - 0.01 || current[3] < before[3] - 0.01)) {
        by = clip.key;
        axis = !afterX || afterX[2] < before[2] - 0.01 ? 'x' : 'y';
      }
    }
    return { rect: current, by, axis };
  }

  /** The reach of the document: where the window can be scrolled to show content, in page coordinates. */
  reach(axis: 'x' | 'y'): [number, number] {
    const vp = this.viewport;
    if (axis === 'y') return [0, userScrollable(vp.overflowY) ? Infinity : vp.clientHeight];
    if (!userScrollable(vp.overflowX)) return [0, vp.clientWidth];
    return vp.rtl ? [-Infinity, vp.clientWidth] : [0, Infinity];
  }

  inFixed(layer: number | undefined): boolean {
    return layer !== undefined && this.fixedLayers.has(layer);
  }
}

/** Why part of a line is not shown: a clipping ancestor (its key), the root that does not scroll horizontally or vertically, the start edge of the document, or a fixed layer that reaches beyond the viewport. */
type LostBy = number | 'rootX' | 'rootY' | 'edge' | 'fixed';

interface LineLoss {
  lost: boolean;
  by: LostBy | null;
  /** Part of the line still shown, or null. */
  shown: R | null;
}

function isLost(line: R, shown: R | null, fontSize: number, config: ReflowConfig): boolean {
  if (!shown) return true;
  return line[2] - shown[2] >= config.lostMinEm * fontSize || line[3] - shown[3] >= config.lostMinLineShare * line[3];
}

/** What becomes of one rectangle of a text or a control: clipped, cut at the edge, beyond what the root lets scroll. */
function lossOf(layout: Layout, rect: R, chain: number, layer: number | undefined, fontSize: number, share?: number): LineLoss {
  const config = layout.config;
  const lost = (shown: R | null): boolean => (share === undefined ? isLost(rect, shown, fontSize, config) : !shown || 1 - area(shown) / Math.max(area(rect), 0.0001) >= share);
  const clipped = layout.through(rect, chain, 'cut');
  if (lost(clipped.rect)) {
    // A body that clips is the viewport that does not scroll, as overflow on the root is.
    const body = clipped.by !== null && layout.clipByKey.get(clipped.by)?.tag === 'body';
    return { lost: true, by: body ? (clipped.axis === 'x' ? 'rootX' : 'rootY') : clipped.by, shown: clipped.rect };
  }
  let shown = clipped.rect!;
  const vp = layout.viewport;
  if (layout.inFixed(layer)) {
    const kept = clampY(clampX(shown, 0, vp.clientWidth) ?? [0, 0, 0, 0], 0, vp.clientHeight);
    if (lost(kept)) return { lost: true, by: 'fixed', shown: kept };
    return { lost: false, by: null, shown: kept };
  }
  const minX = vp.rtl ? -Infinity : 0;
  const edge = clampY(clampX(shown, minX, Infinity) ?? [0, 0, 0, 0], 0, Infinity);
  if (lost(edge)) return { lost: true, by: 'edge', shown: edge };
  shown = edge!;
  const [, maxX] = layout.reach('x');
  const inX = clampX(shown, minX, maxX);
  if (lost(inX)) return { lost: true, by: 'rootX', shown: inX };
  shown = inX!;
  const [, maxY] = layout.reach('y');
  const inY = clampY(shown, 0, maxY);
  if (lost(inY)) return { lost: true, by: 'rootY', shown: inY };
  return { lost: false, by: null, shown: inY };
}

interface ItemLoss {
  lines: number;
  by: LostBy | null;
  firstLine: R | null;
}

function textLoss(layout: Layout, text: ReflowText): ItemLoss {
  let lines = 0;
  let by: LostBy | null = null;
  let firstLine: R | null = null;
  for (const line of text.lines) {
    const loss = lossOf(layout, line, text.chain, text.layer, text.fontSize);
    if (!loss.lost) continue;
    lines++;
    if (by === null) {
      by = loss.by;
      firstLine = line;
    }
  }
  return { lines, by, firstLine };
}

function controlLoss(layout: Layout, box: ReflowBox): LineLoss {
  return lossOf(layout, box.rect, box.chain, box.layer, 0, layout.config.controlLostMinShare);
}

/** The page is laid out to scroll horizontally: at the baseline it scrolls on that axis and not vertically. */
export function horizontalLayout(baseline: ReflowLayout, config: ReflowConfig): boolean {
  const vp = baseline.viewport;
  const tolerance = config.scrollToleranceCssPx;
  return userScrollable(vp.overflowX) && vp.scrollWidth > vp.clientWidth + tolerance && vp.scrollHeight <= vp.clientHeight + tolerance;
}

/** The axis on which content beyond the viewport needs a second direction of scrolling, for a pass; null when the rule does not apply. */
export function beyondAxisOf(pass: ReflowPassName, baseline: ReflowLayout, config: ReflowConfig): 'x' | 'y' | null {
  const horizontal = horizontalLayout(baseline, config);
  if (pass === 'narrow') return horizontal ? null : 'x';
  if (pass === 'short') return horizontal ? 'y' : null;
  return 'x';
}

/** How far a rectangle reaches beyond the viewport edge on an axis (0 when it does not). */
function beyondBy(layout: Layout, rect: R, axis: 'x' | 'y'): number {
  const vp = layout.viewport;
  const tolerance = layout.config.toleranceCssPx;
  if (axis === 'y') return Math.max(0, bottom(rect) - vp.clientHeight - tolerance);
  if (vp.rtl) return Math.max(0, -rect[0] - tolerance);
  return Math.max(0, right(rect) - vp.clientWidth - tolerance);
}

interface BeyondItem {
  key: number;
  span: [number, number];
  kind: 'text' | 'control' | ReflowExceptKind;
  lines: number;
  reach: number;
  first: R;
  sample: string;
}

/** Texts, controls and excepted content that lie beyond the edge on `axis` and that scrolling the document reaches. */
function beyondItems(layout: Layout, axis: 'x' | 'y'): BeyondItem[] {
  const config = layout.config;
  const out: BeyondItem[] = [];
  for (const text of layout.data.texts) {
    if (text.layer !== undefined || text.transformed) continue;
    let lines = 0;
    let reach = 0;
    let first: R | null = null;
    for (const line of text.lines) {
      const shown = layout.through(line, text.chain, 'all').rect;
      if (!shown) continue;
      const by = beyondBy(layout, shown, axis);
      if (by < config.beyondMinEm * text.fontSize || by <= 0) continue;
      lines++;
      reach = Math.max(reach, by);
      first ??= shown;
    }
    if (lines > 0 && first) out.push({ key: text.key, span: text.span, kind: text.except ?? 'text', lines, reach, first, sample: text.sample });
  }
  for (const box of layout.data.boxes) {
    if (box.kind === 'box' || box.layer !== undefined || box.transformed) continue;
    const shown = layout.through(box.rect, box.chain, 'all').rect;
    if (!shown) continue;
    const by = beyondBy(layout, shown, axis);
    const extent = axis === 'x' ? shown[2] : shown[3];
    if (by <= 0) continue;
    if (box.kind === 'control' && by < config.controlBeyondMinShare * extent) continue;
    out.push({ key: box.key, span: box.span, kind: box.kind === 'control' ? 'control' : box.kind, lines: 1, reach: by, first: shown, sample: '' });
  }
  return out;
}

/** The outermost element beyond the edge that holds the item: what pushes it out. The item itself when none does. */
function causeOf(layout: Layout, item: { key: number; span: [number, number] }): number {
  let cause: { key: number; span: [number, number] } | null = null;
  for (const wide of layout.data.beyond) {
    if (wide.tag === 'html' || !holds(wide.span, item.span)) continue;
    if (!cause || holds(wide.span, cause.span)) cause = wide;
  }
  return cause?.key ?? item.key;
}

function rectOfKey(layout: Layout, key: number): R | null {
  return (
    layout.data.beyond.find((wide) => wide.key === key)?.rect ??
    layout.clipByKey.get(key)?.rect ??
    layout.boxByKey.get(key)?.rect ??
    (() => {
      const text = layout.textByKey.get(key);
      return text && text.lines.length > 0 ? text.lines.reduce(unionRect) : null;
    })()
  );
}

function viewportValue(layout: Layout): string {
  return `${layout.data.requested.width}x${layout.data.requested.height}`;
}

/** Values every finding of a pass carries: the viewport asked for and the one measured. */
function passValues(layout: Layout): Record<string, string | number | boolean> {
  const vp = layout.viewport;
  return {
    pass: layout.data.pass,
    viewport: viewportValue(layout),
    innerWidth: vp.width,
    innerHeight: vp.height,
    clientWidth: vp.clientWidth,
    clientHeight: vp.clientHeight,
    scrollWidth: vp.scrollWidth,
    scrollHeight: vp.scrollHeight,
  };
}

function candidateId(rule: string, pass: ReflowPassName, key: number, other = 0): string {
  return `${rule}|${pass}|${key}|${other}`;
}

/** Rule 1: the document needs scrolling in the second direction to reach text or controls; and inner scrollers whose lines do not fit. */
function twoDimensional(base: Layout, layout: Layout): ReflowCandidate[] {
  const config = layout.config;
  const axis = layout.data.beyondAxis;
  if (!axis) return [];
  const vp = layout.viewport;
  const out: ReflowCandidate[] = [];
  const overflow = axis === 'x' ? vp.scrollWidth - vp.clientWidth : vp.scrollHeight - vp.clientHeight;
  const scrollable = userScrollable(axis === 'x' ? vp.overflowX : vp.overflowY);
  if (overflow > config.toleranceCssPx && scrollable) {
    const atBaseline = new Set(beyondItems(base, axis).map((item) => item.key));
    const groups = new Map<number, BeyondItem[]>();
    for (const item of beyondItems(layout, axis)) {
      const cause = causeOf(layout, item);
      groups.set(cause, [...(groups.get(cause) ?? []), item]);
    }
    const bothAxes = axis === 'x' ? vp.scrollHeight - vp.clientHeight > config.scrollToleranceCssPx && userScrollable(vp.overflowY) : true;
    for (const [cause, items] of groups) {
      const running = items.filter((item) => item.kind === 'text' || item.kind === 'control');
      const fresh = running.filter((item) => !atBaseline.has(item.key));
      const excepted = [...new Set(items.filter((item) => item.kind !== 'text' && item.kind !== 'control').map((item) => item.kind))].sort();
      const flags: string[] = [];
      let status: Status;
      if (fresh.length > 0) status = 'fail';
      else {
        status = 'info';
        flags.push(running.length > 0 ? 'atBaseline' : 'exceptedOnly');
      }
      if (excepted.length > 0) flags.push('excepted');
      if (bothAxes) flags.push('documentScrollsBothAxes');
      const first = (fresh[0] ?? running[0] ?? items[0])!;
      const lines = running.filter((item) => item.kind === 'text').reduce((sum, item) => sum + item.lines, 0);
      const controls = running.filter((item) => item.kind === 'control').length;
      out.push({
        id: candidateId(REFLOW_RULES.twoDimensional, layout.data.pass, cause),
        rule: REFLOW_RULES.twoDimensional,
        pass: layout.data.pass,
        status,
        key: cause,
        related: first.key !== cause ? [{ role: 'firstBeyond', key: first.key }] : [],
        box: rectOfKey(layout, cause),
        flags: flags.sort(),
        values: {
          ...passValues(layout),
          axis,
          overflowCssPx: round(overflow),
          linesBeyond: lines,
          controlsBeyond: controls,
          reachBeyondCssPx: round(Math.max(...items.map((item) => item.reach))),
          ...(excepted.length > 0 ? { exceptedKinds: excepted.join(' ') } : {}),
        },
        capture: { kind: 'viewport', x: 0, y: Math.max(0, Math.floor((axis === 'x' ? first.first[1] : 0) - config.clipMarginCssPx)) },
        sample: first.sample,
      });
    }
  }
  // Inner scrollers whose lines of running text are wider than what they show.
  if (axis === 'x') {
    const innerAtBaseline = new Set(innerScrollers(base).map((entry) => entry.clip.key));
    for (const { clip, lines, first } of innerScrollers(layout)) {
      const identical = innerAtBaseline.has(clip.key);
      out.push({
        id: candidateId(REFLOW_RULES.twoDimensional, layout.data.pass, clip.key),
        rule: REFLOW_RULES.twoDimensional,
        pass: layout.data.pass,
        status: identical ? 'info' : 'likely',
        key: clip.key,
        related: [{ role: 'firstLine', key: first.key }],
        box: roundRect(clip.rect),
        flags: identical ? ['atBaseline', 'innerScroller'] : ['innerScroller'],
        values: { ...passValues(layout), scrollerClientWidth: clip.scroll[4], scrollerScrollWidth: clip.scroll[0], linesWiderThanScroller: lines },
        capture: { kind: 'region', region: clip.rect },
        sample: first.sample,
      });
    }
  }
  return out;
}

function innerScrollers(layout: Layout): { clip: ReflowClipBox; lines: number; first: ReflowText }[] {
  const config = layout.config;
  const out: { clip: ReflowClipBox; lines: number; first: ReflowText }[] = [];
  for (const clip of layout.data.clips) {
    if (clip.x !== 'auto' && clip.x !== 'scroll') continue;
    if (clip.scroll[0] - clip.scroll[4] <= config.scrollToleranceCssPx) continue;
    if (clip.except || clip.holdsTable || clip.carousel || clip.frame || clip.layer !== undefined || ['pre', 'code', 'textarea', 'select'].includes(clip.tag)) continue;
    let lines = 0;
    let first: ReflowText | null = null;
    for (const text of layout.data.texts) {
      if (text.except || text.transformed || !(layout.data.chains[text.chain] ?? []).includes(clip.key)) continue;
      const wide = text.lines.filter((line) => line[2] > clip.scroll[4] + config.toleranceCssPx + config.beyondMinEm * text.fontSize).length;
      if (wide === 0) continue;
      lines += wide;
      first ??= text;
    }
    if (lines > 0 && first) out.push({ clip, lines, first });
  }
  return out;
}

/** Rule 2: text and controls shown at the baseline that a pass cuts off; text no longer displayed. */
function contentLost(base: Layout, layout: Layout): ReflowCandidate[] {
  const config = layout.config;
  interface Lost {
    key: number;
    lines: number;
    chars: number;
    first: R | null;
    sample: string;
    control: boolean;
  }
  const groups = new Map<string, { by: LostBy; items: Lost[] }>();
  const add = (by: LostBy, item: Lost): void => {
    const id = String(by);
    const group = groups.get(id) ?? { by, items: [] };
    group.items.push(item);
    groups.set(id, group);
  };
  for (const text of layout.data.texts) {
    if (text.transformed) continue;
    const loss = textLoss(layout, text);
    if (loss.lines === 0 || loss.by === null || loss.by === 'rootY') continue;
    const before = base.textByKey.get(text.key);
    if (!before || before.transformed || textLoss(base, before).lines > 0) continue;
    add(loss.by, { key: text.key, lines: loss.lines, chars: Math.round((text.chars * loss.lines) / Math.max(1, text.lines.length)), first: loss.firstLine, sample: text.sample, control: false });
  }
  for (const box of layout.data.boxes) {
    if (box.kind !== 'control' || box.transformed) continue;
    const loss = controlLoss(layout, box);
    if (!loss.lost || loss.by === null || loss.by === 'rootY') continue;
    const before = base.boxByKey.get(box.key);
    if (!before || before.transformed || controlLoss(base, before).lost) continue;
    add(loss.by, { key: box.key, lines: 0, chars: 0, first: box.rect, sample: '', control: true });
  }
  // Clipping elements that already cut text at the baseline: a viewport by design (a carousel, a ticker).
  const cutAtBaseline = new Set<number>();
  for (const text of base.data.texts) {
    const loss = textLoss(base, text);
    if (loss.lines > 0 && typeof loss.by === 'number') cutAtBaseline.add(loss.by);
  }
  const out: ReflowCandidate[] = [];
  for (const { by, items } of groups.values()) {
    const first = items[0]!;
    const flags: string[] = [];
    let status: Status = 'fail';
    let key: number;
    let box: R | null;
    if (typeof by === 'number') {
      const clip = layout.clipByKey.get(by);
      key = by;
      box = clip ? roundRect(clip.rect) : null;
      if (clip?.truncates) {
        status = 'advisory';
        flags.push(clip.truncates === 'ellipsis' ? 'ellipsis' : 'lineClamp');
      } else if (cutAtBaseline.has(by)) {
        status = 'info';
        flags.push('clipsAtBaseline');
      } else if (clip?.carousel) {
        status = 'info';
        flags.push('carousel');
      } else if (clip?.revealControl) {
        status = 'likely';
        flags.push('revealControl');
      }
      flags.push('clippedByAncestor');
    } else if (by === 'rootX') {
      key = causeOf(layout, { key: first.key, span: (layout.textByKey.get(first.key) ?? layout.boxByKey.get(first.key))!.span });
      box = rectOfKey(layout, key);
      flags.push('rootOverflowHidden');
    } else if (by === 'fixed') {
      key = (layout.textByKey.get(first.key) ?? layout.boxByKey.get(first.key))?.layer ?? first.key;
      box = rectOfKey(layout, key);
      flags.push('fixedBeyondViewport');
    } else {
      key = first.key;
      box = rectOfKey(layout, key);
      flags.push('beforeStartEdge');
    }
    if (items.some((item) => item.control)) flags.push('control');
    const lines = items.reduce((sum, item) => sum + item.lines, 0);
    const chars = items.reduce((sum, item) => sum + item.chars, 0);
    const firstLine = items.find((item) => item.first)?.first ?? null;
    out.push({
      id: candidateId(REFLOW_RULES.lost, layout.data.pass, key),
      rule: REFLOW_RULES.lost,
      pass: layout.data.pass,
      status,
      key,
      related: first.key !== key ? [{ role: 'firstCut', key: first.key }] : [],
      box: box ? roundRect(box) : null,
      flags: flags.sort(),
      values: {
        ...passValues(layout),
        linesCut: lines,
        approxCharsCut: chars,
        textsCut: items.filter((item) => !item.control).length,
        controlsCut: items.filter((item) => item.control).length,
      },
      capture: by === 'rootX' || by === 'fixed' || by === 'edge' || !box ? { kind: 'viewport', x: 0, y: Math.max(0, Math.floor((firstLine?.[1] ?? 0) - config.clipMarginCssPx)) } : { kind: 'region', region: box },
      sample: first.sample,
    });
  }
  // Text displayed at the baseline that a pass does not display at all.
  const shown = new Set(layout.data.texts.map((text) => text.key));
  const missing = base.data.texts.filter((text) => !shown.has(text.key) && text.layer === undefined && textLoss(base, text).lines === 0);
  const hiddenChars = missing.reduce((sum, text) => sum + text.chars, 0);
  const before = new Set(base.data.disclosures);
  const newDisclosure = layout.data.disclosures.some((key) => !before.has(key));
  if (hiddenChars >= config.hiddenTextMinChars && !newDisclosure && missing.length > 0) {
    out.push({
      id: candidateId(REFLOW_RULES.lost, layout.data.pass, 0, -1),
      rule: REFLOW_RULES.lost,
      pass: layout.data.pass,
      status: 'info',
      key: missing[0]!.key,
      related: [],
      box: null,
      flags: ['notDisplayed'],
      values: { ...passValues(layout), textsNotDisplayed: missing.length, charsNotDisplayed: hiddenChars },
      capture: null,
      sample: missing[0]!.sample,
    });
  }
  return out;
}

/** The middle band of a line: where glyphs of two lines that touch at their edges do not meet. */
function core(line: R, inset: number): R {
  return [line[0], line[1] + line[3] * inset, line[2], line[3] * (1 - 2 * inset)];
}

interface Shown {
  key: number;
  span: [number, number];
  rects: R[];
  item: ReflowText | ReflowBox;
}

function shownTexts(layout: Layout): Shown[] {
  const inset = layout.config.overlapCoreInset;
  return layout.data.texts.flatMap((text) => {
    if (text.transformed || text.popup) return [];
    const rects = text.lines.flatMap((line) => {
      const shown = layout.through(line, text.chain, 'all').rect;
      return shown ? [core(shown, inset)] : [];
    });
    return rects.length > 0 ? [{ key: text.key, span: text.span, rects, item: text }] : [];
  });
}

function shownBoxes(layout: Layout): Shown[] {
  return layout.data.boxes.flatMap((box) => {
    if (!box.paints || box.transformed || box.popup) return [];
    const shown = layout.through(box.rect, box.chain, 'all').rect;
    return shown ? [{ key: box.key, span: box.span, rects: [shown], item: box }] : [];
  });
}

/** Grid of buckets over rectangles, for pairs that meet. */
function buckets(items: Shown[], size: number): Map<string, number[]> {
  const grid = new Map<string, number[]>();
  items.forEach((item, index) => {
    const seen = new Set<string>();
    for (const rect of item.rects) {
      for (let gx = Math.floor(rect[0] / size); gx <= Math.floor(right(rect) / size); gx++) {
        for (let gy = Math.floor(rect[1] / size); gy <= Math.floor(bottom(rect) / size); gy++) {
          const id = `${gx},${gy}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const list = grid.get(id) ?? [];
          list.push(index);
          grid.set(id, list);
        }
      }
    }
  });
  return grid;
}

function sameLayer(a: ReflowText | ReflowBox, b: ReflowText | ReflowBox): boolean {
  return a.layer === b.layer;
}

/** How much two sets of rectangles meet: the largest share of the smaller rectangle, and the region of all that meets. */
function meeting(a: R[], b: R[], config: ReflowConfig, against: 'smaller' | 'first'): { share: number; region: R | null } {
  let share = 0;
  let region: R | null = null;
  for (const ra of a) {
    for (const rb of b) {
      const inter = intersectRects(ra, rb);
      if (!inter || inter[2] < config.overlapMinCssPx || inter[3] < config.overlapMinCssPx) continue;
      const denominator = against === 'first' ? area(ra) : Math.min(area(ra), area(rb));
      share = Math.max(share, area(inter) / Math.max(denominator, 0.0001));
      region = region ? unionRect(region, inter) : inter;
    }
  }
  return { share, region };
}

/** Pairs that meet, by geometry, in a layout: text on text, and text under a box that paints. */
function overlapPairs(layout: Layout): { a: Shown; b: Shown; kind: 'text' | 'box'; share: number; region: R }[] {
  const config = layout.config;
  const texts = shownTexts(layout);
  const boxes = shownBoxes(layout);
  const all = [...texts, ...boxes];
  const grid = buckets(all, 128);
  const seen = new Set<string>();
  const out: { a: Shown; b: Shown; kind: 'text' | 'box'; share: number; region: R }[] = [];
  for (const list of grid.values()) {
    for (const i of list) {
      if (i >= texts.length) continue;
      for (const j of list) {
        if (j === i || (j < texts.length && j < i)) continue;
        const id = `${i},${j}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const a = all[i]!;
        const b = all[j]!;
        if (holds(a.span, b.span) || holds(b.span, a.span) || !sameLayer(a.item, b.item)) continue;
        const kind = j < texts.length ? 'text' : 'box';
        if (kind === 'text' && (a.item as ReflowText).ruby !== undefined && (a.item as ReflowText).ruby === (b.item as ReflowText).ruby) continue;
        const { share, region } = meeting(a.rects, b.rects, config, kind === 'text' ? 'smaller' : 'first');
        if (region && share >= config.overlapMinShare) out.push({ a, b, kind, share, region });
      }
    }
  }
  return out.sort((x, y) => x.a.span[0] - y.a.span[0] || x.b.span[0] - y.b.span[0]);
}

function pairMet(layout: Layout, a: number, b: number): boolean {
  const config = layout.config;
  const text = (key: number): R[] | null => {
    const item = layout.textByKey.get(key);
    if (!item) return null;
    return item.lines.flatMap((line) => {
      const shown = layout.through(line, item.chain, 'all').rect;
      return shown ? [core(shown, config.overlapCoreInset)] : [];
    });
  };
  const ra = text(a);
  const rb = text(b) ?? (() => {
    const box = layout.boxByKey.get(b);
    const shown = box ? layout.through(box.rect, box.chain, 'all').rect : null;
    return shown ? [shown] : null;
  })();
  if (!ra || !rb) return false;
  return ra.some((x) => rb.some((y) => intersectRects(x, y) !== null));
}

/** Overlap candidates of a pass that did not exist at the baseline: what is tested by pixels. */
export function reflowPixelPlan(baseline: ReflowLayout, pass: ReflowLayout, config: ReflowConfig): ReflowPixelCandidate[] {
  const base = new Layout(baseline, config);
  const layout = new Layout(pass, config);
  const out: ReflowPixelCandidate[] = [];
  for (const pair of overlapPairs(layout)) {
    const aBefore = base.textByKey.has(pair.a.key);
    const bBefore = pair.kind === 'text' ? base.textByKey.has(pair.b.key) : base.boxByKey.has(pair.b.key);
    // The text made unreadable is content of the page at the baseline.
    if (pair.kind === 'box' ? !aBefore : !aBefore && !bBefore) continue;
    if (pairMet(base, pair.a.key, pair.b.key)) continue;
    out.push({ id: candidateId(REFLOW_RULES.overlap, pass.pass, pair.a.key, pair.b.key), a: pair.a.key, b: pair.b.key, kind: pair.kind, region: roundRect(pair.region), share: round(pair.share) });
  }
  return out;
}

function count(mask: Mask): number {
  let total = 0;
  for (const value of mask.data) total += value;
  return total;
}

/** What the captures of a pixel test show. Null when a capture is missing or the sizes differ. */
export function reflowInk(test: ReflowPixelTest, clips: Record<string, Screenshot>, config: ReflowConfig): ReflowInk | null {
  const crops = test.crops;
  if (!crops) return null;
  const read = (id: string | null) => (id ? clips[id] : undefined);
  const normal = read(crops.normal);
  const victimClear = read(crops.victimClear);
  const coverHidden = read(crops.coverHidden);
  const coverHiddenVictimClear = read(crops.coverHiddenVictimClear);
  if (!normal || !victimClear || !coverHidden || !coverHiddenVictimClear) return null;
  try {
    const images = [normal, victimClear, coverHidden, coverHiddenVictimClear].map((clip) => decodePng(clip.png));
    const [n, vc, ch, chvc] = images as [ReturnType<typeof decodePng>, ReturnType<typeof decodePng>, ReturnType<typeof decodePng>, ReturnType<typeof decodePng>];
    if (images.some((image) => image.width !== n.width || image.height !== n.height)) return null;
    const victimMask = diffMask(n, vc, config.inkDeltaE);
    const revealedMask = diffMask(ch, chvc, config.inkDeltaE);
    let cover: number | null = null;
    let both = 0;
    if (crops.coverClear || crops.bothClear) {
      const coverClip = read(crops.coverClear);
      const bothClip = read(crops.bothClear);
      if (!coverClip || !bothClip) return null;
      const cc = decodePng(coverClip.png);
      const bc = decodePng(bothClip.png);
      if (cc.width !== n.width || cc.height !== n.height || bc.width !== n.width || bc.height !== n.height) return null;
      // Each text alone: what it paints while the other is transparent.
      const victimAlone = diffMask(cc, bc, config.inkDeltaE);
      const coverAlone = diffMask(vc, bc, config.inkDeltaE);
      cover = count(coverAlone);
      for (let i = 0; i < coverAlone.data.length; i++) if (coverAlone.data[i] === 1 && victimAlone.data[i] === 1) both++;
      const alone = count(victimAlone);
      const victim = count(victimMask);
      const revealed = count(revealedMask);
      return { victim, alone, cover, both, revealed, coveredShare: revealed > 0 ? round(Math.max(0, 1 - victim / revealed)) : 0 };
    }
    const victim = count(victimMask);
    const revealed = count(revealedMask);
    return { victim, alone: revealed, cover, both, revealed, coveredShare: revealed > 0 ? round(Math.max(0, 1 - victim / revealed)) : 0 };
  } catch {
    return null;
  }
}

/** Glyphs of one text on glyphs of the other, or a text whose ink is gone under the other. */
export function inkConfirms(ink: ReflowInk, config: ReflowConfig): { glyphs: boolean; covered: boolean } {
  const glyphs = ink.cover !== null && ink.both >= config.inkOverlapMinPx && ink.both >= config.inkOverlapMinShare * Math.max(1, Math.min(ink.alone, ink.cover));
  const covered = ink.revealed >= config.inkMinPx && ink.coveredShare >= config.coveredMinShare;
  return { glyphs, covered };
}

/** Rule 3: text made unreadable by other text or by a box painted over it, where it was not at the baseline. */
function textOverlap(base: Layout, layout: Layout, clips: Record<string, Screenshot>): { candidates: ReflowCandidate[]; cleared: number; total: number } {
  const config = layout.config;
  const plan = reflowPixelPlan(base.data, layout.data, config);
  const out: ReflowCandidate[] = [];
  let cleared = 0;
  for (const pair of plan) {
    const test = layout.data.pixels[pair.id];
    const flags: string[] = [pair.kind === 'text' ? 'textOnText' : 'textUnderBox'];
    // The covered one: the one the hit test found below the other (text on text); the text under a box.
    const victim = pair.kind === 'text' && test?.top === 'a' ? pair.b : pair.a;
    const other = victim === pair.a ? pair.b : pair.a;
    const values: Record<string, string | number | boolean> = { ...passValues(layout), overlapShare: pair.share };
    let status: Status;
    const ink = test ? reflowInk(test, clips, config) : null;
    if (ink) {
      const confirmed = inkConfirms(ink, config);
      Object.assign(values, {
        inkVictimPx: ink.victim,
        inkVictimAlonePx: ink.alone,
        inkRevealedPx: ink.revealed,
        coveredShare: ink.coveredShare,
        ...(ink.cover !== null ? { inkOtherAlonePx: ink.cover, inkBothPx: ink.both } : {}),
      });
      if (!confirmed.glyphs && !confirmed.covered) {
        cleared++;
        continue;
      }
      status = 'fail';
      if (confirmed.glyphs) flags.push('glyphsOverlap');
      if (confirmed.covered) flags.push('inkCovered');
      flags.push('pixelConfirmed');
    } else {
      status = pair.kind === 'text' ? 'likely' : 'info';
      flags.push('geometryOnly');
      if (test?.reason) flags.push(test.reason === 'layer-over' ? 'layerOver' : test.reason === 'not-in-view' ? 'notInView' : 'notCaptured');
      else if (!test) flags.push('notTested');
    }
    const text = layout.textByKey.get(victim) ?? layout.textByKey.get(pair.a);
    out.push({
      id: pair.id,
      rule: REFLOW_RULES.overlap,
      pass: layout.data.pass,
      status,
      key: victim,
      related: [{ role: 'other', key: other }],
      box: pair.region,
      flags: flags.sort(),
      values,
      capture: test?.crops ? { kind: 'pixel' } : { kind: 'region', region: pair.region },
      sample: text?.sample ?? '',
    });
  }
  return { candidates: out, cleared, total: plan.length };
}

function stuckLayers(states: ReflowScrollState[], state: ReflowScrollState, tolerance: number): ReflowLayer[] {
  const top = states[0];
  return state.layers.filter((layer) => {
    if (layer.position === 'fixed') return true;
    const before = top?.layers.find((other) => other.key === layer.key);
    if (!before) return state.y > (top?.y ?? 0);
    return Math.abs(layer.rect[1] + state.y - (before.rect[1] + (top?.y ?? 0))) > tolerance || Math.abs(layer.rect[0] + state.x - (before.rect[0] + (top?.x ?? 0))) > tolerance;
  });
}

function obscured(layers: ReflowLayer[], vp: ReflowViewport): number {
  const view: R = [0, 0, vp.clientWidth, vp.clientHeight];
  const rects = layers.flatMap((layer) =>
    layer.painted.flatMap((rect) => {
      const shown = intersectRects(rect, view);
      return shown ? [shown] : [];
    }),
  );
  return unionArea(rects) / Math.max(1, vp.clientWidth * vp.clientHeight);
}

function dismissible(layer: ReflowLayer, config: ReflowConfig): boolean {
  if (layer.dialog) return true;
  return !layer.landmark && layer.buttons > 0 && layer.controls <= config.maxDismissControls;
}

/** The worst scroll position of a layout for fixed and stuck elements: the least readable share of the viewport. */
function worstState(layout: Layout): { state: ReflowScrollState; layers: ReflowLayer[]; readable: number } | null {
  const states = layout.data.scrolls;
  let worst: { state: ReflowScrollState; layers: ReflowLayer[]; readable: number } | null = null;
  for (const state of states) {
    const layers = stuckLayers(states, state, layout.config.toleranceCssPx);
    const readable = 1 - obscured(layers, layout.viewport);
    if (!worst || readable < worst.readable - 1e-9) worst = { state, layers, readable };
  }
  return worst;
}

/** Rule 4: fixed and stuck elements that leave less than the readable share; and a document that cannot be scrolled to its content. */
function sticky(base: Layout, layout: Layout): ReflowCandidate[] {
  const config = layout.config;
  const worst = worstState(layout);
  if (!worst || worst.readable >= config.minReadableViewportShare) return [];
  const atBaseline = worstState(base);
  const flags: string[] = [];
  let status: Status = config.stickyObscuresStatus;
  const kept = worst.layers.filter((layer) => !dismissible(layer, config));
  const withoutDismissible = 1 - obscured(kept, layout.viewport);
  if (kept.length < worst.layers.length) flags.push('dismissible');
  if (atBaseline && atBaseline.readable < config.minReadableViewportShare) {
    status = 'info';
    flags.push('atBaseline');
  } else if (withoutDismissible >= config.minReadableViewportShare) {
    status = status === 'fail' ? 'likely' : status === 'likely' ? 'advisory' : 'info';
    flags.push('loweredDismissible');
  }
  if (worst.state.y > 0) flags.push('afterScroll');
  const vp = layout.viewport;
  const ranked = [...worst.layers].sort((a, b) => obscured([b], vp) - obscured([a], vp) || a.key - b.key);
  const main = ranked[0]!;
  return [
    {
      id: candidateId(REFLOW_RULES.sticky, layout.data.pass, main.key),
      rule: REFLOW_RULES.sticky,
      pass: layout.data.pass,
      status,
      key: main.key,
      related: ranked.slice(1).map((layer) => ({ role: 'layer', key: layer.key })),
      box: roundRect([main.rect[0] + worst.state.x, main.rect[1] + worst.state.y, main.rect[2], main.rect[3]]),
      flags: flags.sort(),
      values: {
        ...passValues(layout),
        readableShare: round(worst.readable),
        readableShareWithoutDismissible: round(withoutDismissible),
        threshold: config.minReadableViewportShare,
        scrollY: worst.state.y,
        layers: worst.layers.length,
        dismissibleLayers: worst.layers.length - kept.length,
        ...(atBaseline ? { readableShareAtBaseline: round(atBaseline.readable) } : {}),
      },
      capture: { kind: 'viewport', x: worst.state.x, y: worst.state.y },
      sample: '',
    },
  ];
}

/** Whether the innermost scroller of a chain can bring a rectangle below the viewport into view. */
function reachableByScroller(layout: Layout, rect: R, chain: number): boolean {
  const config = layout.config;
  const vp = layout.viewport;
  for (const clip of layout.chain(chain)) {
    if (clip.y !== 'auto' && clip.y !== 'scroll') continue;
    const range = clip.scroll[1] - clip.scroll[5] - clip.scroll[3];
    if (clip.scroll[1] - clip.scroll[5] <= config.scrollToleranceCssPx) continue;
    const top = Math.max(clip.rect[1], 0);
    const low = Math.min(bottom(clip.rect), vp.clientHeight);
    if (low - top < Math.min(rect[3], 8)) return false;
    return rect[1] - range < low - rect[3] * 0.5;
  }
  return false;
}

function unreachable(layout: Layout): { texts: ReflowText[]; controls: ReflowBox[]; others: ReflowBox[] } {
  const out = { texts: [] as ReflowText[], controls: [] as ReflowBox[], others: [] as ReflowBox[] };
  // Only what the root (or a body that clips) leaves below the viewport: `rootY`.
  const below = (rect: R, chain: number, layer: number | undefined, fontSize: number, share?: number): boolean => {
    const loss = lossOf(layout, rect, chain, layer, fontSize, share);
    return loss.lost && loss.by === 'rootY' && !reachableByScroller(layout, rect, chain);
  };
  for (const text of layout.data.texts) {
    if (text.layer !== undefined || text.transformed) continue;
    if (text.lines.some((line) => below(line, text.chain, text.layer, text.fontSize))) out.texts.push(text);
  }
  for (const box of layout.data.boxes) {
    if (box.layer !== undefined || box.transformed || box.kind === 'box') continue;
    if (!below(box.rect, box.chain, box.layer, 0, layout.config.controlLostMinShare)) continue;
    (box.kind === 'control' ? out.controls : out.others).push(box);
  }
  return out;
}

function scrollLocked(base: Layout, layout: Layout): ReflowCandidate[] {
  const config = layout.config;
  const vp = layout.viewport;
  // Empty when the document scrolls vertically: only a root that does not can lock content out.
  const found = unreachable(layout);
  const before = unreachable(base);
  const known = new Set([...before.texts.map((t) => t.key), ...before.controls.map((b) => b.key), ...before.others.map((b) => b.key)]);
  const freshTexts = found.texts.filter((text) => !known.has(text.key) && base.textByKey.has(text.key));
  const freshControls = found.controls.filter((box) => !known.has(box.key) && base.boxByKey.has(box.key));
  const freshOthers = found.others.filter((box) => !known.has(box.key) && base.boxByKey.has(box.key));
  const total = found.texts.length + found.controls.length + found.others.length;
  if (total === 0) return [];
  let status: Status;
  const flags: string[] = [];
  if (freshTexts.length + freshControls.length > 0) status = 'fail';
  else if (freshOthers.length > 0) status = 'likely';
  else {
    status = 'info';
    flags.push('atBaseline');
  }
  const top = layout.data.scrolls[0];
  if (top?.layers.some((layer) => obscured([layer], vp) >= config.fullScreenLayerMinShare)) flags.push('fullScreenLayer');
  const first = freshTexts[0] ?? found.texts[0];
  return [
    {
      id: candidateId(REFLOW_RULES.locked, layout.data.pass, 0),
      rule: REFLOW_RULES.locked,
      pass: layout.data.pass,
      status,
      key: 0,
      related: first ? [{ role: 'firstUnreachable', key: first.key }] : [],
      box: [0, 0, vp.clientWidth, vp.clientHeight],
      flags: flags.sort(),
      values: {
        ...passValues(layout),
        overflowY: vp.overflowY,
        unreachableTexts: found.texts.length,
        unreachableControls: found.controls.length,
        unreachableOther: found.others.length,
      },
      capture: { kind: 'viewport', x: 0, y: 0 },
      sample: first?.sample ?? '',
    },
  ];
}

const NESTED_EXCLUDED_TAGS = ['textarea', 'select', 'pre', 'code', 'iframe', 'frame'];
const NESTED_EXCLUDED_ROLES = ['log', 'listbox', 'grid', 'treegrid', 'table', 'menu', 'menubar', 'tree', 'application', 'combobox'];

function nestedScrollers(layout: Layout, axis: 'x' | 'y'): { clip: ReflowClipBox; chars: number; share: number }[] {
  const config = layout.config;
  const vp = layout.viewport;
  const pageScrolls = axis === 'y' ? vp.scrollHeight - vp.clientHeight > config.scrollToleranceCssPx && userScrollable(vp.overflowY) : vp.scrollWidth - vp.clientWidth > config.scrollToleranceCssPx && userScrollable(vp.overflowX);
  if (!pageScrolls) return [];
  const out: { clip: ReflowClipBox; chars: number; share: number }[] = [];
  for (const clip of layout.data.clips) {
    const mode = axis === 'y' ? clip.y : clip.x;
    if (mode !== 'auto' && mode !== 'scroll') continue;
    const range = axis === 'y' ? clip.scroll[1] - clip.scroll[5] : clip.scroll[0] - clip.scroll[4];
    if (range <= config.scrollToleranceCssPx) continue;
    const extent = axis === 'y' ? clip.scroll[5] : clip.scroll[4];
    const share = extent / Math.max(1, axis === 'y' ? vp.clientHeight : vp.clientWidth);
    if (share < config.nestedScrollerMinShare) continue;
    if (clip.except || clip.holdsTable || clip.carousel || clip.frame || clip.layer !== undefined) continue;
    if (NESTED_EXCLUDED_TAGS.includes(clip.tag) || NESTED_EXCLUDED_ROLES.includes(clip.role)) continue;
    let chars = 0;
    for (const text of layout.data.texts) {
      if (!text.except && (layout.data.chains[text.chain] ?? []).includes(clip.key)) chars += text.chars;
    }
    if (chars < config.nestedScrollerMinTextChars) continue;
    out.push({ clip, chars, share });
  }
  return out;
}

/** Rule 5: a scroller inside the page, on the axis the page scrolls on, large enough to hold the main content. */
function doubleScrollbar(base: Layout, layout: Layout): ReflowCandidate[] {
  const axis: 'x' | 'y' = horizontalLayout(base.data, layout.config) ? 'x' : 'y';
  const before = new Set(nestedScrollers(base, axis).map((entry) => entry.clip.key));
  return nestedScrollers(layout, axis).map(({ clip, chars, share }) => {
    const identical = before.has(clip.key);
    return {
      id: candidateId(REFLOW_RULES.double, layout.data.pass, clip.key),
      rule: REFLOW_RULES.double,
      pass: layout.data.pass,
      status: identical ? 'info' : 'likely',
      key: clip.key,
      related: [],
      box: roundRect(clip.rect),
      flags: identical ? ['atBaseline'] : [],
      values: {
        ...passValues(layout),
        axis,
        scrollerShareOfViewport: round(share),
        scrollerClientHeight: clip.scroll[5],
        scrollerScrollHeight: clip.scroll[1],
        scrollerClientWidth: clip.scroll[4],
        scrollerScrollWidth: clip.scroll[0],
        textChars: chars,
      },
      capture: { kind: 'viewport', x: 0, y: Math.max(0, Math.floor(clip.rect[1] - layout.config.clipMarginCssPx)) },
      sample: '',
    };
  });
}

const RULE_ORDER: ReflowRule[] = [REFLOW_RULES.twoDimensional, REFLOW_RULES.lost, REFLOW_RULES.overlap, REFLOW_RULES.sticky, REFLOW_RULES.locked, REFLOW_RULES.double];
const STATUS_RANK: Record<Status, number> = { fail: 0, likely: 1, advisory: 2, info: 3 };

/**
 * The candidates of one pass, against the baseline. `clips` are the captures of the scan, for
 * the tests by pixels (`ReflowLayout.pixels`).
 */
export function reflowPassReport(baseline: ReflowLayout, pass: ReflowLayout, settings: ReflowConfig, clips: Record<string, Screenshot>): ReflowPassReport {
  const base = new Layout(baseline, settings);
  const layout = new Layout(pass, settings);
  const overlap = textOverlap(base, layout, clips);
  const all = [...twoDimensional(base, layout), ...contentLost(base, layout), ...overlap.candidates, ...sticky(base, layout), ...scrollLocked(base, layout), ...doubleScrollbar(base, layout)];
  // A pass whose viewport was not the one asked for, or whose layout did not settle, measures something else than the criterion asks.
  const applied = Math.abs(pass.viewport.width - pass.requested.width) <= 1 && Math.abs(pass.viewport.height - pass.requested.height) <= 1;
  for (const candidate of all) {
    if (!applied) {
      candidate.status = 'info';
      candidate.flags = [...new Set([...candidate.flags, 'viewportNotApplied'])].sort();
    } else if (!pass.settled) {
      if (candidate.status === 'fail') candidate.status = 'likely';
      candidate.flags = [...new Set([...candidate.flags, 'notSettled'])].sort();
    }
  }
  const omitted: Record<string, number> = {};
  const kept: ReflowCandidate[] = [];
  for (const rule of RULE_ORDER) {
    const ofRule = all.filter((candidate) => candidate.rule === rule).sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || (a.box?.[1] ?? 0) - (b.box?.[1] ?? 0) || a.key - b.key || (a.id < b.id ? -1 : 1));
    kept.push(...ofRule.slice(0, settings.maxFindingsPerRule));
    if (ofRule.length > settings.maxFindingsPerRule) omitted[rule] = ofRule.length - settings.maxFindingsPerRule;
  }
  return { candidates: kept, omitted, clearedByPixels: overlap.cleared, overlapCandidates: overlap.total };
}

/** The candidates of every pass of a survey. */
export function reflowReport(survey: ReflowSurvey, settings: ReflowConfig, clips: Record<string, Screenshot>): { passes: { layout: ReflowLayout; report: ReflowPassReport }[] } {
  return { passes: survey.passes.map((layout) => ({ layout, report: reflowPassReport(survey.baseline, layout, settings, clips) })) };
}

/** Readable share of the viewport at the worst scroll position of a layout, for the survey. */
export function reflowReadableShare(layout: ReflowLayout, settings: ReflowConfig): number | null {
  const worst = worstState(new Layout(layout, settings));
  return worst ? round(worst.readable) : null;
}
