/**
 * Types of the reflow check (1.4.10). Kept apart from `types.ts`, which imports them, so that the
 * check is one block of its own.
 *
 * Every rectangle is `[x, y, width, height]` in CSS px. Unless said otherwise it is in page
 * coordinates of the top document, measured with the window scrolled to 0,0, in the layout of the
 * pass it belongs to.
 */

export type ReflowRect = [number, number, number, number];

/**
 * `baseline`: the reference layout every pass is compared with: the viewport the caller gave the page when it is at
 * least `referenceMinWidthCssPx` by `referenceMinHeightCssPx`, otherwise `referenceWidthCssPx` by
 * `referenceHeightCssPx` (1280 by 720). `narrow`: 320 by 800 by default. `short`: 800 by 256 by default.
 */
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
  /** The root has a vertical writing mode: its lines run top to bottom and the page grows sideways. */
  vertical?: boolean;
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
  /** Laid out right to left: its horizontal overflow, and its scroll range, go to the left. */
  rtl?: boolean;
  tag: string;
  role: string;
  /** Single-line truncation by design: `text-overflow: ellipsis` with `white-space: nowrap`, or `-webkit-line-clamp`. */
  truncates?: 'ellipsis' | 'line-clamp';
  /** It, or its parent, holds a control that may show what it hides: a button, a `summary`, an element with `aria-expanded`. */
  revealControl?: boolean;
  /**
   * The viewport of a carousel: scroll snapping; `aria-roledescription` on it or around it; it or the track it
   * holds is named in `aria-controls` of a control; previous, next or pagination controls in the region it
   * shares with them (`carouselControlLevels` ancestors up); or a track wider than it, moved by a translation
   * or with a declared transition of its position.
   */
  carousel?: boolean;
  /** Its content is moved through it by an animation (a ticker, a marquee): see `ReflowText.moving`. */
  moving?: boolean;
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
  /** Under `aria-hidden="true"` or `inert`: decoration. Never the victim of a rule nor the cause of a failure. */
  decorative?: boolean;
  /**
   * It, or an element it is in, moves by itself: a CSS animation is declared on it, an animation or a transition
   * was running when the scan began, or a script kept changing its style while the layout was waited for.
   */
  moving?: boolean;
  /** It is, or is inside, an element that a visible control names in `aria-controls`: what such a control may show. */
  controlled?: boolean;
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
  /** `display: inline`: laid out in the lines of text, whose rectangle spans the lines it wraps over. */
  inline?: boolean;
  /** Under `aria-hidden="true"` or `inert`. */
  decorative?: boolean;
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
  /** A dialog: the element itself has the role `dialog` or `alertdialog`, `aria-modal`, or is an open `dialog`. What it holds, hidden or not, does not count. */
  dialog?: boolean;
  /** Modal: `aria-modal="true"` on it or on a visible dialog it holds, or a `dialog` opened modally (`:modal`). */
  modal?: boolean;
  /** It holds a visible control whose accessible name contains one of `dismissWords` (close, accept, refuse...). */
  dismissControl?: boolean;
  /** A landmark: `header`, `footer`, `nav`, `aside` or their roles. */
  landmark?: boolean;
  /** Buttons inside it, and controls of every kind. */
  buttons: number;
  controls: number;
}

