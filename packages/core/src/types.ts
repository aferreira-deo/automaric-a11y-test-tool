export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Encoded PNG bytes. */
export type Png = Uint8Array;

export type Status = 'fail' | 'likely' | 'advisory' | 'info';

export type CheckId =
  | 'noop'
  | 'focus-indicator'
  | 'icon-contrast'
  | 'headings'
  | 'lists'
  | 'grouping';

/** CSS pixels, relative to the top-left of the document of the frame the node lives in. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WcagRef {
  /** Success criterion number, e.g. "2.4.7". */
  sc: string;
  level: 'A' | 'AA';
}

export interface SnapshotNode {
  id: number;
  /** Stable CSS selector, unique within its frame and shadow scope. */
  selector: string;
  frameId: string;
  /** Selectors of the shadow hosts to traverse, outermost first. Empty in the light DOM. */
  shadowPath: string[];
  box: Box | null;
  /** Subset of computed styles, keyed by CSS property name. */
  styles: Record<string, string>;
  /** Text of the node's own text-node children, not of its descendants. */
  ownText: string;
}

export interface AxNode {
  id: string;
  role: string;
  name: string;
  /** Matching SnapshotNode id, when the accessibility node maps to a DOM node. */
  nodeId: number | null;
  childIds: string[];
  properties: Record<string, JsonValue>;
}

export interface Screenshot {
  box: Box;
  /** Device pixels per CSS pixel in `png`. */
  scale: number;
  png: Png;
}

export interface Environment {
  url: string;
  devicePixelRatio: number;
  viewport: { width: number; height: number };
  colorScheme: 'light' | 'dark';
}

/** One element that received focus during collection. All boxes are CSS pixels in page coordinates. */
export interface FocusStop {
  selector: string;
  /** Selectors of the enclosing same-origin iframes, outermost first, joined with " >>> ". Empty in the main frame. */
  frame: string;
  /** Border box while focused. */
  box: Box;
  /** `tab`: reached with real Tab presses. `forced`: pseudo-state forced through CDP, lower confidence. */
  reachedBy: 'tab' | 'forced';
  /** Text field, textarea or contenteditable: the (hidden) caret may be its only focus cue. */
  textEntry: boolean;
  /** An author rule matched in the focused state declares an outline or has :focus in its selector. */
  authorModified: boolean;
  /** Cross-origin iframe: focus went inside and could not be followed. */
  opaqueFrame: boolean;
  /**
   * Where the browser left the element when it received focus, before collection scrolled it:
   * how many of the sampled points were covered by fixed or sticky content, and under how many
   * of those the covering content is demonstrably opaque (see `obscuredInfo` in the collector).
   * Null when not sampled.
   */
  obscured: { covered: number; sampled: number; by: string; opaque: number } | null;
  /**
   * While it was captured, after scrolling, the element was entirely under fixed or sticky
   * content that is not demonstrably opaque. The captures then show what gets through that content.
   */
  coveredAtCapture?: boolean;
  /**
   * The element was still focused after it was blurred (a script gives focus back), so the
   * "unfocused" capture does not show the unfocused state and nothing can be concluded from the pair.
   */
  unfocusedNotCaptured?: boolean;
  /** Once scrolled for capture, the border box still reached beyond the viewport on at least one side. */
  clippedByViewport?: boolean;
  /**
   * The stabilising styles (no transitions, no animations, no caret) did not take effect on this
   * element: an author `!important` rule outweighs them, or the style sheet could not be attached.
   */
  unstabilised?: boolean;
  /** The box moved or resized between the unfocused and the focused state. */
  geometryChanged: boolean;
  /** Crop ids of the two captures of the same region; null when the element could not be captured. */
  crops: { focused: string; unfocused: string } | null;
  /**
   * Why `crops` is null. `transformed-frame`: the element is inside an iframe that is scaled,
   * rotated or zoomed, where page coordinates cannot be worked out from the frame's box.
   */
  notCaptured?: 'no-box' | 'obscured' | 'outside-viewport' | 'transformed-frame';
  /**
   * While it was captured, something the 2.4.11 sampling cannot see lay over the element, or
   * that could not be ruled out: content of a parent document over the iframe it is in, a layer
   * with `pointer-events: none`, a pseudo-element of an ancestor. The captures may show that
   * content, so no `fail` is drawn from them.
   */
  possiblyCovered?: boolean;
  /**
   * Evaluated only when the two crops are identical: bounding box of what changed elsewhere
   * in the viewport, or null when nothing did. Undefined when not evaluated.
   */
  outsideChange?: Box | null;
}

