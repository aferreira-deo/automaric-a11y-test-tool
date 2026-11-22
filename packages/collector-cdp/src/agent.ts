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
    },
  };
}
