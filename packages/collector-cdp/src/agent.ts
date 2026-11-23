/**
 * Code that runs inside the page, in an isolated world: it shares the DOM with the page
 * but not its JavaScript globals, so nothing here is visible to page scripts.
 *
 * `agentFactory` is serialised with `toString()` and evaluated in the page. It must stay
 * self-contained: no imports, no references to anything outside its own body.
 */

export interface AgentOptions {
  settleFrames: number;
  settleTimeoutMs: number;
  fontsTimeoutMs: number;
  clipMarginCssPx: number;
  obscuredGrid: number;
  coverGrid: number;
  opaqueCoverMinAlpha: number;
  invisibleCoverMaxOpacity: number;
  icon: AgentIconOptions;
  headings: AgentHeadingsOptions;
  lists: AgentListsOptions;
  grouping: AgentGroupingOptions;
}

/** Subset of GroupingConfig the agent needs; documented there. */
export interface AgentGroupingOptions {
  maxControls: number;
  maxNameChars: number;
  maxAncestorLevels: number;
  minControlSizeCssPx: number;
  clipMarginCssPx: number;
  maxLabelTargets: number;
}

/** Mirror GroupingControl, GroupingGroup and GroupingBlock of core. */
export interface AgentGroupingControl {
  selector: string;
  frame: string;
  ord: number;
  chain: number[];
  box: AgentRect;
  proxied?: boolean;
  kind: 'radio' | 'checkbox' | 'field';
  role: string;
  element: string;
  name: string;
  description: string;
  setKey: string;
  form: number;
  region: string;
  cell: number;
  inWidget: boolean;
  fontSize: number;
  rtl: boolean;
  switch?: boolean;
}

export interface AgentGroupingGroup {
  selector: string;
  frame: string;
  ord: number;
  end: number;
  role: string;
  name: string;
}

export interface AgentGroupingBlock {
  frame: string;
  at: number;
  end: number;
  text: string;
  chars: number;
  words: number;
  lines: number;
  box: AgentRect;
  style: AgentTextStyle;
  contexts: AgentTextContext[];
  heading: number;
  labels: number[];
  group: number;
  describes: boolean;
  otherLabel: boolean;
  inControl: boolean;
  disclosure: boolean;
  free: boolean;
  freeText?: string;
}

export interface AgentGroupingSurvey {
  controls: AgentGroupingControl[];
  totalControls: number;
  groups: AgentGroupingGroup[];
  blocks: AgentGroupingBlock[];
  totalBlocks: number;
}

/** Subset of HeadingsConfig the agent needs; documented there. */
export interface AgentHeadingsOptions {
  maxBlocks: number;
  maxTextChars: number;
  minVisibleTextCssPx: number;
  minFontSizeCssPx: number;
  regionSelector: string;
  clipMarginCssPx: number;
  clipAboveCssPx: number;
  clipBelowCssPx: number;
  sameLineMinOverlap: number;
  mergeMaxGapEm: number;
}

/** Subset of ListsConfig the agent needs; documented there. */
export interface AgentListsOptions {
  lineStartChars: number;
  lineEndChars: number;
  keySeparatorChars: string;
  maxGroupParents: number;
  maxAncestorLevels: number;
  markerAncestorLevels: number;
  maxGroups: number;
  maxGroupItems: number;
  maxListElements: number;
  markerMinSizeCssPx: number;
  markerMaxSizeCssPx: number;
  markerMaxGapEm: number;
  markerRoomEm: number;
  shapeDepth: number;
  minRepeatedItems: number;
  itemTextMaxChars: number;
  clipMarginCssPx: number;
  clipMarkerRoomCssPx: number;
  sameRowMinOverlap: number;
}

/** Mirror ListMarker, ListLine, ListBlock, ListGroupItem, ListGroup and ListElement of core. */
export interface AgentListMarker {
  kind: 'pseudo-text' | 'pseudo-counter' | 'pseudo-shape' | 'image' | 'shape' | 'list-item';
  text: string;
  key: string;
}

export interface AgentListLine {
  start: string;
  box: AgentRect;
  marker?: AgentListMarker;
  end: string;
  startColor: string;
  keyStyle?: string;
}

export interface AgentListBlock {
  selector: string;
  frame: string;
  tag: string;
  text: string;
  chars: number;
  words: number;
  box: AgentRect;
  lines: number;
  firstLine: AgentRect;
  style: AgentTextStyle;
  contexts: AgentTextContext[];
  inList: boolean;
  heading: boolean;
  rtl: boolean;
  clickable?: boolean;
  chain: number[];
  segments: AgentListLine[];
}

export interface AgentListGroupItem {
  box: AgentRect;
  ord: number;
  end: number;
  blocks: number;
  chars: number;
  links: number;
  linkChars: number;
  buttonChars: number;
  controls: number;
  graphics: number;
  lists: number;
  heading: 'none' | 'plain' | 'link';
  text: string;
}

export interface AgentListGroup {
  selector: string;
  frame: string;
  ord: number;
  end: number;
  count: number;
  looseChars: number;
  items: AgentListGroupItem[];
  navigation: boolean;
  target: number;
}

export interface AgentListElement {
  kind: 'presentational' | 'unstyled';
  selector: string;
  frame: string;
  tag: string;
  box: AgentRect;
  ord: number;
  items: number;
  markers: number;
  markersInside: boolean;
  target: number;
}

export interface AgentListSurvey {
  blocks: AgentListBlock[];
  totalBlocks: number;
  groups: AgentListGroup[];
  totalGroups: number;
  parents: number;
  totalParents: number;
  lists: AgentListElement[];
  totalLists: number;
  exposedLists: number;
}

/** Mirrors TextContext, TextStyle and TextBlock of core (the agent cannot import). */
export type AgentTextContext =
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

export interface AgentTextStyle {
  family: string;
  size: number;
  weight: number;
  color: string;
  transform: string;
  italic: boolean;
}

export interface AgentTextBlock {
  selector: string;
  frame: string;
  tag: string;
  text: string;
  chars: number;
  words: number;
  box: AgentRect;
  lines: number;
  firstLine: AgentRect;
  lastLine: AgentRect;
  breaks: number;
  style: AgentTextStyle;
  styleShare: number;
  contexts: AgentTextContext[];
  inMain: boolean;
  inListItem: boolean;
  region: string;
  heading: { level: number; selector: string } | null;
  sameColourAsBackground?: boolean;
}

export interface AgentHeadingSurvey {
  blocks: AgentTextBlock[];
  total: number;
}

export interface AgentHeadingPrepared {
  /** Region to capture, page coordinates, whole CSS pixels. Null when the block cannot be shown. */
  clip: AgentRect | null;
  /** The text of the block when the clip was worked out, same coordinates. Null with no clip. */
  target?: AgentRect | null;
  /** Other content lies over the middle of the block. */
  covered: boolean;
}

/** Subset of IconConfig the agent needs; documented there. */
export interface AgentIconOptions {
  clipMarginCssPx: number;
  minControlSizeCssPx: number;
  maxGraphicSizeCssPx: number;
  iconFontFamilyPattern: string;
  inactiveHintPattern: string;
  logoHintPattern: string;
  homeLinkNamePattern: string;
  minPaintedSizeCssPx: number;
  boxToleranceCssPx: number;
  boundaryProbeInsetCssPx: number;
  minVisibleTextCssPx: number;
  boundaryWrapperLevels: number;
  boundaryWrapperSlackCssPx: number;
  coverGrid: number;
}

export type AgentIconSource =
  | 'svg'
  | 'img'
  | 'font-glyph'
  | 'background-image'
  | 'mask-image'
  | 'pseudo-element'
  | 'css-shape';

export interface AgentIconItem {
  /** Handle for later calls; stable for the lifetime of the agent. */
  key: number;
  selector: string;
  frame: string;
  kind: 'icon' | 'boundary';
  disabled: boolean;
  /** Icon controls: what draws the graphic, in a fixed order. */
  sources: AgentIconSource[];
  /** Icon controls: #rrggbb when computed styles give one opaque colour for the whole graphic. */
  declaredColor: string | null;
  /** Boundary controls. */
  control: 'text-field' | 'select' | 'checkbox' | 'radio' | 'switch' | null;
  /** Boundary controls: an input, textarea or select, whose default look belongs to the browser. */
  native: boolean;
  /** Signs in styles and markup that the control may be exempt; see IconCandidate.hints. */
  hints: AgentIconHint[];
}

export type AgentIconHint = 'inactive' | 'logo' | 'home-link' | 'plain-shape' | 'visible-label' | 'duplicate-link';

/**
 * What a hit test found at a point, in relation to an element. `own`: the element, something in
 * it, or what lies behind it. `cover`: other content, in front of it. `through`: other content
 * that paints nothing there (a transparent box, opacity 0), so what is under it shows.
 */
export type AgentHitKind = 'own' | 'through' | 'cover';

export interface AgentIconSurvey {
  total: number;
  skipped: Record<string, number>;
  items: AgentIconItem[];
}

/** All rectangles in page coordinates. */
export interface AgentIconPrepared {
  box: AgentRect | null;
  /** Icon controls: box of the graphic, and whether it is the graphic's own box or the control's padding box. */
  graphic: AgentRect | null;
  graphicFrom: 'graphic' | 'control';
  /** Icon controls: padding box of the control. */
  room: AgentRect | null;
  /** Boundary controls: the control's box, then its tight wrappers, innermost first. */
  boxes: AgentRect[];
  clip: AgentRect | null;
  reason: 'no-box' | 'outside-viewport' | 'covered' | 'detached' | 'transformed-frame' | null;
  /** Points, in page coordinates, where the caller must make sure with a real hit test that nothing covers the control. */
  probes: [number, number][];
  clipped: boolean;
  stable: boolean;
}

export interface AgentObscured {
  /** Sampled points under unrelated fixed or sticky content that is not invisible. */
  covered: number;
  sampled: number;
  by: string;
  /** How many of the covered points lie under content that is demonstrably opaque. */
  opaque: number;
}

export interface AgentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AgentElementInfo {
  /** Handle for later calls; stable for the lifetime of the agent. */
  key: number;
  selector: string;
  frame: string;
  textEntry: boolean;
  opaqueFrame: boolean;
  obscured: AgentObscured | null;
}

export interface AgentPrepared {
  /** Element border box, page coordinates. Null when it has none. */
  box: AgentRect | null;
  /** Region to capture, page coordinates, snapped to whole CSS pixels. */
  clip: AgentRect | null;
  reason: 'no-box' | 'outside-viewport' | 'obscured' | 'transformed-frame' | null;
  /** Points over the element, in page coordinates, for the caller to hit-test for covers this code cannot see. */
  probes: [number, number][];
  /** A parent document has other content over the iframe the element is in, at one of those points. */
  frameCovered: boolean;
  /** Entirely under fixed or sticky content that is not demonstrably opaque; captured all the same. */
  covered: boolean;
  /** The border box reaches beyond the viewport (of the page or of its own frame) on at least one side. */
  clipped: boolean;
  /** The stabilising styles are in effect on the element. */
  stable: boolean;
}

export interface AgentBlurred {
  box: AgentRect | null;
  /** False when the element is still the focused element after the blur settled. */
  blurred: boolean;
}

export interface Agent {
  stabilise(): Promise<void>;
  settle(): Promise<void>;
  active(): AgentElementInfo | null;
  prepare(key: number): Promise<AgentPrepared>;
  box(key: number): AgentRect | null;
  blur(key: number): Promise<AgentBlurred>;
  isActive(key: number): boolean;
  refocus(key: number): Promise<void>;
  skipFrames(frames: number[], from: number | null): Promise<void>;
  blurActive(): Promise<void>;
  viewport(): AgentRect;
  unreached(max: number): { total: number; items: AgentElementInfo[] };
  iconSurvey(max: number): AgentIconSurvey;
  prepareIcon(key: number): Promise<AgentIconPrepared>;
  hitKind(key: number, hit: unknown, mode: 'icon' | 'focus'): AgentHitKind;
  coveredBelow(key: number, x: number, y: number, mode: 'icon' | 'focus'): boolean;
  connected(key: number): boolean;
  element(key: number): Element;
  /** Records that the accessibility tree exposes this element as a heading. Called on the node itself. */
  markHeading(element: unknown, level: number): boolean;
  /** True for a frame element whose document the agent can look into. */
  frameReadable(element: unknown): boolean;
  /** Has the browser render what it skips (`content-visibility: auto`), until cleanup(). Called before the accessibility tree and the text are read. */
  renderAll(): Promise<void>;
  headingSurvey(): AgentHeadingSurvey;
  prepareHeading(index: number): Promise<AgentHeadingPrepared>;
  /** Records that the accessibility tree exposes this element as a list or a description list. Called on the node itself. */
  markList(element: unknown): boolean;
  listSurvey(): AgentListSurvey;
  /** Selectors of elements of the last list or grouping survey, by their position; null for a position it does not know. */
  listSelectors(ords: number[]): (string | null)[];
  /** Scrolls what a finding of the lists check is about into view and says what to capture. */
  prepareList(kind: 'blocks' | 'elements', ids: number[]): Promise<AgentHeadingPrepared>;
  /** Records what the accessibility tree says about a form control: its role, its name and its description. Called on the node itself. */
  markControl(element: unknown, role: string, name: string, description: string): boolean;
  /** Records that the accessibility tree exposes this element as a group or another container with a role, and its name. Called on the node itself. */
  markGroup(element: unknown, role: string, name: string): boolean;
  groupingSurvey(): AgentGroupingSurvey;
  /**
   * Scrolls what a finding of the grouping check is about into view and says what to capture:
   * blocks of text and controls of the last grouping survey, by index. `target` is the block to
   * point at inside the capture, or -1 for all of it.
   */
  prepareGrouping(blocks: number[], controls: number[], target: number): Promise<AgentHeadingPrepared>;
  cleanup(): void;
}

export const AGENT_GLOBAL = '__a11yVisionAgent';

