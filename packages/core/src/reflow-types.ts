/**
 * Types of the reflow check (1.4.10). Kept apart from `types.ts`, which imports them, so that the
 * check is one block of its own.
 *
 * Every rectangle is `[x, y, width, height]` in CSS px. Unless said otherwise it is in page
 * coordinates of the top document, measured with the window scrolled to 0,0, in the layout of the
 * pass it belongs to.
 */

export type ReflowRect = [number, number, number, number];

/** `baseline`: the viewport the caller gave the page. `narrow`: 320 by 800 by default. `short`: 800 by 256 by default. */
export type ReflowPassName = 'baseline' | 'narrow' | 'short';

/** Computed `overflow-x` or `overflow-y`; `overlay` is read as `auto`. */
export type ReflowOverflow = 'visible' | 'hidden' | 'clip' | 'auto' | 'scroll';

/**
 * Content that 1.4.10 lets need two dimensions, by what it is: a data table, a picture, a video, a
 * canvas, an SVG drawing, a frame, an embedded object, preformatted text or code, a toolbar, a math
 * formula, an application region (maps, editors), a grid widget.
 */
export type ReflowExceptKind = 'table' | 'image' | 'video' | 'canvas' | 'svg' | 'frame' | 'object' | 'code' | 'toolbar' | 'math' | 'application' | 'grid';

export interface ReflowViewport {
  /** `innerWidth` and `innerHeight`: the layout viewport the pass set. */
  width: number;
  height: number;
  /** `clientWidth` and `clientHeight` of the root element: what content can use, scroll bars apart. */
  clientWidth: number;
  clientHeight: number;
  /** Of the scrolling element of the document. */
  scrollWidth: number;
  scrollHeight: number;
  /** The overflow of the viewport: that of the root element, or that of `body` when the root leaves it `visible` (propagation). */
  overflowX: ReflowOverflow;
  overflowY: ReflowOverflow;
  /** The root is laid out right to left: horizontal overflow goes to the left. */
  rtl: boolean;
}

/**
 * An element that clips what it holds on at least one axis: overflow other than `visible`,
 * `contain: paint`, the `clip` property, or the content box of a frame (as `auto` on both axes).
 */
export interface ReflowClipBox {
  key: number;
  /** What is shown of its content: the padding box, or the rectangle of `clip`. */
  rect: ReflowRect;
  x: ReflowOverflow;
  y: ReflowOverflow;
  /** `scrollWidth`, `scrollHeight`, `scrollLeft`, `scrollTop`, `clientWidth`, `clientHeight`. */
  scroll: [number, number, number, number, number, number];
  tag: string;
  role: string;
  /** Single-line truncation by design: `text-overflow: ellipsis` with `white-space: nowrap`, or `-webkit-line-clamp`. */
  truncates?: 'ellipsis' | 'line-clamp';
  /** It, or its parent, holds a control that may show what it hides: a button, a `summary`, an element with `aria-expanded`. */
  revealControl?: boolean;
  /** Scroll snapping or `aria-roledescription`: the viewport of a carousel. */
  carousel?: boolean;
  /** It holds a `table` or an element with the role `table` or `grid`. */
  holdsTable?: boolean;
  /** Excepted content it is, or is inside of. */
  except?: ReflowExceptKind;
  /** The content box of a frame. */
  frame?: boolean;
  /** Inside a fixed or sticky layer: the key of the layer. */
  layer?: number;
}

/** The visible text of one element: what its own text nodes lay out. */
export interface ReflowText {
  key: number;
  /** Position of the element in the walk of this pass, entering and leaving: A holds B when A's span holds B's. */
  span: [number, number];
  /** Line boxes of its text nodes, as laid out (before any clipping). */
  lines: ReflowRect[];
  chars: number;
  fontSize: number;
  /** Index into `ReflowLayout.chains`: the clipping ancestors on its containing-block chain, innermost first. */
  chain: number;
  /** Key of the fixed or sticky element it is in, or is. */
  layer?: number;
  /** Excepted content it is inside of. */
  except?: ReflowExceptKind;
  /** Under a rotation, a skew or a 3D transform: its rectangles are bounding boxes. */
  transformed?: boolean;
  /** Key of the `ruby` it is in. */
  ruby?: number;
  /** In a dialog, a menu, a list box or a tooltip. */
  popup?: boolean;
  /** The start of its text, white space collapsed. */
  sample: string;
}