export interface FocusWalk {
  stops: FocusStop[];
  /**
   * `cycle`: focus came back to a visited element. `limit`: `maxTabStops` was hit.
   * `opaque-frame`: focus stayed inside a cross-origin iframe and could not be moved past it.
   */
  stoppedBy: 'cycle' | 'limit' | 'opaque-frame' | 'no-focusable';
  /** Focusable elements the Tab walk never reached. */
  unreached: number;
  /** How many of those were measured with a forced state. */
  forced: number;
}

/** What draws the graphic of an icon control. */
export type IconSource =
  | 'svg'
  | 'img'
  | 'font-glyph'
  | 'background-image'
  | 'mask-image'
  | 'pseudo-element'
  | 'css-shape';

export type IconHint = 'inactive' | 'logo' | 'home-link' | 'plain-shape' | 'visible-label' | 'duplicate-link';

export type BoundaryControl = 'text-field' | 'select' | 'checkbox' | 'radio' | 'switch';

/**
 * One control collected for the icon-contrast check: an interactive element without visible
 * text that renders a graphic (`icon`), or a form control identified by its boundary
 * (`boundary`). All boxes are CSS pixels in page coordinates, taken while it was captured.
 */
export interface IconCandidate {
  selector: string;
  /** Same convention as FocusStop.frame. */
  frame: string;
  /** Border box of the control. */
  box: Box;
  kind: 'icon' | 'boundary';
  /** `disabled`, inside a disabled fieldset, or `aria-disabled="true"` on it or an ancestor. Not measured. */
  disabled: boolean;
  icon?: {
    /** Distinct sources found in the control, in a fixed order. */
    sources: IconSource[];
    /** Box of the graphic: the union of the elements that draw it, or the padding box of the control. */
    box: Box;
    /** Where `box` comes from. `control`: a source without a box of its own (pseudo-element, background). */
    boxFrom: 'graphic' | 'control';
    /** Padding box of the control: what lies inside it and around the graphic is the control's own fill. */
    room: Box;
    /**
     * #rrggbb when the collector could read one opaque colour for the whole graphic from computed
     * styles: SVG shapes that all paint the same solid colour, an icon-font glyph, the background
     * colour under a mask. Null when opacity, a filter, a blend mode, a gradient, an image or
     * several colours are involved: then only pixels can tell.
     */
    declaredColor: string | null;
  };
  boundary?: {
    control: BoundaryControl;
    /**
     * False for a native control on which no author rule declares a border, background,
     * box-shadow, appearance or accent colour: its look is the browser default.
     */
    authorModified: boolean;
    /** Boxes whose edges are measured: the control first, then its tight wrappers, innermost first. */
    boxes: Box[];
  };
  /**
   * Signs in styles and markup that the control may be exempt, or may not be identified by its
   * graphic, although nothing says so programmatically. Any of them keeps a finding from being a `fail`.
   * - `inactive`: no pointer events, a not-allowed cursor, or a class naming it disabled.
   * - `logo`: a class, id, name or file name says logo.
   * - `home-link`: a link to the root of the site or with `rel="home"`, or a link in the page
   *   header named "home" or after the site: where a logotype usually is.
   * - `plain-shape`: the graphic is a single element drawn with CSS (a colour swatch).
   * - `visible-label`: visible text outside the control is its label (`aria-labelledby`, `label`).
   * - `duplicate-link`: a link hidden from assistive technology (`aria-hidden`, `tabindex="-1"`)
   *   next to a text link with the same target.
   */
  hints?: IconHint[];
  /** Crop id of the capture; null when the control could not be captured. */
  crop: string | null;
  /**
   * Why `crop` is null. `cover-unknown`: the hit test that proves nothing lies in front of the
   * control gave no answer. `detached`: the control was removed from the page during the scan.
   * `transformed-frame`: see FocusStop.notCaptured.
   */
  notCaptured?: 'no-box' | 'outside-viewport' | 'covered' | 'cover-unknown' | 'moving' | 'detached' | 'transformed-frame';
  /** Once scrolled for capture, the measured region still reached beyond the viewport. */
  clippedByViewport?: boolean;
  /** See FocusStop.unstabilised. */
  unstabilised?: boolean;
}

