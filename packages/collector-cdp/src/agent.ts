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
  obscured: { covered: number; sampled: number; by: string } | null;
}

export interface AgentPrepared {
  /** Element border box, page coordinates. Null when it has none. */
  box: AgentRect | null;
  /** Region to capture, page coordinates, snapped to whole CSS pixels. */
  clip: AgentRect | null;
  reason: 'no-box' | 'outside-viewport' | 'obscured' | null;
}

export interface Agent {
  stabilise(): Promise<void>;
  settle(): Promise<void>;
  active(): AgentElementInfo | null;
  prepare(key: number): Promise<AgentPrepared>;
  box(key: number): AgentRect | null;
  blur(key: number): Promise<AgentRect | null>;
  refocus(key: number): Promise<void>;
  blurActive(): Promise<void>;
  viewport(): AgentRect;
  unreached(max: number): { total: number; items: AgentElementInfo[] };
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
    'caret-color:transparent!important;scroll-behavior:auto!important}';
  const FOCUSABLE =
    'a[href],area[href],button,input:not([type="hidden"]),select,textarea,summary,' +
    '[tabindex],[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],' +
    'audio[controls],video[controls]';
  const TEXT_INPUT_TYPES = ['text', 'search', 'url', 'tel', 'email', 'password', 'number'];
  const JOIN = ' >>> ';

  const elements = new Map<number, Element>();
  const keys = new WeakMap<Element, number>();
  const tabbed = new Set<number>();
  const styles: HTMLStyleElement[] = [];
  const styledRoots = new WeakSet<Node>();
  const initialScroll = { x: window.scrollX, y: window.scrollY };
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

  function ensureStable(root: Node): void {
    if (styledRoots.has(root)) return;
    styledRoots.add(root);
    const doc = root.nodeType === 9 ? (root as Document) : root.ownerDocument;
    const parent = root.nodeType === 9 ? ((root as Document).head ?? (root as Document).documentElement) : root;
    if (!doc || !parent) return;
    const style = doc.createElement('style');
    style.textContent = STABILISER_CSS;
    parent.appendChild(style);
    styles.push(style);
  }

  function ensureStableAround(element: Element): void {
    for (let current: Element | null = element; current; ) {
      const root = current.getRootNode();
      ensureStable(root);
      current = hostOf(root) ?? (root.nodeType === 9 ? frameElementOf(current) : null);
    }
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

  /** Border box in the coordinates of the top-level viewport. */
  function viewportRect(element: Element): AgentRect {
    const rect = element.getBoundingClientRect();
    let x = rect.left;
    let y = rect.top;
    for (let frame = frameElementOf(element); frame; frame = frameElementOf(frame)) {
      const outer = frame.getBoundingClientRect();
      x += outer.left + frame.clientLeft;
      y += outer.top + frame.clientTop;
    }
    return { x, y, width: rect.width, height: rect.height };
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
   * 2.4.11: samples a grid over the element and counts the points whose topmost element is
   * unrelated to it and sits in fixed or sticky content. Other overlaps are not counted:
   * only the overlay patterns the criterion names are certain enough.
   * Looks at the element's own document only; an overlay in a parent document is not seen.
   */
  function obscuredInfo(element: Element): AgentElementInfo['obscured'] {
    const doc = element.ownerDocument;
    const view = doc.defaultView;
    const rect = element.getBoundingClientRect();
    if (!view || rect.width <= 0 || rect.height <= 0) return null;
    const grid = options.obscuredGrid;
    let sampled = 0;
    let covered = 0;
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
          covered++;
          by = selectorOf(current as Element);
          break;
        }
      }
    }
    return { covered, sampled, by };
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
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      await settle();

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
      if (!region) return { box: null, clip: null, reason: 'no-box' };

      const box = hasBox ? toPage(own) : null;
      const margin = options.clipMarginCssPx;
      const left = Math.max(0, region.x - margin);
      const top = Math.max(0, region.y - margin);
      const right = Math.min(window.innerWidth, region.x + region.width + margin);
      const bottom = Math.min(window.innerHeight, region.y + region.height + margin);
      if (right - left < 1 || bottom - top < 1) return { box, clip: null, reason: 'outside-viewport' };

      const obscured = obscuredInfo(element);
      if (obscured && obscured.sampled > 0 && obscured.covered === obscured.sampled) {
        return { box, clip: null, reason: 'obscured' };
      }

      const x0 = Math.floor(left + window.scrollX);
      const y0 = Math.floor(top + window.scrollY);
      const x1 = Math.ceil(right + window.scrollX);
      const y1 = Math.ceil(bottom + window.scrollY);
      return { box, clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, reason: null };
    },

    box(key) {
      return boxOf(get(key));
    },

    async blur(key) {
      const element = get(key);
      (element as HTMLElement).blur();
      await settle();
      return boxOf(element);
    },

    async refocus(key) {
      (get(key) as HTMLElement).focus({ preventScroll: true });
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

    element(key) {
      return get(key);
    },

    cleanup() {
      for (const style of styles) style.remove();
      styles.length = 0;
      const element = deepActive();
      if (element) (element as HTMLElement).blur();
      window.scrollTo(initialScroll.x, initialScroll.y);
    },
  };
}