/** Fixed and sticky elements at one scroll position of the window, or of the main scroller of a document that does not scroll. */
export interface ReflowScrollState {
  x: number;
  y: number;
  /** Key of the scroll container that was scrolled, when it was not the window (an application shell). */
  scroller?: number;
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
  /** Elements that kept moving by script after `settleMotionMs`: their changes were no longer waited for (`unsettled`). */
  motion?: number;
  /** The waits of this pass used up `settleBudgetMs`: the later ones were cut short. */
  budgetSpent?: boolean;
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
  /**
   * Fixed and sticky elements at each scroll position of `stickyScrollPositions`; the first is the top. When the
   * document does not scroll and one scroll container covers most of the viewport (`mainScrollerMinShare`), the
   * positions are those of that container (`ReflowScrollState.scroller`).
   */
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
   * The layout every pass is compared with (`baseline`). The caller's viewport when it is at least
   * `referenceMinWidthCssPx` by `referenceMinHeightCssPx`; otherwise the page is laid out at
   * `referenceWidthCssPx` by `referenceHeightCssPx` for it, so that a problem a narrow caller's viewport already
   * shows is still compared with a wide layout.
   */
  referenceWidthCssPx: number;
  referenceHeightCssPx: number;
  referenceMinWidthCssPx: number;
  referenceMinHeightCssPx: number;
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
  /**
   * Changes that only an element moving by script keeps making (its `style` or `class` changed at least three
   * times) are no longer waited for after this long; the pass records them (`motion`, `unsettled`).
   */
  settleMotionMs: number;
  /** All waits of one layout together (settling, scrolling, captures) at most; once used up, each wait is one frame. */
  settleBudgetMs: number;
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
  /**
   * A layer counts as one a user can dismiss when it is itself a visible, open dialog, or when it holds a
   * visible control whose accessible name contains one of `dismissWords` (whole words, any case) and at most
   * `maxDismissControls` controls in all (a cookie banner). Hidden descendants never count.
   */
  maxDismissControls: number;
  dismissWords: string[];
  /**
   * A clipping element is the viewport of a carousel when an ancestor at most `carouselControlLevels` up holds,
   * outside it, a visible control whose accessible name contains one of `carouselControlWords` (previous, next,
   * slide...), or a tab list: the arrows and dots of a slider.
   */
  carouselControlLevels: number;
  carouselControlWords: string[];
  /** A document that does not scroll, with a scroll container this share of the viewport or more: that container is the page (an application shell). */
  mainScrollerMinShare: number;
  /**
   * A page counts as laid out horizontally (positive evidence only) when its root has a vertical writing mode, or
   * when at the baseline it scrolls horizontally and fits vertically and at least this share of its running text
   * is laid out in lines wholly beyond the inline end, where that scrolling reaches them (a panel, a column).
   */
  horizontalMinTextShare: number;
  /** A layer that covers this share of the viewport is a full-screen layer. */
  fullScreenLayerMinShare: number;
  /** Below this, `scrollHeight - clientHeight` is not something to scroll. */
  scrollToleranceCssPx: number;
  /** A nested scroller on the axis of the page counts as a second scroll bar for the main content from this share of the viewport on that axis, holding this much text. */
  nestedScrollerMinShare: number;
  nestedScrollerMinTextChars: number;
  /**
   * A second scroll bar that the baseline has as well is reported with this status (`atBaseline` in its values)
   * when it takes at least `nestedScrollerAtBaselineMinShare` of the viewport: what is asked of the reflowed view
   * does not depend on the baseline. Smaller ones that the baseline has are `info`.
   */
  doubleScrollbarAtBaselineStatus: 'likely' | 'info';
  nestedScrollerAtBaselineMinShare: number;
}

export interface ReflowSurvey {
  /** Null only when the survey stopped before the baseline was measured (`stopped`). */
  baseline: ReflowLayout | null;
  /** The passes that ran, in order. */
  passes: ReflowLayout[];
  /** Passes switched off in the configuration. */
  skipped: ReflowPassName[];
  /** Selector and frame of the elements findings name, by key. */
  names: Record<string, { selector: string; frame: string }>;
  /** The viewport of the page as the scan found it, which is put back. */
  original: { width: number; height: number };
  /** The size the baseline was measured at: the caller's viewport, or the configured reference size. */
  reference?: { width: number; height: number; source: 'caller' | 'configured' };
  /**
   * Why the survey stopped before its end, when it did: the page went to another document while a pass was in
   * effect (it reloads or navigates on resize), or a step failed. What was measured before is kept; the other
   * checks are not affected.
   */
  stopped?: { reason: 'navigated' | 'error'; detail: string };
}