export interface IconSurvey {
  candidates: IconCandidate[];
  /** Controls that qualified, including those beyond `maxCandidates`. */
  total: number;
  /** Controls looked at and left out, by reason (`hidden`, `small`, `large`, `noGraphic`, `unsupported`). */
  skipped: Record<string, number>;
}

/** Computed text style of a block: that of most of its characters. */
export interface TextStyle {
  /** First family of the computed `font-family`, lower case, without quotes. */
  family: string;
  /** Computed font size, CSS px. */
  size: number;
  /** Computed font weight, 1 to 1000. */
  weight: number;
  /** Computed colour: #rrggbb, or #rrggbbaa when it is translucent. */
  color: string;
  /** Computed `text-transform`. */
  transform: string;
  italic: boolean;
}

/**
 * Where a text block sits in the page, read from its ancestors (across shadow roots and frames).
 * A block has a context only when all of its text is inside one.
 * - `label`: `label` or `legend`. `caption`: `caption` or `figcaption`.
 * - `tableHeader`, `tableCell`: by tag or by role. `term`: `dt`.
 * - `button`: `button`, `summary`, or a widget role (button, tab, menuitem, option, switch, checkbox, radio, treeitem).
 * - `link`: `a[href]` or the role link.
 * - `quote`: `blockquote` or `q`. `code`: `pre`, `code`, `kbd` or `samp`.
 * - `navigation`: `nav`, or the role navigation, menu, menubar, tablist, toolbar, tree or listbox.
 * - `ariaHidden`: `aria-hidden="true"` or `inert`: not exposed to assistive technology at all.
 */
export type TextContext =
  | 'label'
  | 'caption'
  | 'tableHeader'
  | 'tableCell'
  | 'term'
  | 'button'
  | 'link'
  | 'quote'
  | 'code'
  | 'navigation'
  | 'ariaHidden';

/**
 * One block of visible text: the text nodes that are laid out together in one block container,
 * between two block-level boundaries, whatever their tags. A forced line break splits a block
 * only where the style changes across it. All boxes are CSS pixels in page coordinates.
 */
export interface TextBlock {
  /** The lowest element that holds all the text of the block, or the block container when the block is all its text. */
  selector: string;
  /** Same convention as FocusStop.frame. */
  frame: string;
  /** Local name of that element. */
  tag: string;
  /** Text with white space collapsed, cut to `maxTextChars`. */
  text: string;
  /** Characters of the whole text that are not white space. */
  chars: number;
  /** Runs of characters separated by white space, in the whole text. */
  words: number;
  /** Union of the painted line boxes. */
  box: Box;
  /** Painted lines. */
  lines: number;
  firstLine: Box;
  lastLine: Box;
  /** Forced line breaks (`br`) inside the block. */
  breaks: number;
  style: TextStyle;
  /** Share of the characters that have `style`, 0 to 1. Under 1, the block mixes styles (a bold lead-in). */
  styleShare: number;
  contexts: TextContext[];
  /** Inside `main` or the role main. */
  inMain: boolean;
  /** Inside a list item (`li`, or the role listitem). */
  inListItem: boolean;
  /**
   * The nearest enclosing region (a landmark element or role, `article`, `dialog`), as frame and
   * selector; empty outside any. Heading levels are compared inside one region only.
   */
  region: string;
  /**
   * Set when the accessibility tree exposes the block as a heading: an ancestor of all its text
   * is a node with the role heading that is not ignored. `selector` is that of the heading element.
   */
  heading: { level: number; selector: string } | null;
  /** Crop id of the capture of the block with what surrounds it; null when it was not captured. */
  crop: string | null;
  /** Other content lay over the middle of the block when it was to be captured (a banner, a dialog), so it was not. */
  covered?: boolean;
  /**
   * The text has exactly the colour of the background behind it, as far as styles tell: the
   * nearest opaque background colour among its ancestors, with no background image, translucent
   * colour, text shadow or text stroke on the way. It may still sit over a picture positioned
   * behind it, so it is read as text and only held back.
   */
  sameColourAsBackground?: boolean;
}