/** A control, a piece of excepted content (its outermost element), or another element that paints (`box`). */
export interface ReflowBox {
  key: number;
  span: [number, number];
  /** Border box. */
  rect: ReflowRect;
  kind: 'control' | 'box' | ReflowExceptKind;
  chain: number;
  layer?: number;
  transformed?: boolean;
  popup?: boolean;
  /** It paints over what lies under it: a background colour that is not transparent, a background image, replaced content. */
  paints: boolean;
  tag: string;
}

/** An element that extends beyond the viewport on the axis of the pass (right edge, or bottom edge for a page laid out horizontally). */
export interface ReflowBeyond {
  key: number;
  span: [number, number];
  rect: ReflowRect;
  tag: string;
}

/** A fixed or sticky element (the outermost of its kind), at one scroll position. Rectangles in viewport coordinates. */
export interface ReflowLayer {
  key: number;
  position: 'fixed' | 'sticky';
  rect: ReflowRect;
  /** What it paints: its own box when it paints, otherwise the boxes and text inside it that do. */
  painted: ReflowRect[];
  /** A dialog: the role `dialog` or `alertdialog`, `aria-modal`, an open `dialog`. */
  dialog?: boolean;
  /** A landmark: `header`, `footer`, `nav`, `aside` or their roles. */
  landmark?: boolean;
  /** Buttons inside it, and controls of every kind. */
  buttons: number;
  controls: number;
}

/** Fixed and sticky elements at one scroll position of the window. */
export interface ReflowScrollState {
  x: number;
  y: number;
  layers: ReflowLayer[];
}

/**
 * The captures of one test of overlapping text by pixels, all of one region: as it is; with the
 * text of the covered element made transparent (`victimClear`); when the other is text, with its
 * text transparent (`coverClear`) and with both transparent (`bothClear`); with the other hidden
 * (`coverHidden`); with the other hidden and the text of the covered one transparent
 * (`coverHiddenVictimClear`). Ids of `Snapshot.screenshots.clips`.
 *
 * The ink of each text alone is what making it transparent changes while the other is
 * transparent too: so the pixels both would paint are counted whatever their colours and
 * whichever is painted last.
 */
export interface ReflowPixelCrops {
  normal: string;
  victimClear: string;
  coverClear: string | null;
  bothClear: string | null;
  coverHidden: string;
  coverHiddenVictimClear: string;
}

export interface ReflowPixelTest {
  /** Page coordinates of the region, at the layout of the pass. */
  region: ReflowRect;
  /** Which of the two lies on top at the region, by the browser's hit test: the other one is the one covered. */
  top: 'a' | 'b' | 'unknown';
  crops: ReflowPixelCrops | null;
  /** Why there are no captures. */
  reason?: 'not-in-view' | 'no-selector' | 'detached' | 'layer-over' | 'capture-failed';
}

export interface ReflowLayout {
  pass: ReflowPassName;
  /** The viewport asked for. */
  requested: { width: number; height: number };
  viewport: ReflowViewport;
  /** The layout settled within `settleMaxMs` (no change to the document for `settleQuietMs`). */
  settled: boolean;
  texts: ReflowText[];
  boxes: ReflowBox[];
  clips: ReflowClipBox[];
  /** Chains of clipping ancestors, as keys of `clips`, innermost first. */
  chains: number[][];
  /** Elements beyond the edge on the axis of `beyondAxis`. */
  beyond: ReflowBeyond[];
  beyondAxis: 'x' | 'y' | null;
  /** Keys of the controls that disclose content (`aria-expanded`, `aria-haspopup`, `aria-controls` on a button, `summary`). */
  disclosures: number[];
  /** Fixed and sticky elements at each scroll position of `stickyScrollPositions`; the first is the top. */
  scrolls: ReflowScrollState[];
  /** The largest scroll position of the window on each axis. */
  maxScroll: { x: number; y: number };
  /** Elements walked, of how many; text items and boxes left out at their limits. */
  elements: number;
  truncated: boolean;
  textsBeyond: number;
  boxesBeyond: number;
  /** Frames whose document could be read, and frames of another origin (measured as a box only). */
  frames: { readable: number; opaque: number };
  /** Pixel tests of overlapping text, by candidate id. */
  pixels: Record<string, ReflowPixelTest>;
  /** Evidence captures, by candidate id; null when none could be taken. */
  captures: Record<string, string | null>;
}

