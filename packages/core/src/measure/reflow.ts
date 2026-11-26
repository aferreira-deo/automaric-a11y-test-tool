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
export type ReflowCaptureRequest = { kind: 'viewport'; x: number; y: number; scroller?: number } | { kind: 'region'; region: ReflowRect } | { kind: 'pixel' };

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
  /**
   * The other is text hidden from assistive technology (`ReflowText.hiddenFromAT`): `a` is real text. When the other
   * lies on top, `a` is the covered one and only ink of it that the other hides counts; when `a` lies on top, the other
   * is the covered one, unless it is placed out of the flow (`behind`): decoration laid out behind real text.
   */
  coverOnly?: boolean;
  behind?: boolean;
  /** `a` is text hidden from assistive technology under a box. */
  hiddenA?: boolean;
}

/**
 * Which of a pair is the covered one, from which of the two the hit test finds on top: null when nothing is to be
 * captured (a text over the box under it, real text over decoration laid out behind it). `coverOnly`: only ink of
 * the covered text that the other hides counts (decoration over real text). `hidden`: the covered one is text hidden
 * from assistive technology: what is found is advisory at most.
 */
export function reflowPixelRoles(candidate: ReflowPixelCandidate, top: 'a' | 'b' | 'unknown'): { victim: number; cover: number; coverOnly: boolean; hidden: boolean } | null {
  if (candidate.kind === 'box') return top === 'a' ? null : { victim: candidate.a, cover: candidate.b, coverOnly: false, hidden: !!candidate.hiddenA };
  if (candidate.coverOnly) {
    if (top === 'a') return candidate.behind ? null : { victim: candidate.b, cover: candidate.a, coverOnly: false, hidden: true };
    return { victim: candidate.a, cover: candidate.b, coverOnly: true, hidden: false };
  }
  return top === 'a' ? { victim: candidate.b, cover: candidate.a, coverOnly: false, hidden: false } : { victim: candidate.a, cover: candidate.b, coverOnly: false, hidden: false };
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

/** The physical side of the viewport (or of the document) beyond which a loss to the root lies. */
type Side = 'left' | 'right' | 'top' | 'bottom';

interface LineLoss {
  lost: boolean;
  by: LostBy | null;
  /** Part of the line still shown, or null when nothing of it can be. */
  shown: R | null;
  /** For a loss to the root (`rootX`, `rootY`, `edge`, `fixed`): the side it lies beyond. */
  side?: Side;
}

/** What one axis of a rectangle becomes on its way out through its clipping ancestors and the root. */
interface AxisReach {
  /** Some scroll position of the scrollers around it shows it with less than the threshold hidden. */
  ok: boolean;
  /** Some scroll position shows something of it. */
  any: boolean;
  /** What of it stays hidden at the best position (frame by frame: the largest of what each one hides at least). */
  missing: number;
  /** What made it too small, first. */
  by: LostBy | null;
  side?: Side;
}

type Interval = [number, number];

function meet(a: Interval | null, b: Interval | null): Interval | null {
  if (!a || !b) return null;
  const lo = Math.max(a[0], b[0]);
  const hi = Math.min(a[1], b[1]);
  return hi >= lo ? [lo, hi] : null;
}

/**
 * Where an extent of `length` may start for less than `allowed` of it to lie outside the window `[w0, w1]`; null
 * when nowhere. Inside a window at least as long, from `w0 - allowed` to `w1 - length + allowed`; in a shorter
 * one, around the positions where it covers the window, while what sticks out stays under what is allowed.
 */
function placesIn(length: number, w0: number, w1: number, allowed: number): Interval | null {
  const slack = allowed - Math.max(0, length - Math.max(0, w1 - w0)) - 1e-6;
  if (slack <= 0) return null;
  return [Math.min(w0, w1 - length) - slack, Math.max(w0, w1 - length) + slack];
}

/** The least of an extent that lies outside the window, over the starts it may take. */
function leastOutside(length: number, w0: number, w1: number, starts: Interval): number {
  const best0 = Math.min(w0, w1 - length);
  const best1 = Math.max(w0, w1 - length);
  const base = Math.max(0, length - Math.max(0, w1 - w0));
  const away = starts[0] > best1 ? starts[0] - best1 : starts[1] < best0 ? best0 - starts[1] : 0;
  return Math.min(length, base + away);
}

/**
 * Reachability of an extent of a line (or a control) on one axis, from the inside out. The positions it can take are
 * carried as an interval of where it starts: each scroll container adds what scrolling it moves its content by (from
 * where it is scrolled to, `[pos − (max − scroll), pos + scroll]`), and the boxes that clip it (those of clipping
 * ancestors, the scroller's own, which does not move with it, the viewport and the start edge of the document) keep
 * only the positions where it is shown, wholly or with less than `minVisible` of it hidden. Boxes that scroll
 * together are taken together. A line longer than the box of a scroller it is in is read across that box by
 * scrolling (which `two-dimensional-scroll` reports): what has to be shown at once is then as long as that box.
 */
function reachAxis(layout: Layout, start: number, end: number, chain: number, layer: number | undefined, axis: 'x' | 'y', minVisible: number): AxisReach {
  const vp = layout.viewport;
  const tolerance = layout.config.toleranceCssPx;
  const full = Math.max(0, end - start);
  const clips = layout.chain(chain).filter((clip) => (axis === 'x' ? clip.x : clip.y) !== 'visible');
  const boxOf = (clip: ReflowClipBox): Interval => (axis === 'x' ? [clip.rect[0], right(clip.rect)] : [clip.rect[1], bottom(clip.rect)]);
  const scrolls = (clip: ReflowClipBox): boolean => {
    const mode = axis === 'x' ? clip.x : clip.y;
    return mode === 'auto' || mode === 'scroll';
  };
  // What has to be shown at once: the line, or as much of it as the smallest scroller it is in shows.
  const length = Math.min(full, ...clips.filter(scrolls).map((clip) => Math.max(0, boxOf(clip)[1] - boxOf(clip)[0])));
  const out: AxisReach = { ok: true, any: true, missing: 0, by: null };
  let ok: Interval | null = [start, start + (full - length)];
  let any: Interval | null = ok;
  let worst = 0;
  let frame: { lo: number; hi: number; by: LostBy; side?: Side }[] = [];
  const close = (): void => {
    let w0 = -Infinity;
    let w1 = Infinity;
    for (const box of frame) {
      w0 = Math.max(w0, box.lo);
      w1 = Math.min(w1, box.hi);
      if (out.by === null && meet(ok, placesIn(length, w0, w1, minVisible)) === null) {
        out.by = box.by;
        if (box.side) out.side = box.side;
      }
    }
    ok = meet(ok, placesIn(length, w0, w1, minVisible));
    if (any) worst = Math.max(worst, leastOutside(length, w0, w1, any));
    any = meet(any, placesIn(length, w0, w1, length));
    frame = [];
  };
  for (const clip of clips) {
    const [box0, box1] = boxOf(clip);
    if (!scrolls(clip)) {
      // A body that clips is the viewport that does not scroll, as overflow on the root is; not that of a frame.
      const by: LostBy = clip.tag === 'body' && !clip.inFrame ? (axis === 'x' ? 'rootX' : 'rootY') : clip.key;
      frame.push({ lo: box0, hi: box1, by });
      continue;
    }
    // A scroll container: what it holds moves with its scrolling, its own box does not.
    close();
    if (!any) break;
    const [sw, sh, sl, st, cw, ch] = clip.scroll;
    const range = axis === 'x' ? Math.max(0, sw - cw) : Math.max(0, sh - ch);
    const at = axis === 'x' ? sl : st;
    const [d0, d1] = axis === 'x' && clip.rtl ? [at, at + range] : [at - range, at];
    ok = ok ? [ok[0] + d0 - tolerance, ok[1] + d1 + tolerance] : null;
    any = [any[0] + d0 - tolerance, any[1] + d1 + tolerance];
    frame.push({ lo: box0, hi: box1, by: clip.key });
  }
  if (any) {
    const extent = axis === 'x' ? vp.clientWidth : vp.clientHeight;
    if (layout.inFixed(layer)) {
      // A fixed element does not scroll with the document: what lies outside the viewport stays there.
      frame.push({ lo: 0, hi: Infinity, by: 'fixed', side: axis === 'x' ? 'left' : 'top' });
      frame.push({ lo: -Infinity, hi: extent, by: 'fixed', side: axis === 'x' ? 'right' : 'bottom' });
    } else if (axis === 'x') {
      // The start edge: the left of a document laid out left to right, the right of one laid out from the right.
      frame.push(vp.rtl ? { lo: -Infinity, hi: vp.clientWidth, by: 'edge', side: 'right' } : { lo: 0, hi: Infinity, by: 'edge', side: 'left' });
      const [minX, maxX] = layout.reach('x');
      frame.push({ lo: minX, hi: maxX, by: 'rootX', side: vp.rtl ? 'left' : 'right' });
    } else {
      frame.push({ lo: 0, hi: Infinity, by: 'edge', side: 'top' });
      frame.push({ lo: -Infinity, hi: layout.reach('y')[1], by: 'rootY', side: 'bottom' });
    }
    close();
  }
  out.ok = ok !== null;
  out.any = any !== null;
  out.missing = any ? worst : full;
  return out;
}

/** What becomes of one rectangle of a text or a control: clipped, cut at the edge, beyond what the root lets scroll. `share`: for a control, the share of its area that has to be hidden. */
function lossOf(layout: Layout, rect: R, chain: number, layer: number | undefined, fontSize: number, share?: number): LineLoss {
  const config = layout.config;
  const minX = share === undefined ? config.lostMinEm * fontSize : 0.01;
  const minY = share === undefined ? config.lostMinLineShare * rect[3] : 0.01;
  const x = reachAxis(layout, rect[0], right(rect), chain, layer, 'x', minX);
  const y = reachAxis(layout, rect[1], bottom(rect), chain, layer, 'y', minY);
  const vx = x.any ? Math.max(0, rect[2] - x.missing) : 0;
  const vy = y.any ? Math.max(0, rect[3] - y.missing) : 0;
  const shown: R | null = x.any && y.any ? [rect[0], rect[1], Math.max(vx, 0.01), Math.max(vy, 0.01)] : null;
  const lostX = share === undefined ? !x.ok : false;
  const lostY = share === undefined ? !y.ok : false;
  const lostArea = share !== undefined && (!shown || 1 - (vx * vy) / Math.max(area(rect), 0.0001) >= share);
  if (!shown || lostX || lostY || lostArea) {
    // The axis that loses the line names the cause; x first, as it did.
    const pick = !shown ? (!x.any ? x : y) : lostX ? x : lostY ? y : rect[2] - vx >= rect[3] - vy ? x : y;
    const other = pick === x ? y : x;
    const cause = pick.by ?? other.by;
    const side = pick.by !== null ? pick.side : other.side;
    return { lost: true, by: cause, shown, ...(side ? { side } : {}) };
  }
  return { lost: false, by: null, shown };
}

interface ItemLoss {
  lines: number;
  /** Lines of which nothing is shown. */
  whole: number;
  by: LostBy | null;
  side?: Side;
  firstLine: R | null;
}

function textLoss(layout: Layout, text: ReflowText): ItemLoss {
  let lines = 0;
  let whole = 0;
  let by: LostBy | null = null;
  let side: Side | undefined;
  let firstLine: R | null = null;
  for (const line of text.lines) {
    const loss = lossOf(layout, line, text.chain, text.layer, text.fontSize);
    if (!loss.lost) continue;
    lines++;
    if (!loss.shown) whole++;
    if (by === null) {
      by = loss.by;
      side = loss.side;
      firstLine = line;
    }
  }
  return { lines, whole, by, ...(side ? { side } : {}), firstLine };
}

/** Lost to the root's reach (an edge the document does not scroll to, the viewport around a fixed element), not to a clipping element. */
function toRoot(by: LostBy | null): boolean {
  return by === 'rootX' || by === 'edge' || by === 'fixed';
}

/**
 * What an item wholly beyond the root's reach is (an edge the document does not scroll to, the viewport around a
 * fixed element). `parked`: out of the flow (`placed`: positioned, or moved off its place as a block) and named as
 * content shown on demand (`controlled`: what a control names, a dialog, a popover), or hidden from assistive
 * technology while it is off screen, as a closed drawer is: treated as content that is not displayed, never as lost.
 * `likely`: out of the flow without any of that evidence. `lost`: in the flow (a column, a cell, a block, an item of a
 * flex or grid row), or cut in part. Inside a fixed layer of which something is shown, content below the bottom of
 * the viewport is lost: it is the part of a dialog or a banner that a short window leaves out of reach. Nothing of an
 * ancestor decides it: only the item itself.
 */
function offScreen(loss: ItemLoss, item: { layer?: number | undefined; placed?: string | undefined; controlled?: boolean | undefined; hiddenFromAT?: boolean | undefined }, whole: boolean, shownLayers: Set<number>): 'lost' | 'parked' | 'likely' {
  if (!toRoot(loss.by) || !whole) return 'lost';
  if (loss.by === 'fixed' && loss.side === 'bottom' && item.layer !== undefined && shownLayers.has(item.layer)) return 'lost';
  if (!item.placed) return 'lost';
  return item.controlled || item.hiddenFromAT ? 'parked' : 'likely';
}

/** Fixed layers of which some text or control is shown in the viewport. */
function shownFixedLayers(layout: Layout): Set<number> {
  const out = new Set<number>();
  for (const text of layout.data.texts) {
    if (text.layer === undefined || !layout.inFixed(text.layer) || out.has(text.layer) || text.decorative) continue;
    if (text.lines.some((line) => lossOf(layout, line, text.chain, text.layer, text.fontSize).shown !== null)) out.add(text.layer);
  }
  for (const box of layout.data.boxes) {
    if (box.kind !== 'control' || box.layer === undefined || !layout.inFixed(box.layer) || out.has(box.layer)) continue;
    if (lossOf(layout, box.rect, box.chain, box.layer, 0, layout.config.controlLostMinShare).shown !== null) out.add(box.layer);
  }
  return out;
}

function controlLoss(layout: Layout, box: ReflowBox): LineLoss {
  return lossOf(layout, box.rect, box.chain, box.layer, 0, layout.config.controlLostMinShare);
}

/** Running text: in the flow (neither positioned nor moved), seen by assistive technology, not excepted content, in no layer, not rotated. */
function running(text: ReflowText): boolean {
  return !text.except && !text.decorative && !text.hiddenFromAT && text.layer === undefined && !text.transformed && !text.placed;
}

/** That share of its running text lies in lines wholly beyond the inline end. */
function sideways(data: ReflowLayout, config: ReflowConfig): boolean {
  const vp = data.viewport;
  const layout = new Layout(data, config);
  const texts = data.texts.filter(running);
  const total = texts.reduce((sum, text) => sum + text.chars, 0);
  if (total === 0) return false;
  let beyond = 0;
  for (const text of texts) {
    const whole = text.lines.filter((line) => {
      const shown = layout.through(line, text.chain, 'all').rect;
      return shown !== null && (vp.rtl ? right(shown) <= config.toleranceCssPx : shown[0] >= vp.clientWidth - config.toleranceCssPx);
    }).length;
    beyond += (text.chars * whole) / Math.max(1, text.lines.length);
  }
  return beyond > 0 && beyond >= config.horizontalMinTextShare * total;
}

/**
 * The page is laid out to scroll horizontally, on positive evidence of the reference layout only: the root has a
 * vertical writing mode; or the document scrolls horizontally and not vertically, and either its root (or body) is
 * a horizontal track (it snaps horizontally, or is a flex row that does not wrap) or most of its running text in the
 * flow (`horizontalMinTextShare`) is laid out in lines wholly beyond the inline end. Content out of the flow (an
 * off-canvas menu parked beyond the edge) is no evidence, nor a page that is a little too wide. `narrow` is not
 * used: what the reference layout is decides.
 */
export function horizontalLayout(baseline: ReflowLayout, config: ReflowConfig, _narrow?: ReflowLayout): boolean {
  const vp = baseline.viewport;
  if (vp.vertical) return true;
  const tolerance = config.scrollToleranceCssPx;
  if (!userScrollable(vp.overflowX) || vp.scrollWidth <= vp.clientWidth + tolerance) return false;
  if (vp.scrollHeight > vp.clientHeight + tolerance && userScrollable(vp.overflowY)) return false;
  return vp.track !== undefined || sideways(baseline, config);
}

/**
 * The axis on which content beyond the viewport needs a second direction of scrolling, for a pass; null when the
 * rule does not apply. The narrow pass always looks at the horizontal axis; the short one at the vertical axis of
 * a page laid out horizontally (`horizontalLayout`).
 */
export function beyondAxisOf(pass: ReflowPassName, baseline: ReflowLayout, config: ReflowConfig, _narrow?: ReflowLayout): 'x' | 'y' | null {
  if (pass === 'short') return horizontalLayout(baseline, config) ? 'y' : null;
  return 'x';
}

/** Whether a pass is of a page laid out horizontally: what the collector decided for the short pass, measured for the others. */
function horizontalFor(base: Layout, layout: Layout): boolean {
  if (layout.data.pass === 'short') return layout.data.beyondAxis === 'y';
  return horizontalLayout(base.data, layout.config);
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
  /** Text hidden from assistive technology (`ReflowText.hiddenFromAT`). */
  hidden: boolean;
  /** Out of the flow (`ReflowText.placed`). */
  placed: boolean;
}

/** Texts, controls and excepted content that lie beyond the edge on `axis` and that scrolling the document reaches. */
function beyondItems(layout: Layout, axis: 'x' | 'y'): BeyondItem[] {
  const config = layout.config;
  const out: BeyondItem[] = [];
  for (const text of layout.data.texts) {
    if (text.layer !== undefined || text.transformed || text.decorative) continue;
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
    if (lines > 0 && first) out.push({ key: text.key, span: text.span, kind: text.except ?? 'text', lines, reach, first, sample: text.sample, hidden: !!text.hiddenFromAT, placed: !!text.placed });
  }
  for (const box of layout.data.boxes) {
    if (box.kind === 'box' || box.layer !== undefined || box.transformed || box.decorative) continue;
    const shown = layout.through(box.rect, box.chain, 'all').rect;
    if (!shown) continue;
    const by = beyondBy(layout, shown, axis);
    const extent = axis === 'x' ? shown[2] : shown[3];
    if (by <= 0) continue;
    if (box.kind === 'control' && by < config.controlBeyondMinShare * extent) continue;
    out.push({ key: box.key, span: box.span, kind: box.kind === 'control' ? 'control' : box.kind, lines: 1, reach: by, first: shown, sample: '', hidden: false, placed: !!box.placed });
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
    const scrollsVertically = vp.scrollHeight - vp.clientHeight > config.scrollToleranceCssPx && userScrollable(vp.overflowY);
    const bothAxes = axis === 'x' ? scrollsVertically : true;
    // A page laid out to scroll horizontally is meant to scroll that way: on the horizontal axis, nothing to report as
    // long as it does not scroll vertically as well, which would be two dimensions whatever it is laid out as.
    const skipX = axis === 'x' && !scrollsVertically && horizontalFor(base, layout);
    // On the vertical axis (the short pass, a page laid out horizontally): only when the page still needs horizontal
    // scrolling for its running text at this pass. One that grows downwards instead scrolls in one direction.
    const skipY = axis === 'y' && !beyondItems(layout, 'x').some((item) => item.kind === 'text' && !item.hidden && !item.placed);
    for (const [cause, items] of groups) {
      if (skipX || skipY) break;
      const running = items.filter((item) => item.kind === 'text' || item.kind === 'control');
      const fresh = running.filter((item) => !atBaseline.has(item.key));
      const seen = fresh.filter((item) => !item.hidden);
      const excepted = [...new Set(items.filter((item) => item.kind !== 'text' && item.kind !== 'control').map((item) => item.kind))].sort();
      const flags: string[] = [];
      let status: Status;
      if (seen.length > 0) status = 'fail';
      else if (fresh.length > 0) {
        // Text hidden from assistive technology alone: what is seen, but perhaps decoration.
        status = 'advisory';
        flags.push('hiddenFromAT');
      } else {
        status = 'info';
        flags.push(running.length > 0 ? 'atBaseline' : 'exceptedOnly');
      }
      if (excepted.length > 0) flags.push('excepted');
      if (bothAxes) flags.push('documentScrollsBothAxes');
      const first = (seen[0] ?? fresh[0] ?? running[0] ?? items[0])!;
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
      if (text.except || text.transformed || text.decorative || !(layout.data.chains[text.chain] ?? []).includes(clip.key)) continue;
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
    moving: boolean;
    /** Text hidden from assistive technology. */
    hidden: boolean;
    /** Wholly beyond the root's reach, out of the flow, with nothing that names it (`offScreen`): likely at most. */
    unnamed: boolean;
  }
  const groups = new Map<string, { by: LostBy; side: Side | undefined; items: Lost[] }>();
  const add = (by: LostBy, side: Side | undefined, item: Lost): void => {
    const id = `${String(by)}|${side ?? ''}`;
    const group = groups.get(id) ?? { by, side, items: [] };
    group.items.push(item);
    groups.set(id, group);
  };
  const shownLayers = shownFixedLayers(layout);
  const before = new Set(base.data.disclosures);
  const newDisclosure = layout.data.disclosures.some((key) => !before.has(key));
  for (const text of layout.data.texts) {
    if (text.transformed || text.decorative) continue;
    const loss = textLoss(layout, text);
    if (loss.lines === 0 || loss.by === null || loss.by === 'rootY') continue;
    const atBase = base.textByKey.get(text.key);
    if (!atBase || atBase.transformed || textLoss(base, atBase).lines > 0) continue;
    const where = offScreen(loss, text, loss.whole === text.lines.length, shownLayers);
    // Content shown on demand and parked out of the flow, or hidden from assistive technology off screen: not reported.
    if (where === 'parked') continue;
    add(loss.by, loss.side, {
      key: text.key,
      lines: loss.lines,
      chars: Math.round((text.chars * loss.lines) / Math.max(1, text.lines.length)),
      first: loss.firstLine,
      sample: text.sample,
      control: false,
      moving: !!text.moving,
      hidden: !!text.hiddenFromAT,
      unnamed: where === 'likely',
    });
  }
  for (const box of layout.data.boxes) {
    if (box.kind !== 'control' || box.transformed || box.decorative) continue;
    const loss = controlLoss(layout, box);
    if (!loss.lost || loss.by === null || loss.by === 'rootY') continue;
    const where = offScreen({ lines: 1, whole: loss.shown ? 0 : 1, by: loss.by, ...(loss.side ? { side: loss.side } : {}), firstLine: box.rect }, box, !loss.shown, shownLayers);
    if (where === 'parked') continue;
    const atBase = base.boxByKey.get(box.key);
    if (!atBase || atBase.transformed || controlLoss(base, atBase).lost) continue;
    add(loss.by, loss.side, { key: box.key, lines: 0, chars: 0, first: box.rect, sample: '', control: true, moving: false, hidden: false, unnamed: where === 'likely' });
  }
  // Clipping elements that already cut text at the baseline: a viewport by design (a carousel, a ticker).
  const cutAtBaseline = new Set<number>();
  for (const text of base.data.texts) {
    const loss = textLoss(base, text);
    if (loss.lines > 0 && typeof loss.by === 'number') cutAtBaseline.add(loss.by);
  }
  const out: ReflowCandidate[] = [];
  for (const group of groups.values()) {
    const { by, side } = group;
    // Content that moves through what clips it by itself (a ticker) is not lost; with nothing else in the group, info at most.
    const still = group.items.filter((item) => !item.moving);
    // What assistive technology is told about counts first; text hidden from it alone is advisory at most.
    const seen = still.filter((item) => !item.hidden);
    const items = seen.length > 0 ? seen : still.length > 0 ? still : group.items;
    const first = items[0]!;
    const flags: string[] = [];
    // In the flow, or cut in part: lost. Out of the flow beyond the root's reach with nothing naming it: likely.
    let status: Status = items.some((item) => !item.unnamed) ? 'fail' : 'likely';
    if (status === 'likely') flags.push('outOfFlow');
    let key: number;
    let box: R | null;
    if (still.length === 0) {
      status = 'info';
      flags.push('moving');
    } else if (seen.length === 0) {
      status = status === 'fail' || status === 'likely' ? 'advisory' : status;
      flags.push('hiddenFromAT');
    }
    if (typeof by === 'number') {
      const clip = layout.clipByKey.get(by);
      key = by;
      box = clip ? roundRect(clip.rect) : null;
      if (status === 'info') {
        // Moving content: already as low as it goes.
      } else if (clip?.moving) {
        status = 'info';
        flags.push('moving');
      } else if (clip?.truncates) {
        status = status === 'fail' || status === 'likely' ? 'advisory' : status;
        flags.push(clip.truncates === 'ellipsis' ? 'ellipsis' : 'lineClamp');
      } else if (cutAtBaseline.has(by)) {
        status = 'info';
        flags.push('clipsAtBaseline');
      } else if (clip?.carousel) {
        status = 'info';
        flags.push('carousel');
      } else if (clip?.revealControl) {
        // A control inside or beside it may show what it hides ("Read more", a menu button, arrows).
        status = status === 'fail' || status === 'likely' ? 'advisory' : status;
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
        ...(side && typeof by !== 'number' ? { side } : {}),
      },
      capture: by === 'rootX' || by === 'fixed' || by === 'edge' || !box ? { kind: 'viewport', x: 0, y: Math.max(0, Math.floor((firstLine?.[1] ?? 0) - config.clipMarginCssPx)) } : { kind: 'region', region: box },
      sample: first.sample,
    });
  }
  // Text displayed at the baseline that a pass does not display at all.
  const shown = new Set(layout.data.texts.map((text) => text.key));
  const missing = base.data.texts.filter((text) => !shown.has(text.key) && text.layer === undefined && !text.decorative && textLoss(base, text).lines === 0);
  const hiddenChars = missing.reduce((sum, text) => sum + text.chars, 0);
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
    // A glyph of decoration is left out of every rule.
    if (text.transformed || text.popup || text.decorative) return [];
    const rects = text.lines.flatMap((line) => {
      const shown = layout.through(line, text.chain, 'all').rect;
      return shown ? [core(shown, inset)] : [];
    });
    return rects.length > 0 ? [{ key: text.key, span: text.span, rects, item: text }] : [];
  });
}