export interface HeadingSurvey {
  /** Visible text blocks in document order, frames in place. */
  blocks: TextBlock[];
  /** Blocks found, including those beyond `maxBlocks`. */
  total: number;
  /**
   * False when the accessibility tree of a document the survey looked into could not be read, or
   * one of its headings could not be matched to its element: which text is exposed as a heading
   * is then not known for certain, and nothing is reported above `info`.
   */
  axComplete: boolean;
}

export interface Snapshot {
  environment: Environment;
  /** Present when the headings check was collected. */
  headings?: HeadingSurvey;
  /** Present when the focus-indicator check was collected. */
  focus?: FocusWalk;
  /** Present when the icon-contrast check was collected. */
  icons?: IconSurvey;
  nodes: SnapshotNode[];
  axTree: AxNode[];
  screenshots: {
    tiles: Screenshot[];
    /** On-demand clips, keyed by the crop id that findings reference in `evidence.crops`. */
    clips: Record<string, Screenshot>;
  };
}

export interface Evidence {
  /** Crop ids (keys of `Snapshot.screenshots.clips`); reporters turn them into file paths. */
  crops: string[];
  /** Measured colours as #rrggbb, keyed by role (e.g. "indicator", "outer"). */
  colors: Record<string, string>;
  /** Measured contrast ratios, keyed by role. */
  ratios: Record<string, number>;
  /** e.g. "forced", "authorModified". */
  flags: string[];
  /** Other measured values and what was read from the page, keyed by name (font size, word count, text). */
  values?: Record<string, string | number | boolean>;
}

export type Verdict = 'yes' | 'no' | 'unsure';

export interface AiEvidence {
  model: string;
  promptVersion: string;
  votes: Verdict[];
  rationale: string;
}

export interface Finding {
  /** Stable fingerprint, see fingerprint.ts. */
  id: string;
  check: CheckId;
  /** The rule that fired, namespaced by check: "focus-indicator/no-visible-change". */
  rule: string;
  status: Status;
  /** Null only for inventory findings that relate to no success criterion. */
  wcag: WcagRef | null;
  selector: string;
  /** Frame id; empty string for the main frame. */
  frame: string;
  box: Box | null;
  evidence: Evidence;
  /** Absent when no model was involved. */
  ai?: AiEvidence;
  message: string;
  help: string;
}

/** A finding before its fingerprint is computed. */
export type FindingDraft = Omit<Finding, 'id'> & {
  /**
   * Takes the place of `rule` in the fingerprint, for a check that reports one thing under two
   * rule names depending on its status (a heading candidate): the id then survives the change.
   * Not part of the finding.
   */
  fingerprintRule?: string;
};

export interface Check {
  id: CheckId;
  /** Pure: same snapshot and config give the same findings. */
  evaluate(snapshot: Snapshot, config: Config): FindingDraft[];
}

