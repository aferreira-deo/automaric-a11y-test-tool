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

export interface Snapshot {
  environment: Environment;
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

export interface Config {
  /** Checks to run, in any order. */
  checks: CheckId[];
}

export interface ScanResult {
  tool: { name: string; version: string };
  url: string;
  /** ISO 8601. The only field allowed to differ between two runs on the same page. */
  timestamp: string;
  environment: Environment;
  findings: Finding[];
}