function shownBoxes(layout: Layout): Shown[] {
  return layout.data.boxes.flatMap((box) => {
    // An inline box is laid out in the lines of text and paints over none of them; its rectangle spans the lines it wraps over.
    if (!box.paints || box.transformed || box.popup || box.inline) return [];
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
    // Text hidden from assistive technology is tested as the covered one only under a box, or under real text laid
    // over it (see `reflowPixelRoles`); with other such text, never.
    const aHidden = !!(pair.a.item as ReflowText).hiddenFromAT;
    const bHidden = pair.kind === 'text' && !!(pair.b.item as ReflowText).hiddenFromAT;
    if (aHidden && bHidden) continue;
    const [a, b] = aHidden && pair.kind === 'text' ? [pair.b.key, pair.a.key] : [pair.a.key, pair.b.key];
    const coverOnly = pair.kind === 'text' && (aHidden || bHidden);
    const hiddenItem = coverOnly ? ((aHidden ? pair.a.item : pair.b.item) as ReflowText) : null;
    const aBefore = base.textByKey.has(a);
    const bBefore = pair.kind === 'text' ? base.textByKey.has(b) : base.boxByKey.has(b);
    // The text made unreadable is content of the page at the baseline.
    if (pair.kind === 'box' ? !aBefore : !aBefore && !bBefore) continue;
    if (pairMet(base, a, b)) continue;
    out.push({
      id: candidateId(REFLOW_RULES.overlap, pass.pass, a, b),
      a,
      b,
      kind: pair.kind,
      region: roundRect(pair.region),
      share: round(pair.share),
      ...(coverOnly ? { coverOnly: true } : {}),
      ...(hiddenItem?.placed ? { behind: true } : {}),
      ...(pair.kind === 'box' && aHidden ? { hiddenA: true } : {}),
    });
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

/** Something that moves by itself (`ReflowLayout.motionBoxes`, or one of the two moving) meets one of the two or the region they meet in. */
function movesNear(layout: Layout, keys: number[], region: R): boolean {
  const margin = layout.config.toleranceCssPx;
  const areas: R[] = [[region[0] - margin, region[1] - margin, region[2] + 2 * margin, region[3] + 2 * margin]];
  for (const key of keys) {
    const text = layout.textByKey.get(key);
    if (text?.moving) return true;
    if (text) areas.push(...text.lines);
    const box = layout.boxByKey.get(key);
    if (box) areas.push(box.rect);
  }
  return (layout.data.motionBoxes ?? []).some((moving) => areas.some((other) => intersectRects(moving, other) !== null));
}

/** Rule 3: text made unreadable by other text or by a box painted over it, where it was not at the baseline. */
function textOverlap(base: Layout, layout: Layout, clips: Record<string, Screenshot>): { candidates: ReflowCandidate[]; cleared: number; total: number } {
  const config = layout.config;
  const plan = reflowPixelPlan(base.data, layout.data, config);
  const out: ReflowCandidate[] = [];
  let cleared = 0;
  for (const pair of plan) {
    const test = layout.data.pixels[pair.id];
    // The browser's hit test finds the text over the box: the box paints under it. Real text over decoration laid
    // out behind it: the decoration paints under it.
    const roles = reflowPixelRoles(pair, test?.top ?? 'unknown');
    if (!roles) {
      cleared++;
      continue;
    }
    const flags: string[] = [pair.kind === 'text' ? 'textOnText' : 'textUnderBox'];
    // The covered one: the one the hit test found below the other (text on text); the text under a box.
    const victim = roles.victim;
    const other = roles.cover;
    const values: Record<string, string | number | boolean> = { ...passValues(layout), overlapShare: pair.share };
    let status: Status;
    const ink = test ? reflowInk(test, clips, config) : null;
    if (ink) {
      const found = inkConfirms(ink, config);
      // Decoration over real text: only ink of the real text that it hides counts.
      const confirmed = roles.coverOnly ? { glyphs: false, covered: found.covered } : found;
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
      if (roles.coverOnly) flags.push('decorativeCover');
      // Something that moves by itself where the two meet: the pixels may show a passing moment. Decided from where
      // what moves is, not from whether it moved while this was captured.
      if (movesNear(layout, [victim, other], pair.region)) {
        status = 'likely';
        flags.push('unsettled');
      }
    } else {
      // From boxes alone, two texts that meet are likely to be unreadable when the region could not
      // be captured; beyond the limit of tests (`maxPixelChecks`) nothing was looked at, which is no
      // evidence: info. A text under a box is info, as which of the two is painted on top is not known.
      status = pair.kind === 'text' && test && !roles.coverOnly ? 'likely' : 'info';
      flags.push('geometryOnly');
      if (test?.reason) flags.push(test.reason === 'layer-over' ? 'layerOver' : test.reason === 'not-in-view' ? 'notInView' : 'notCaptured');
      else if (!test) flags.push('notTested');
    }
    // Text hidden from assistive technology made unreadable: what is seen, but perhaps decoration.
    if (roles.hidden) {
      if (status === 'fail' || status === 'likely') status = 'advisory';
      flags.push('hiddenFromAT');
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

/**
 * The fixed elements, and the sticky ones that are stuck, at one scroll position. A sticky element is stuck when
 * its page position differs from the one at the top, when it became sticky after scrolling, or when it kept its
 * place in the viewport between this position and another one: that last one counts it at the top as well, as a
 * footer stuck to the bottom from the start is.
 */
function stuckLayers(states: ReflowScrollState[], state: ReflowScrollState, tolerance: number): ReflowLayer[] {
  const top = states[0];
  return state.layers.filter((layer) => {
    // Under the page (a background behind it): it hides nothing.
    if (layer.behind) return false;
    if (layer.position === 'fixed') return true;
    const kept = states.some((other) => {
      if (other === state || other.scroller !== state.scroller) return false;
      if (Math.abs(other.y - state.y) <= tolerance && Math.abs(other.x - state.x) <= tolerance) return false;
      const there = other.layers.find((item) => item.key === layer.key);
      return !!there && Math.abs(there.rect[1] - layer.rect[1]) <= tolerance && Math.abs(there.rect[0] - layer.rect[0]) <= tolerance;
    });
    if (kept) return true;
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

/**
 * A layer a user can dismiss: a visible, open dialog itself, or one that holds a visible control named to close,
 * accept or refuse (`dismissWords`) among at most `maxDismissControls` controls. Never a layer whose own content
 * this pass leaves out of reach (`blocked`): what cannot be reached cannot be answered either.
 */
function dismissible(layer: ReflowLayer, config: ReflowConfig, blocked: Set<number>): boolean {
  if (blocked.has(layer.key)) return false;
  if (layer.dialog) return true;
  return !!layer.dismissControl && layer.controls <= config.maxDismissControls;
}

/**
 * The readable share of the viewport at one scroll position: what fixed and stuck elements leave of it. In an
 * application shell (the document does not scroll; the scroll container that holds the page was scrolled), only the
 * box that container shows is read in: the rest of the viewport (bars around it, stuck or not) is not, and what
 * sticks over that box is taken away. Always a share of the whole viewport.
 */
function readableShare(layout: Layout, state: ReflowScrollState, layers: ReflowLayer[]): number {
  const vp = layout.viewport;
  const view: R = [0, 0, vp.clientWidth, vp.clientHeight];
  const scroller = state.scroller !== undefined ? layout.clipByKey.get(state.scroller) : undefined;
  const reading = scroller ? intersectRects(scroller.rect, view) : view;
  if (!reading) return 0;
  const covered = unionArea(
    layers.flatMap((layer) =>
      layer.painted.flatMap((rect) => {
        const shown = intersectRects(rect, reading);
        return shown ? [shown] : [];
      }),
    ),
  );
  return Math.max(0, area(reading) - covered) / Math.max(1, vp.clientWidth * vp.clientHeight);
}

/** The worst scroll position of a layout for fixed and stuck elements: the least readable share of the viewport. */
function worstState(layout: Layout): { state: ReflowScrollState; layers: ReflowLayer[]; readable: number } | null {
  const states = layout.data.scrolls;
  let worst: { state: ReflowScrollState; layers: ReflowLayer[]; readable: number } | null = null;
  for (const state of states) {
    const layers = stuckLayers(states, state, layout.config.toleranceCssPx);
    const readable = readableShare(layout, state, layers);
    if (!worst || readable < worst.readable - 1e-9) worst = { state, layers, readable };
  }
  return worst;
}

/** Rule 4: fixed and stuck elements that leave less than the readable share; and a document that cannot be scrolled to its content. */
function sticky(base: Layout, layout: Layout, blocked: Set<number>): ReflowCandidate[] {
  const config = layout.config;
  const worst = worstState(layout);
  if (!worst || worst.readable >= config.minReadableViewportShare) return [];
  const atBaseline = worstState(base);
  const flags: string[] = [];
  let status: Status = config.stickyObscuresStatus;
  const kept = worst.layers.filter((layer) => !dismissible(layer, config, blocked));
  const withoutDismissible = readableShare(layout, worst.state, kept);
  if (kept.length < worst.layers.length) flags.push('dismissible');
  if (atBaseline && atBaseline.readable < config.minReadableViewportShare) {
    status = 'info';
    flags.push('atBaseline');
  } else if (withoutDismissible >= config.minReadableViewportShare) {
    status = status === 'fail' ? 'likely' : status === 'likely' ? 'advisory' : 'info';
    flags.push('loweredDismissible');
  }
  if (worst.state.y > 0) flags.push('afterScroll');
  if (worst.state.scroller !== undefined) flags.push('mainScroller');
  if (worst.layers.length === 0) flags.push('scrollerBox');
  const vp = layout.viewport;
  const ranked = [...worst.layers].sort((a, b) => obscured([b], vp) - obscured([a], vp) || a.key - b.key);
  const main = ranked[0];
  // No layer at all: the box of the scroll container of a shell is what leaves so little to read.
  const key = main?.key ?? worst.state.scroller ?? 0;
  const scrollerRect = worst.state.scroller !== undefined ? layout.clipByKey.get(worst.state.scroller)?.rect : undefined;
  const mainBox: R | null = main ? [main.rect[0] + worst.state.x, main.rect[1] + worst.state.y, main.rect[2], main.rect[3]] : (scrollerRect ?? null);
  return [
    {
      id: candidateId(REFLOW_RULES.sticky, layout.data.pass, key),
      rule: REFLOW_RULES.sticky,
      pass: layout.data.pass,
      status,
      key,
      related: ranked.slice(1).map((layer) => ({ role: 'layer', key: layer.key })),
      box: mainBox ? roundRect(mainBox) : null,
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
      capture: { kind: 'viewport', x: worst.state.x, y: worst.state.y, ...(worst.state.scroller !== undefined ? { scroller: worst.state.scroller } : {}) },
      sample: '',
    },
  ];
}

function unreachable(layout: Layout): { texts: ReflowText[]; controls: ReflowBox[]; others: ReflowBox[] } {
  const out = { texts: [] as ReflowText[], controls: [] as ReflowBox[], others: [] as ReflowBox[] };
  // Only what the root (or a body that clips) leaves below the viewport, whatever the scroll containers around it are scrolled to: `rootY`.
  const below = (rect: R, chain: number, layer: number | undefined, fontSize: number, share?: number): boolean => {
    const loss = lossOf(layout, rect, chain, layer, fontSize, share);
    return loss.lost && loss.by === 'rootY';
  };
  for (const text of layout.data.texts) {
    if (text.layer !== undefined || text.transformed || text.decorative) continue;
    if (text.lines.some((line) => below(line, text.chain, text.layer, text.fontSize))) out.texts.push(text);
  }
  for (const box of layout.data.boxes) {
    if (box.layer !== undefined || box.transformed || box.decorative || box.kind === 'box') continue;
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
  const freshAll = found.texts.filter((text) => !known.has(text.key) && base.textByKey.has(text.key));
  // Text hidden from assistive technology alone is advisory at most.
  const freshTexts = freshAll.filter((text) => !text.hiddenFromAT);
  const freshControls = found.controls.filter((box) => !known.has(box.key) && base.boxByKey.has(box.key));
  const freshOthers = found.others.filter((box) => !known.has(box.key) && base.boxByKey.has(box.key));
  const total = found.texts.length + found.controls.length + found.others.length;
  if (total === 0) return [];
  let status: Status;
  const flags: string[] = [];
  // A document that already locks content out at the baseline (a dialog that stops scrolling while
  // it is open, a consent wall) has that problem at every size: not one of reflow.
  if (known.size > 0) {
    status = 'info';
    flags.push('atBaseline');
  } else if (freshTexts.length + freshControls.length > 0) status = 'fail';
  else if (freshOthers.length > 0) status = 'likely';
  else if (freshAll.length > 0) {
    status = 'advisory';
    flags.push('hiddenFromAT');
  } else {
    status = 'info';
    flags.push('atBaseline');
  }
  const top = layout.data.scrolls[0];
  // A layer over the whole viewport counts only when the hit test finds it over the page: a background behind the
  // page (z-index: -1) stops nothing.
  const fullScreen = !!top?.layers.some((layer) => layer.covers && obscured([layer], vp) >= config.fullScreenLayerMinShare);
  if (fullScreen) flags.push('fullScreenLayer');
  // An open modal layer that stops the page from scrolling: what lies behind it is not lost while it is open. Its
  // own content has to be reachable, which `content-lost` measures (a fixed layer whose fields lie beyond the viewport).
  if (fullScreen || top?.layers.some((layer) => layer.modal)) {
    status = 'info';
    flags.push('modalOpen');
  }
  const first = freshTexts[0] ?? freshAll[0] ?? found.texts[0];
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
      if (!text.except && !text.decorative && (layout.data.chains[text.chain] ?? []).includes(clip.key)) chars += text.chars;
    }
    if (chars < config.nestedScrollerMinTextChars) continue;
    out.push({ clip, chars, share });
  }
  return out;
}

/** Rule 5: a scroller inside the page, on the axis the page scrolls on, large enough to hold the main content. */
function doubleScrollbar(base: Layout, layout: Layout): ReflowCandidate[] {
  const axis: 'x' | 'y' = horizontalFor(base, layout) ? 'x' : 'y';
  const before = new Set(nestedScrollers(base, axis).map((entry) => entry.clip.key));
  const config = layout.config;
  return nestedScrollers(layout, axis).map(({ clip, chars, share }) => {
    const identical = before.has(clip.key);
    // What is asked of the reflowed view does not depend on the baseline: a scroller that takes the place of the
    // page there too is still reported (`doubleScrollbarAtBaselineStatus`); a smaller one the baseline has is info.
    const status: Status = !identical ? 'likely' : share >= config.nestedScrollerAtBaselineMinShare ? config.doubleScrollbarAtBaselineStatus : 'info';
    return {
      id: candidateId(REFLOW_RULES.double, layout.data.pass, clip.key),
      rule: REFLOW_RULES.double,
      pass: layout.data.pass,
      status,
      key: clip.key,
      related: [],
      box: roundRect(clip.rect),
      flags: identical ? ['atBaseline'] : [],
      values: {
        ...passValues(layout),
        ...(identical ? { atBaseline: true } : {}),
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
  const lost = contentLost(base, layout);
  // Fixed layers whose own content this pass leaves out of reach: not dismissible.
  const blocked = new Set(lost.filter((candidate) => candidate.flags.includes('fixedBeyondViewport') && candidate.status === 'fail').map((candidate) => candidate.key));
  const all = [...twoDimensional(base, layout), ...lost, ...overlap.candidates, ...sticky(base, layout, blocked), ...scrollLocked(base, layout), ...doubleScrollbar(base, layout)];
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
  const baseline = survey.baseline;
  if (!baseline) return { passes: [] };
  return { passes: survey.passes.map((layout) => ({ layout, report: reflowPassReport(baseline, layout, settings, clips) })) };
}

/** Readable share of the viewport at the worst scroll position of a layout, for the survey. */
export function reflowReadableShare(layout: ReflowLayout, settings: ReflowConfig): number | null {
  const worst = worstState(new Layout(layout, settings));
  return worst ? round(worst.readable) : null;
}