export interface FocusConfig {
  /**
   * Device pixels per CSS pixel while measuring. At 2, a 1 CSS px line is two device pixels
   * wide, so it has pixels of its true colour and not only anti-aliased ones.
   */
  deviceScaleFactor: number;
  /** Margin captured around the element (and its labels). Larger outline offsets fall back to the viewport diff. */
  clipMarginCssPx: number;
  /** The Tab walk stops after this many elements. */
  maxTabStops: number;
  /** At most this many unreached focusable elements are measured with a forced state. */
  maxForced: number;
  /** Tab presses spent inside one cross-origin iframe before the walk moves focus past it. */
  maxTabsInOpaqueFrame: number;
  /**
   * A capture may differ by this many pixels, per side, from its clip size times the scale:
   * Chrome rounds the edges of a clip to device pixels. Beyond that, the scale is worked out from
   * the capture itself.
   */
  captureSizeTolerancePx: number;
  /** Animation frames to wait after each state change before capturing. */
  settleFrames: number;
  /** Upper bound for that wait, for pages where animation frames do not fire. */
  settleTimeoutMs: number;
  /** Longest wait for web fonts before the walk starts. */
  fontsTimeoutMs: number;
  /** CIEDE2000 difference above which a pixel counts as changed. Around 1 is just noticeable. */
  diffDeltaE: number;
  /** Changed regions smaller than this many square CSS pixels are discarded as noise. */
  minComponentAreaCssPx2: number;
  /** Changed regions measured per element, largest first. */
  maxComponents: number;
  /** Skipped next to an indicator before sampling adjacent colours: blended edge pixels. */
  adjacentGapCssPx: number;
  /** Width of the band sampled for adjacent colours. Kept under a 2px outline-offset. */
  adjacentBandCssPx: number;
  /** Colours closer than this (CIEDE2000) are the same colour when looking for dominant ones. */
  clusterDeltaE: number;
  /** A colour inside an indicator is considered only above this share of it. */
  minIndicatorShare: number;
  /** Below that share, a colour still counts if it reaches this share and forms a solid block (a bar, a ring). */
  minorPartMinShare: number;
  /** Side of that solid block. */
  minorPartSolidCssPx: number;
  /** An adjacent colour is considered only above this share of the sampled band. */
  minAdjacentShare: number;
  /** WCAG 1.4.11. */
  contrastThreshold: number;
  /** From here up to the threshold a low ratio is `likely`, not `fail`: absorbs anti-aliasing error. */
  likelyBandFloor: number;
  /** A changed region thicker than this in both directions, and covering its box, is a fill. */
  strokeMaxThicknessCssPx: number;
  /** Share of its bounding box a region must cover to be a fill. */
  fillMinCoverage: number;
  /** An unmodified browser indicator stays within this distance of the element box. */
  defaultRingMaxCssPx: number;
  /** Points per side of the grid sampled for 2.4.11. */
  obscuredGrid: number;
  /**
   * Points per side of the grid hit-tested from the top document before the captures, to find
   * content over the element that the 2.4.11 sampling cannot see (see FocusStop.possiblyCovered).
   */
  coverGrid: number;
  /**
   * Alpha of a background colour, and cumulated opacity of an element and its ancestors, from
   * which fixed or sticky content counts as opaque. Only opaque content can `fail` 2.4.11.
   */
  opaqueCoverMinAlpha: number;
  /** Cumulated opacity at or below which covering content is invisible and ignored. */
  invisibleCoverMaxOpacity: number;
  /** Box movement below this is not a geometry change. */
  geometryToleranceCssPx: number;
}

export interface IconConfig {
  /** At most this many controls are captured and measured, in document order. */
  maxCandidates: number;
  /** Margin captured around the control. */
  clipMarginCssPx: number;
  /** Controls smaller than this on either side are not looked at (visually hidden inputs, 1px links). */
  minControlSizeCssPx: number;
  /**
   * A graphic larger than this on either side is not an icon (a linked picture, a logo, a card
   * that is one link) and is left out.
   */
  maxGraphicSizeCssPx: number;
  /**
   * A text node or pseudo-element whose first font family matches this pattern (case-insensitive)
   * is an icon-font glyph even when its characters are letters (ligature icon fonts). Characters
   * of the Private Use Areas are glyphs whatever the font.
   */
  iconFontFamilyPattern: string;
  /**
   * A control whose class, or whose parent's class, matches this pattern (case-insensitive) may
   * be inactive without saying so with `disabled` or `aria-disabled`. Inactive controls are exempt.
   */
  inactiveHintPattern: string;
  /**
   * A control or graphic whose class, id, name or file name matches this pattern
   * (case-insensitive) may be a logotype, which is exempt.
   */
  logoHintPattern: string;
  /**
   * The accessible name of a link in the page header (`header`, `role="banner"`) matching this
   * pattern (case-insensitive) marks it as the home link, where a logotype usually is.
   */
  homeLinkNamePattern: string;
  /** Text clipped to less than this on either side is not visible text. */
  minVisibleTextCssPx: number;
  /** Wrappers of a field, up to this many levels, whose edges may be its boundary. */
  boundaryWrapperLevels: number;
  /** A wrapper counts only if it is at most this much taller than the field, above and below together. */
  boundaryWrapperSlackCssPx: number;
  /** Points per side of the grid hit-tested to make sure nothing else covers the graphic. */
  coverGrid: number;
  /** A graphic, or a part of one, smaller than this on either side paints nothing worth measuring; so does text of a smaller font size. */
  minPaintedSizeCssPx: number;
  /**
   * Slack when two boxes are compared for containment or equal size: an element laid over a
   * field counts as around it within this, and a box is untransformed when its layout size and
   * its size on screen agree within this.
   */
  boxToleranceCssPx: number;
  /** How far inside each side of a boundary control the point lies that is hit-tested for content in front of it. */
  boundaryProbeInsetCssPx: number;
  /** A control whose box moved by more than this between measuring it and capturing it is captured again. Sub-pixel differences are rounding. */
  sameBoxToleranceCssPx: number;
  /**
   * CSS properties (pattern on the property name) through which an author changes what the
   * boundary of a native control looks like. A native control with none of them declared by an
   * author rule has the browser default look, which is exempt.
   */
  boundaryAuthorPropertyPattern: string;