export function agentFactory(options: AgentOptions): Agent {
  const STABILISER_CSS =
    '*,*::before,*::after{' +
    // Zero durations jump to the end state and keep fill-mode results, unlike `animation: none`.
    'transition-duration:0s!important;transition-delay:0s!important;' +
    'animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;' +
    'caret-color:transparent!important;scroll-behavior:auto!important}' +
    // Tab selects the text of a field. The highlight is not a focus indicator.
    '*::selection{background:transparent!important}';
  const FOCUSABLE =
    'a[href],area[href],button,input:not([type="hidden"]),select,textarea,summary,' +
    '[tabindex],[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],' +
    'audio[controls],video[controls]';
  const TEXT_INPUT_TYPES = ['text', 'search', 'url', 'tel', 'email', 'password', 'number'];
  const JOIN = ' >>> ';

  const elements = new Map<number, Element>();
  const keys = new WeakMap<Element, number>();
  const tabbed = new Set<number>();
  const sheets: { root: Document | ShadowRoot; sheet: CSSStyleSheet }[] = [];
  const styledRoots = new WeakSet<Node>();
  /** Frames taken out of the Tab order by skipFrames, with the tabindex attribute they had. */
  const skippedFrames = new Map<Element, string | null>();
  let nextKey = 1;

  function keyOf(element: Element): number {
    let key = keys.get(element);
    if (key === undefined) {
      key = nextKey++;
      keys.set(element, key);
      elements.set(key, element);
    }
    return key;
  }

  function get(key: number): Element {
    const element = elements.get(key);
    if (!element) throw new Error('Unknown element key ' + key);
    return element;
  }

  // `instanceof ShadowRoot` fails for nodes of another frame, so test the shape instead.
  function hostOf(node: Node | null): Element | null {
    return node && node.nodeType === 11 && 'host' in node ? (node as ShadowRoot).host : null;
  }

  function composedParent(node: Node): Node | null {
    const parent = node.parentNode;
    return hostOf(parent) ?? parent;
  }

  function composedContains(ancestor: Node, node: Node | null): boolean {
    for (let current = node; current; current = composedParent(current)) {
      if (current === ancestor) return true;
    }
    return false;
  }

  function frameElementOf(element: Element): Element | null {
    try {
      return element.ownerDocument.defaultView?.frameElement ?? null;
    } catch {
      return null;
    }
  }

  function frameDocument(frame: Element): Document | null {
    try {
      return (frame as HTMLIFrameElement).contentDocument ?? null;
    } catch {
      return null;
    }
  }

  function isFrame(element: Element): boolean {
    return element.localName === 'iframe' || element.localName === 'frame';
  }

  /**
   * The stabilising rules go in a constructed style sheet adopted by the document or shadow root,
   * not in a <style> element: a Content-Security-Policy with a restrictive style-src silently
   * drops injected <style> elements, but does not apply to constructed sheets (verified in
   * Chrome with style-src 'nonce-…', style-src 'none' and default-src 'none'). It also adds no
   * node to the page. Whether the rules win the cascade on a given element is checked by isStable.
   */
  function ensureStable(root: Node): void {
    if (styledRoots.has(root)) return;
    styledRoots.add(root);
    const owner = root as Document | ShadowRoot;
    const doc = root.nodeType === 9 ? (root as Document) : root.ownerDocument;
    try {
      // A sheet can only be adopted by a document of the window whose constructor made it.
      const view = doc?.defaultView as (Window & { CSSStyleSheet: typeof CSSStyleSheet }) | null | undefined;
      if (!view) return;
      const sheet = new view.CSSStyleSheet();
      sheet.replaceSync(STABILISER_CSS);
      owner.adoptedStyleSheets = [...owner.adoptedStyleSheets, sheet];
      sheets.push({ root: owner, sheet });
    } catch {
      // isStable reports the element as unstabilised.
    }
  }

  function ensureStableAround(element: Element): void {
    for (let current: Element | null = element; current; ) {
      const root = current.getRootNode();
      ensureStable(root);
      current = hostOf(root) ?? (root.nodeType === 9 ? frameElementOf(current) : null);
    }
  }

  function alphaOf(color: string): number {
    // Computed colours: "rgb(r, g, b)", "rgba(r, g, b, a)", or a colour function ending in "/ a)".
    const slash = color.lastIndexOf('/');
    if (slash >= 0) return parseFloat(color.slice(slash + 1));
    const legacy = /^rgba\(.*,\s*([\d.e+-]+)\)$/.exec(color);
    if (legacy) return parseFloat(legacy[1]!);
    return color === 'transparent' ? 0 : 1;
  }

  /** True when the stabilising rules are what the element actually computes to. */
  function isStable(element: Element): boolean {
    const view = element.ownerDocument.defaultView;
    if (!view) return false;
    const style = view.getComputedStyle(element);
    const zero = (list: string): boolean => list.split(',').every((item) => parseFloat(item) === 0);
    if (!zero(style.transitionDuration) || !zero(style.transitionDelay)) return false;
    if (style.animationName !== 'none' && (!zero(style.animationDuration) || !zero(style.animationDelay))) return false;
    return !isTextEntry(element) || alphaOf(style.caretColor) === 0;
  }

  function settle(): Promise<void> {
    return new Promise((resolve) => {
      let remaining = options.settleFrames;
      const timer = setTimeout(resolve, options.settleTimeoutMs);
      const step = (): void => {
        if (--remaining <= 0) {
          clearTimeout(timer);
          resolve();
        } else {
          requestAnimationFrame(step);
        }
      };
      requestAnimationFrame(step);
    });
  }

  function deepActive(): Element | null {
    let element: Element | null = document.activeElement;
    while (element) {
      const inner: Element | null | undefined = element.shadowRoot?.activeElement;
      if (inner) {
        element = inner;
        continue;
      }
      if (isFrame(element)) {
        const doc = frameDocument(element);
        const active: Element | null | undefined = doc?.activeElement;
        if (doc && active && active !== doc.body && active !== doc.documentElement) {
          element = active;
          continue;
        }
      }
      break;
    }
    if (!element || element === document.body || element === document.documentElement) return null;
    return element;
  }

  function selectorWithin(element: Element): string {
    const root = element.getRootNode() as Document | ShadowRoot;
    const uniqueId = (candidate: Element): string | null => {
      if (!candidate.id) return null;
      const selector = '#' + CSS.escape(candidate.id);
      return root.querySelectorAll(selector).length === 1 ? selector : null;
    };
    const parts: string[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) {
      const id = uniqueId(current);
      if (id) {
        parts.unshift(id);
        break;
      }
      const tag = current.localName;
      let index = 1;
      let twins = 0;
      for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.localName === tag) index++;
      }
      for (let sibling = current.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
        if (sibling.localName === tag) twins++;
      }
      parts.unshift(index === 1 && twins === 0 ? tag : tag + ':nth-of-type(' + index + ')');
    }
    return parts.join(' > ');
  }

  /** Selector that crosses shadow boundaries: host selectors, then the element, joined with " >>> ". */
  function selectorOf(element: Element): string {
    const parts = [selectorWithin(element)];
    for (let host = hostOf(element.getRootNode()); host; host = hostOf(host.getRootNode())) {
      parts.unshift(selectorWithin(host));
    }
    return parts.join(JOIN);
  }

  function frameOf(element: Element): string {
    const parts: string[] = [];
    for (let frame = frameElementOf(element); frame; frame = frameElementOf(frame)) {
      parts.unshift(selectorOf(frame));
    }
    return parts.join(JOIN);
  }

  /**
   * Offset from the client coordinates of the element's frame to those of the top-level viewport.
   * The content of a frame starts at its content box: after the border and the padding.
   */
  function frameOffset(element: Element): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (let frame = frameElementOf(element); frame; frame = frameElementOf(frame)) {
      const origin = contentOrigin(frame);
      x += origin.x;
      y += origin.y;
    }
    return { x, y };
  }

  /** Where the content of a frame starts, in the client coordinates of the document the frame element is in. */
  function contentOrigin(frame: Element): { x: number; y: number } {
    const outer = frame.getBoundingClientRect();
    const style = frame.ownerDocument.defaultView?.getComputedStyle(frame);
    return {
      x: outer.left + frame.clientLeft + (style ? parseFloat(style.paddingLeft) || 0 : 0),
      y: outer.top + frame.clientTop + (style ? parseFloat(style.paddingTop) || 0 : 0),
    };
  }

  /**
   * True when a frame the element is nested in, or anything around such a frame, is scaled,
   * rotated, skewed or zoomed. The bounding box of a frame then says where the frame is, but not
   * where a point inside it lands, and its content is not at the capture scale either: nothing in
   * such a frame is measured. A plain translation moves the box and everything in it alike.
   */
  function inTransformedFrame(element: Element): boolean {
    for (let frame = frameElementOf(element); frame; frame = frameElementOf(frame)) {
      for (let current: Node | null = frame; current; current = composedParent(current)) {
        if (current.nodeType !== 1) continue;
        const style = (current as Element).ownerDocument.defaultView?.getComputedStyle(current as Element);
        if (!style) return true;
        if (style.rotate !== 'none' || style.scale !== 'none') return true;
        if (style.zoom !== undefined && style.zoom !== '' && parseFloat(style.zoom) !== 1) return true;
        if (style.transform !== 'none' && !/^matrix\(1, 0, 0, 1, [^,]+, [^,]+\)$/.test(style.transform)) return true;
      }
    }
    return false;
  }

  /** Border box in the coordinates of the top-level viewport. */
  function viewportRect(element: Element): AgentRect {
    const rect = element.getBoundingClientRect();
    const offset = frameOffset(element);
    return { x: rect.left + offset.x, y: rect.top + offset.y, width: rect.width, height: rect.height };
  }

  function toPage(rect: AgentRect): AgentRect {
    return { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height };
  }

  function isTextEntry(element: Element): boolean {
    if (element.localName === 'textarea') return true;
    if (element.localName === 'input') return TEXT_INPUT_TYPES.includes((element as HTMLInputElement).type);
    return (element as HTMLElement).isContentEditable === true;
  }

  function isOpaqueFrame(element: Element): boolean {
    return isFrame(element) && frameDocument(element) === null;
  }

  function topElementAt(doc: Document, x: number, y: number): Element | null {
    let top = doc.elementFromPoint(x, y);
    while (top?.shadowRoot) {
      const inner = top.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === top) break;
      top = inner;
    }
    return top;
  }

  /**
   * True when, in a document the element's frame is nested in, something other than that frame
   * is on top at the point: content of a parent page lying over the frame. `x` and `y` are client
   * coordinates of the element's own document.
   */
  function frameCoveredAt(element: Element, x: number, y: number): boolean {
    for (let frame = frameElementOf(element); frame; frame = frameElementOf(frame)) {
      const origin = contentOrigin(frame);
      x += origin.x;
      y += origin.y;
      if (topElementAt(frame.ownerDocument, x, y) !== frame) return true;
    }
    return false;
  }

  const PAINTS_ITSELF = ['img', 'picture', 'canvas', 'video', 'iframe', 'frame', 'object', 'embed', 'input', 'textarea', 'select', 'button', 'hr', 'meter', 'progress'];

  /**
   * True when a box that was hit paints nothing over what lies under it: it is invisible
   * (cumulated opacity), or it is an HTML box without background, border, shadow, backdrop
   * filter or text of its own. A transparent container over the page (for toasts, for a closed
   * dialog) is hit by a hit test that ignores `pointer-events`, and hides nothing.
   */
  function paintsNothing(element: Element, pseudo: string | null): boolean {
    const view = element.ownerDocument.defaultView;
    if (!view) return false;
    const style = view.getComputedStyle(element, pseudo);
    // A pseudo-element that is not generated.
    if (pseudo && (style.content === 'none' || style.content === 'normal' || style.display === 'none')) return true;
    let opacity = pseudo ? parseFloat(style.opacity) : 1;
    for (let current: Node | null = element; current; current = composedParent(current)) {
      if (current.nodeType !== 1) continue;
      const own = parseFloat(view.getComputedStyle(current as Element).opacity);
      opacity *= Number.isFinite(own) ? own : 0;
    }
    if (opacity <= options.invisibleCoverMaxOpacity) return true;
    if (alphaOf(style.backgroundColor) > 0 || style.backgroundImage !== 'none' || hasBorder(style)) return false;
    if (style.boxShadow !== 'none' || style.backdropFilter !== 'none' || style.maskImage !== 'none') return false;
    if (pseudo) return /^(""|'')$/.test(style.content);
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || PAINTS_ITSELF.includes(element.localName)) return false;
    for (const child of element.childNodes) {
      if (child.nodeType === 3 && (child as Text).data.trim() !== '') return false;
    }
    return true;
  }

  /** Icon controls: the element inside which other content may lie over the measured area, set by prepareIcon. */
  const iconOuter = new Map<number, Element>();

  /**
   * Judges what Chrome's own hit test found at a point over the element held under `key`. That
   * hit test starts in the top document and does not skip `pointer-events: none`, and it names
   * pseudo-elements (as a CSSPseudoElement object), so it sees the three kinds of cover that
   * `elementFromPoint` in the element's own document cannot: content of a parent page over an
   * iframe, a layer that lets pointer events through, and a veil painted by a pseudo-element of
   * an ancestor.
   *
   * `icon`: anything in front that is not part of the control is a cover. `focus`: only those
   * three kinds are, because the 2.4.11 sampling already deals with what it can see, and a
   * neighbour laid over a control is often what shows its focus (a custom checkbox).
   */
  function hitKind(key: number, hit: unknown, mode: 'icon' | 'focus'): AgentHitKind {
    const element = get(key);
    let node: Element | null = null;
    let pseudo: string | null = null;
    if (hit && typeof hit === 'object' && (hit as Node).nodeType === 1) node = hit as Element;
    else if (hit && typeof hit === 'object' && 'element' in hit && 'type' in hit) {
      node = (hit as { element: Element }).element;
      pseudo = String((hit as { type: unknown }).type);
    }
    if (!node || node.nodeType !== 1) return 'cover';
    const target = node;
    const blocked = (): AgentHitKind => (paintsNothing(target, pseudo) ? 'through' : 'cover');

    if (mode === 'icon') {
      const outer = iconOuter.get(key) ?? element;
      if (composedContains(outer, node)) return 'own';
      // An ancestor itself lies behind the control; its pseudo-element can lie in front.
      if (!pseudo && composedContains(node, element)) return 'own';
      return blocked();
    }

    // The content of a frame that is, or is inside, the element belongs to it.
    let inner: Element | null = node;
    while (inner && inner.ownerDocument !== element.ownerDocument) inner = frameElementOf(inner);
    if (inner && composedContains(element, inner)) return 'own';
    if (node.ownerDocument !== element.ownerDocument) return blocked();
    if (composedContains(node, element)) return pseudo ? blocked() : 'own';
    const labels = (element as HTMLInputElement).labels;
    if (labels) {
      for (const label of labels) if (composedContains(label, node)) return 'own';
    }
    const style = node.ownerDocument.defaultView?.getComputedStyle(node, pseudo);
    return style?.pointerEvents === 'none' ? blocked() : 'own';
  }

  const FORCE_POINTER_EVENTS_CSS = '*,*::before,*::after{pointer-events:auto!important}';

  /**
   * Runs `read` while everything in `root`, and in the trees it is nested in, takes pointer
   * events, so that `elementsFromPoint` lists layers with `pointer-events: none` too. The style
   * sheet is adopted and dropped within one task: nothing is painted with it, and no event tells
   * the page. An author `!important` rule can still outweigh it; the caller starts from Chrome's
   * own hit test, which no rule escapes.
   */
  function withPointerEvents<T>(root: Document | ShadowRoot, read: () => T): T {
    const adopted: { owner: Document | ShadowRoot; sheet: CSSStyleSheet }[] = [];
    try {
      for (let current: Node | null = root; current; ) {
        const owner = current as Document | ShadowRoot;
        const doc = current.nodeType === 9 ? (current as Document) : current.ownerDocument;
        const view = doc?.defaultView as (Window & { CSSStyleSheet: typeof CSSStyleSheet }) | null | undefined;
        if (!view) throw new Error('No window');
        const sheet = new view.CSSStyleSheet();
        sheet.replaceSync(FORCE_POINTER_EVENTS_CSS);
        owner.adoptedStyleSheets = [...owner.adoptedStyleSheets, sheet];
        adopted.push({ owner, sheet });
        const host = hostOf(current);
        current = host ? host.getRootNode() : null;
      }
      return read();
    } finally {
      for (const { owner, sheet } of adopted) {
        owner.adoptedStyleSheets = owner.adoptedStyleSheets.filter((other) => other !== sheet);
      }
    }
  }

  /**
   * Called when Chrome's hit test found, on top at a point, something that paints nothing: what
   * lies under it, in front of the element? Walks the stack of elements at the point, from the
   * top document down through the frames the element is nested in, until it reaches the element.
   * True when something in front paints, or when that cannot be told. `x` and `y` are page coordinates.
   *
   * `elementsFromPoint` answers with the element for a hit on its pseudo-elements, so an
   * ancestor listed in front of the element stands for its `::before` or `::after`.
   */
  function coveredBelow(key: number, pageX: number, pageY: number, mode: 'icon' | 'focus'): boolean {
    const element = get(key);
    const outer = mode === 'icon' ? (iconOuter.get(key) ?? element) : element;
    const steps: { root: Document | ShadowRoot; pass: Element | null }[] = [
      { root: element.getRootNode() as Document | ShadowRoot, pass: null },
    ];
    for (let frame = frameElementOf(element); frame; frame = frameElementOf(frame)) {
      steps.unshift({ root: frame.getRootNode() as Document | ShadowRoot, pass: frame });
    }
    const labels = [...((element as HTMLInputElement).labels ?? [])];
    let x = pageX - window.scrollX;
    let y = pageY - window.scrollY;
    try {
      for (const { root, pass } of steps) {
        if (!('elementsFromPoint' in root)) return true;
        const seen = new Set(root.elementsFromPoint(x, y));
        const stack = withPointerEvents(root, () => root.elementsFromPoint(x, y));
        let reached = false;
        for (const entry of stack) {
          if (pass ? entry === pass : composedContains(outer, entry)) {
            reached = true;
            break;
          }
          const ancestor = !pass && composedContains(entry, element);
          if (mode === 'focus' && !pass && !ancestor) {
            // What takes pointer events in the element's own document is the business of the 2.4.11 sampling.
            if (seen.has(entry) || labels.some((label) => composedContains(label, entry))) continue;
          }
          const noPseudo = paintsNothing(entry, '::before') && paintsNothing(entry, '::after');
          // An ancestor's own box lies behind the element; a shadow host stands for anything in its tree.
          if (ancestor ? !noPseudo || entry.shadowRoot !== null : !noPseudo || !paintsNothing(entry, null)) return true;
        }
        // The element is not at the point at all: nothing can be said about it there.
        if (!reached) return mode === 'icon';
        if (pass) {
          const origin = contentOrigin(pass);
          x -= origin.x;
          y -= origin.y;
        }
      }
    } catch {
      return true;
    }
    return false;
  }

  /**
   * 2.4.11: samples a grid over the element and counts the points whose topmost element is
   * unrelated to it and sits in fixed or sticky content. Other overlaps are not counted:
   * only the overlay patterns the criterion names are certain enough.
   * Looks at the element's own document only; an overlay in a parent document is not seen.
   */
  function contains(rect: DOMRect, x: number, y: number): boolean {
    return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
  }

  /**
   * What the content hit at a point does to what lies behind it. `top` is the hit element and
   * `layer` its fixed or sticky ancestor.
   * - `none`: the cumulated opacity makes it invisible.
   * - `opaque`: nothing reduces its opacity or blends it, and an element between `top` and
   *   `layer` paints a solid background colour over the point.
   * - `unknown`: anything else, such as a translucent colour, an image or gradient, or text only.
   */
  function coverAt(top: Element, layer: Element, x: number, y: number, view: Window): 'none' | 'opaque' | 'unknown' {
    let opacity = 1;
    let blended = false;
    for (let current: Node | null = top; current; current = composedParent(current)) {
      if (current.nodeType !== 1) continue;
      const style = view.getComputedStyle(current as Element);
      const own = parseFloat(style.opacity);
      opacity *= Number.isFinite(own) ? own : 0;
      if (style.mixBlendMode !== 'normal' || style.filter !== 'none' || style.maskImage !== 'none') blended = true;
    }
    if (opacity <= options.invisibleCoverMaxOpacity) return 'none';
    if (opacity < options.opaqueCoverMinAlpha || blended) return 'unknown';
    for (let current: Node | null = top; current; current = composedParent(current)) {
      if (current.nodeType === 1) {
        const background = view.getComputedStyle(current as Element).backgroundColor;
        if (
          alphaOf(background) >= options.opaqueCoverMinAlpha &&
          contains((current as Element).getBoundingClientRect(), x, y)
        ) {
          return 'opaque';
        }
      }
      if (current === layer) break;
    }
    return 'unknown';
  }

  function obscuredInfo(element: Element): AgentElementInfo['obscured'] {
    const doc = element.ownerDocument;
    const view = doc.defaultView;
    const rect = element.getBoundingClientRect();
    if (!view || rect.width <= 0 || rect.height <= 0) return null;
    const grid = options.obscuredGrid;
    let sampled = 0;
    let covered = 0;
    let opaque = 0;
    let by = '';
    for (let row = 0; row < grid; row++) {
      for (let column = 0; column < grid; column++) {
        const x = rect.left + ((column + 0.5) / grid) * rect.width;
        const y = rect.top + ((row + 0.5) / grid) * rect.height;
        if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) continue;
        const top = topElementAt(doc, x, y);
        if (!top) continue;
        sampled++;
        if (composedContains(element, top) || composedContains(top, element)) continue;
        for (let current: Node | null = top; current; current = composedParent(current)) {
          if (current.nodeType !== 1) continue;
          const position = view.getComputedStyle(current as Element).position;
          if (position !== 'fixed' && position !== 'sticky') continue;
          if (composedContains(current, element)) break; // shares the element's own sticky container
          const kind = coverAt(top, current as Element, x, y, view);
          if (kind === 'none') break;
          covered++;
          if (kind === 'opaque') opaque++;
          by = selectorOf(current as Element);
          break;
        }
      }
    }
    return { covered, sampled, by, opaque };
  }

  function describe(element: Element, withObscured: boolean): AgentElementInfo {
    return {
      key: keyOf(element),
      selector: selectorOf(element),
      frame: frameOf(element),
      textEntry: isTextEntry(element),
      opaqueFrame: isOpaqueFrame(element),
      obscured: withObscured ? obscuredInfo(element) : null,
    };
  }

  function union(a: AgentRect, b: AgentRect): AgentRect {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
      x,
      y,
      width: Math.max(a.x + a.width, b.x + b.width) - x,
      height: Math.max(a.y + a.height, b.y + b.height) - y,
    };
  }

  function boxOf(element: Element): AgentRect | null {
    const rect = viewportRect(element);
    return rect.width > 0 && rect.height > 0 ? toPage(rect) : null;
  }

  function collectUnreached(root: Document | ShadowRoot, out: Element[]): void {
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) collectUnreached(element.shadowRoot, out);
      if (isFrame(element)) {
        const doc = frameDocument(element);
        if (doc) collectUnreached(doc, out);
        continue;
      }
      if (!element.matches(FOCUSABLE)) continue;
      const key = keys.get(element);
      if (key !== undefined && tabbed.has(key)) continue;
      if (element.matches(':disabled') || element.closest('[inert]')) continue;
      if (!element.checkVisibility({ visibilityProperty: true })) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      out.push(element);
    }
  }

  function eachElement(root: Document | ShadowRoot, visit: (element: Element) => void): void {
    for (const element of root.querySelectorAll('*')) {
      visit(element);
      if (element.shadowRoot) eachElement(element.shadowRoot, visit);
      if (isFrame(element)) {
        const doc = frameDocument(element);
        if (doc) eachElement(doc, visit);
      }
    }
  }

  // State to put back in cleanup(). Recorded now, before the first Tab press moves anything.
  const initialActive = deepActive();
  const initialScroll = { x: window.scrollX, y: window.scrollY };
  /** Scroll containers and same-origin frame windows that were not at 0,0. Everything else was. */
  const initialScrolls = new Map<Element | Window, { x: number; y: number }>();
  eachElement(document, (element) => {
    if (element.scrollLeft !== 0 || element.scrollTop !== 0) {
      initialScrolls.set(element, { x: element.scrollLeft, y: element.scrollTop });
    }
    const view = isFrame(element) ? frameDocument(element)?.defaultView : null;
    if (view && (view.scrollX !== 0 || view.scrollY !== 0)) initialScrolls.set(view, { x: view.scrollX, y: view.scrollY });
  });

  function restoreScroll(target: Element | Window): void {
    const { x, y } = initialScrolls.get(target) ?? { x: 0, y: 0 };
    const current =
      'scrollX' in target ? { x: target.scrollX, y: target.scrollY } : { x: target.scrollLeft, y: target.scrollTop };
    if (current.x !== x || current.y !== y) target.scrollTo({ left: x, top: y, behavior: 'instant' });
  }

  /** Focusing and scrollIntoView scroll every scrollable ancestor of an element, in every frame it is nested in. */
  function restoreScrolls(): void {
    const seen = new Set<Node>();
    for (const element of elements.values()) {
      for (let current: Node | null = element; current && !seen.has(current); ) {
        seen.add(current);
        if (current.nodeType === 1) restoreScroll(current as Element);
        const parent: Node | null = composedParent(current);
        if (parent) {
          current = parent;
          continue;
        }
        // Top of a document: carry on from the frame that holds it, if any.
        const view: Window | null = current.nodeType === 9 ? (current as Document).defaultView : null;
        const frame: Element | null = view && view !== window ? view.frameElement : null;
        if (view && frame) restoreScroll(view);
        current = frame;
      }
    }
    window.scrollTo({ left: initialScroll.x, top: initialScroll.y, behavior: 'instant' });
  }

  function isClipped(element: Element): boolean {
    const outside = (rect: { x: number; y: number; width: number; height: number }, view: Window): boolean =>
      rect.x < 0 || rect.y < 0 || rect.x + rect.width > view.innerWidth || rect.y + rect.height > view.innerHeight;
    const view = element.ownerDocument.defaultView;
    const own = element.getBoundingClientRect();
    return outside(viewportRect(element), window) || (view !== null && outside(own, view));
  }

  /** Tab selects the whole value of a field; the selection highlight must not be read as an indicator. */
  function collapseSelection(element: Element): void {
    if (element.localName !== 'input' && element.localName !== 'textarea') return;
    try {
      (element as HTMLInputElement).setSelectionRange(0, 0);
    } catch {
      // Input types without a selection API (email, number): the ::selection rule hides the highlight.
    }
  }

  // ---------------------------------------------------------------------------------------
  // icon-contrast: controls without visible text that show a graphic, and control boundaries.
  // ---------------------------------------------------------------------------------------

  const ICON_CONTROLS =
    'a[href],button,summary,input[type="button"],input[type="submit"],input[type="reset"],input[type="image"],' +
    '[role="button"],[role="link"],[role="menuitem"],[role="tab"]';
  const BOUNDARY_CONTROLS = 'input,textarea,select,[role="checkbox"],[role="radio"],[role="switch"]';
  const FIELD_TYPES = [...TEXT_INPUT_TYPES, 'date', 'datetime-local', 'month', 'week', 'time'];
  const SVG_SHAPES = ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'];
  const SVG_GROUPS = ['g', 'svg', 'a'];
  const SVG_NOT_PAINTED =
    'defs,clipPath,mask,symbol,marker,pattern,linearGradient,radialGradient,title,desc,style,script,metadata';
  const SVG_OPEN = ['line', 'polyline'];
  const NOT_READABLE = ['canvas', 'video', 'object', 'embed', 'iframe', 'frame'];
  const SOURCE_ORDER: AgentIconSource[] = [
    'svg',
    'img',
    'font-glyph',
    'background-image',
    'mask-image',
    'pseudo-element',
    'css-shape',
  ];
  const VISIBLE = { visibilityProperty: true, opacityProperty: true };
  const iconFamily = new RegExp(options.icon.iconFontFamilyPattern, 'i');
  const inactiveHint = new RegExp(options.icon.inactiveHintPattern, 'i');
  const logoHint = new RegExp(options.icon.logoHintPattern, 'i');
  const homeName = new RegExp(options.icon.homeLinkNamePattern, 'i');

  interface GraphicScan {
    sources: Set<AgentIconSource>;
    /** What has a box of its own. */
    holders: (Element | Range)[];
    /** A source without a box of its own: the graphic box is the padding box of the control. */
    controlBox: boolean;
    /** One entry per graphic found: its colour when computed styles give one, else null. */
    declared: (string | null)[];
    /** Visible text: the control is not identified by a graphic. */
    text: boolean;
    /** Content this check cannot read (a canvas, a broken image, generated content other than a string). */
    unsupported: boolean;
  }
  interface IconInfo {
    kind: 'icon' | 'boundary';
    control: AgentIconItem['control'];
    scan: GraphicScan | null;
  }
  const iconInfo = new Map<number, IconInfo>();

  function parseColor(text: string): { r: number; g: number; b: number; a: number } | null {
    const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(text.trim());
    if (!match) return null;
    const alpha = match[4];
    const a = alpha === undefined ? 1 : alpha.endsWith('%') ? parseFloat(alpha) / 100 : parseFloat(alpha);
    return { r: Math.round(Number(match[1])), g: Math.round(Number(match[2])), b: Math.round(Number(match[3])), a };
  }

  /** #rrggbb for a computed colour that is opaque sRGB; null for anything else. */
  function opaqueHex(text: string): string | null {
    const color = parseColor(text);
    if (!color || color.a < 1) return null;
    return '#' + [color.r, color.g, color.b].map((channel) => channel.toString(16).padStart(2, '0')).join('');
  }

  function plainRect(rect: { left: number; top: number; width: number; height: number }): AgentRect {
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }

  function intersect(a: AgentRect, b: AgentRect): AgentRect {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    return {
      x,
      y,
      width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
      height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
    };
  }

  function parentElementOf(element: Element): Element | null {
    const parent = composedParent(element);
    return parent && parent.nodeType === 1 ? (parent as Element) : null;
  }

  /**
   * True when what the element paints reaches the screen in the colours its styles compute to:
   * no opacity, filter or blend mode on it or on anything it is nested in, frames included.
   */
  function paintsPlainly(element: Element): boolean {
    for (let current: Element | null = element; current; ) {
      const view = current.ownerDocument.defaultView;
      if (!view) return false;
      const style = view.getComputedStyle(current);
      if (parseFloat(style.opacity) !== 1 || style.filter !== 'none' || style.mixBlendMode !== 'normal') return false;
      if (current !== element && style.maskImage !== 'none') return false;
      current = parentElementOf(current) ?? (current === current.ownerDocument.documentElement ? frameElementOf(current) : null);
    }
    return true;
  }

  /** The one opaque colour every painted shape of an inline SVG computes to, or null. */
  function svgColor(svg: Element): string | null {
    const view = svg.ownerDocument.defaultView;
    if (!view || !paintsPlainly(svg)) return null;
    const colors = new Set<string>();
    for (const node of svg.querySelectorAll('*')) {
      if (node.closest(SVG_NOT_PAINTED)) continue;
      const name = node.localName;
      const style = view.getComputedStyle(node);
      if (style.display === 'none') continue;
      if (parseFloat(style.opacity) !== 1 || style.filter !== 'none' || style.maskImage !== 'none') return null;
      if (SVG_GROUPS.includes(name)) continue;
      // use, image, text, foreignObject: what they paint is not in their own computed styles.
      if (!SVG_SHAPES.includes(name)) return null;
      if (style.visibility !== 'visible') continue;
      if (style.fill !== 'none' && !SVG_OPEN.includes(name)) {
        const fill = opaqueHex(style.fill);
        if (!fill || parseFloat(style.fillOpacity) !== 1) return null;
        colors.add(fill);
      }
      if (style.stroke !== 'none' && parseFloat(style.strokeWidth) > 0) {
        const stroke = opaqueHex(style.stroke);
        if (!stroke || parseFloat(style.strokeOpacity) !== 1) return null;
        colors.add(stroke);
      }
    }
    return colors.size === 1 ? [...colors][0]! : null;
  }

  function isPrivateUse(text: string): boolean {
    for (const char of text) {
      const code = char.codePointAt(0)!;
      if (/\s/.test(char)) continue;
      const privateUse =
        (code >= 0xe000 && code <= 0xf8ff) || (code >= 0xf0000 && code <= 0xffffd) || (code >= 0x100000 && code <= 0x10fffd);
      if (!privateUse) return false;
    }
    return true;
  }

  function isGlyph(text: string, fontFamily: string): boolean {
    const first = (fontFamily.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');
    return isPrivateUse(text) || iconFamily.test(first);
  }

  function hasBorder(style: CSSStyleDeclaration): boolean {
    const sides = [
      [style.borderTopWidth, style.borderTopStyle, style.borderTopColor],
      [style.borderRightWidth, style.borderRightStyle, style.borderRightColor],
      [style.borderBottomWidth, style.borderBottomStyle, style.borderBottomColor],
      [style.borderLeftWidth, style.borderLeftStyle, style.borderLeftColor],
    ] as const;
    return sides.some(([width, line, color]) => parseFloat(width) > 0 && line !== 'none' && line !== 'hidden' && alphaOf(color) > 0);
  }

  /**
   * Where a text node shows on screen, in the client coordinates of its frame, or null when it
   * does not: hidden, zero font size, transparent, clipped away (the usual "visually hidden"
   * rules) or pushed off the page.
   */
  function textRect(text: Text, control: Element): AgentRect | null {
    const holder = text.parentElement ?? hostOf(text.parentNode);
    const view = holder?.ownerDocument.defaultView;
    if (!holder || !view || !holder.checkVisibility(VISIBLE)) return null;
    const style = view.getComputedStyle(holder);
    if (parseFloat(style.fontSize) < options.icon.minPaintedSizeCssPx || alphaOf(style.color) === 0) return null;
    const range = holder.ownerDocument.createRange();
    range.selectNodeContents(text);
    let box = plainRect(range.getBoundingClientRect());
    for (let current: Element | null = holder; current; current = parentElementOf(current)) {
      const own = view.getComputedStyle(current);
      if (own.overflowX !== 'visible' || own.overflowY !== 'visible' || own.clip !== 'auto' || own.clipPath !== 'none') {
        box = intersect(box, plainRect(current.getBoundingClientRect()));
      }
      if (current === control) break;
    }
    const root = holder.ownerDocument.documentElement;
    box = intersect(box, { x: -view.scrollX, y: -view.scrollY, width: root.scrollWidth, height: root.scrollHeight });
    const min = options.icon.minVisibleTextCssPx;
    return box.width >= min && box.height >= min ? box : null;
  }

  function composedChildren(element: Element): Node[] {
    if (element.localName === 'slot') {
      const assigned = (element as HTMLSlotElement).assignedNodes({ flatten: true });
      if (assigned.length > 0) return assigned;
    }
    return [...(element.shadowRoot ?? element).childNodes];
  }

  /** What a control shows: visible text, or the graphics that stand in for it. */
  function scanGraphic(control: Element): GraphicScan {
    const scan: GraphicScan = {
      sources: new Set(),
      holders: [],
      controlBox: false,
      declared: [],
      text: false,
      unsupported: false,
    };
    const view = control.ownerDocument.defaultView;
    if (!view) return scan;
    const minSize = options.icon.minPaintedSizeCssPx;

    const place = (element: Element): void => {
      const rect = element.getBoundingClientRect();
      if (element === control || rect.width < minSize || rect.height < minSize) scan.controlBox = true;
      else scan.holders.push(element);
    };
    const add = (source: AgentIconSource, color: string | null): void => {
      scan.sources.add(source);
      scan.declared.push(color);
    };

    const pseudo = (element: Element, which: '::before' | '::after'): void => {
      const style = view.getComputedStyle(element, which);
      const content = style.content;
      if (content === 'none' || content === 'normal' || style.display === 'none') return;
      if (style.visibility !== 'visible' || parseFloat(style.opacity) === 0) return;
      const plain = parseFloat(style.opacity) === 1 && style.filter === 'none' && style.mixBlendMode === 'normal' && paintsPlainly(element);
      if (content.includes('url(')) {
        place(element);
        add('pseudo-element', null);
        return;
      }
      const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(content);
      if (!quoted) {
        // counter(), attr(), quotes: generated text this check does not read.
        scan.unsupported = true;
        return;
      }
      const value = quoted[1]!.replace(/\\(.)/g, '$1').trim();
      if (value === '') {
        if (style.maskImage.includes('url(')) {
          place(element);
          add('mask-image', plain && style.backgroundImage === 'none' ? opaqueHex(style.backgroundColor) : null);
        } else if (style.backgroundImage.includes('url(')) {
          place(element);
          add('background-image', null);
        } else if (alphaOf(style.backgroundColor) > 0 || hasBorder(style)) {
          const width =
            parseFloat(style.width) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
          const height =
            parseFloat(style.height) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
          if (width >= minSize && height >= minSize) {
            place(element);
            add('pseudo-element', null);
          }
        }
        return;
      }
      if (parseFloat(style.fontSize) < minSize || alphaOf(style.color) === 0) return;
      // Letters and digits are text, unless an icon font turns them into a glyph. A lone symbol is a graphic.
      if (isGlyph(value, style.fontFamily) || !/[\p{L}\p{N}]/u.test(value)) {
        place(element);
        add('font-glyph', plain ? opaqueHex(style.color) : null);
      } else {
        scan.text = true;
      }
    };

    const visit = (element: Element): void => {
      const isControl = element === control;
      const shown = isControl || element.checkVisibility(VISIBLE);
      // `visibility: hidden` can be undone by a descendant; `display: none` and `opacity: 0` cannot.
      if (!shown && !element.checkVisibility({ opacityProperty: true })) return;
      const name = element.localName;
      if (shown) {
        if (NOT_READABLE.includes(name)) {
          scan.unsupported = true;
          return;
        }
        if (name === 'svg') {
          const rect = element.getBoundingClientRect();
          if (rect.width >= minSize && rect.height >= minSize) {
            scan.holders.push(element);
            add('svg', svgColor(element));
          }
          return;
        }
        if (name === 'img') {
          const image = element as HTMLImageElement;
          // A broken image shows its alternative text instead.
          if (!image.complete || image.naturalWidth === 0) scan.unsupported = true;
          else {
            place(element);
            add('img', null);
          }
          return;
        }
        if (name === 'input') {
          const input = element as HTMLInputElement;
          if (input.type === 'image') {
            place(element);
            add('img', null);
            return;
          }
          // Button inputs show their value, or a default label when there is no value attribute.
          if (input.value.trim() !== '' || (input.type !== 'button' && !input.hasAttribute('value'))) scan.text = true;
        }
        const style = view.getComputedStyle(element);
        if (style.maskImage.includes('url(')) {
          place(element);
          add('mask-image', style.backgroundImage === 'none' && paintsPlainly(element) ? opaqueHex(style.backgroundColor) : null);
        } else if (style.backgroundImage.includes('url(')) {
          place(element);
          add('background-image', null);
        } else if (
          !isControl &&
          element.childElementCount === 0 &&
          !element.shadowRoot &&
          (element.textContent ?? '').trim() === '' &&
          (alphaOf(style.backgroundColor) > 0 || hasBorder(style))
        ) {
          const rect = element.getBoundingClientRect();
          if (rect.width >= minSize && rect.height >= minSize) {
            scan.holders.push(element);
            add('css-shape', null);
          }
        }
        pseudo(element, '::before');
        pseudo(element, '::after');
      }
      for (const child of composedChildren(element)) {
        if (child.nodeType === 1) visit(child as Element);
        if (child.nodeType !== 3) continue;
        const text = child as Text;
        const value = text.data.trim();
        if (value === '' || !textRect(text, control)) continue;
        const holder = text.parentElement ?? hostOf(text.parentNode);
        const family = holder ? view.getComputedStyle(holder) : null;
        if (holder && family && isGlyph(value, family.fontFamily)) {
          const range = holder.ownerDocument.createRange();
          range.selectNodeContents(text);
          scan.holders.push(range);
          add('font-glyph', paintsPlainly(holder) ? opaqueHex(family.color) : null);
        } else {
          scan.text = true;
        }
      }
    };
    visit(control);
    return scan;
  }

  /** Padding box in client coordinates; the border box for an inline or transformed element. */
  function paddingRect(element: Element): AgentRect {
    const rect = element.getBoundingClientRect();
    const html = element as HTMLElement;
    const tolerance = options.icon.boxToleranceCssPx;
    const layoutMatches = Math.abs(html.offsetWidth - rect.width) < tolerance && Math.abs(html.offsetHeight - rect.height) < tolerance;
    if (!layoutMatches || element.clientWidth <= 0 || element.clientHeight <= 0) return plainRect(rect);
    return {
      x: rect.left + element.clientLeft,
      y: rect.top + element.clientTop,
      width: element.clientWidth,
      height: element.clientHeight,
    };
  }

  /** Box of the graphic in client coordinates of its frame. */
  function graphicRect(control: Element, scan: GraphicScan): AgentRect {
    if (scan.controlBox || scan.holders.length === 0) return paddingRect(control);
    let box: AgentRect | null = null;
    for (const holder of scan.holders) {
      const rect = plainRect(holder.getBoundingClientRect());
      if (rect.width < options.icon.minPaintedSizeCssPx || rect.height < options.icon.minPaintedSizeCssPx) continue;
      box = box ? union(box, rect) : rect;
    }
    return box ?? paddingRect(control);
  }

  function boundaryControlOf(element: Element): AgentIconItem['control'] {
    const role = element.getAttribute('role');
    const name = element.localName;
    if (name === 'input') {
      const type = (element as HTMLInputElement).type;
      if (type === 'checkbox') return role === 'switch' ? 'switch' : 'checkbox';
      if (type === 'radio') return 'radio';
      return FIELD_TYPES.includes(type) ? 'text-field' : null;
    }
    if (name === 'textarea') return 'text-field';
    if (name === 'select') return 'select';
    if (role === 'checkbox' || role === 'radio' || role === 'switch') return role;
    return null;
  }

  /** True when the element, or something in it, shows text on screen. */
  function showsText(element: Element): boolean {
    if (!element.checkVisibility(VISIBLE)) return false;
    const walker = element.ownerDocument.createTreeWalker(element, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if ((node as Text).data.trim() !== '' && textRect(node as Text, element)) return true;
    }
    return false;
  }

  /** Elements that `aria-labelledby` names, in the tree the control is in. */
  function labelledBy(control: Element): Element[] {
    const root = control.getRootNode() as Document | ShadowRoot;
    const found: Element[] = [];
    for (const id of (control.getAttribute('aria-labelledby') ?? '').split(/\s+/)) {
      const target = id === '' || !('getElementById' in root) ? null : root.getElementById(id);
      if (target) found.push(target);
    }
    return found;
  }

  /**
   * Visible text outside the control that is its label: an element named by `aria-labelledby`,
   * or a `label` element. Such a control shows no text of its own, yet its icon is not the only
   * thing that identifies it.
   */
  function hasVisibleLabel(control: Element): boolean {
    const labels: Element[] = labelledBy(control);
    const native = (control as HTMLButtonElement).labels;
    if (native) labels.push(...native);
    return labels.some((label) => !composedContains(control, label) && showsText(label));
  }

  /**
   * A link taken out of the accessibility tree and the tab order (`aria-hidden="true"`,
   * `tabindex="-1"`) whose parent also holds a link to the same address that shows text and is
   * not hidden: a decorative copy of that text link.
   */
  function duplicatesTextLink(control: Element): boolean {
    if (control.localName !== 'a' || control.getAttribute('aria-hidden') !== 'true' || control.getAttribute('tabindex') !== '-1') {
      return false;
    }
    const href = (control as HTMLAnchorElement).href;
    for (const sibling of control.parentElement?.children ?? []) {
      if (sibling === control || sibling.localName !== 'a' || (sibling as HTMLAnchorElement).href !== href) continue;
      if (sibling.closest('[aria-hidden="true"]') === null && showsText(sibling)) return true;
    }
    return false;
  }

  /** What names a control without text: its own naming attributes, and the alternative texts and titles of its graphics. */
  function nameWords(control: Element, scan: GraphicScan): string[] {
    const words = [control.getAttribute('aria-label') ?? '', control.getAttribute('title') ?? ''];
    for (const label of labelledBy(control)) words.push(label.textContent ?? '');
    for (const holder of scan.holders) {
      if (!('localName' in holder)) continue;
      words.push(holder.getAttribute('alt') ?? '', holder.getAttribute('aria-label') ?? '', holder.getAttribute('title') ?? '');
      for (const title of holder.querySelectorAll('title')) words.push(title.textContent ?? '');
    }
    return words.map((word) => word.trim().replace(/\s+/g, ' ')).filter((word) => word !== '');
  }

  /**
   * The home link of a site is where its logotype usually is, whatever the markup calls it:
   * a link with `rel="home"`, a link to the root of the site, or a link in the page header
   * (`header`, `role="banner"`) whose name matches `homeLinkNamePattern` or contains the name the
   * site gives itself in `og:site_name` or `application-name`.
   */
  function isHomeLink(control: Element, scan: GraphicScan): boolean {
    if (control.localName !== 'a') return false;
    const link = control as HTMLAnchorElement;
    if (link.relList.contains('home')) return true;
    const doc = control.ownerDocument;
    try {
      const target = new URL(link.href);
      const here = new URL(doc.location.href);
      if (target.origin === here.origin && target.pathname === '/' && target.search === '' && target.hash === '') return true;
    } catch {
      // Not an address that can be compared.
    }
    if (!control.closest('header,[role="banner"]')) return false;
    const names = nameWords(control, scan);
    if (names.some((name) => homeName.test(name))) return true;
    const site = (
      doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ??
      doc.querySelector('meta[name="application-name"]')?.getAttribute('content') ??
      ''
    )
      .trim()
      .toLowerCase();
    return site !== '' && names.some((name) => name.toLowerCase().includes(site));
  }

  /**
   * Signs that a control may be exempt from 1.4.11, or may not be identified by its graphic,
   * although nothing says so programmatically; see IconCandidate.hints in core.
   * `inactive`: it takes no pointer events, shows a not-allowed cursor, or it or its parent has a
   * class naming it disabled. `logo`: a class, id, name or file name on it or on its graphic says logo.
   */
  function hintsOf(control: Element, scan: GraphicScan | null): AgentIconHint[] {
    const hints: AgentIconHint[] = [];
    const style = control.ownerDocument.defaultView?.getComputedStyle(control);
    // Class names with a colon are state variants of utility CSS ("disabled:opacity-50"): they
    // say what the control would look like when disabled, not that it is.
    const classes = ((control.getAttribute('class') ?? '') + ' ' + (control.parentElement?.getAttribute('class') ?? ''))
      .split(/\s+/)
      .filter((name) => !name.includes(':'));
    if (style?.pointerEvents === 'none' || style?.cursor === 'not-allowed' || classes.some((name) => inactiveHint.test(name))) {
      hints.push('inactive');
    }
    if (scan) {
      const words: string[] = [];
      const collect = (element: Element): void => {
        for (const name of ['class', 'id', 'alt', 'title', 'aria-label']) words.push(element.getAttribute(name) ?? '');
        // The file name only: a path or a host called "logos" says nothing about this image.
        for (const name of ['src', 'href', 'xlink:href']) {
          if (element.localName === 'a') continue;
          words.push((element.getAttribute(name) ?? '').split(/[?#]/)[0]!.split('/').pop() ?? '');
        }
      };
      collect(control);
      for (const holder of scan.holders) {
        if (!('localName' in holder)) continue;
        collect(holder);
        for (const inner of holder.querySelectorAll('title,use')) {
          words.push(inner.localName === 'title' ? (inner.textContent ?? '') : (inner.getAttribute('href') ?? inner.getAttribute('xlink:href') ?? ''));
        }
      }
      if (words.some((word) => logoHint.test(word))) hints.push('logo');
      if (isHomeLink(control, scan)) hints.push('home-link');
      // One element drawn with CSS and nothing else: a swatch as likely as an icon.
      if (scan.sources.size === 1 && scan.sources.has('css-shape') && scan.holders.length === 1) hints.push('plain-shape');
      if (hasVisibleLabel(control)) hints.push('visible-label');
      if (duplicatesTextLink(control)) hints.push('duplicate-link');
    }
    return hints;
  }

  function iconSurvey(max: number): AgentIconSurvey {
    const skipped: Record<string, number> = { hidden: 0, small: 0, large: 0, noGraphic: 0, unsupported: 0 };
    const items: AgentIconItem[] = [];
    let total = 0;
    const min = options.icon.minControlSizeCssPx;
    eachElement(document, (element) => {
      const control = boundaryControlOf(element);
      const isIcon = control === null && element.matches(ICON_CONTROLS);
      if (control === null && !isIcon) return;
      if (element.closest('[inert]')) return;
      if (!element.checkVisibility(VISIBLE)) {
        skipped['hidden']!++;
        return;
      }
      const rect = element.getBoundingClientRect();
      let scan: GraphicScan | null = null;
      if (isIcon) {
        // A control that holds other controls is a container, not an icon button.
        if (element.querySelector(ICON_CONTROLS + ',' + BOUNDARY_CONTROLS)) return;
        scan = scanGraphic(element);
        if (scan.text) return;
        if (scan.unsupported) {
          skipped['unsupported']!++;
          return;
        }
        if (scan.sources.size === 0) {
          skipped['noGraphic']!++;
          return;
        }
        const graphic = graphicRect(element, scan);
        if (graphic.width < min || graphic.height < min) {
          skipped['small']!++;
          return;
        }
        if (Math.max(graphic.width, graphic.height) > options.icon.maxGraphicSizeCssPx) {
          skipped['large']!++;
          return;
        }
      } else if (rect.width < min || rect.height < min) {
        skipped['small']!++;
        return;
      }
      total++;
      if (items.length >= max) return;
      const key = keyOf(element);
      iconInfo.set(key, { kind: isIcon ? 'icon' : 'boundary', control, scan });
      const declared = scan && scan.declared.length > 0 && scan.declared.every((color) => color === scan.declared[0]) ? scan.declared[0]! : null;
      items.push({
        key,
        selector: selectorOf(element),
        frame: frameOf(element),
        kind: isIcon ? 'icon' : 'boundary',
        disabled: element.matches(':disabled') || element.closest('[aria-disabled="true"]') !== null,
        sources: scan ? SOURCE_ORDER.filter((source) => scan.sources.has(source)) : [],
        declaredColor: declared,
        control,
        native: !isIcon && ['input', 'textarea', 'select'].includes(element.localName),
        hints: hintsOf(element, scan),
      });
    });
    return { total, skipped, items };
  }

  /** True when the element paints a box of its own: a border, a background or a shadow, also through a pseudo-element. */
  function drawsBox(element: Element, view: Window): boolean {
    const paints = (style: CSSStyleDeclaration): boolean =>
      hasBorder(style) || alphaOf(style.backgroundColor) > 0 || style.backgroundImage !== 'none' || style.boxShadow !== 'none';
    if (!element.checkVisibility(VISIBLE)) return false;
    if (paints(view.getComputedStyle(element))) return true;
    for (const which of ['::before', '::after']) {
      const style = view.getComputedStyle(element, which);
      if (style.content !== 'none' && style.content !== 'normal' && style.display !== 'none' && paints(style)) return true;
    }
    return false;
  }

  async function prepareIcon(key: number): Promise<AgentIconPrepared> {
    const element = get(key);
    const info = iconInfo.get(key);
    if (!info) throw new Error('Unknown icon key ' + key);
    const gone: AgentIconPrepared = {
      box: null,
      graphic: null,
      graphicFrom: 'control',
      room: null,
      boxes: [],
      clip: null,
      reason: 'detached',
      probes: [],
      clipped: false,
      stable: true,
    };
    if (!element.isConnected) return gone;
    ensureStableAround(element);
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await settle();
    // Scrolling is something page scripts react to: the page may have rendered the control again.
    if (!element.isConnected) return gone;

    const doc = element.ownerDocument;
    const view = doc.defaultView;
    const offset = frameOffset(element);
    const page = (rect: AgentRect): AgentRect => toPage({ ...rect, x: rect.x + offset.x, y: rect.y + offset.y });
    const own = plainRect(element.getBoundingClientRect());
    const result: AgentIconPrepared = {
      box: own.width > 0 && own.height > 0 ? page(own) : null,
      graphic: null,
      graphicFrom: 'control',
      room: null,
      boxes: [],
      clip: null,
      reason: null,
      probes: [],
      clipped: false,
      stable: isStable(element),
    };
    if (!view) return { ...result, reason: 'no-box' };
    if (inTransformedFrame(element)) return { ...result, reason: 'transformed-frame' };

    /** What has to be on screen and uncovered for the measurement to mean anything. */
    let measured = own;
    let region = own;
    /** Content inside this element may lie over the measured area without hiding it from the check. */
    let outer = element;
    const points: [number, number][] = [];
    if (info.kind === 'icon' && info.scan) {
      const graphic = graphicRect(element, info.scan);
      result.graphic = page(graphic);
      result.graphicFrom = info.scan.controlBox || info.scan.holders.length === 0 ? 'control' : 'graphic';
      result.room = page(paddingRect(element));
      measured = graphic;
      region = union(own, graphic);
      const grid = options.icon.coverGrid;
      for (let row = 0; row < grid; row++) {
        for (let column = 0; column < grid; column++) {
          points.push([graphic.x + ((column + 0.5) / grid) * graphic.width, graphic.y + ((row + 0.5) / grid) * graphic.height]);
        }
      }
    } else {
      const boxes = [own];
      if (info.control === 'text-field' || info.control === 'select') {
        for (let level = 0, current = element; level < options.icon.boundaryWrapperLevels; level++) {
          const parent = parentElementOf(current);
          if (!parent || parent === doc.body || parent === doc.documentElement) break;
          const rect = plainRect(parent.getBoundingClientRect());
          if (rect.height > own.height + options.icon.boundaryWrapperSlackCssPx) break;
          // The wrapper itself, and anything else in it laid over the control (an outline element).
          const drawn = drawsBox(parent, view) ? [rect] : [];
          for (const sibling of parent.children) {
            if (sibling === current || !drawsBox(sibling, view)) continue;
            const over = plainRect(sibling.getBoundingClientRect());
            const slack = options.icon.boxToleranceCssPx;
            const contains =
              over.x <= own.x + slack &&
              over.y <= own.y + slack &&
              over.x + over.width >= own.x + own.width - slack &&
              over.y + over.height >= own.y + own.height - slack;
            if (contains && over.height <= own.height + options.icon.boundaryWrapperSlackCssPx) drawn.push(over);
          }
          for (const box of drawn) {
            boxes.push(box);
            region = union(region, box);
          }
          if (drawn.length > 0) outer = parent;
          current = parent;
        }
      }
      result.boxes = boxes.map(page);
      const inset = Math.min(options.icon.boundaryProbeInsetCssPx, own.width / 2, own.height / 2);
      points.push(
        [own.x + own.width / 2, own.y + inset],
        [own.x + own.width - inset, own.y + own.height / 2],
        [own.x + own.width / 2, own.y + own.height - inset],
        [own.x + inset, own.y + own.height / 2],
      );
    }
    if (measured.width < options.icon.minPaintedSizeCssPx || measured.height < options.icon.minPaintedSizeCssPx) {
      return { ...result, reason: 'no-box' };
    }

    const inside = (rect: AgentRect, width: number, height: number): boolean =>
      rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height;
    const top = { ...measured, x: measured.x + offset.x, y: measured.y + offset.y };
    result.clipped =
      !inside(measured, view.innerWidth, view.innerHeight) || !inside(top, window.innerWidth, window.innerHeight);

    iconOuter.set(key, outer);
    let covered = false;
    for (const [x, y] of points) {
      if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) continue;
      const hit = topElementAt(doc, x, y);
      if (!hit) continue;
      const topX = x + offset.x;
      const topY = y + offset.y;
      if (topX < 0 || topY < 0 || topX >= window.innerWidth || topY >= window.innerHeight) continue;
      result.probes.push([topX + window.scrollX, topY + window.scrollY]);
      if ((!composedContains(outer, hit) && !composedContains(hit, element)) || frameCoveredAt(element, x, y)) covered = true;
    }
    if (result.probes.length === 0) return { ...result, reason: 'outside-viewport' };
    if (covered) return { ...result, reason: 'covered' };

    const margin = options.icon.clipMarginCssPx;
    const left = Math.max(0, region.x + offset.x - margin);
    const upper = Math.max(0, region.y + offset.y - margin);
    const right = Math.min(window.innerWidth, region.x + offset.x + region.width + margin);
    const lower = Math.min(window.innerHeight, region.y + offset.y + region.height + margin);
    if (right - left < 1 || lower - upper < 1) return { ...result, reason: 'outside-viewport' };
    const x0 = Math.floor(left + window.scrollX);
    const y0 = Math.floor(upper + window.scrollY);
    const x1 = Math.ceil(right + window.scrollX);
    const y1 = Math.ceil(lower + window.scrollY);
    return { ...result, clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
  }

  // ---------------------------------------------------------------------------------------
  // headings: blocks of visible text, whatever their tags.
  // ---------------------------------------------------------------------------------------

  const TEXT_SKIPPED = [
    'script', 'style', 'noscript', 'template', 'head', 'title', 'svg', 'math', 'select', 'option', 'optgroup', 'datalist',
    'textarea', 'input', 'canvas', 'video', 'audio', 'object', 'embed', 'img', 'picture', 'map', 'meter', 'progress',
  ];
  const WIDGET_ROLES = ['button', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'checkbox', 'radio', 'treeitem'];
  const NAVIGATION_ROLES = ['navigation', 'menu', 'menubar', 'tablist', 'toolbar', 'tree', 'listbox'];
  const CONTEXT_ORDER: AgentTextContext[] = [
    'label', 'caption', 'tableHeader', 'tableCell', 'term', 'button', 'link', 'quote', 'code', 'navigation', 'ariaHidden',
  ];

  /** Elements the accessibility tree exposes as headings, with their level. Filled by the collector before the survey. */
  const headingMarks = new Map<Element, number>();
  /** The text nodes and the element of each block of the last survey, by position. */
  let surveyedBlocks: { nodes: Text[]; element: Element }[] = [];

  function markHeading(element: unknown, level: number): boolean {
    if (!element || (element as Node).nodeType !== 1) return false;
    headingMarks.set(element as Element, level);
    return true;
  }

  function frameReadable(element: unknown): boolean {
    return !!element && (element as Node).nodeType === 1 && isFrame(element as Element) && frameDocument(element as Element) !== null;
  }

  /**
   * Rendering that the browser skips is switched on for as long as text is read: with
   * `content-visibility: auto`, what is off screen is not laid out, and Chrome leaves it out of
   * the accessibility tree as well (verified against Chrome: a list inside such a subtree has no
   * node in `Accessibility.getFullAXTree` until it is rendered). Text read from the DOM there
   * would look like text without any semantics. A reader gets that content rendered on scrolling
   * to it, so it is rendered here: the elements whose computed `content-visibility` is `auto`
   * are tagged with an attribute, and a constructed style sheet in their document or shadow root
   * makes the tagged ones `visible`. cleanup() removes both.
   *
   * Only those elements are touched. What the author hides with `content-visibility: hidden` or
   * with `hidden="until-found"` (which computes to the same) stays hidden: it is not rendered,
   * so it takes no room and paints nothing in a capture, and it stays unread, as those elements
   * are recorded here and the walk passes them over. A rule for every element would open them
   * (it did: a closed panel then pushed everything under it down the page).
   */
  const RENDER_ATTRIBUTE = 'data-a11y-vision-render';
  const RENDER_CSS = '[' + RENDER_ATTRIBUTE + ']{content-visibility:visible!important}';
  const contentHidden = new WeakSet<Element>();
  const renderedElements: Element[] = [];
  let renderedAll = false;

  async function renderAll(): Promise<void> {
    if (renderedAll) return;
    renderedAll = true;
    const roots = new Set<Document | ShadowRoot>();
    eachElement(document, (element) => {
      const visibility = element.ownerDocument.defaultView?.getComputedStyle(element).contentVisibility;
      if (visibility === 'hidden') contentHidden.add(element);
      else if (visibility === 'auto') {
        renderedElements.push(element);
        roots.add(element.getRootNode() as Document | ShadowRoot);
      }
    });
    // Nothing is skipped: the page is left alone.
    if (renderedElements.length === 0) return;
    for (const root of roots) {
      try {
        const doc = root.nodeType === 9 ? (root as Document) : root.ownerDocument;
        const view = doc?.defaultView as (Window & { CSSStyleSheet: typeof CSSStyleSheet }) | null | undefined;
        if (!view) continue;
        const sheet = new view.CSSStyleSheet();
        sheet.replaceSync(RENDER_CSS);
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
        sheets.push({ root, sheet });
      } catch {
        // The content of that root stays as the browser renders it.
      }
    }
    for (const element of renderedElements) element.setAttribute(RENDER_ATTRIBUTE, '');
    await settle();
  }

  /**
   * True for an element that a modal dialog makes inert: the dialog was opened with showModal(),
   * and the element is outside it. Chrome leaves such content out of the accessibility tree
   * (verified), as it does for `inert`. Asked of the topmost such elements only: the answer is
   * handed down to what they hold.
   *
   * Inside and outside are those of the composed tree: what a component of the dialog renders
   * in its shadow tree is inside the dialog, and a dialog that lives in a shadow tree makes the
   * rest of its document inert like any other.
   */
  function blockedByModal(element: Element): boolean {
    const modals = (modalDialogs ??= findModals()).get(element.ownerDocument);
    if (!modals || element === element.ownerDocument.documentElement) return false;
    return !modals.some((modal) => composedContains(modal, element) || composedContains(element, modal));
  }

  /**
   * The modal dialogs of each document, shadow trees included. Looked for once per survey, in
   * one walk: asked of every element instead, a query over the whole document made the survey
   * quadratic (17 s of a scan of 28 s on a page of 100 000 elements).
   */
  let modalDialogs: Map<Document, Element[]> | null = null;

  function findModals(): Map<Document, Element[]> {
    const found = new Map<Document, Element[]>();
    eachElement(document, (element) => {
      if (element.localName !== 'dialog') return;
      try {
        if (!element.matches(':modal')) return;
      } catch {
        return;
      }
      const known = found.get(element.ownerDocument);
      if (known) known.push(element);
      else found.set(element.ownerDocument, [element]);
    });
    return found;
  }

  function ownContexts(element: Element): AgentTextContext[] {
    const name = element.localName;
    const role = (element.getAttribute('role') ?? '').trim().toLowerCase();
    const found: AgentTextContext[] = [];
    if (name === 'label' || name === 'legend') found.push('label');
    if (name === 'caption' || name === 'figcaption') found.push('caption');
    if (name === 'th' || name === 'td') {
      // A table used for layout has no cells as far as assistive technology is concerned.
      const tableRole = (element.closest('table')?.getAttribute('role') ?? '').trim().toLowerCase();
      if (tableRole !== 'presentation' && tableRole !== 'none') found.push(name === 'th' ? 'tableHeader' : 'tableCell');
    }
    if (role === 'columnheader' || role === 'rowheader') found.push('tableHeader');
    if (role === 'cell' || role === 'gridcell') found.push('tableCell');
    if (name === 'dt') found.push('term');
    if (name === 'button' || name === 'summary' || WIDGET_ROLES.includes(role)) found.push('button');
    if ((name === 'a' && element.hasAttribute('href')) || role === 'link') found.push('link');
    if (name === 'blockquote' || name === 'q') found.push('quote');
    if (name === 'pre' || name === 'code' || name === 'kbd' || name === 'samp') found.push('code');
    if (name === 'nav' || NAVIGATION_ROLES.includes(role)) found.push('navigation');
    if (element.getAttribute('aria-hidden') === 'true' || element.hasAttribute('inert') || blockedByModal(element)) found.push('ariaHidden');
    return found;
  }

  /** Elements the accessibility tree exposes as lists or description lists. Filled by the collector before the list survey. */
  const listMarks = new Set<Element>();
  /** The elements of the last list survey by position, and what each capture handle stands for. */
  let listOrdElements: Element[] = [];
  let listTargets: Element[][] = [];

  function markList(element: unknown): boolean {
    if (!element || (element as Node).nodeType !== 1) return false;
    listMarks.add(element as Element);
    return true;
  }

  /**
   * Form controls and containers with a role, as the accessibility tree exposes them. Filled by
   * the collector before the grouping survey: role, name and description are those the browser
   * computed, and are never worked out from attributes here.
   */
  const controlMarks = new Map<Element, { role: string; name: string; description: string }>();
  const groupMarks = new Map<Element, { role: string; name: string }>();
  /** The controls of the last grouping survey, by index. */
  let groupingControls: Element[] = [];

  function markControl(element: unknown, role: string, name: string, description: string): boolean {
    if (!element || (element as Node).nodeType !== 1) return false;
    // The ARIA role listbox is a list of options, often the popup of a combobox: only a `select` shown as a list is a field.
    if (role === 'listbox' && (element as Element).localName !== 'select') return true;
    controlMarks.set(element as Element, { role, name, description });
    return true;
  }

  function markGroup(element: unknown, role: string, name: string): boolean {
    if (!element || (element as Node).nodeType !== 1) return false;
    // Chrome exposes `details`, `address` and others as groups too. Without a name, only a
    // fieldset and an element with a role of its own are groups an author made.
    if (role === 'group' && name === '' && (element as Element).localName !== 'fieldset' && !(element as Element).hasAttribute('role')) return true;
    groupMarks.set(element as Element, { role, name });
    return true;
  }

  function headingSurvey(): AgentHeadingSurvey {
    return textSurvey('headings').survey;
  }

  function listSurvey(): AgentListSurvey {
    return textSurvey('lists').lists!;
  }

  function groupingSurvey(): AgentGroupingSurvey {
    return textSurvey('grouping').grouping!;
  }

  /**
   * Reads the blocks of visible text of the page. For the lists check (`forLists`) the same walk
   * also records what stands before each line, where each block sits among the elements, the
   * series of sibling elements of one shape and the lists of interest; nothing of that is done,
   * and nothing changes, for the headings check.
   */
  function textSurvey(mode: 'headings' | 'lists' | 'grouping'): { survey: AgentHeadingSurvey; lists: AgentListSurvey | null; grouping?: AgentGroupingSurvey } {
    const forLists = mode === 'lists';
    const forGrouping = mode === 'grouping';
    // Both number the elements of the page in document order, to say what comes before what.
    const withOrds = forLists || forGrouping;
    const limits = options.headings;
    const blocks: AgentTextBlock[] = [];
    surveyedBlocks = [];
    let total = 0;
    // The page may have opened or closed a dialog since the last survey.
    modalDialogs = findModals();

    const listLimits = options.lists;
    interface Graphic {
      /** Client coordinates of its frame. */
      rect: AgentRect;
      kind: 'image' | 'shape';
      key: string;
      doc: Document;
    }
    const ords = new Map<Element, { ord: number; end: number }>();
    const ordElements: Element[] = [];
    let lastGraphic: Graphic | null = null;
    const firstPieceIn = new Map<Element, Piece>();
    const charCounts = new Map<Element, number>();
    /** Characters of the text an element holds itself, outside its child elements. */
    const looseCounts = new Map<Element, number>();
    const blockCounts = new Map<Element, number>();
    const lastBlockIn = new Map<Element, Pending>();
    const groupParents: Element[] = [];
    const listBlocks: AgentListBlock[] = [];
    const listElements: AgentListElement[] = [];
    const targets: Element[][] = [];
    let totalLists = 0;
    let exposedLists = 0;
    /** Grouping: the marked controls and containers the walk met, in document order. */
    const controlElements: Element[] = [];
    const groupElements: Element[] = [];
    const groupingBlocks: AgentGroupingBlock[] = [];

    const shortKey = (text: string): string => (text.length <= 160 ? text : text.length + ':' + text.slice(0, 80) + text.slice(-80));
    const markerSized = (width: number, height: number): boolean =>
      width >= listLimits.markerMinSizeCssPx &&
      height >= listLimits.markerMinSizeCssPx &&
      width <= listLimits.markerMaxSizeCssPx &&
      height <= listLimits.markerMaxSizeCssPx;

    /** A small image or inline SVG: what a bullet is when it is not a character. */
    function noteGraphic(element: Element): void {
      if (!element.checkVisibility(VISIBLE)) return;
      const rect = plainRect(element.getBoundingClientRect());
      // A picture between a bullet and text means the bullet is not at the start of that text.
      lastGraphic = null;
      if (!markerSized(rect.width, rect.height)) return;
      const source =
        element.localName === 'img'
          ? (element as HTMLImageElement).currentSrc || element.getAttribute('src') || ''
          : element.innerHTML.replace(/\s+/g, ' ').trim();
      lastGraphic = {
        rect,
        kind: 'image',
        key: element.localName + '|' + Math.round(rect.width) + 'x' + Math.round(rect.height) + '|' + shortKey(source),
        doc: element.ownerDocument,
      };
    }

    /** Generated content of `::before`, when it shows: its text, and whether it uses a counter or an image. */
    function generated(element: Element, view: Window): { text: string; counter: boolean; image: boolean; style: CSSStyleDeclaration } | null {
      const style = view.getComputedStyle(element, '::before');
      const content = style.content;
      if (!content || content === 'none' || content === 'normal') return null;
      if (style.display === 'none' || style.visibility !== 'visible' || parseFloat(style.opacity) === 0) return null;
      // Alternative text after a slash is not shown.
      const shown = content.replace(/\s\/\s"(?:[^"\\]|\\.)*"$/, '');
      let text = '';
      const strings = /"((?:[^"\\]|\\.)*)"/g;
      for (let match = strings.exec(shown); match; match = strings.exec(shown)) text += match[1]!.replace(/\\(.)/g, '$1');
      return { text: text.replace(/\s+/g, ' ').trim(), counter: /counters?\(/.test(shown), image: /url\(|gradient\(/.test(shown), style };
    }

    /**
     * Whether a list item shows its marker: it is displayed as a list item, has a list style, the
     * marker paints, and a marker outside the item has room before it (it is cut off by a box
     * that clips, and off the page at its edge).
     */
    function markerShows(item: Element, style: CSSStyleDeclaration, view: Window): { shows: boolean; inside: boolean } {
      const no = { shows: false, inside: false };
      if (style.display !== 'list-item') return no;
      const type = style.listStyleType;
      const image = style.listStyleImage;
      if ((type === 'none' || type.startsWith('disclosure')) && image === 'none') return no;
      const marker = view.getComputedStyle(item, '::marker');
      if (marker.content === 'none' || marker.content === '""') return no;
      if (image === 'none' && !(alphaOf(marker.color) > 0 && parseFloat(marker.fontSize) > 0)) return no;
      if (style.listStylePosition === 'inside') return { shows: true, inside: true };
      const rect = item.getBoundingClientRect();
      const clip = clipOf(item);
      const size = parseFloat(style.fontSize) || 0;
      const root = item.ownerDocument.documentElement;
      const room =
        style.direction === 'rtl'
          ? Math.min(clip ? clip.x + clip.width : Infinity, root.scrollWidth - view.scrollX) -
            (rect.right - (parseFloat(style.borderRightWidth) || 0) - (parseFloat(style.paddingRight) || 0))
          : rect.left + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.paddingLeft) || 0) - Math.max(clip ? clip.x : -Infinity, -view.scrollX);
      return { shows: room >= listLimits.markerRoomEm * size, inside: false };
    }

    /**
     * What stands before a line of text where a bullet would: a marker or generated content of
     * the elements this text is the first text of, or a small graphic right before it on its line.
     */
    function markerOf(piece: Piece, line: AgentRect): AgentListMarker | null {
      const view = piece.holder.ownerDocument.defaultView;
      if (!view) return null;
      let level = 0;
      for (let current: Element | null = piece.holder; current && level < listLimits.markerAncestorLevels; current = parentElementOf(current), level++) {
        if (firstPieceIn.get(current) !== piece) break;
        const style = view.getComputedStyle(current);
        const name = current.localName;
        // A `li` outside a list is for axe (`listitem`); `summary` shows a disclosure triangle.
        if (style.display === 'list-item' && name !== 'li' && name !== 'summary' && placeOf(current).list === null && markerShows(current, style, view).shows) {
          return { kind: 'list-item', text: '', key: style.listStyleType + '|' + shortKey(style.listStyleImage) };
        }
        const before = generated(current, view);
        if (!before) continue;
        if (before.counter) return { kind: 'pseudo-counter', text: '', key: shortKey(before.style.content) };
        if (before.text !== '') {
          if (alphaOf(before.style.color) > 0 && parseFloat(before.style.fontSize) > 0) {
            const text = before.text.slice(0, 16);
            return { kind: 'pseudo-text', text, key: text + '|' + (before.style.fontFamily.split(',')[0] ?? '').trim() };
          }
          continue;
        }
        const side = (...values: string[]): number => values.reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
        const width = side(before.style.width, before.style.borderLeftWidth, before.style.borderRightWidth, before.style.paddingLeft, before.style.paddingRight);
        const height = side(before.style.height, before.style.borderTopWidth, before.style.borderBottomWidth, before.style.paddingTop, before.style.paddingBottom);
        const paints =
          before.image || alphaOf(before.style.backgroundColor) > 0 || before.style.backgroundImage !== 'none' || hasBorder(before.style);
        // An image given as content has the size of the image, which styles do not tell.
        const sized = markerSized(width, height) || (before.image && before.style.width === 'auto');
        if (paints && sized) {
          return {
            kind: 'pseudo-shape',
            text: '',
            key: [Math.round(width) + 'x' + Math.round(height), before.style.backgroundColor, shortKey(before.style.backgroundImage), before.style.backgroundPosition, before.style.borderRadius, shortKey(before.style.content)].join('|'),
          };
        }
      }
      const graphic = piece.before;
      if (graphic && graphic.doc === piece.holder.ownerDocument) {
        const rtl = view.getComputedStyle(piece.holder).direction === 'rtl';
        const gap = rtl ? graphic.rect.x - (line.x + line.width) : line.x - (graphic.rect.x + graphic.rect.width);
        const overlap = Math.min(graphic.rect.y + graphic.rect.height, line.y + line.height) - Math.max(graphic.rect.y, line.y);
        if (
          overlap >= listLimits.sameRowMinOverlap * Math.min(graphic.rect.height, line.height) &&
          gap >= -listLimits.markerMinSizeCssPx &&
          gap <= listLimits.markerMaxGapEm * piece.look.style.size
        ) {
          return { kind: graphic.kind, text: '', key: graphic.key };
        }
      }
      return null;
    }

    /** A `ul`, `ol` or `menu`: recorded when its role was removed and markers still show, or when it is a list without markers. */
    function noteListElement(element: Element): void {
      const view = element.ownerDocument.defaultView;
      if (!view) return;
      const role = (element.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
      const exposed = listMarks.has(element);
      const presentational = (role === 'presentation' || role === 'none') && !exposed;
      const unstyled = exposed && !element.hasAttribute('role');
      if (!presentational && !unstyled) return;
      // Hidden from assistive technology altogether: not a list that lost its role.
      if (placeOf(element).contexts.has('ariaHidden')) return;
      let items = 0;
      let markers = 0;
      let inside = 0;
      let styled = false;
      let ownBullets = false;
      for (const child of composedChildren(element)) {
        if (child.nodeType !== 1 || (child as Element).localName !== 'li' || !ords.has(child as Element)) continue;
        const item = child as Element;
        const rect = item.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || !item.checkVisibility(VISIBLE)) continue;
        items++;
        const style = view.getComputedStyle(item);
        if (style.display === 'list-item' && (style.listStyleType !== 'none' || style.listStyleImage !== 'none')) styled = true;
        const before = generated(item, view);
        if (before && (before.text !== '' || before.image || before.counter)) ownBullets = true;
        const shown = markerShows(item, style, view);
        if (shown.shows) {
          markers++;
          if (shown.inside) inside++;
        }
      }
      if (items === 0) return;
      if (presentational && markers === 0) return;
      if (unstyled) {
        if (styled || ownBullets) return;
        for (let current: Element | null = element; current; current = parentElementOf(current)) {
          if (current.localName === 'nav' || (current.getAttribute('role') ?? '').trim().toLowerCase() === 'navigation') return;
        }
      }
      const box = boxOf(element);
      const slot = ords.get(element);
      if (!box || !slot) return;
      totalLists++;
      if (listElements.length >= listLimits.maxListElements) return;
      targets.push([element]);
      listElements.push({
        kind: presentational ? 'presentational' : 'unstyled',
        selector: selectorOf(element),
        frame: frameOf(element),
        tag: element.localName,
        box,
        ord: slot.ord,
        items,
        markers,
        markersInside: markers > 0 && inside === markers,
        target: targets.length - 1,
      });
    }

    /** Called when the walk leaves an element, once everything inside it has been visited. */
    function afterElement(element: Element): void {
      if (listMarks.has(element)) exposedLists++;
      const name = element.localName;
      if (name === 'ul' || name === 'ol' || name === 'menu') noteListElement(element);
      if ((element.shadowRoot ?? element).childElementCount >= listLimits.minRepeatedItems || name === 'slot') groupParents.push(element);
      // An empty element that paints a small box, or shows a glyph of an icon font: a bullet of its own.
      if (element.firstElementChild || element.shadowRoot || /\S/.test(element.textContent ?? '')) return;
      const view = element.ownerDocument.defaultView;
      if (!view || !element.checkVisibility(VISIBLE)) return;
      const rect = plainRect(element.getBoundingClientRect());
      if (!markerSized(rect.width, rect.height)) return;
      const style = view.getComputedStyle(element);
      const size = Math.round(rect.width) + 'x' + Math.round(rect.height);
      if (alphaOf(style.backgroundColor) > 0 || style.backgroundImage !== 'none' || style.maskImage !== 'none' || hasBorder(style)) {
        lastGraphic = {
          rect,
          kind: 'shape',
          // The position too: icons cut out of one sprite share everything else.
          key: ['shape', size, style.backgroundColor, shortKey(style.backgroundImage), style.backgroundPosition, shortKey(style.maskImage), style.maskPosition, style.borderRadius].join('|'),
          doc: element.ownerDocument,
        };
        return;
      }
      const before = generated(element, view);
      if (before && before.text !== '' && alphaOf(before.style.color) > 0) {
        lastGraphic = { rect, kind: 'image', key: ['glyph', before.text.slice(0, 16), (before.style.fontFamily.split(',')[0] ?? '').trim()].join('|'), doc: element.ownerDocument };
      }
    }

    /** The element and its ancestors in its document, innermost first: position, and position of the last element inside. */
    function chainOf(element: Element, levels: number = listLimits.maxAncestorLevels): number[] {
      const chain: number[] = [];
      let level = 0;
      for (let current: Element | null = element; current && level < levels; current = parentElementOf(current), level++) {
        const slot = ords.get(current);
        if (!slot) break;
        chain.push(slot.ord, slot.end);
      }
      return chain;
    }

    /** The lines of a block, as forced line breaks cut it. */
    function segmentsOf(entry: Pending, page: (rect: AgentRect) => AgentRect): AgentListLine[] {
      const out: AgentListLine[] = [];
      entry.starts.forEach((start, index) => {
        const pieces = entry.pieces.slice(start, entry.starts[index + 1] ?? entry.pieces.length);
        if (pieces.length === 0) return;
        const line = linesOf(pieces)[0]!;
        const text = pieces
          .map((piece, at) => (at > 0 && piece.apart ? ' ' : '') + piece.text)
          .join('')
          .replace(/\s+/g, ' ')
          .trim();
        const marker = markerOf(pieces[0]!, line);
        // The styles of the text before the first colon: of the name, when the line is a name and a value.
        let keyStyle: string | undefined;
        const styles: string[] = [];
        for (const piece of pieces) {
          let at = -1;
          for (const separator of listLimits.keySeparatorChars) {
            const index = piece.text.indexOf(separator);
            if (index >= 0 && (at < 0 || index < at)) at = index;
          }
          if (/\S/.test(at < 0 ? piece.text : piece.text.slice(0, at)) && !styles.includes(piece.look.signature)) styles.push(piece.look.signature);
          if (at >= 0) {
            keyStyle = styles.join('\n');
            break;
          }
        }
        out.push({
          start: text.slice(0, listLimits.lineStartChars),
          box: page(line),
          ...(marker ? { marker } : {}),
          end: text.slice(-listLimits.lineEndChars),
          startColor: pieces[0]!.look.style.color,
          ...(keyStyle !== undefined ? { keyStyle } : {}),
        });
      });
      return out;
    }

    interface Place {
      contexts: Set<AgentTextContext>;
      inMain: boolean;
      inListItem: boolean;
      region: Element | null;
      heading: Element | null;
      /** The nearest element, itself included, that the accessibility tree exposes as a list. */
      list: Element | null;
    }
    interface Look {
      visible: boolean;
      style: AgentTextStyle;
      signature: string;
      /** The text is painted in the colour of the background behind it, as far as styles tell. */
      blends: boolean;
    }
    interface Piece {
      node: Text;
      holder: Element;
      rects: AgentRect[];
      text: string;
      chars: number;
      look: Look;
      /** Something stands between this text and the text before it in its block: a forced line break, or the edge of a box. */
      apart?: boolean;
      /** Lists: the small graphic met just before this text, with no other text in between. */
      before?: Graphic;
      /** Grouping: how many elements the walk had numbered when it met this text. */
      at?: number;
    }
    interface Pending {
      pieces: Piece[];
      breaks: number;
      /** Where each line starts in `pieces`: the first piece, and the first after each forced line break. */
      starts: number[];
      /** Set once the block has taken in a neighbour: the element whose boxes they both are. */
      home?: Element;
    }
    const places = new Map<Element, Place>();
    const looks = new Map<Element, Look>();
    const clips = new Map<Element, AgentRect | null>();
    const offsets = new Map<Document, { x: number; y: number }>();
    const textCounts = new Map<Element, number>();
    const regionNames = new Map<Element, string>();
    const backdrops = new Map<Element, string | null>();
    const pending: Pending[] = [];

    const outerElement = (element: Element): Element | null => parentElementOf(element) ?? frameElementOf(element);

    function placeOf(element: Element): Place {
      const known = places.get(element);
      if (known) return known;
      // Iterative: the chain of ancestors can be long, and most of it is cached.
      const chain: Element[] = [];
      let base: Place | undefined;
      for (let current: Element | null = element; current; current = outerElement(current)) {
        base = places.get(current);
        if (base) break;
        chain.push(current);
      }
      let place: Place = base ?? { contexts: new Set(), inMain: false, inListItem: false, region: null, heading: null, list: null };
      for (let index = chain.length - 1; index >= 0; index--) {
        const current = chain[index]!;
        const own = ownContexts(current);
        let matchesRegion = false;
        let matchesMain = false;
        try {
          matchesRegion = current.matches(limits.regionSelector);
          matchesMain = current.matches('main,[role="main"]');
        } catch {
          // An invalid selector in the configuration: no regions.
        }
        const isHeading = headingMarks.has(current);
        const isItem = current.localName === 'li' || (current.getAttribute('role') ?? '').trim().toLowerCase() === 'listitem';
        const isList = listMarks.has(current);
        if (own.length > 0 || matchesRegion || matchesMain || isHeading || isItem || isList) {
          place = {
            contexts: own.length > 0 ? new Set([...place.contexts, ...own]) : place.contexts,
            inMain: place.inMain || matchesMain,
            inListItem: place.inListItem || isItem,
            region: matchesRegion ? current : place.region,
            heading: isHeading ? current : place.heading,
            list: isList ? current : place.list,
          };
        }
        places.set(current, place);
      }
      return place;
    }

    /**
     * The opaque colour behind the content of an element, as far as styles tell: the nearest
     * background colour among its ancestors. Null when they do not tell: a background image or a
     * translucent colour on the way, a frame (it shows the page that holds it), a root that asks
     * for a dark canvas. Content positioned behind the element is not looked for.
     */
    function backdropOf(element: Element): string | null {
      const chain: Element[] = [];
      let found: string | null | undefined;
      for (let current: Element | null = element; current; current = parentElementOf(current)) {
        const known = backdrops.get(current);
        if (known !== undefined) {
          found = known;
          break;
        }
        chain.push(current);
        const own = current.ownerDocument.defaultView?.getComputedStyle(current);
        const color = own && own.backgroundImage === 'none' ? parseColor(own.backgroundColor) : null;
        if (!own || !color || (color.a > 0 && color.a < 1)) {
          found = null;
          break;
        }
        if (color.a >= 1) {
          found = '#' + [color.r, color.g, color.b].map((channel) => channel.toString(16).padStart(2, '0')).join('');
          break;
        }
      }
      if (found === undefined) {
        // Nothing painted up to the root: the canvas, which is white unless the page asks otherwise.
        const root = element.ownerDocument.documentElement;
        const scheme = element.ownerDocument.defaultView?.getComputedStyle(root).colorScheme ?? '';
        found = element.ownerDocument === document && !scheme.includes('dark') ? '#ffffff' : null;
      }
      for (const current of chain) backdrops.set(current, found);
      return found;
    }

    function lookOf(holder: Element): Look {
      const known = looks.get(holder);
      if (known) return known;
      const view = holder.ownerDocument.defaultView;
      const computed = view?.getComputedStyle(holder);
      const color = computed ? parseColor(computed.color) : null;
      const hex = color
        ? '#' +
          [color.r, color.g, color.b, ...(color.a < 1 ? [Math.round(color.a * 255)] : [])]
            .map((channel) => channel.toString(16).padStart(2, '0'))
            .join('')
        : (computed?.color ?? '');
      const style: AgentTextStyle = {
        family: (computed?.fontFamily ?? '').split(',')[0]!.trim().replace(/^["']|["']$/g, '').toLowerCase(),
        size: computed ? parseFloat(computed.fontSize) || 0 : 0,
        weight: computed ? Number(computed.fontWeight) || 400 : 400,
        color: hex,
        transform: computed?.textTransform ?? 'none',
        italic: computed ? computed.fontStyle !== 'normal' : false,
      };
      const look: Look = {
        visible:
          !!computed &&
          holder.checkVisibility(VISIBLE) &&
          style.size >= limits.minFontSizeCssPx &&
          (color ? color.a > 0 : alphaOf(computed.color) > 0),
        style,
        signature: [style.family, Math.round(style.size * 10) / 10, style.weight, style.color, style.transform].join('|'),
        blends:
          !!computed &&
          !!color &&
          color.a >= 1 &&
          computed.textShadow === 'none' &&
          !(parseFloat(computed.webkitTextStrokeWidth) > 0) &&
          backdropOf(holder) === hex,
      };
      looks.set(holder, look);
      return look;
    }

    /** What clips the content of an element, in the client coordinates of its frame: its hidden-overflow ancestors. */
    function clipOf(element: Element): AgentRect | null {
      const chain: Element[] = [];
      let clip: AgentRect | null = null;
      for (let current: Element | null = element; current; current = parentElementOf(current)) {
        if (clips.has(current)) {
          clip = clips.get(current) ?? null;
          break;
        }
        chain.push(current);
      }
      for (let index = chain.length - 1; index >= 0; index--) {
        const current = chain[index]!;
        const own = current.ownerDocument.defaultView?.getComputedStyle(current);
        const hides = (value: string): boolean => value === 'hidden' || value === 'clip';
        if (own && (hides(own.overflowX) || hides(own.overflowY) || own.clip !== 'auto' || own.clipPath !== 'none')) {
          const rect = plainRect(current.getBoundingClientRect());
          clip = clip ? intersect(clip, rect) : rect;
        }
        clips.set(current, clip);
      }
      return clip;
    }

    function pieceOf(node: Text): Piece | null {
      if (!/\S/.test(node.data)) return null;
      const holder = node.parentElement ?? hostOf(node.parentNode);
      const view = holder?.ownerDocument.defaultView;
      if (!holder || !view) return null;
      const look = lookOf(holder);
      if (!look.visible) return null;
      const range = holder.ownerDocument.createRange();
      range.selectNodeContents(node);
      const clip = clipOf(holder);
      const root = holder.ownerDocument.documentElement;
      const page = { x: -view.scrollX, y: -view.scrollY, width: root.scrollWidth, height: root.scrollHeight };
      const rects: AgentRect[] = [];
      for (const raw of range.getClientRects()) {
        let rect = intersect(plainRect(raw), page);
        if (clip) rect = intersect(rect, clip);
        if (rect.width >= limits.minVisibleTextCssPx && rect.height >= limits.minVisibleTextCssPx) rects.push(rect);
      }
      if (rects.length === 0) return null;
      const text = node.data.replace(/\s+/g, ' ');
      return { node, holder, rects, text, chars: text.replace(/\s/g, '').length, look };
    }

    function dominant(pieces: Piece[]): { look: Look; share: number } {
      const weights = new Map<string, { look: Look; chars: number }>();
      let all = 0;
      for (const piece of pieces) {
        const entry = weights.get(piece.look.signature) ?? { look: piece.look, chars: 0 };
        entry.chars += piece.chars;
        weights.set(piece.look.signature, entry);
        all += piece.chars;
      }
      let best: { look: Look; chars: number } | null = null;
      for (const entry of weights.values()) {
        if (!best || entry.chars > best.chars || (entry.chars === best.chars && entry.look.signature < best.look.signature)) best = entry;
      }
      return { look: best!.look, share: all > 0 ? best!.chars / all : 1 };
    }

    /** The inline content of one block container, split at forced line breaks. */
    let open: Piece[][] | null = null;

    function flush(): void {
      const segments = (open ?? []).filter((segment) => segment.length > 0);
      open = null;
      if (segments.length === 0) return;
      // A forced line break splits the block only where the style changes across it.
      let group: Piece[] = [];
      let breaks = 0;
      let starts: number[] = [];
      let signature = '';
      const close = (): void => {
        if (group.length === 0) return;
        total++;
        if (pending.length < limits.maxBlocks) {
          const entry: Pending = { pieces: group, breaks, starts };
          pending.push(entry);
          for (const piece of group) {
            for (let current: Element | null = piece.holder; current; current = parentElementOf(current)) {
              textCounts.set(current, (textCounts.get(current) ?? 0) + 1);
              if (!forLists) continue;
              if (current === piece.holder) looseCounts.set(current, (looseCounts.get(current) ?? 0) + piece.chars);
              if (!firstPieceIn.has(current)) firstPieceIn.set(current, piece);
              charCounts.set(current, (charCounts.get(current) ?? 0) + piece.chars);
              if (lastBlockIn.get(current) !== entry) {
                lastBlockIn.set(current, entry);
                blockCounts.set(current, (blockCounts.get(current) ?? 0) + 1);
              }
            }
          }
        }
        group = [];
        breaks = 0;
        starts = [];
      };
      for (const segment of segments) {
        const own = dominant(segment).look.signature;
        if (group.length > 0 && own !== signature) close();
        else if (group.length > 0) {
          breaks++;
          // The two sides of a line break are separate words, with or without white space around it.
          segment[0]!.apart = true;
        }
        if (group.length === 0) signature = own;
        starts.push(group.length);
        group.push(...segment);
      }
      close();
    }

    function visit(node: Node): void {
      if (node.nodeType === 3) {
        const piece = pieceOf(node as Text);
        if (!piece) return;
        if (lastGraphic) piece.before = lastGraphic;
        lastGraphic = null;
        if (forGrouping) piece.at = ordElements.length;
        open ??= [[]];
        open[open.length - 1]!.push(piece);
        return;
      }
      if (node.nodeType !== 1) return;
      const element = node as Element;
      const name = element.localName;
      if (TEXT_SKIPPED.includes(name)) {
        if (forLists && (name === 'img' || name === 'svg')) noteGraphic(element);
        // Grouping: a native control is numbered like any element, although nothing is read inside it.
        if (forGrouping && controlMarks.has(element)) {
          ords.set(element, { ord: ordElements.length, end: ordElements.length });
          ordElements.push(element);
          controlElements.push(element);
        }
        return;
      }
      const view = element.ownerDocument.defaultView;
      if (!view) return;
      const display = view.getComputedStyle(element).display;
      if (display === 'none' || contentHidden.has(element)) return;
      if (name === 'br') {
        if (open && open[open.length - 1]!.length > 0) open.push([]);
        return;
      }
      // Lists: the position of the element among the elements of the page, and of the last one inside it.
      const slot = withOrds ? { ord: ordElements.length, end: 0 } : null;
      if (slot) {
        ords.set(element, slot);
        ordElements.push(element);
        if (forGrouping) {
          if (controlMarks.has(element)) controlElements.push(element);
          if (groupMarks.has(element)) groupElements.push(element);
        }
      }
      if (isFrame(element)) {
        flush();
        const doc = frameDocument(element);
        // Where a transformed frame puts its content cannot be worked out from its box.
        if (doc?.body && !inTransformedFrame(doc.body)) visit(doc.body);
        flush();
        if (slot) slot.end = ordElements.length - 1;
        return;
      }
      const inline = display === 'inline' || display === 'contents' || display.startsWith('ruby');
      if (!inline) flush();
      for (const child of composedChildren(element)) visit(child);
      if (!inline) flush();
      if (slot) {
        slot.end = ordElements.length - 1;
        if (forLists) afterElement(element);
      }
    }

    if (document.body) visit(document.body);
    flush();

    const offsetOf = (element: Element): { x: number; y: number } => {
      const doc = element.ownerDocument;
      let offset = offsets.get(doc);
      if (!offset) {
        offset = frameOffset(element);
        offsets.set(doc, offset);
      }
      return offset;
    };
    const regionName = (region: Element | null): string => {
      if (!region) return '';
      let name = regionNames.get(region);
      if (name === undefined) {
        const frame = frameOf(region);
        name = (frame ? frame + JOIN : '') + selectorOf(region);
        regionNames.set(region, name);
      }
      return name;
    };

    const sameLine = (a: AgentRect, b: AgentRect): boolean =>
      Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) >= limits.sameLineMinOverlap * Math.min(a.height, b.height);
    /** Lines, from the painted boxes of the text. */
    const linesOf = (pieces: Piece[]): AgentRect[] => {
      const rects = pieces.flatMap((piece) => piece.rects).sort((a, b) => a.y - b.y || a.x - b.x);
      const lines: AgentRect[] = [];
      for (const rect of rects) {
        const last = lines[lines.length - 1];
        if (last && sameLine(last, rect)) lines[lines.length - 1] = union(last, rect);
        else lines.push(rect);
      }
      return lines;
    };
    /** The lowest element that holds all the text of a block. */
    const containerOf = (pieces: Piece[]): Element => {
      let element = pieces[0]!.holder;
      for (const piece of pieces) {
        while (!composedContains(element, piece.holder)) {
          const parent = parentElementOf(element);
          if (!parent) break;
          element = parent;
        }
      }
      return element;
    };

    // One text laid out in several boxes is one block: the words of a title set as inline blocks
    // or as flex items, text around a word that must not wrap. Two blocks that follow each other
    // are joined when they have one style, are boxes of one element, and sit on one line no
    // further apart than words are. Boxes that are something of their own (a link, a button, a
    // cell, a list item, a heading) are peers, and peers in a row are set further apart.
    const standsAlone = (element: Element): boolean =>
      ownContexts(element).length > 0 ||
      headingMarks.has(element) ||
      element.localName === 'li' ||
      (element.getAttribute('role') ?? '').trim().toLowerCase() === 'listitem';
    const sharedHome = (a: Pending, b: Pending): Element | null => {
      const inner = containerOf(b.pieces);
      const outer = parentElementOf(inner);
      const boxes: Element[] = [];
      let home: Element | null = null;
      if (a.home) {
        home = a.home === inner || a.home === outer ? a.home : null;
      } else {
        const own = containerOf(a.pieces);
        const above = parentElementOf(own);
        if (own === inner) return null;
        if (own === outer) home = own;
        else if (above !== null && (above === inner || above === outer)) home = above;
        if (home !== null && own !== home) boxes.push(own);
      }
      if (home === null) return null;
      if (inner !== home) boxes.push(inner);
      return boxes.some(standsAlone) ? null : home;
    };
    const blocksToRead: Pending[] = [];
    for (const entry of pending) {
      const last = blocksToRead[blocksToRead.length - 1];
      const look = dominant(entry.pieces).look;
      if (last && entry.pieces[0]!.holder.ownerDocument === last.pieces[0]!.holder.ownerDocument && dominant(last.pieces).look.signature === look.signature) {
        const before = linesOf(last.pieces);
        const a = before[before.length - 1]!;
        const b = linesOf(entry.pieces)[0]!;
        const gap = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
        if (sameLine(a, b) && Math.abs(gap) <= limits.mergeMaxGapEm * look.style.size) {
          const home = sharedHome(last, entry);
          if (home) {
            entry.pieces[0]!.apart = true;
            // The first line of the block that is taken in goes on with the last line of this one.
            last.starts.push(...entry.starts.slice(1).map((start) => start + last.pieces.length));
            last.pieces.push(...entry.pieces);
            last.breaks += entry.breaks;
            last.home = home;
            total--;
            continue;
          }
        }
      }
      blocksToRead.push(entry);
    }

    // Grouping: which text is tied to which control or container. Worked out now that the walk
    // has met every control: a label can stand before its control.
    interface Binding {
      /** Controls this element labels, by index; -1 stands for a control that is not among those read. */
      labels: number[];
      group: number;
      describes: boolean;
      inControl: boolean;
      disclosure: boolean;
    }
    const NO_BINDING: Binding = { labels: [], group: -1, describes: false, inControl: false, disclosure: false };
    const MAX_LABELLED = options.grouping.maxLabelTargets;
    const controlIndex = new Map<Element, number>();
    const groupIndex = new Map<Element, number>();
    const boundTargets = new Map<Element, Binding>();
    const bindings = new Map<Element, Binding>();
    /** The controls that show, or whose labels show, with what shows of them (client coordinates of their frame). */
    const shownControls: { element: Element; rect: AgentRect; proxied: boolean }[] = [];
    if (forGrouping) {
      const minSide = options.grouping.minControlSizeCssPx;
      const shownRect = (target: Element): AgentRect | null => {
        const view = target.ownerDocument.defaultView;
        if (!view || !target.checkVisibility(VISIBLE)) return null;
        let rect = plainRect(target.getBoundingClientRect());
        const root = target.ownerDocument.documentElement;
        rect = intersect(rect, { x: -view.scrollX, y: -view.scrollY, width: root.scrollWidth, height: root.scrollHeight });
        const holder = parentElementOf(target);
        const clip = holder ? clipOf(holder) : null;
        if (clip) rect = intersect(rect, clip);
        return rect.width >= minSide && rect.height >= minSide ? rect : null;
      };
      for (const element of controlElements) {
        let rect = shownRect(element);
        let proxied = false;
        if (!rect) {
          // A native control hidden under its label: the label is what shows of it.
          const labels = (element as HTMLInputElement).labels;
          for (const label of labels ? [...labels].slice(0, MAX_LABELLED) : []) {
            const own = shownRect(label);
            if (own) rect = rect ? union(rect, own) : own;
          }
          proxied = rect !== null;
        }
        if (rect) shownControls.push({ element, rect, proxied });
      }
      shownControls.slice(0, options.grouping.maxControls).forEach((entry, index) => controlIndex.set(entry.element, index));
      groupElements.forEach((element, index) => groupIndex.set(element, index));
      const targetOf = (element: Element): Binding => {
        let binding = boundTargets.get(element);
        if (!binding) {
          binding = { labels: [], group: -1, describes: false, inControl: false, disclosure: false };
          boundTargets.set(element, binding);
        }
        return binding;
      };
      const referenced = (owner: Element, attribute: string): Element[] => {
        const value = owner.getAttribute(attribute);
        if (!value) return [];
        const root = owner.getRootNode() as Document | ShadowRoot;
        const found: Element[] = [];
        for (const id of value.split(/\s+/).filter(Boolean).slice(0, MAX_LABELLED)) {
          const target = typeof root.getElementById === 'function' ? root.getElementById(id) : null;
          if (target) found.push(target);
        }
        return found;
      };
      // Every control the accessibility tree exposes, also those that do not show or are beyond
      // the limit: text that names one of them is not free to be the label of something else.
      for (const element of controlMarks.keys()) {
        const index = controlIndex.get(element) ?? -1;
        for (const target of referenced(element, 'aria-labelledby')) {
          const binding = targetOf(target);
          if (binding.labels.length < MAX_LABELLED && !binding.labels.includes(index)) binding.labels.push(index);
        }
        for (const target of referenced(element, 'aria-describedby')) targetOf(target).describes = true;
      }
      groupElements.forEach((element, index) => {
        for (const target of referenced(element, 'aria-labelledby')) {
          const binding = targetOf(target);
          if (binding.group < 0) binding.group = index;
        }
        for (const target of referenced(element, 'aria-describedby')) targetOf(target).describes = true;
      });
    }
    /** What an element is tied to, itself or through what it is inside. */
    function bindingOf(element: Element): Binding {
      const chain: Element[] = [];
      let base: Binding | undefined;
      for (let current: Element | null = element; current; current = parentElementOf(current)) {
        base = bindings.get(current);
        if (base) break;
        chain.push(current);
      }
      let binding = base ?? NO_BINDING;
      for (let index = chain.length - 1; index >= 0; index--) {
        const current = chain[index]!;
        const name = current.localName;
        const target = boundTargets.get(current);
        let labels = target ? target.labels : [];
        let group = target ? target.group : -1;
        if (name === 'label') {
          const control = (current as HTMLLabelElement).control;
          if (control) labels = [...labels, controlIndex.get(control) ?? -1];
        } else if (name === 'legend' && group < 0) {
          const fieldset = current.parentElement;
          if (fieldset && fieldset.localName === 'fieldset') {
            let first: Element | null = fieldset.firstElementChild;
            while (first && first.localName !== 'legend') first = first.nextElementSibling;
            const index = first === current ? groupIndex.get(fieldset) : undefined;
            if (index !== undefined) group = index;
          }
        }
        const inControl = controlMarks.has(current);
        const disclosure =
          name === 'summary' || (current.hasAttribute('aria-expanded') && (name === 'button' || (current.getAttribute('role') ?? '').trim().toLowerCase() === 'button'));
        if (labels.length > 0 || group >= 0 || target?.describes || inControl || disclosure) {
          binding = {
            labels: labels.length > 0 ? [...new Set([...binding.labels, ...labels])].slice(0, MAX_LABELLED) : binding.labels,
            // The nearest container that the text names.
            group: group >= 0 ? group : binding.group,
            describes: binding.describes || target?.describes === true,
            inControl: binding.inControl || inControl,
            disclosure: binding.disclosure || disclosure,
          };
        }
        bindings.set(current, binding);
      }
      return binding;
    }

    for (const entry of blocksToRead) {
      const { pieces, breaks } = entry;
      const first = pieces[0]!;
      const lines = linesOf(pieces);
      const offset = offsetOf(first.holder);
      const page = (rect: AgentRect): AgentRect => toPage({ ...rect, x: rect.x + offset.x, y: rect.y + offset.y });

      let element = containerOf(pieces);
      // An inline wrapper that holds all the text of its parent stands for nothing: name the parent.
      for (;;) {
        const parent = element.parentElement;
        const display = element.ownerDocument.defaultView?.getComputedStyle(element).display;
        if (!parent || parent === element.ownerDocument.body || (display !== 'inline' && display !== 'contents')) break;
        if ((textCounts.get(parent) ?? 0) !== pieces.length) break;
        element = parent;
      }

      const place = placeOf(element);
      const piecePlaces = pieces.map((piece) => placeOf(piece.holder));
      const headingElement = piecePlaces[0]!.heading;
      const isHeading = headingElement !== null && piecePlaces.every((own) => own.heading === headingElement);
      const { look, share } = dominant(pieces);
      const text = pieces
        .map((piece) => (piece.apart ? ' ' : '') + piece.text)
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      surveyedBlocks.push({ nodes: pieces.map((piece) => piece.node), element });
      if (forLists) {
        const own = element.ownerDocument.defaultView?.getComputedStyle(element);
        listBlocks.push({
          selector: selectorOf(element),
          frame: frameOf(element),
          tag: element.localName,
          text: text.slice(0, limits.maxTextChars),
          chars: text.replace(/\s/g, '').length,
          words: text.split(' ').filter(Boolean).length,
          box: page(lines.reduce(union)),
          lines: lines.length,
          firstLine: page(lines[0]!),
          style: look.style,
          contexts: CONTEXT_ORDER.filter((context) => piecePlaces.every((own) => own.contexts.has(context))),
          inList: piecePlaces.every((own) => own.list !== null),
          heading: isHeading,
          rtl: own?.direction === 'rtl',
          // Inherited: also the text of a block inside something that is clicked.
          ...(own?.cursor === 'pointer' ? { clickable: true } : {}),
          chain: chainOf(element),
          segments: segmentsOf(entry, page),
        });
        continue;
      }
      if (forGrouping) {
        const tied = pieces.map((piece) => bindingOf(piece.holder));
        const loose = tied.map((own) => own.labels.length === 0 && own.group < 0 && !own.describes && !own.inControl);
        // The part that is tied to nothing, when another part is the label of a control.
        const looseText = loose.every(Boolean)
          ? ''
          : pieces
              .filter((_, at) => loose[at])
              .map((piece) => piece.text)
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim();
        const labels: number[] = [];
        for (const own of tied) {
          for (const index of own.labels) if (!labels.includes(index)) labels.push(index);
        }
        groupingBlocks.push({
          frame: frameOf(element),
          at: first.at ?? 0,
          end: pieces[pieces.length - 1]!.at ?? 0,
          text: text.slice(0, limits.maxTextChars),
          chars: text.replace(/\s/g, '').length,
          words: text.split(' ').filter(Boolean).length,
          lines: lines.length,
          box: page(lines.reduce(union)),
          style: look.style,
          contexts: CONTEXT_ORDER.filter((context) => piecePlaces.every((own) => own.contexts.has(context))),
          heading: isHeading ? (headingMarks.get(headingElement) ?? 0) : 0,
          labels: labels.filter((index) => index >= 0).slice(0, MAX_LABELLED),
          group: tied.find((own) => own.group >= 0)?.group ?? -1,
          describes: tied.every((own) => own.describes),
          otherLabel: labels.includes(-1),
          inControl: tied.every((own) => own.inControl),
          disclosure: tied.every((own) => own.disclosure),
          // Some of the text is tied to nothing at all. Punctuation alone does not count: the colon
          // after a label (`<label>Summary</label>:`) does not make that label free text.
          free: loose.some((own, at) => own && /[\p{L}\p{N}]/u.test(pieces[at]!.text)),
          ...(/[\p{L}\p{N}]/u.test(looseText) ? { freeText: looseText.slice(0, limits.maxTextChars) } : {}),
        });
        continue;
      }
      blocks.push({
        selector: selectorOf(element),
        frame: frameOf(element),
        tag: element.localName,
        text: text.slice(0, limits.maxTextChars),
        chars: text.replace(/\s/g, '').length,
        words: text.split(' ').filter(Boolean).length,
        box: page(lines.reduce(union)),
        lines: lines.length,
        firstLine: page(lines[0]!),
        lastLine: page(lines[lines.length - 1]!),
        breaks,
        style: look.style,
        styleShare: share,
        contexts: CONTEXT_ORDER.filter((context) => piecePlaces.every((own) => own.contexts.has(context))),
        inMain: piecePlaces.every((own) => own.inMain),
        inListItem: piecePlaces.every((own) => own.inListItem),
        region: regionName(place.region),
        heading: isHeading ? { level: headingMarks.get(headingElement) ?? 0, selector: selectorOf(headingElement) } : null,
        ...(pieces.every((piece) => piece.look.blends) ? { sameColourAsBackground: true } : {}),
      });
    }
    if (forGrouping) {
      const limit = options.grouping;
      const CHOICES: Record<string, 'radio' | 'checkbox'> = { radio: 'radio', checkbox: 'checkbox', switch: 'checkbox' };
      const COMPOSITES = ['toolbar', 'menu', 'menubar', 'tablist', 'tree', 'treegrid', 'grid', 'listbox'];
      const ownRole = (element: Element): string => (element.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
      const forms = new Map<Element, number>();
      const roots = new Map<Node, number>();
      const numberOf = <K>(map: Map<K, number>, key: K): number => {
        let index = map.get(key);
        if (index === undefined) {
          index = map.size;
          map.set(key, index);
        }
        return index;
      };
      const kept = shownControls.slice(0, limit.maxControls);
      const controls: AgentGroupingControl[] = kept.map(({ element, rect, proxied }) => {
        const mark = controlMarks.get(element)!;
        const name = element.localName;
        const style = element.ownerDocument.defaultView?.getComputedStyle(element);
        const offset = offsetOf(element);
        const place = placeOf(element);
        const slot = ords.get(element)!;
        const type = name === 'input' ? ((element as HTMLInputElement).type || 'text').toLowerCase() : '';
        const form = (element as HTMLInputElement).form ?? element.closest('form');
        let inWidget = false;
        let radiogroup: Element | null = null;
        for (let current = parentElementOf(element); current; current = parentElementOf(current)) {
          const role = ownRole(current);
          if (COMPOSITES.includes(role)) inWidget = true;
          if (role === 'radiogroup' && !radiogroup) radiogroup = current;
        }
        const kind = CHOICES[mark.role] ?? 'field';
        const formNumber = form ? numberOf(forms, form) : -1;
        let setKey = '';
        const nameAttribute = name === 'input' && (type === 'radio' || type === 'checkbox') ? (element.getAttribute('name') ?? '') : '';
        if (nameAttribute !== '') setKey = 'n:' + numberOf(roots, element.getRootNode()) + ':' + formNumber + ':' + nameAttribute;
        else if (mark.role === 'radio' && radiogroup) {
          const at = ords.get(radiogroup);
          if (at) setKey = 'g:' + at.ord;
        }
        const cellElement = place.contexts.has('tableCell') || place.contexts.has('tableHeader') ? element.closest('td,th,[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]') : null;
        return {
          selector: selectorOf(element),
          frame: frameOf(element),
          ord: slot.ord,
          chain: chainOf(element, limit.maxAncestorLevels),
          box: toPage({ ...rect, x: rect.x + offset.x, y: rect.y + offset.y }),
          ...(proxied ? { proxied: true } : {}),
          kind,
          role: mark.role,
          element: name + (type ? ':' + type : ''),
          name: mark.name,
          description: mark.description,
          setKey,
          form: formNumber,
          region: regionName(place.region),
          cell: cellElement ? (ords.get(cellElement)?.ord ?? -1) : -1,
          inWidget,
          fontSize: style ? parseFloat(style.fontSize) || 0 : 0,
          rtl: style?.direction === 'rtl',
          ...(mark.role === 'switch' ? { switch: true } : {}),
        };
      });
      const groups: AgentGroupingGroup[] = groupElements.map((element) => {
        const slot = ords.get(element)!;
        const mark = groupMarks.get(element)!;
        return { selector: selectorOf(element), frame: frameOf(element), ord: slot.ord, end: slot.end, role: mark.role, name: mark.name };
      });
      groupingControls = kept.map((entry) => entry.element);
      listOrdElements = ordElements;
      return {
        survey: { blocks, total },
        lists: null,
        grouping: { controls, totalControls: shownControls.length, groups, blocks: groupingBlocks, totalBlocks: total },
      };
    }
    if (!forLists) return { survey: { blocks, total }, lists: null };

    // Series of sibling elements of one shape. Looked for now, when every block of text is known.
    const STRUCTURE_TAGS = ['table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup', 'dl', 'select', 'datalist', 'optgroup', 'ruby'];
    const STRUCTURE_ROLES = [
      'table', 'grid', 'treegrid', 'rowgroup', 'row', 'list', 'tablist', 'menu', 'menubar', 'listbox', 'tree', 'radiogroup', 'toolbar', 'feed', 'combobox',
    ];
    const NOT_IN: AgentTextContext[] = ['ariaHidden', 'button', 'link', 'label', 'code', 'tableCell', 'tableHeader', 'term', 'caption'];
    const SHAPE_LEAVES = ['img', 'svg', 'picture', 'video', 'canvas', 'input', 'select', 'textarea'];
    const FIELD_ROLES = ['textbox', 'searchbox', 'combobox', 'slider', 'spinbutton', 'checkbox', 'radio', 'switch'];
    const NOT_FIELDS = ['hidden', 'button', 'submit', 'reset', 'image'];
    const INSIDE = 'a[href],[role],button,summary,input,select,textarea,[contenteditable],img,svg,picture,video,canvas,ul,ol,dl,table';
    const roleOf = (element: Element): string => (element.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
    const shapeMemo: Map<Element, string>[] = [];
    const shapeOf = (element: Element, depth: number): string => {
      const memo = (shapeMemo[depth] ??= new Map<Element, string>());
      const known = memo.get(element);
      if (known !== undefined) return known;
      let shape = element.localName;
      if (depth > 0) {
        const parts: string[] = [];
        for (const child of composedChildren(element)) {
          if (child.nodeType !== 1) continue;
          if (!ords.has(child as Element) && !SHAPE_LEAVES.includes((child as Element).localName)) continue;
          const own = shapeOf(child as Element, depth - 1);
          // Two paragraphs or three: the same shape.
          if (parts[parts.length - 1] !== own) parts.push(own);
        }
        if (parts.length > 0) shape += '(' + parts.join(',') + ')';
      }
      shape = shortKey(shape);
      memo.set(element, shape);
      return shape;
    };
    const structural = (parent: Element): boolean => {
      if (STRUCTURE_ROLES.includes(roleOf(parent))) return true;
      if (!STRUCTURE_TAGS.includes(parent.localName)) return false;
      // The rows of a table used for layout are not rows to assistive technology.
      const tableRole = parent.localName === 'dl' ? '' : roleOf(parent.closest('table') ?? parent);
      return tableRole !== 'presentation' && tableRole !== 'none';
    };
    const facts = (item: Element): AgentListGroupItem => {
      const slot = ords.get(item)!;
      const chars = charCounts.get(item) ?? 0;
      const isLink = (element: Element): boolean => (element.localName === 'a' && element.hasAttribute('href')) || roleOf(element) === 'link';
      const isButton = (element: Element): boolean => {
        const name = element.localName;
        const type = (element.getAttribute('type') ?? '').toLowerCase();
        return name === 'button' || name === 'summary' || roleOf(element) === 'button' || (name === 'input' && ['button', 'submit', 'reset'].includes(type));
      };
      const whole = { link: isLink(item), button: isButton(item) };
      let links = whole.link ? 1 : 0;
      let linkChars = whole.link ? chars : 0;
      let buttonChars = whole.button ? chars : 0;
      let controls = 0;
      let graphics = 0;
      // A list or a table is no item of a series, whatever stands beside it.
      let inner = ['ul', 'ol', 'dl', 'table'].includes(item.localName) || ['list', 'table', 'grid'].includes(roleOf(item)) ? 1 : 0;
      for (const element of item.querySelectorAll(INSIDE)) {
        const name = element.localName;
        const role = roleOf(element);
        if (isLink(element)) {
          links++;
          if (!whole.link) linkChars += charCounts.get(element) ?? 0;
        } else if (isButton(element)) {
          if (!whole.button) buttonChars += charCounts.get(element) ?? 0;
        }
        if (name === 'select' || name === 'textarea' || FIELD_ROLES.includes(role) || element.hasAttribute('contenteditable')) controls++;
        else if (name === 'input' && !NOT_FIELDS.includes((element.getAttribute('type') ?? '').toLowerCase())) controls++;
        if (name === 'img' || name === 'svg' || name === 'picture' || name === 'video' || name === 'canvas') graphics++;
        if (name === 'ul' || name === 'ol' || name === 'dl' || name === 'table' || role === 'list' || role === 'table' || role === 'grid') inner++;
      }
      let heading: AgentListGroupItem['heading'] = 'none';
      for (const element of headingMarks.has(item) ? [item] : item.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')) {
        if (!headingMarks.has(element)) continue;
        heading = element.querySelector('a[href]') || element.closest('a[href]') ? 'link' : 'plain';
        break;
      }
      return {
        box: toPage(viewportRect(item)),
        ord: slot.ord,
        end: slot.end,
        blocks: blockCounts.get(item) ?? 0,
        chars,
        links,
        linkChars: Math.min(chars, linkChars),
        buttonChars: Math.min(chars, buttonChars),
        controls,
        graphics,
        lists: inner,
        heading,
        text: (item.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, listLimits.itemTextMaxChars),
      };
    };
    const groups: AgentListGroup[] = [];
    let totalGroups = 0;
    groupParents.sort((a, b) => ords.get(a)!.ord - ords.get(b)!.ord);
    // Bounded: each parent costs a look at its place in the page and at the box and the shape of
    // every child. The survey says how many were left out.
    const totalParents = groupParents.length;
    const readParents = groupParents.slice(0, listLimits.maxGroupParents);
    for (const parent of readParents) {
      const place = placeOf(parent);
      if (place.list !== null || NOT_IN.some((context) => place.contexts.has(context)) || structural(parent)) continue;
      const kids: Element[] = [];
      for (const child of composedChildren(parent)) {
        if (child.nodeType !== 1 || !ords.has(child as Element)) continue;
        const rect = (child as Element).getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && (child as Element).checkVisibility(VISIBLE)) kids.push(child as Element);
      }
      let series = 0;
      for (let start = 0; start < kids.length; ) {
        const shape = shapeOf(kids[start]!, listLimits.shapeDepth);
        let stop = start + 1;
        while (stop < kids.length && shapeOf(kids[stop]!, listLimits.shapeDepth) === shape) stop++;
        const members = kids.slice(start, stop);
        start = stop;
        if (members.length < listLimits.minRepeatedItems) continue;
        // Without text there is nothing to call an item: spacers, a row of pictures.
        if (!members.some((member) => (charCounts.get(member) ?? 0) > 0)) continue;
        totalGroups++;
        if (groups.length >= listLimits.maxGroups) continue;
        const measured = members.slice(0, listLimits.maxGroupItems);
        const slot = ords.get(parent)!;
        targets.push(measured);
        groups.push({
          // A second series under one parent is named after its first item, so that the two stay apart.
          selector: selectorOf(series === 0 ? parent : members[0]!),
          frame: frameOf(parent),
          ord: slot.ord,
          end: slot.end,
          count: members.length,
          looseChars: looseCounts.get(parent) ?? 0,
          items: measured.map(facts),
          navigation: place.contexts.has('navigation'),
          target: targets.length - 1,
        });
        series++;
      }
    }

    listOrdElements = ordElements;
    listTargets = targets;
    return {
      survey: { blocks, total },
      lists: { blocks: listBlocks, totalBlocks: total, groups, totalGroups, parents: readParents.length, totalParents, lists: listElements, totalLists, exposedLists },
    };
  }

  function listSelectors(positions: number[]): (string | null)[] {
    return positions.map((position) => {
      const element = listOrdElements[position];
      return element && element.isConnected ? selectorOf(element) : null;
    });
  }

  /** True when content that floats over the page (fixed or sticky, outside what holds the element) lies at a point of the element's frame. */
  function floatsOver(element: Element, x: number, y: number): boolean {
    const doc = element.ownerDocument;
    const view = doc.defaultView;
    if (!view || x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) return false;
    let floating = false;
    for (let current: Node | null = topElementAt(doc, x, y); current; current = composedParent(current)) {
      if (current.nodeType !== 1) continue;
      if (composedContains(current, element)) break;
      const position = view.getComputedStyle(current as Element).position;
      if (position === 'fixed' || position === 'sticky') floating = true;
    }
    return floating || frameCoveredAt(element, x, y);
  }

  /**
   * Scrolls what a finding of the lists check is about into view and says what to capture: the
   * blocks of text (`blocks`, by position in the last survey) or the elements behind a capture
   * handle (`elements`), with a margin, as far as the window shows them.
   */
  async function prepareList(kind: 'blocks' | 'elements', ids: number[]): Promise<AgentHeadingPrepared> {
    const none = { clip: null, covered: false };
    const entries = kind === 'blocks' ? ids.map((id) => surveyedBlocks[id]).filter((entry) => entry !== undefined) : [];
    const members = kind === 'elements' ? (listTargets[ids[0] ?? -1] ?? []) : [];
    const anchor = kind === 'blocks' ? entries[0]?.element : members[0];
    if (!anchor || !anchor.isConnected) return none;
    // Registered, so that the scroll positions of what holds it are put back by cleanup().
    keyOf(anchor);
    ensureStableAround(anchor);
    anchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    await settle();
    if (!anchor.isConnected || inTransformedFrame(anchor)) return none;
    let own: AgentRect | null = null;
    const add = (rect: AgentRect): void => {
      if (rect.width > 0 && rect.height > 0) own = own ? union(own, rect) : rect;
    };
    for (const entry of entries) {
      for (const node of entry.nodes) {
        if (!node.isConnected || node.ownerDocument !== anchor.ownerDocument) continue;
        const range = node.ownerDocument.createRange();
        range.selectNodeContents(node);
        add(plainRect(range.getBoundingClientRect()));
      }
    }
    for (const member of members) {
      if (member.isConnected && member.ownerDocument === anchor.ownerDocument) add(plainRect(member.getBoundingClientRect()));
    }
    const found = own as AgentRect | null;
    if (!found) return none;
    const view = anchor.ownerDocument.defaultView;
    if (!view) return none;
    const offset = frameOffset(anchor);
    const margin = options.lists.clipMarginCssPx;
    // The boxes of text do not hold a bullet that is drawn or generated: room is left for it on both sides.
    const beside = margin + (kind === 'blocks' ? options.lists.clipMarkerRoomCssPx : 0);
    let left = Math.max(0, found.x + offset.x - beside);
    let right = Math.min(window.innerWidth, found.x + found.width + offset.x + beside);
    let upper = Math.max(0, found.y + offset.y - margin);
    let lower = Math.min(window.innerHeight, found.y + found.height + offset.y + margin);
    if (view !== window) {
      // Inside a frame, only what the frame shows.
      left = Math.max(left, offset.x);
      right = Math.min(right, offset.x + view.innerWidth);
      upper = Math.max(upper, offset.y);
      lower = Math.min(lower, offset.y + view.innerHeight);
    }
    if (right - left < 1 || lower - upper < 1) return none;
    // A capture is evidence only if it shows the content: not when a banner or a dialog lies over it.
    if (floatsOver(anchor, (left + right) / 2 - offset.x, (upper + lower) / 2 - offset.y)) return { clip: null, covered: true };
    const x0 = Math.floor(left + window.scrollX);
    const y0 = Math.floor(upper + window.scrollY);
    const x1 = Math.ceil(right + window.scrollX);
    const y1 = Math.ceil(lower + window.scrollY);
    const shown = intersect(
      { x: found.x + offset.x + window.scrollX, y: found.y + offset.y + window.scrollY, width: found.width, height: found.height },
      { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    );
    return { clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, target: shown, covered: false };
  }

  /**
   * Scrolls what a finding of the grouping check is about into view and says what to capture: the
   * text (blocks of the last survey, by index) and the controls (of the last grouping survey, by
   * index) with their labels, with a margin, as far as the window shows them.
   */
  async function prepareGrouping(blockIds: number[], controlIds: number[], targetBlock: number): Promise<AgentHeadingPrepared> {
    const none = { clip: null, covered: false };
    const entries = blockIds.map((id) => surveyedBlocks[id]).filter((entry) => entry !== undefined);
    const members = controlIds.map((id) => groupingControls[id]).filter((element) => element !== undefined);
    const pointed = targetBlock >= 0 ? surveyedBlocks[targetBlock] : undefined;
    const anchor = pointed?.element ?? entries[0]?.element ?? members[0];
    if (!anchor || !anchor.isConnected) return none;
    // Registered, so that the scroll positions of what holds it are put back by cleanup().
    keyOf(anchor);
    ensureStableAround(anchor);
    anchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    await settle();
    if (!anchor.isConnected || inTransformedFrame(anchor)) return none;
    const textRect = (nodes: Text[]): AgentRect | null => {
      let box: AgentRect | null = null;
      for (const node of nodes) {
        if (!node.isConnected || node.ownerDocument !== anchor.ownerDocument) continue;
        const range = node.ownerDocument.createRange();
        range.selectNodeContents(node);
        const rect = plainRect(range.getBoundingClientRect());
        if (rect.width > 0 && rect.height > 0) box = box ? union(box, rect) : rect;
      }
      return box;
    };
    let own: AgentRect | null = null;
    const add = (rect: AgentRect | null): void => {
      if (rect && rect.width > 0 && rect.height > 0) own = own ? union(own, rect) : rect;
    };
    for (const entry of entries) add(textRect(entry.nodes));
    for (const member of members) {
      if (!member.isConnected || member.ownerDocument !== anchor.ownerDocument) continue;
      add(plainRect(member.getBoundingClientRect()));
      const labels = (member as HTMLInputElement).labels;
      for (const label of labels ? [...labels].slice(0, options.grouping.maxLabelTargets) : []) {
        if (label.checkVisibility(VISIBLE)) add(plainRect(label.getBoundingClientRect()));
      }
    }
    const found = own as AgentRect | null;
    if (!found) return none;
    const view = anchor.ownerDocument.defaultView;
    if (!view) return none;
    const offset = frameOffset(anchor);
    const margin = options.grouping.clipMarginCssPx;
    let left = Math.max(0, found.x + offset.x - margin);
    let right = Math.min(window.innerWidth, found.x + found.width + offset.x + margin);
    let upper = Math.max(0, found.y + offset.y - margin);
    let lower = Math.min(window.innerHeight, found.y + found.height + offset.y + margin);
    if (view !== window) {
      // Inside a frame, only what the frame shows.
      left = Math.max(left, offset.x);
      right = Math.min(right, offset.x + view.innerWidth);
      upper = Math.max(upper, offset.y);
      lower = Math.min(lower, offset.y + view.innerHeight);
    }
    if (right - left < 1 || lower - upper < 1) return none;
    // A capture is evidence only if it shows the content: not when a banner or a dialog lies over it.
    if (floatsOver(anchor, (left + right) / 2 - offset.x, (upper + lower) / 2 - offset.y)) return { clip: null, covered: true };
    const x0 = Math.floor(left + window.scrollX);
    const y0 = Math.floor(upper + window.scrollY);
    const x1 = Math.ceil(right + window.scrollX);
    const y1 = Math.ceil(lower + window.scrollY);
    const aim = (pointed ? textRect(pointed.nodes) : null) ?? found;
    const shown = intersect(
      { x: aim.x + offset.x + window.scrollX, y: aim.y + offset.y + window.scrollY, width: aim.width, height: aim.height },
      { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    );
    return { clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, target: shown, covered: false };
  }

  /** Scrolls a block of the last survey into view and says what to capture: the block with what is above and below it. */
  async function prepareHeading(index: number): Promise<AgentHeadingPrepared> {
    const block = surveyedBlocks[index];
    if (!block || !block.element.isConnected) return { clip: null, covered: false };
    const { element } = block;
    // Registered, so that the scroll positions of what holds it are put back by cleanup().
    keyOf(element);
    ensureStableAround(element);
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    await settle();
    if (!element.isConnected || inTransformedFrame(element)) return { clip: null, covered: false };
    const rectOf = (nodes: Text[]): AgentRect | null => {
      let box: AgentRect | null = null;
      for (const node of nodes) {
        if (!node.isConnected) continue;
        const range = node.ownerDocument.createRange();
        range.selectNodeContents(node);
        const rect = plainRect(range.getBoundingClientRect());
        if (rect.width > 0 && rect.height > 0) box = box ? union(box, rect) : rect;
      }
      return box;
    };
    const own = rectOf(block.nodes);
    if (!own) return { clip: null, covered: false };
    // A capture is evidence only if it shows the block: not when a banner or a dialog lies over it.
    const doc = element.ownerDocument;
    const view = doc.defaultView;
    const middleX = own.x + own.width / 2;
    const middleY = own.y + own.height / 2;
    if (view && middleX >= 0 && middleY >= 0 && middleX < view.innerWidth && middleY < view.innerHeight) {
      // Only content that floats over the page counts (fixed or sticky, outside what holds the
      // block): a stretched link over a card also answers the hit test, and hides nothing.
      let floating = false;
      for (let current: Node | null = topElementAt(doc, middleX, middleY); current; current = composedParent(current)) {
        if (current.nodeType !== 1) continue;
        if (composedContains(current, element)) break;
        const position = view.getComputedStyle(current as Element).position;
        if (position === 'fixed' || position === 'sticky') floating = true;
      }
      if (floating || frameCoveredAt(element, middleX, middleY)) return { clip: null, covered: true };
    }
    const limits = options.headings;
    const next = surveyedBlocks[index + 1];
    const after = next && next.element.ownerDocument === element.ownerDocument ? rectOf(next.nodes) : null;
    const offset = frameOffset(element);
    const top = own.y + offset.y - limits.clipAboveCssPx;
    const low = own.y + own.height + offset.y + limits.clipBelowCssPx;
    // As wide as the block and the one after it, when that one is under it.
    const wide = after && after.y >= own.y && after.y < own.y + own.height + limits.clipBelowCssPx ? union(own, after) : own;
    const left = Math.max(0, wide.x + offset.x - limits.clipMarginCssPx);
    const right = Math.min(window.innerWidth, wide.x + wide.width + offset.x + limits.clipMarginCssPx);
    const upper = Math.max(0, top);
    const lower = Math.min(window.innerHeight, low);
    if (right - left < 1 || lower - upper < 1) return { clip: null, covered: false };
    const x0 = Math.floor(left + window.scrollX);
    const y0 = Math.floor(upper + window.scrollY);
    const x1 = Math.ceil(right + window.scrollX);
    const y1 = Math.ceil(lower + window.scrollY);
    const target = { x: own.x + offset.x + window.scrollX, y: own.y + offset.y + window.scrollY, width: own.width, height: own.height };
    return { clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, target, covered: false };
  }

  return {
    async stabilise() {
      ensureStable(document);
      await Promise.race([
        document.fonts.ready,
        new Promise((resolve) => setTimeout(resolve, options.fontsTimeoutMs)),
      ]);
      await settle();
    },

    settle,

    active() {
      const element = deepActive();
      if (!element) return null;
      const info = describe(element, true);
      tabbed.add(info.key);
      return info;
    },

    async prepare(key) {
      const element = get(key);
      ensureStableAround(element);
      collapseSelection(element);
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      await settle();
      const state = { covered: false, clipped: false, stable: isStable(element), probes: [] as [number, number][], frameCovered: false };
      if (inTransformedFrame(element)) return { box: null, clip: null, reason: 'transformed-frame', ...state };

      const own = viewportRect(element);
      const hasBox = own.width > 0 && own.height > 0;
      // A visually hidden control usually shows its focus on its label, so labels are captured too.
      let region: AgentRect | null = hasBox ? own : null;
      const labels = (element as HTMLInputElement).labels;
      if (labels) {
        for (const label of labels) {
          const rect = viewportRect(label);
          if (rect.width > 0 && rect.height > 0) region = region ? union(region, rect) : rect;
        }
      }
      if (!region) return { box: null, clip: null, reason: 'no-box', ...state };
      state.clipped = hasBox && isClipped(element);

      const box = hasBox ? toPage(own) : null;
      const margin = options.clipMarginCssPx;
      const left = Math.max(0, region.x - margin);
      const top = Math.max(0, region.y - margin);
      const right = Math.min(window.innerWidth, region.x + region.width + margin);
      const bottom = Math.min(window.innerHeight, region.y + region.height + margin);
      if (right - left < 1 || bottom - top < 1) return { box, clip: null, reason: 'outside-viewport', ...state };

      const obscured = obscuredInfo(element);
      if (obscured && obscured.sampled > 0 && obscured.covered === obscured.sampled) {
        // Under opaque content there is nothing to capture. Under anything else the captures
        // are the evidence of what gets through, so they are taken.
        if (obscured.opaque === obscured.sampled) return { box, clip: null, reason: 'obscured', ...state };
        state.covered = true;
      }

      const view = element.ownerDocument.defaultView;
      if (hasBox && view) {
        const rect = element.getBoundingClientRect();
        const offset = frameOffset(element);
        const grid = options.coverGrid;
        for (let row = 0; row < grid; row++) {
          for (let column = 0; column < grid; column++) {
            const x = rect.left + ((column + 0.5) / grid) * rect.width;
            const y = rect.top + ((row + 0.5) / grid) * rect.height;
            if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) continue;
            const topX = x + offset.x;
            const topY = y + offset.y;
            if (topX < 0 || topY < 0 || topX >= window.innerWidth || topY >= window.innerHeight) continue;
            state.probes.push([topX + window.scrollX, topY + window.scrollY]);
            if (frameCoveredAt(element, x, y)) state.frameCovered = true;
          }
        }
      }

      const x0 = Math.floor(left + window.scrollX);
      const y0 = Math.floor(top + window.scrollY);
      const x1 = Math.ceil(right + window.scrollX);
      const y1 = Math.ceil(bottom + window.scrollY);
      return { box, clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, reason: null, ...state };
    },

    box(key) {
      return boxOf(get(key));
    },

    async blur(key) {
      const element = get(key);
      (element as HTMLElement).blur();
      await settle();
      // A page script may have given the focus straight back (a blur handler, a focus trap).
      return { box: boxOf(element), blurred: deepActive() !== element };
    },

    isActive(key) {
      return deepActive() === get(key);
    },

    async refocus(key) {
      (get(key) as HTMLElement).focus({ preventScroll: true });
      await settle();
    },

    /**
     * Gets the Tab walk out of cross-origin frames it cannot see into: takes them out of the Tab
     * order with tabindex="-1" (put back in cleanup) and restarts sequential navigation from
     * `from`, the last stop before them, or from the top of the document when there is none.
     */
    async skipFrames(frames, from) {
      for (const key of frames) {
        const frame = get(key);
        if (!skippedFrames.has(frame)) skippedFrames.set(frame, frame.getAttribute('tabindex'));
        frame.setAttribute('tabindex', '-1');
      }
      const start = from === null ? undefined : elements.get(from);
      if (start?.isConnected) (start as HTMLElement).focus({ preventScroll: true });
      else (deepActive() as HTMLElement | null)?.blur();
      await settle();
    },

    async blurActive() {
      const element = deepActive();
      if (element) (element as HTMLElement).blur();
      await settle();
    },

    viewport() {
      return { x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight };
    },

    unreached(max) {
      const found: Element[] = [];
      collectUnreached(document, found);
      return { total: found.length, items: found.slice(0, max).map((element) => describe(element, false)) };
    },

    iconSurvey,
    prepareIcon,
    hitKind,
    coveredBelow,
    markHeading,
    frameReadable,
    renderAll,
    headingSurvey,
    prepareHeading,
    markList,
    listSurvey,
    listSelectors,
    prepareList,
    markControl,
    markGroup,
    groupingSurvey,
    prepareGrouping,

    connected(key) {
      return get(key).isConnected;
    },

    element(key) {
      return get(key);
    },

    cleanup() {
      for (const [frame, tabindex] of skippedFrames) {
        if (tabindex === null) frame.removeAttribute('tabindex');
        else frame.setAttribute('tabindex', tabindex);
      }
      skippedFrames.clear();
      if (initialActive?.isConnected) {
        (initialActive as HTMLElement).focus({ preventScroll: true });
      } else {
        const element = deepActive();
        if (element) (element as HTMLElement).blur();
      }
      restoreScrolls();
      for (const { root, sheet } of sheets) {
        root.adoptedStyleSheets = root.adoptedStyleSheets.filter((adopted) => adopted !== sheet);
      }
      sheets.length = 0;
      for (const element of renderedElements) element.removeAttribute(RENDER_ATTRIBUTE);
      renderedElements.length = 0;
    },
  };
}