/** Settings of the reflow check. Every number the check uses is here. */
export interface ReflowConfig {
  /**
   * The pass for content that scrolls vertically: a viewport `narrowWidthCssPx` wide (320, the width
   * of 1280 px at 400% zoom) and `narrowHeightCssPx` tall. Off: the pass does not run.
   */
  narrowPass: boolean;
  narrowWidthCssPx: number;
  narrowHeightCssPx: number;
  /** The pass for content that scrolls horizontally, and for what a short window does: `shortWidthCssPx` by `shortHeightCssPx` (256, 1024 px at 400%). */
  shortPass: boolean;
  shortWidthCssPx: number;
  shortHeightCssPx: number;
  /**
   * After the viewport changes, the layout is waited for: at least `settleMinMs`, then until
   * nothing in the document (elements, attributes, text, the size of the root and of `body`) has
   * changed for `settleQuietMs`, `settleMaxMs` at most. Fonts are waited for within that time.
   */
  settleMinMs: number;
  settleQuietMs: number;
  settleMaxMs: number;
  /** The same after the window is scrolled to look at fixed and sticky elements. */
  scrollSettleMs: number;
  scrollSettleMaxMs: number;
  /** At most this many elements are walked in one layout, text items and boxes kept, line boxes per text, elements beyond the edge kept. */
  maxElements: number;
  maxTextItems: number;
  maxBoxes: number;
  maxLinesPerText: number;
  maxBeyond: number;
  /** Findings of one rule in one pass beyond this are counted in the survey, not listed. */
  maxFindingsPerRule: number;
  /** Evidence captures, and tests by pixels of overlapping text, per pass. */
  maxCaptures: number;
  maxPixelChecks: number;
  /** Margin around what an evidence capture of a region shows. */
  clipMarginCssPx: number;
  /** Characters of an element's text kept for messages. */
  sampleChars: number;
  /** Below this, a difference of position or size is rounding, not overflow. */
  toleranceCssPx: number;
  /** A line of text counts as beyond the edge of the viewport when this much of it (in em of its font size) lies beyond. */
  beyondMinEm: number;
  /** A control counts as beyond the edge when this share of its width lies beyond. */
  controlBeyondMinShare: number;
  /** A line counts as cut off when at least this much of its width (em) or this share of its height is hidden by what clips it. */
  lostMinEm: number;
  lostMinLineShare: number;
  /** A control counts as cut off when this share of its area is hidden. */
  controlLostMinShare: number;
  /** Text shown at the baseline and not displayed in a pass is reported (`info`) from this many characters. */
  hiddenTextMinChars: number;
  /**
   * Two texts are candidates for overlapping when the middle bands of two of their lines
   * (`overlapCoreInset` of the height cut off at top and bottom) intersect by at least
   * `overlapMinShare` of the smaller band, and by `overlapMinCssPx` on each axis.
   */
  overlapMinShare: number;
  overlapCoreInset: number;
  overlapMinCssPx: number;
  /** A pixel is ink of a text when making that text transparent changes it by more than this (CIEDE2000). */
  inkDeltaE: number;
  /** Ink, in device pixels, that a covered text must show once what covers it is hidden. */
  inkMinPx: number;
  /** Device pixels where the ink of both texts coincides, and their share of the smaller ink, for glyphs on glyphs. */
  inkOverlapMinPx: number;
  inkOverlapMinShare: number;
  /** Share of the ink of a text that is gone under what covers it. */
  coveredMinShare: number;
  /** The readable part of the viewport, with fixed and stuck elements taken away, under which `reflow/sticky-obscures` is reported. */
  minReadableViewportShare: number;
  /** Status of `reflow/sticky-obscures`: the threshold is a working rule of the owner, not a number of WCAG. */
  stickyObscuresStatus: 'advisory' | 'likely' | 'fail';
  /** Where the window is scrolled to look at fixed and sticky elements, as shares of the largest scroll position. */
  stickyScrollPositions: number[];
  /** Elements looked at inside a fixed or sticky element that paints nothing itself. */
  layerMaxDescendants: number;
  /** A layer with a button and at most this many controls, that is no landmark, counts as one a user can dismiss (a cookie banner). */
  maxDismissControls: number;
  /** A layer that covers this share of the viewport is a full-screen layer. */
  fullScreenLayerMinShare: number;
  /** Below this, `scrollHeight - clientHeight` is not something to scroll. */
  scrollToleranceCssPx: number;
  /** A nested scroller on the axis of the page counts as a second scroll bar for the main content from this share of the viewport on that axis, holding this much text. */
  nestedScrollerMinShare: number;
  nestedScrollerMinTextChars: number;
}

export interface ReflowSurvey {
  baseline: ReflowLayout;
  /** The passes that ran, in order. */
  passes: ReflowLayout[];
  /** Passes switched off in the configuration. */
  skipped: ReflowPassName[];
  /** Selector and frame of the elements findings name, by key. */
  names: Record<string, { selector: string; frame: string }>;
  /** The viewport of the page as the scan found it, which is put back. */
  original: { width: number; height: number };
}