  /** Colours closer than this (CIEDE2000) are the same colour. */
  clusterDeltaE: number;
  /** Skipped between the graphic box and the band sampled for its background. */
  backgroundGapCssPx: number;
  /** Width of that band. */
  backgroundBandCssPx: number;
  /** The background is one colour when its most common colour reaches this share of the band. */
  uniformBackgroundMinShare: number;
  /** On a background of several colours, the icon is compared with those above this share of the band. */
  minBackgroundShare: number;
  /** Below this share of the graphic box, what differs from the background is noise, not a graphic. */
  minInkShare: number;
  /** A colour is a part of the icon (not anti-aliasing residue) from this share of its ink. */
  minPartShare: number;
  /**
   * Below `minPartShare`, a colour is still a part from this share if it forms a solid block: a
   * small detail can be the part that matters (a dark glyph on a pale disc).
   */
  minSolidPartShare: number;
  /**
   * A colour within this distance (Euclidean, 8-bit RGB) of the line between two other colours
   * is their anti-aliasing blend, not a colour of its own.
   */
  blendToleranceRgb: number;
  /**
   * A colour read from pixels is trusted as a true colour only if this share of its pixels is
   * interior (surrounded by pixels of the graphic). Strokes of about 1 CSS px and less have no
   * interior at the capture scale: every pixel of theirs may be blended with the background.
   */
  minInteriorShare: number;
  /**
   * A colour that forms a solid square of this side is a flat area of its own even when it lies
   * between two other colours (a gradient, a lighter tone of the same hue). Anti-aliasing never does.
   */
  flatBlockCssPx: number;
  /** Fewest interior pixels (see `minInteriorShare`) for a colour to be trusted, whatever its share. */
  minInteriorPixels: number;
  /** Smallest side of the solid square of `flatBlockCssPx`, in device pixels, whatever the scale: anti-aliasing can fill a smaller one. */
  flatBlockMinPx: number;
  /** More parts than this, and the graphic is a picture rather than an icon. */
  maxParts: number;
  /** Share of the ink that belongs to no part and no blend above which the graphic is a picture. */
  complexResidualShare: number;
  /**
   * A declared colour is taken as the colour of the icon when pixels of it are found, or when at
   * least this share of the ink is a blend of it with the background (strokes too thin to show it).
   */
  declaredBlendMinShare: number;
  /** WCAG 1.4.11. */
  contrastThreshold: number;
  /** From here up to the threshold a low ratio is `likely`, not `fail`. */
  likelyBandFloor: number;

