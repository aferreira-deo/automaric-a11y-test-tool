/**
 * The in-page parts of probing. Probing happens in copies of the page, loaded in a browser of
 * their own (see `nrv-probe.ts`); nothing here runs in the page under test, except
 * `cloneSourceReader`, which only reads.
 *
 * - `probeAgentFactory`: an isolated world of each copy. Serialised with `toString()`: self-contained.
 *   It finds an element by its selector, checks that it is the element of the page under test,
 *   scrolls it into view, focuses it, records what is visible, activates it with synthetic
 *   events (no trusted input: the page gets no user activation, so what the browser keeps
 *   behind a gesture, a popup, a file picker, fullscreen, a payment sheet, does not open), and
 *   says what changed.
 * - `GUARD_SCRIPT`: evaluated in the main world of every document of a copy before the page's
 *   own scripts (`Page.addScriptToEvaluateOnNewDocument`). It records what an activation does
 *   that the network does not show, and stops what would leave the copy.
 * - `cloneSourceReader`: what a copy needs from the page under test to render like it (local and
 *   session storage, language, time zone, user agent), read in the isolated world of the collector.
 */

import type { AgentRect } from './agent.js';

export interface ProbeAgentOptions {
  settleFrames: number;
  settleTimeoutMs: number;
  maxVisibilityElements: number;
  revealMinAreaCssPx2: number;
  regionMaxAncestorLevels: number;
  clipSideCssPx: number;
  clipAboveCssPx: number;
  clipBelowCssPx: number;
  itemTextMaxChars: number;
}

export interface ProbePrepared {
  /** Border box, page coordinates. */
  box: AgentRect | null;
  /** What to capture, page coordinates, whole CSS pixels. */
  clip: AgentRect | null;
  /** The element inside the capture, CSS px from its top left. */
  inClip: AgentRect | null;
  visible: boolean;
}

export interface ProbeRegion {
  box: AgentRect;
  kind: '' | 'dialog' | 'live' | 'popup';
  fixed: boolean;
  controlled: boolean;
  near: boolean;
  existed: boolean;
}

export interface ProbeObserved {
  removed: boolean;
  /** The activated element is in the document and no longer visible: it hid itself. */
  selfHidden: boolean;
  revealed: ProbeRegion[];
  hidden: ProbeRegion[];
  textChanged: number;
  scrolled: boolean;
  focusMoved: boolean;
  url: string;
  /** For a fragment of the address: an element with that id or name exists. */
  fragmentTarget: boolean;
  fingerprint: string;
}

export interface ProbeStorage {
  origin: string;
  local: [string, string][] | null;
  session: [string, string][] | null;
}

/** What the collector reads from the page under test for its copies. */
export interface CloneSourceRead {
  storage: ProbeStorage[];
  userAgent: string;
  language: string;
  timezone: string;
}

export interface ProbeAgent {
  install(): void;
  /** Elements interactive by their markup, as `nrvAgentFactory` counts them: what the copy is compared with. */
  interactiveCount(): number;
  /** Scrolls the window down a viewport at a time to the end and back to the top, `max` ms at most: what loads as it is scrolled to loads. */
  scrollThrough(max: number): Promise<void>;
  locate(frame: string, selector: string, tag: string): number;
  /** The visible text of the element as the survey reads it, to tell whether it is the same element. */
  identity(key: number): { text: string };
  element(key: number): Element;
  prepare(key: number): Promise<ProbePrepared>;
  begin(key: number): { fields: string[]; url: string; fingerprint: string };
  activate(key: number): void;
  settle(): Promise<void>;
  observe(key: number): ProbeObserved;
  revealReverted(): boolean;
  /** Where the element is now, page coordinates; null when it has no box. */
  boxOf(key: number): AgentRect | null;
  /** Waits until no element has been added, removed or changed, and no animation that ends has run, for `ms`; `max` at most. Text alone does not count. */
  quiet(ms: number, max: number): Promise<void>;
  noise(ms: number): Promise<{ text: number; visibility: number }>;
  fingerprint(): string;
  restoreScroll(): void;
}

export const PROBE_AGENT_GLOBAL = '__a11yVisionProbe';
export const PROBE_WORLD_NAME = 'a11y-vision-probe';
export const GUARD_GLOBAL = '__a11yVisionGuard';

