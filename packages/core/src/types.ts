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

export interface Snapshot {
  environment: Environment;
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
export type FindingDraft = Omit<Finding, 'id'>;

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

export interface Config {
  /** Checks to run, in any order. */
  checks: CheckId[];
  /**
   * Focus-indicator settings. Its capture settings (`deviceScaleFactor`, `settleFrames`,
   * `settleTimeoutMs`, `fontsTimeoutMs`) apply to every check that takes captures.
   */
  focus: FocusConfig;
  icon: IconConfig;
}

export interface ScanResult {
  tool: { name: string; version: string };
  url: string;
  /** ISO 8601. The only field allowed to differ between two runs on the same page. */
  timestamp: string;
  environment: Environment;
  findings: Finding[];
}