  /** How far outside a boundary box its edge is looked for (outer shadows, rings). */
  boundaryReachCssPx: number;
  /** How far inside. Kept small so that the content of the control stays out. */
  boundaryDepthCssPx: number;
  /** Share of each side, around its middle, that is sampled: stays clear of rounded corners. */
  boundarySideShare: number;
  /** Shortest length sampled on a side, whatever its share. */
  boundaryMinSideCssPx: number;
  /** A colour counts on an edge from this share of the sampled zone: a 0.5px line still does. */
  boundaryMinShare: number;
  /**
   * Colours on an edge closer than this (CIEDE2000) are one colour. Smaller than `clusterDeltaE`:
   * a pale fill next to a white page must stay two colours, or a line is compared with their mix.
   */
  boundaryClusterDeltaE: number;
  /** Times a control is captured again when its box moved between measuring it and capturing it. */
  captureAttempts: number;
}

export interface HeadingsConfig {
  /** At most this many text blocks are read from the page, in document order. */
  maxBlocks: number;
  /** Text of a block kept in the snapshot, in characters. */
  maxTextChars: number;
  /** At most this many candidates are reported and captured: likely ones first, then in document order. */
  maxCandidates: number;
  /** At most this many contradictions between heading levels are reported and captured, in document order. */
  maxInversions: number;
  /** Text smaller than this on either side, once clipped by its containers, is not visible text. */
  minVisibleTextCssPx: number;
  /** Text of a smaller font size paints nothing worth reading. */
  minFontSizeCssPx: number;
  /**
   * Elements that bound a region (CSS selector). The visual rank and the level of two headings are
   * compared only inside one region, and text of two regions never shares a line.
   */
  regionSelector: string;
  /** Margin captured to the left and right of a candidate. */
  clipMarginCssPx: number;
  /** Captured above a candidate, to show what it follows. */
  clipAboveCssPx: number;
  /** Captured below a candidate, to show what it heads. */
  clipBelowCssPx: number;
  /** Text of the block before a candidate that is given as context (`HeadingCandidate.context.textBefore`), in characters. */
  contextBeforeMaxChars: number;
  /** Text of the block after a candidate that is given as context and as evidence (`textAfter`, `followedBy`), in characters. */
  contextAfterMaxChars: number;
  /** Text of a block quoted in the message of a finding, in characters. */
  messageTextMaxChars: number;

  /**
   * Fewest characters (white space apart) in the most common style of a pool of text for that
   * style to be taken as the body style. Under it inside `main`, the whole page is measured; under
   * it on the whole page, the body style is not trusted and no candidate is above `info`
   * (`lowText`).
   */
  baselineMinChars: number;
  /** `main` sets the body style only if it holds at least this share of the plain text of the page. */
  baselineMainMinShare: number;