export function probeAgentFactory(options: ProbeAgentOptions): ProbeAgent {
  const JOIN = ' >>> ';
  const STABILISER_CSS =
    // Not 0s: a transition of no duration fires no transitionend, and scripts that update a state
    // when the transition ends (a collapse that sets aria-expanded at its end) would never do it.
    '*,*::before,*::after{transition-duration:0.001s!important;transition-delay:0s!important;' +
    'animation-duration:0.001s!important;animation-delay:0s!important;animation-iteration-count:1!important;' +
    'caret-color:transparent!important;scroll-behavior:auto!important}*::selection{background:transparent!important}';
  // The same as `INTERACTIVE` of the survey agent: the two counts are compared.
  const CONTROL_ROLE_ATTRS = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'slider', 'spinbutton', 'combobox', 'textbox', 'searchbox'];
  const INTERACTIVE = 'a[href],area[href],button,input:not([type="hidden"]),select,textarea,summary,[tabindex]:not([tabindex^="-"]),' + CONTROL_ROLE_ATTRS.map((role) => `[role="${role}"]`).join(',');
  const elements = new Map<number, Element>();
  let nextKey = 1;
  const styled = new WeakSet<Node>();
  const scrolls = new Map<Element | Window, { x: number; y: number }>();
  let visibility = new Map<Element, boolean>();
  let revealedByFirst: Element[] = [];
  let observer: MutationObserver[] = [];
  let records: MutationRecord[] = [];
  let trigger: Element | null = null;
  let before = { url: '', scrollX: 0, scrollY: 0, active: null as Element | null };

  function hostOf(node: Node | null): Element | null {
    return node && node.nodeType === 11 && 'host' in node ? (node as ShadowRoot).host : null;
  }

  function composedParent(node: Node): Node | null {
    const parent = node.parentNode;
    return hostOf(parent) ?? parent;
  }

  function composedContains(ancestor: Node, node: Node | null): boolean {
    for (let current = node; current; current = composedParent(current)) if (current === ancestor) return true;
    return false;
  }

  function isFrame(element: Element): boolean {
    return element.localName === 'iframe' || element.localName === 'frame';
  }

  function frameDocument(frame: Element): Document | null {
    try {
      return (frame as HTMLIFrameElement).contentDocument ?? null;
    } catch {
      return null;
    }
  }

  function frameElementOf(element: Element): Element | null {
    try {
      return element.ownerDocument.defaultView?.frameElement ?? null;
    } catch {
      return null;
    }
  }

  function each(root: Document | ShadowRoot, visit: (element: Element) => boolean | void): void {
    for (const element of root.querySelectorAll('*')) {
      if (visit(element) === false) return;
      if (element.shadowRoot) each(element.shadowRoot, visit);
      if (isFrame(element)) {
        const doc = frameDocument(element);
        if (doc) each(doc, visit);
      }
    }
  }

  function documents(): Document[] {
    const out: Document[] = [document];
    each(document, (element) => {
      if (!isFrame(element)) return;
      const doc = frameDocument(element);
      if (doc) out.push(doc);
    });
    return out;
  }

  function stabilise(root: Document | ShadowRoot): void {
    if (styled.has(root)) return;
    styled.add(root);
    try {
      const doc = root.nodeType === 9 ? (root as Document) : root.ownerDocument;
      const view = doc?.defaultView as (Window & { CSSStyleSheet: typeof CSSStyleSheet }) | null | undefined;
      if (!view) return;
      const sheet = new view.CSSStyleSheet();
      sheet.replaceSync(STABILISER_CSS);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    } catch {
      // Animations run; the capture shows what they show.
    }
  }

  function contentOrigin(frame: Element): { x: number; y: number } {
    const outer = frame.getBoundingClientRect();
    const style = frame.ownerDocument.defaultView?.getComputedStyle(frame);
    return {
      x: outer.left + frame.clientLeft + (style ? parseFloat(style.paddingLeft) || 0 : 0),
      y: outer.top + frame.clientTop + (style ? parseFloat(style.paddingTop) || 0 : 0),
    };
  }

  function viewportRect(element: Element): AgentRect {
    const rect = element.getBoundingClientRect();
    let x = rect.left;
    let y = rect.top;
    for (let frame = frameElementOf(element); frame; frame = frameElementOf(frame)) {
      const origin = contentOrigin(frame);
      x += origin.x;
      y += origin.y;
    }
    return { x, y, width: rect.width, height: rect.height };
  }

  function settle(): Promise<void> {
    return new Promise((resolve) => {
      let remaining = options.settleFrames;
      const timer = setTimeout(resolve, options.settleTimeoutMs);
      const step = (): void => {
        if (--remaining <= 0) {
          clearTimeout(timer);
          resolve();
        } else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  function visibleNow(element: Element): boolean {
    if (!element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** Boxes of what was visible when the last activation began: what is hidden afterwards has no box any more. */
  let boxesBefore = new Map<Element, AgentRect>();

  function snapshotVisibility(withBoxes = false): Map<Element, boolean> {
    const map = new Map<Element, boolean>();
    if (withBoxes) boxesBefore = new Map();
    let count = 0;
    each(document, (element) => {
      if (++count > options.maxVisibilityElements) return false;
      const visible = visibleNow(element);
      map.set(element, visible);
      if (withBoxes && visible) {
        const rect = viewportRect(element);
        boxesBefore.set(element, { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height });
      }
      return true;
    });
    return map;
  }

  function regionOf(element: Element, existed: boolean): ProbeRegion {
    const role = (element.getAttribute('role') ?? '').trim().toLowerCase();
    const isDialog = (candidate: Element): boolean => {
      const own = (candidate.getAttribute('role') ?? '').trim().toLowerCase();
      return own === 'dialog' || own === 'alertdialog' || candidate.localName === 'dialog' || candidate.getAttribute('aria-modal') === 'true';
    };
    let kind: ProbeRegion['kind'] = '';
    if (isDialog(element) || element.querySelector('[role="dialog"],[role="alertdialog"],dialog,[aria-modal="true"]')) kind = 'dialog';
    else if (['alert', 'status', 'log', 'marquee', 'timer', 'tooltip'].includes(role) || element.hasAttribute('aria-live')) kind = 'live';
    else if (['menu', 'listbox', 'tree', 'grid', 'menubar'].includes(role) || element.querySelector('[role="menu"],[role="listbox"],[role="tree"]')) kind = 'popup';
    if (kind === '') {
      for (let current = composedParent(element); current && current.nodeType === 1; current = composedParent(current)) {
        const ancestor = current as Element;
        const own = (ancestor.getAttribute('role') ?? '').trim().toLowerCase();
        if (['alert', 'status', 'log', 'tooltip'].includes(own) || ancestor.hasAttribute('aria-live')) {
          kind = 'live';
          break;
        }
        if (isDialog(ancestor)) {
          kind = 'dialog';
          break;
        }
      }
    }
    let fixed = false;
    for (let current: Node | null = element; current && current.nodeType === 1; current = composedParent(current)) {
      const view = (current as Element).ownerDocument.defaultView;
      if (view && view.getComputedStyle(current as Element).position === 'fixed') {
        fixed = true;
        break;
      }
    }
    let controlled = false;
    if (trigger) {
      const root = trigger.getRootNode() as Document | ShadowRoot;
      for (const id of (trigger.getAttribute('aria-controls') ?? '').split(/\s+/)) {
        const target = id === '' ? null : (root.getElementById?.(id) ?? trigger.ownerDocument.getElementById(id));
        if (target && (composedContains(element, target) || composedContains(target, element))) controlled = true;
      }
    }
    // Near: it and the activated element share an ancestor at most `regionMaxAncestorLevels` above the latter.
    let near = controlled;
    if (trigger && !near) {
      let ancestor: Node | null = trigger;
      for (let level = 0; level < options.regionMaxAncestorLevels && ancestor; level++) {
        ancestor = composedParent(ancestor);
        if (ancestor && ancestor.nodeType === 1 && composedContains(ancestor, element)) {
          near = true;
          break;
        }
      }
    }
    const rect = viewportRect(element);
    const box = rect.width > 0 && rect.height > 0 ? { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height } : (boxesBefore.get(element) ?? { x: 0, y: 0, width: 0, height: 0 });
    return { box, kind, fixed, controlled, near, existed };
  }

  /** The outermost of a set of elements: those with no ancestor in the set. */
  function outermost(set: Element[]): Element[] {
    const members = new Set(set);
    return set.filter((element) => {
      for (let current = composedParent(element); current; current = composedParent(current)) if (members.has(current as Element)) return false;
      return true;
    });
  }

  /**
   * What the copy is, as a hash: the address of each document, every element with its attributes
   * (names sorted; an empty `class` or `style` left out, a style without its spaces and its last
   * semicolon, the classes sorted), the values of its fields, and what dialogs are open. Text is
   * left out: a clock or a counter changes it on its own. Two equal hashes, with nothing else
   * recorded (see `nrv-probe.ts`), and the copy can serve the next probe.
   */
  function fingerprintOf(): string {
    let hash = 2166136261;
    const feed = (text: string): void => {
      for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
    };
    for (const doc of documents()) feed(doc.URL);
    each(document, (element) => {
      feed('<' + element.localName);
      for (const name of element.getAttributeNames().sort()) {
        let value = element.getAttribute(name) ?? '';
        if (name === 'style') value = value.replace(/\s+/g, '').replace(/;$/, '');
        if ((name === 'style' || name === 'class') && value.trim() === '') continue;
        if (name === 'class') value = value.trim().split(/\s+/).sort().join(' ');
        feed(' ' + name + '=' + value);
      }
      if (element.localName === 'input' || element.localName === 'textarea' || element.localName === 'select') {
        const control = element as HTMLInputElement;
        feed(`${control.value}|${String(control.checked)}`);
      }
      if (element.localName === 'dialog') feed(String((element as HTMLDialogElement).open));
    });
    return (hash >>> 0).toString(16);
  }

  function rememberScroll(target: Element | Window): void {
    if (scrolls.has(target)) return;
    scrolls.set(target, 'scrollX' in target ? { x: target.scrollX, y: target.scrollY } : { x: target.scrollLeft, y: target.scrollTop });
  }

  function rememberScrollsAround(element: Element): void {
    for (let current: Node | null = element; current; ) {
      if (current.nodeType === 1) rememberScroll(current as Element);
      const parent: Node | null = composedParent(current);
      if (parent) {
        current = parent;
        continue;
      }
      const view: Window | null = current.nodeType === 9 ? (current as Document).defaultView : null;
      if (view) rememberScroll(view);
      current = view && view !== window ? view.frameElement : null;
    }
    rememberScroll(window);
  }

  function collapsed(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  /** As `textOf` of the survey agent: the two are compared. */
  function textOf(element: Element): string {
    if (element.getElementsByTagName('*').length > 200) return collapsed((element.textContent ?? '').slice(0, 4 * options.itemTextMaxChars));
    const inner = (element as HTMLElement).innerText;
    return collapsed(typeof inner === 'string' ? inner : (element.textContent ?? ''));
  }

  /** Something structural changed: an element added or removed, an attribute. Text alone, a clock or a counter, is not counted. */
  function structural(list: MutationRecord[]): boolean {
    return list.some((record) => record.type === 'attributes' || (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === 1)));
  }

  /** Animations that run and will end (an infinite spinner does not hold the wait). */
  function endingAnimations(): boolean {
    try {
      return document.getAnimations().some((animation) => {
        if (animation.playState !== 'running') return false;
        const end = animation.effect?.getComputedTiming().endTime;
        return typeof end === 'number' && Number.isFinite(end);
      });
    } catch {
      return false;
    }
  }

  return {
    install() {
      for (const doc of documents()) stabilise(doc);
      each(document, (element) => {
        if (element.shadowRoot) stabilise(element.shadowRoot);
      });
    },

    async scrollThrough(max) {
      const until = Date.now() + max;
      const root = document.scrollingElement ?? document.documentElement;
      for (let step = 0; step < 60 && Date.now() < until; step++) {
        const before = window.scrollY;
        window.scrollTo({ top: before + window.innerHeight, behavior: 'instant' });
        await new Promise((resolve) => setTimeout(resolve, 60));
        if (window.scrollY === before || window.scrollY + window.innerHeight >= root.scrollHeight) break;
      }
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      await settle();
    },

    interactiveCount() {
      let count = 0;
      each(document, (element) => {
        try {
          if (element.matches(INTERACTIVE)) count++;
        } catch {
          // Not an element a selector applies to.
        }
      });
      return count;
    },

    locate(frame, selector, tag) {
      const parts = [...(frame === '' ? [] : frame.split(JOIN)), ...selector.split(JOIN)];
      let root: Document | ShadowRoot = document;
      let found: Element | null = null;
      for (let index = 0; index < parts.length; index++) {
        try {
          found = root.querySelector(parts[index]!);
        } catch {
          return -1;
        }
        if (!found) return -1;
        if (index === parts.length - 1) break;
        if (isFrame(found)) {
          const doc = frameDocument(found);
          if (!doc) return -1;
          root = doc;
        } else if (found.shadowRoot) root = found.shadowRoot;
        else return -1;
      }
      if (!found) return -1;
      if (found.localName !== tag) return -2;
      const key = nextKey++;
      elements.set(key, found);
      return key;
    },

    identity(key) {
      const element = elements.get(key);
      if (!element) return { text: '' };
      const rect = viewportRect(element);
      return { text: rect.width > 0 && rect.height > 0 ? textOf(element).slice(0, options.itemTextMaxChars) : '' };
    },

    element(key) {
      const element = elements.get(key);
      if (!element) throw new Error('Unknown element key ' + key);
      return element;
    },

    async prepare(key) {
      const element = elements.get(key);
      const none: ProbePrepared = { box: null, clip: null, inClip: null, visible: false };
      if (!element || !element.isConnected) return none;
      for (let current: Element | null = element; current; ) {
        const root = current.getRootNode();
        stabilise(root as Document | ShadowRoot);
        current = hostOf(root) ?? (root.nodeType === 9 ? frameElementOf(current) : null);
      }
      rememberScrollsAround(element);
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const focusable = (element as HTMLElement).tabIndex >= 0 || element.hasAttribute('tabindex');
      if (focusable) (element as HTMLElement).focus({ preventScroll: true });
      await settle();
      if (!element.isConnected || !visibleNow(element)) return none;
      const rect = viewportRect(element);
      const left = Math.max(0, rect.x - options.clipSideCssPx);
      const right = Math.min(window.innerWidth, rect.x + rect.width + options.clipSideCssPx);
      const upper = Math.max(0, rect.y - options.clipAboveCssPx);
      const lower = Math.min(window.innerHeight, rect.y + rect.height + options.clipBelowCssPx);
      if (right - left < 1 || lower - upper < 1) return { ...none, box: { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height } };
      const x0 = Math.floor(left + window.scrollX);
      const y0 = Math.floor(upper + window.scrollY);
      const x1 = Math.ceil(right + window.scrollX);
      const y1 = Math.ceil(lower + window.scrollY);
      const pageBox = { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height };
      return {
        box: pageBox,
        clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
        inClip: { x: pageBox.x - x0, y: pageBox.y - y0, width: rect.width, height: rect.height },
        visible: true,
      };
    },

    begin(key) {
      const element = elements.get(key) ?? null;
      trigger = element;
      visibility = snapshotVisibility(true);
      revealedByFirst = [];
      records = [];
      for (const live of observer) live.disconnect();
      observer = documents().map((doc) => {
        const watch = new MutationObserver((list) => records.push(...list));
        watch.observe(doc, { subtree: true, childList: true, characterData: true });
        return watch;
      });
      // Observers do not see into shadow trees: one per open shadow root.
      each(document, (host) => {
        if (!host.shadowRoot) return;
        const watch = new MutationObserver((list) => records.push(...list));
        watch.observe(host.shadowRoot, { subtree: true, childList: true, characterData: true });
        observer.push(watch);
      });
      before = { url: location.href, scrollX: window.scrollX, scrollY: window.scrollY, active: document.activeElement };
      // Values typed in text fields: a navigation that carries one is a form sent by script.
      const fields: string[] = [];
      each(document, (field) => {
        if (field.localName !== 'input' && field.localName !== 'textarea') return;
        const type = ((field as HTMLInputElement).type || 'text').toLowerCase();
        if (!['text', 'search', 'email', 'tel', 'url', 'number', 'textarea'].includes(type)) return;
        const value = (field as HTMLInputElement).value.trim();
        if (value.length >= 2) fields.push(value);
      });
      return { fields, url: location.href, fingerprint: fingerprintOf() };
    },

    activate(key) {
      const element = elements.get(key);
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, composed: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, view: element.ownerDocument.defaultView };
      const view = element.ownerDocument.defaultView;
      const Pointer = view?.PointerEvent ?? PointerEvent;
      const Mouse = view?.MouseEvent ?? MouseEvent;
      element.dispatchEvent(new Pointer('pointerdown', { ...init, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      element.dispatchEvent(new Mouse('mousedown', { ...init, buttons: 1 }));
      element.dispatchEvent(new Pointer('pointerup', { ...init, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      element.dispatchEvent(new Mouse('mouseup', { ...init, buttons: 0 }));
      // A click event runs the activation behaviour of the element (a link follows its href, a
      // checkbox toggles), as a real click would, but without user activation.
      element.dispatchEvent(new Mouse('click', { ...init, buttons: 0, detail: 1 }));
    },

    settle,

    observe(key) {
      const element = elements.get(key) ?? null;
      const revealed: Element[] = [];
      const hidden: Element[] = [];
      const added: Element[] = [];
      let count = 0;
      each(document, (node) => {
        if (++count > options.maxVisibilityElements) return false;
        // The element, what it holds, and what holds it (a skip link whose list hides once it loses focus) are not regions it shows.
        if (element && (composedContains(element, node) || composedContains(node, element))) return true;
        const was = visibility.get(node);
        const now = visibleNow(node);
        if (was === undefined) {
          if (now) added.push(node);
        } else if (!was && now) revealed.push(node);
        return true;
      });
      for (const [node, was] of visibility) {
        if (!was || (element && (composedContains(element, node) || composedContains(node, element)))) continue;
        if (!node.isConnected || !visibleNow(node)) hidden.push(node);
      }
      const large = (node: Element): boolean => {
        if (!node.isConnected) return true;
        const rect = node.getBoundingClientRect();
        return rect.width * rect.height >= options.revealMinAreaCssPx2;
      };
      const shown = outermost([...revealed, ...added]).filter(large);
      revealedByFirst = revealedByFirst.length === 0 ? shown : revealedByFirst;
      const gone = outermost(hidden);
      let textChanged = 0;
      for (const record of records) {
        const target = record.target;
        if (element && composedContains(element, target)) continue;
        const holder = target.nodeType === 1 ? (target as Element) : target.parentElement;
        if (!holder || !holder.isConnected || !visibleNow(holder)) continue;
        if (record.type === 'characterData' || [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === 3 && (node.textContent ?? '').trim() !== '')) textChanged++;
      }
      records = [];
      const active = document.activeElement;
      let focusMoved = false;
      if (active && active !== before.active && active !== element) {
        let inner: Element | null = active;
        while (inner?.shadowRoot?.activeElement) inner = inner.shadowRoot.activeElement;
        focusMoved = shown.some((region) => composedContains(region, inner)) || (location.hash !== '' && inner !== null && inner.id === decodeURIComponent(location.hash.slice(1)));
      }
      let fragmentTarget = false;
      if (location.hash.length > 1) {
        let id = location.hash.slice(1);
        try {
          id = decodeURIComponent(id);
        } catch {
          // As it is.
        }
        fragmentTarget = document.getElementById(id) !== null || document.getElementsByName(id).length > 0;
      }
      return {
        removed: element !== null && !element.isConnected,
        selfHidden: element !== null && element.isConnected && !visibleNow(element),
        revealed: shown.map((node) => regionOf(node, visibility.has(node))),
        hidden: gone.filter((node) => node.isConnected).map((node) => regionOf(node, true)),
        textChanged,
        scrolled: window.scrollX !== before.scrollX || window.scrollY !== before.scrollY,
        focusMoved,
        url: location.href,
        fragmentTarget,
        fingerprint: fingerprintOf(),
      };
    },

    boxOf(key) {
      const element = elements.get(key);
      if (!element || !element.isConnected) return null;
      const rect = viewportRect(element);
      return rect.width > 0 && rect.height > 0 ? { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height } : null;
    },

    quiet(ms, max) {
      return new Promise((resolve) => {
        const watches: MutationObserver[] = [];
        let timer: ReturnType<typeof setTimeout> | undefined;
        // Set below; the timers that call done() run after it is.
        // eslint-disable-next-line prefer-const
        let poll: ReturnType<typeof setInterval> | undefined;
        const done = (): void => {
          for (const watch of watches) watch.disconnect();
          clearTimeout(timer);
          clearTimeout(limit);
          clearInterval(poll);
          resolve();
        };
        const limit = setTimeout(done, max);
        const again = (): void => {
          clearTimeout(timer);
          timer = setTimeout(done, ms);
        };
        for (const doc of documents()) {
          const watch = new MutationObserver((list) => {
            if (structural(list)) again();
          });
          watch.observe(doc, { subtree: true, childList: true, attributes: true });
          watches.push(watch);
        }
        each(document, (host) => {
          if (!host.shadowRoot) return;
          const watch = new MutationObserver((list) => {
            if (structural(list)) again();
          });
          watch.observe(host.shadowRoot, { subtree: true, childList: true, attributes: true });
          watches.push(watch);
        });
        // An animation that runs and ends holds the wait as long as it runs.
        poll = setInterval(() => {
          if (endingAnimations()) again();
        }, Math.max(16, Math.floor(ms / 3)));
        again();
      });
    },

    revealReverted() {
      return revealedByFirst.length > 0 && revealedByFirst.every((node) => !node.isConnected || !visibleNow(node));
    },

    async noise(ms) {
      const start = snapshotVisibility();
      records = [];
      await new Promise((resolve) => setTimeout(resolve, ms));
      await settle();
      let text = 0;
      for (const record of records) {
        const holder = record.target.nodeType === 1 ? (record.target as Element) : record.target.parentElement;
        if (holder && holder.isConnected && visibleNow(holder) && (!trigger || !composedContains(trigger, record.target))) text++;
      }
      records = [];
      let changed = 0;
      for (const [node, was] of start) if (node.isConnected && visibleNow(node) !== was) changed++;
      return { text, visibility: changed };
    },

    fingerprint: fingerprintOf,

    restoreScroll() {
      for (const [target, { x, y }] of scrolls) {
        try {
          target.scrollTo({ left: x, top: y, behavior: 'instant' });
        } catch {
          // Gone with its document.
        }
      }
      scrolls.clear();
    },
  };
}

/**
 * Reads, in the isolated world of the collector in the page under test, what a copy needs to
 * render like it. Reads only. Serialised with `toString()`: self-contained.
 */
export function cloneSourceReader(): CloneSourceRead {
  const out: ProbeStorage[] = [];
  const origins = new Set<string>();
  const docs: Document[] = [document];
  const visit = (root: Document | ShadowRoot): void => {
    for (const element of root.querySelectorAll('iframe,frame')) {
      try {
        const doc = (element as HTMLIFrameElement).contentDocument;
        if (doc) {
          docs.push(doc);
          visit(doc);
        }
      } catch {
        // Another origin.
      }
    }
  };
  visit(document);
  for (const doc of docs) {
    const view = doc.defaultView;
    if (!view) continue;
    let origin: string;
    try {
      origin = view.location.origin;
    } catch {
      continue;
    }
    if (origin === 'null' || origins.has(origin)) continue;
    origins.add(origin);
    const read = (storage: () => Storage): [string, string][] | null => {
      try {
        const area = storage();
        const entries: [string, string][] = [];
        for (let index = 0; index < area.length; index++) {
          const name = area.key(index);
          if (name !== null) entries.push([name, area.getItem(name) ?? '']);
        }
        return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      } catch {
        return null;
      }
    };
    out.push({ origin, local: read(() => view.localStorage), session: read(() => view.sessionStorage) });
  }
  let timezone = '';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // Left to the browser.
  }
  return { storage: out, userAgent: navigator.userAgent, language: navigator.language, timezone };
}

/**
 * Writes the storage of the page under test into the top document of a copy, before its scripts
 * run. Evaluated on every new document of the copy (`Page.addScriptToEvaluateOnNewDocument`),
 * in its main world, before the guard.
 */
export function storageSeedScript(storage: ProbeStorage[]): string {
  return `(() => {
  if (window !== window.top) return;
  const saved = ${JSON.stringify(storage)};
  let origin = '';
  try { origin = location.origin; } catch { return; }
  const entry = saved.find((item) => item.origin === origin);
  if (!entry) return;
  const put = (area, wanted) => { if (!wanted) return; try { for (const [name, value] of wanted) area.setItem(name, value); } catch {} };
  try { put(localStorage, entry.local); } catch {}
  try { put(sessionStorage, entry.session); } catch {}
})()`;
}

/**
 * The guard of a copy, in the main world of each of its documents, evaluated before the page's
 * own scripts: what the page saves of an API is already the guard's. It records what an
 * activation does that the network does not show, and stops what would leave the copy or hold
 * it:
 * - new windows (`window.open`, links and forms with a target that opens one), downloads,
 *   printing, `window.close`, the JavaScript dialogs (`alert`, `confirm` answers false, `prompt`
 *   answers null), form submission, going back or forward in the history (a copy has no history
 *   of the page under test);
 * - sends over channels that are not requests (WebSocket, WebRTC, WebTransport, EventSource),
 *   beacons, service worker registration, permission prompts and pickers;
 * - recorded and let through, since the copy is thrown away: `pushState`, `replaceState`, writes to
 *   local and session storage, cookies, IndexedDB, the Cache API, the origin private file system;
 *   reads of the value of a field; timers set while an activation runs.
 * The network of the copy is held whatever the guard does (see `nrv-probe.ts`): it is defence in
 * depth, and the source of some evidence (a window that would open, a form that would be sent).
 *
 * `__a11yVisionGuard.begin()` starts recording an activation, `take()` returns what was recorded
 * since the last call, with the timers set since `begin()` that have not run.
 */
export const GUARD_SCRIPT = `(() => {
  if (globalThis.${GUARD_GLOBAL}) return true;
  let top = null;
  try { if (window.top !== window && window.top.${GUARD_GLOBAL}) top = window.top.${GUARD_GLOBAL}; } catch {}
  const own = { log: [], recording: false, timers: new Set() };
  const state = top ? top.state : own;
  const record = (kind, url) => { if (state.recording || kind === 'dialog' || kind === 'window' || kind === 'download' || kind === 'print') state.log.push({ kind, url: typeof url === 'string' ? url : (url && typeof url.href === 'string' ? url.href : '') }); };
  const blocked = (name) => new DOMException('Stopped while a11y-vision probes a copy of the page (' + name + ').', 'SecurityError');
  const patch = (target, name, make) => {
    if (!target) return;
    let original;
    try { original = target[name]; } catch { return; }
    if (typeof original !== 'function') return;
    try { Object.defineProperty(target, name, { value: make(original), configurable: true, writable: true }); } catch {}
  };
  const patchSetter = (proto, name, kind) => {
    if (!proto) return;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor || typeof descriptor.set !== 'function') return;
    const set = descriptor.set;
    try { Object.defineProperty(proto, name, { ...descriptor, set(value) { record(kind); return set.call(this, value); } }); } catch {}
  };
  const patchGetter = (proto, name, kind) => {
    if (!proto) return;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor || typeof descriptor.get !== 'function') return;
    const get = descriptor.get;
    try { Object.defineProperty(proto, name, { ...descriptor, get() { if (state.recording) record(kind); return get.call(this); } }); } catch {}
  };
  const view = window;
  const doc = document;
  const P = (name) => { try { return view[name] && view[name].prototype; } catch { return undefined; } };
  patch(view, 'open', () => function (url) { let target = ''; try { target = url ? String(new URL(String(url), doc.baseURI)) : ''; } catch {} record('window', target); return null; });
  patch(view, 'print', () => function () { record('print'); });
  patch(view, 'close', () => function () { record('close'); });
  patch(view, 'alert', () => function () { record('dialog'); });
  patch(view, 'confirm', () => function () { record('dialog'); return false; });
  patch(view, 'prompt', () => function () { record('dialog'); return null; });
  patch(P('HTMLFormElement'), 'submit', () => function () { record('submit', this.action); });
  patch(P('HTMLFormElement'), 'requestSubmit', () => function () { record('submit', this.action); });
  for (const name of ['back', 'forward', 'go']) patch(P('History'), name, () => function () { record('traverse'); });
  for (const name of ['pushState', 'replaceState']) {
    patch(P('History'), name, (original) => function (s, t, url) {
      let target = '';
      try { target = url === undefined || url === null ? doc.URL : String(new URL(String(url), doc.baseURI)); } catch {}
      record(name === 'pushState' ? 'history' : 'replace', target);
      return original.apply(this, arguments);
    });
  }
  // A socket, a stream, a peer connection: created as the page asks (a page that opens one as it
  // loads must keep working), recorded, and refused by the network of the copy, which goes nowhere.
  patch(P('WebSocket'), 'send', () => function () { record('websocket', this.url); });
  for (const ctor of ['WebSocket', 'WebTransport', 'RTCPeerConnection', 'EventSource']) {
    patch(view, ctor, (Original) => {
      const Wrapped = function (...args) { record(ctor.toLowerCase(), typeof args[0] === 'string' ? args[0] : ''); return new Original(...args); };
      Wrapped.prototype = Original.prototype;
      try { Object.setPrototypeOf(Wrapped, Original); } catch {}
      return Wrapped;
    });
  }
  patch(P('RTCDataChannel'), 'send', () => function () { record('datachannel'); });
  patch(P('ServiceWorkerContainer'), 'register', () => function () { record('serviceworker'); return Promise.reject(blocked('serviceWorker.register')); });
  patch(P('SyncManager'), 'register', () => function () { record('sync'); return Promise.reject(blocked('sync')); });
  patch(P('Navigator'), 'sendBeacon', () => function (url) { record('beacon', url); return true; });
  // The copy is thrown away: what an activation stores is let through, and recorded.
  for (const name of ['setItem', 'removeItem', 'clear']) patch(P('Storage'), name, (original) => function () { record('storage'); return original.apply(this, arguments); });
  patchSetter(P('Document'), 'cookie', 'cookie');
  for (const name of ['set', 'delete']) patch(P('CookieStore'), name, (original) => function () { record('cookie'); return original.apply(this, arguments); });
  for (const name of ['put', 'add', 'delete', 'clear']) patch(P('IDBObjectStore'), name, (original) => function () { record('indexeddb'); return original.apply(this, arguments); });
  for (const name of ['open', 'deleteDatabase']) patch(P('IDBFactory'), name, (original) => function () { record('indexeddb'); return original.apply(this, arguments); });
  for (const name of ['put', 'add', 'addAll', 'delete']) patch(P('Cache'), name, (original) => function () { record('cache'); return original.apply(this, arguments); });
  for (const name of ['open', 'delete']) patch(P('CacheStorage'), name, (original) => function () { record('cache'); return original.apply(this, arguments); });
  patch(P('StorageManager'), 'getDirectory', (original) => function () { record('opfs'); return original.apply(this, arguments); });
  // A script that reads a field while an activation runs sends what it holds (a search by script).
  for (const name of ['HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement']) patchGetter(P(name), 'value', 'field');
  patch(view, 'FormData', (Original) => { const Wrapped = function (...args) { record('field'); return new Original(...args); }; Wrapped.prototype = Original.prototype; return Wrapped; });
  // Timers set while an activation runs: one that has not run yet is something still to happen.
  const timers = state.timers;
  patch(view, 'setTimeout', (original) => function (handler, ...rest) {
    if (!state.recording || typeof handler !== 'function') return original.call(this, handler, ...rest);
    const token = {};
    timers.add(token);
    const id = original.call(this, function () { timers.delete(token); return handler.apply(this, arguments); }, ...rest);
    token.id = id;
    return id;
  });
  patch(view, 'clearTimeout', (original) => function (id) { for (const token of timers) if (token.id === id) timers.delete(token); return original.call(this, id); });
  patch(view, 'setInterval', (original) => function (handler, ...rest) {
    const id = original.call(this, handler, ...rest);
    if (state.recording) timers.add({ id, interval: true });
    return id;
  });
  patch(view, 'clearInterval', (original) => function (id) { for (const token of timers) if (token.id === id) timers.delete(token); return original.call(this, id); });
  patch(P('Element'), 'requestFullscreen', () => function () { record('fullscreen'); return Promise.reject(blocked('fullscreen')); });
  patch(P('Geolocation'), 'getCurrentPosition', () => function (ok, fail) { record('permission'); if (typeof fail === 'function') fail({ code: 1, message: 'denied' }); });
  patch(P('Geolocation'), 'watchPosition', () => function (ok, fail) { record('permission'); if (typeof fail === 'function') fail({ code: 1, message: 'denied' }); return 0; });
  for (const name of ['getUserMedia', 'getDisplayMedia']) patch(P('MediaDevices'), name, () => function () { record('permission'); return Promise.reject(blocked(name)); });
  try { patch(view.Notification, 'requestPermission', () => function () { record('permission'); return Promise.resolve('denied'); }); } catch {}
  for (const name of ['get', 'create', 'store']) patch(P('CredentialsContainer'), name, () => function () { record('permission'); return Promise.reject(blocked('credentials.' + name)); });
  patch(P('PaymentRequest'), 'show', () => function () { record('payment'); return Promise.reject(blocked('PaymentRequest')); });
  for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) patch(view, name, () => function () { record('picker'); return Promise.reject(blocked(name)); });
  patch(P('HTMLInputElement'), 'showPicker', () => function () { record('picker'); });
  patch(P('Navigator'), 'share', () => function () { record('share'); return Promise.reject(blocked('share')); });
  for (const name of ['write', 'writeText']) patch(P('Clipboard'), name, () => function () { record('clipboard'); return Promise.reject(blocked('clipboard')); });
  patch(P('HTMLInputElement'), 'click', (original) => function () { if (this.type === 'file') { record('picker'); return; } return original.apply(this, arguments); });
  const onClick = (event) => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
      if (!node || node.nodeType !== 1) continue;
      const name = node.localName;
      if ((name === 'a' || name === 'area') && node.hasAttribute('href')) {
        const target = (node.getAttribute('target') || '').trim().toLowerCase();
        let named = false;
        try { named = target !== '' && !['_self', '_top', '_parent', '_blank'].includes(target) && !!doc.querySelector('iframe[name="' + CSS.escape(target) + '"],frame[name="' + CSS.escape(target) + '"]'); } catch {}
        if (node.hasAttribute('download')) { record('download', node.href); event.preventDefault(); }
        else if (target !== '' && !['_self', '_top', '_parent'].includes(target) && !named) { record('window', node.href); event.preventDefault(); }
        return;
      }
    }
  };
  const onSubmit = (event) => { record('submit', event.target && event.target.action); event.preventDefault(); };
  view.addEventListener('click', onClick, true);
  view.addEventListener('submit', onSubmit, true);
  globalThis.${GUARD_GLOBAL} = {
    state,
    begin() { state.log.length = 0; state.timers.clear(); state.recording = true; return true; },
    take() { state.recording = false; const out = { entries: state.log.splice(0, state.log.length), pendingTimers: state.timers.size }; return out; },
  };
  return true;
})()`;
