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
  /** Why `crops` is null. */
  notCaptured?: 'no-box' | 'obscured' | 'outside-viewport';
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

export interface Snapshot {
  environment: Environment;
  /** Present when the focus-indicator check was collected. */
  focus?: FocusWalk;
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
   * Alpha of a background colour, and cumulated opacity of an element and its ancestors, from
   * which fixed or sticky content counts as opaque. Only opaque content can `fail` 2.4.11.
   */
  opaqueCoverMinAlpha: number;
  /** Cumulated opacity at or below which covering content is invisible and ignored. */
  invisibleCoverMaxOpacity: number;
  /** Box movement below this is not a geometry change. */
  geometryToleranceCssPx: number;
}

export interface Config {
  /** Checks to run, in any order. */
  checks: CheckId[];
  focus: FocusConfig;
}

export interface ScanResult {
  tool: { name: string; version: string };
  url: string;
  /** ISO 8601. The only field allowed to differ between two runs on the same page. */
  timestamp: string;
  environment: Environment;
  findings: Finding[];
}