  /**
   * A block is larger than body text from this ratio of font sizes. Set well above the ratio
   * that tells two sizes apart: text slightly larger than body text and no bolder is usually a
   * lead paragraph or a tagline (seen on real pages), not a heading.
   */
  minSizeRatio: number;
  /** A block is bolder than body text from this difference of font weights. */
  minWeightDelta: number;
  /** Bold text counts as prominent from this ratio to the body size: bold text of body size, not bold small print. */
  boldMinSizeRatio: number;
  /** The same for bold text in capitals (`text-transform: uppercase`), which is commonly set smaller. */
  uppercaseBoldMinSizeRatio: number;
  /** Longest heading, in words. Longer text is body text however it is styled. */
  maxWords: number;
  /** Longest heading, in characters that are not white space: the limit for text without spaces between words. */
  maxChars: number;
  /** Longest heading, in painted lines. */
  maxLines: number;
  /** Tighter word limit for text that is only bolder than body text: not larger, and not styled as a real heading. */
  maxBoldOnlyWords: number;
  /** Share of the characters of a block that must have its style: under it the block mixes styles. */
  uniformStyleMinShare: number;
  /** From this many forced line breaks, a block is lines of text (an address), not a heading. */
  maxBreaks: number;
  /**
   * Text ending like this (pattern, Unicode flag) reads as a sentence or a clause, not as a heading.
   * Question and exclamation marks are left out: headings do end with them.
   */
  sentenceEndPattern: string;
  /** Text ending like this introduces what follows (a lead-in). Whether it heads it is a judgement. */
  leadInEndPattern: string;
  /** Text opening like this is a quotation. */
  quoteStartPattern: string;
  /** Share of digits among letters and digits from which text is a number (a price, a statistic, a date). */
  numericMinDigitShare: number;
  /**
   * Text that starts with a number and has at most this many words may be a statistic
   * ("15 years", "3x faster") as well as a title ("2026 roadmap"): it is held back, and left to
   * a judgement.
   */
  statisticMaxWords: number;
  /**
   * Text opening like this is numbered, not a statistic: "1. Scope", "2) Method", and a number
   * of one or two digits, with or without parts after dots, before a capital letter
   * ("1 Introduction", "1.2 Requirements"). Scripts without capitals only have the first form.
   */
  ordinalStartPattern: string;
  /**
   * From this many blocks with the same text in the same style on a page, each of them is a label
   * (a badge under every product, "Read more" over every teaser), not a heading.
   */
  repeatedTextMinCount: number;
  /**
   * Text that is only bolder than body text heads little when what follows it is one block of at
   * most this many lines...
   */
  shortFollowerMaxLines: number;
  /** ...and at most this many words. Text no longer than the candidate itself always counts as little. */
  shortFollowerMaxWords: number;
  /**
   * True: one short line that ends like a sentence (`sentenceEndPattern`) is content, as a
   * paragraph of several lines is, so bold text over it can be `likely`. That keeps titles over
   * one-line paragraphs, and also the title of a callout or a name over one sentence. False: any
   * single short line under bold text holds it back, at the price of those titles (on the
   * mutation fixtures, 22 of 34 stripped headings are then `likely`, against 31).
   * Bold text smaller than body text is held back either way.
   */
  sentenceFollowerIsContent: boolean;
  /**
   * At most this many buttons or links that sit beside a candidate on its line (a "View all"
   * link at the end of the row of a title) are passed over to find what the candidate heads.
   */
  besideControlsMax: number;
  /**
   * Boxes of one style on one line inside one parent are one block of text when they are no
   * further apart than this many times the font size: the words of a title set as inline blocks
   * or flex items. Peers in a row (tabs, a menu) are set further apart.
   */
  mergeMaxGapEm: number;
  /**
   * A candidate is taken for a number when at least this share of the other blocks with its
   * exact style are numbers: "Free" among prices, "On request" among statistics.
   */
  peerDemotionMinShare: number;
  /** Fewest such look-alikes for that to apply. */
  peerDemotionMinPeers: number;
  /**
   * Two boxes are on one line when they overlap vertically by this share of the lower of the two.
   * Used for the painted lines of a block as well as for blocks that share a line.
   */
  sameLineMinOverlap: number;
  /**
   * Text before a candidate on its line, and no further from it than this many times its font
   * size, shares the line with it. Further away it is in another column.
   */
  sameLineMaxGapEm: number;
  /** Slack when boxes are compared: stacked, aligned, overlapping. */
  boxToleranceCssPx: number;
  /** Font sizes closer than this are one size. */
  sizeToleranceCssPx: number;
  /**
   * Open decision (section 10.3 of the brief): status of a heading level that contradicts the
   * visual order. `advisory` or `likely`; never `fail`.
   */
  inversionStatus: 'advisory' | 'likely';
  /** Status when the contradiction is extreme (both limits below). */
  extremeInversionStatus: 'advisory' | 'likely';
  /** A heading is visually above another from this ratio of font sizes. */
  inversionMinSizeRatio: number;
  /** Extreme: at least this ratio of font sizes... */
  extremeInversionMinSizeRatio: number;
  /** ...and at least this many levels apart. */
  extremeInversionMinLevelGap: number;
}

export interface Config {
  /** Checks to run, in any order. */
  checks: CheckId[];
  /**
   * Focus-indicator settings. Its capture settings (`deviceScaleFactor`, `settleFrames`,
   * `settleTimeoutMs`, `fontsTimeoutMs`) apply to every check that takes captures.
   */
  focus: FocusConfig;
  icon: IconConfig;
  headings: HeadingsConfig;
}

export interface ScanResult {
  tool: { name: string; version: string };
  url: string;
  /** ISO 8601. The only field allowed to differ between two runs on the same page. */
  timestamp: string;
  environment: Environment;
  findings: Finding[];
}
