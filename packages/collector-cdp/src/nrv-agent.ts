/**
 * The in-page part of the static survey of the name-role-value check. It lives in the isolated
 * world of the main agent (`agent.ts`), as a second global, and asks the main agent for keys,
 * selectors and the Tab walk; like it, it is serialised with `toString()` and must stay
 * self-contained.
 *
 * It reads and does not change the page, with one exception: the attribute
 * `data-a11y-vision-handler` that the script of the main world (`NRV_FRAMEWORK_SCRIPT`) puts on
 * elements a framework holds handlers for is read and removed here, in the same collection.
 */

import type { AgentHeadingPrepared, AgentRect } from './agent.js';

export interface AgentNrvOptions {
  maxElements: number;
  itemTextMaxChars: number;
  iconFontFamilyPattern: string;
  probeExcludeSelector: string;
  clipMarginCssPx: number;
}

/** NrvElement of core, without what the collector adds from the accessibility tree. */
export interface AgentNrvElement {
  ord: number;
  box: AgentRect | null;
  visible: boolean;
  tag: string;
  type: string;
  roleAttr: string;
  sources: string[];
  listeners: string[];
  framework: string[];
  delegated: boolean;
  tabindex: number | null;
  disabled: boolean;
  href?: { kind: 'none' | 'empty' | 'hash' | 'hashbang' | 'javascript' | 'fragment' | 'url'; target: string; download: boolean; sameDocument: boolean; words?: string };
  submits: boolean;
  inForm: boolean;
  isLabel: boolean;
  insideControl: string;
  interactiveDescendants: number;
  text: string;
  textChars: number;
  areaShare: number;
  iconFont: boolean;
  attrs: Record<string, string>;
  controlsHidden: boolean;
  excluded: boolean;
  container: number;
  frameContent?: { readable: boolean; focusables: number };
}

export interface AgentNrvSurvey {
  elements: AgentNrvElement[];
  total: number;
}

export interface NrvAgent {
  /** Records activation listeners of the node (an element or a document), by type. Called on the node itself. */
  markListeners(node: unknown, types: string[]): boolean;
  /** The windows of the documents it can look into: the top one first, then frames in document order. */
  windows(): Window[];
  /** Records activation listeners of a window. Called on the window itself. */
  markWindow(view: unknown, types: string[]): boolean;
  survey(): AgentNrvSurvey;
  /** The elements of the last survey, by `ord`, for the collector to find their nodes. */
  surveyed(): Element[];
  /** Selectors and frames of elements of the last survey. */
  name(ords: number[]): ({ selector: string; frame: string } | null)[];
  /** Scrolls an element of the last survey into view and says what to capture: the element with a margin. */
  prepare(ord: number): Promise<AgentHeadingPrepared>;
}

export const NRV_AGENT_GLOBAL = '__a11yVisionNrv';

export function nrvAgentFactory(options: AgentNrvOptions): NrvAgent {
  const MAIN = '__a11yVisionAgent';
  const HANDLER_ATTRIBUTE = 'data-a11y-vision-handler';
  const ACTIVATION = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'touchstart', 'touchend', 'auxclick', 'dblclick'];
  /** Roles of the controls an element can be inside of (it is then part of that control). */
  const CONTROL_ROLE_ATTRS = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'slider', 'spinbutton', 'combobox', 'textbox', 'searchbox'];
  const CONTAINER_ROLES = ['tablist', 'radiogroup', 'listbox', 'menu', 'menubar', 'tree', 'grid', 'toolbar'];
  const INTERACTIVE = 'a[href],area[href],button,input:not([type="hidden"]),select,textarea,summary,[tabindex]:not([tabindex^="-"]),' + CONTROL_ROLE_ATTRS.map((role) => `[role="${role}"]`).join(',');
  const FOCUSABLE = 'a[href],area[href],button,input:not([type="hidden"]),select,textarea,summary,iframe,[tabindex]:not([tabindex^="-"]),[contenteditable=""],[contenteditable="true"]';
  const iconFamily = (() => {
    try {
      return new RegExp(options.iconFontFamilyPattern, 'i');
    } catch {
      return null;
    }
  })();
  const main = (): {
    keyFor(element: Element): number;
    named(element: Element): { selector: string; frame: string };
    wasTabbed(element: Element): boolean;
    stableAround(element: Element): void;
    settle(): Promise<void>;
  } => (globalThis as unknown as Record<string, ReturnType<typeof main>>)[MAIN]!;

  const listened = new Map<Node, Set<string>>();
  const windowListened = new Set<Window>();
  let surveyedElements: Element[] = [];

  function hostOf(node: Node | null): Element | null {
    return node && node.nodeType === 11 && 'host' in node ? (node as ShadowRoot).host : null;
  }

  function composedParent(node: Node): Node | null {
    const parent = node.parentNode;
    return hostOf(parent) ?? parent;
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

  function isFrame(element: Element): boolean {
    return element.localName === 'iframe' || element.localName === 'frame';
  }

  /** Where the content of a frame starts, in the client coordinates of its parent document. */
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

  function roleOf(element: Element): string {
    return (element.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  }

  function isNative(element: Element): boolean {
    const tag = element.localName;
    if ((tag === 'a' || tag === 'area') && element.hasAttribute('href')) return true;
    if (tag === 'button' || tag === 'select' || tag === 'textarea') return true;
    if (tag === 'input') return (element.getAttribute('type') ?? '').toLowerCase() !== 'hidden';
    if (tag === 'summary') {
      const parent = element.parentElement;
      return parent !== null && parent.localName === 'details' && parent.querySelector(':scope > summary') === element;
    }
    if (tag === 'audio' || tag === 'video') return element.hasAttribute('controls');
    return false;
  }

  /** The control an element is part of: the nearest ancestor that is one, as `tag|role`; empty for none. Labels are not controls. */
  function insideControl(element: Element): string {
    for (let current = composedParent(element); current && current.nodeType === 1; current = composedParent(current)) {
      const ancestor = current as Element;
      const role = roleOf(ancestor);
      if (CONTROL_ROLE_ATTRS.includes(role)) return `${ancestor.localName}|${role}`;
      if (role === 'presentation' || role === 'none' || role === '') {
        const tag = ancestor.localName;
        if (tag === 'a' && ancestor.hasAttribute('href')) return 'a|link';
        if (tag === 'button') return 'button|button';
        if (tag === 'summary' && isNative(ancestor)) return 'summary|button';
        if (tag === 'select' || tag === 'textarea') return `${tag}|${tag}`;
      }
    }
    return '';
  }

  /** At least one interactive element inside, in the composed tree (not in frames). */
  function hasInteractiveInside(element: Element): boolean {
    if (element.querySelector(INTERACTIVE)) return true;
    const hosts: Element[] = element.shadowRoot ? [element] : [];
    const all = element.querySelectorAll('*');
    if (all.length > 2000) return false;
    for (const child of all) if (child.shadowRoot) hosts.push(child);
    for (const host of hosts) {
      const root = host.shadowRoot!;
      if (root.querySelector(INTERACTIVE)) return true;
      for (const inner of root.querySelectorAll('*')) if (inner.shadowRoot && hasInteractiveInside(inner)) return true;
    }
    return false;
  }

  function collapsed(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  function hrefOf(element: Element): NonNullable<AgentNrvElement['href']> {
    const raw = element.getAttribute('href');
    const target = (element.getAttribute('target') ?? '').trim();
    const download = element.hasAttribute('download');
    if (raw === null) return { kind: 'none', target, download, sameDocument: false };
    const value = raw.trim();
    if (value === '') return { kind: 'empty', target, download, sameDocument: true };
    if (value === '#') return { kind: 'hash', target, download, sameDocument: true };
    if (value === '#!') return { kind: 'hashbang', target, download, sameDocument: true };
    if (/^javascript:/i.test(value)) return { kind: 'javascript', target, download, sameDocument: true };
    if (value.startsWith('#')) return { kind: 'fragment', target, download, sameDocument: true, words: value.toLowerCase().slice(0, 200) };
    try {
      const url = new URL(value, element.baseURI);
      const here = new URL(element.ownerDocument.URL);
      const same = url.origin === here.origin && url.pathname === here.pathname && url.search === here.search;
      let words = '';
      try {
        words = decodeURIComponent(url.pathname + url.hash).toLowerCase().slice(0, 200);
      } catch {
        words = (url.pathname + url.hash).toLowerCase().slice(0, 200);
      }
      return { kind: same && url.hash !== '' ? 'fragment' : 'url', target, download, sameDocument: same, words };
    } catch {
      return { kind: 'url', target, download, sameDocument: false };
    }
  }

  /** Visible text; for a large container (a delegation root, a section) the text content, cut: `innerText` would lay out all of it. */
  function textOf(element: Element): string {
    if (element.getElementsByTagName('*').length > 200) return collapsed((element.textContent ?? '').slice(0, 4 * options.itemTextMaxChars));
    const inner = (element as HTMLElement).innerText;
    return collapsed(typeof inner === 'string' ? inner : (element.textContent ?? ''));
  }

  function iconFontIn(element: Element): boolean {
    if (!iconFamily) return false;
    const view = element.ownerDocument.defaultView;
    if (!view) return false;
    const test = (node: Element): boolean => iconFamily.test(view.getComputedStyle(node).fontFamily);
    if (test(element)) return true;
    let checked = 0;
    for (const child of element.querySelectorAll('*')) {
      if (++checked > 6) break;
      if ((child.textContent ?? '').trim() !== '' && test(child)) return true;
    }
    return false;
  }

  function delegatedFor(element: Element): boolean {
    for (let current: Node | null = composedParent(element); current; current = composedParent(current)) {
      if ((listened.get(current)?.size ?? 0) > 0) return true;
      if (current.nodeType === 9) break;
    }
    const view = element.ownerDocument.defaultView;
    return view !== null && windowListened.has(view);
  }

  function walk(root: Document | ShadowRoot, visit: (element: Element) => void): void {
    for (const element of root.querySelectorAll('*')) {
      visit(element);
      if (element.shadowRoot) walk(element.shadowRoot, visit);
      if (isFrame(element)) {
        const doc = frameDocument(element);
        if (doc) walk(doc, visit);
      }
    }
  }

  const containers = new Map<Element, number>();
  function containerOf(element: Element): number {
    for (let current = composedParent(element); current && current.nodeType === 1; current = composedParent(current)) {
      if (CONTAINER_ROLES.includes(roleOf(current as Element))) {
        let index = containers.get(current as Element);
        if (index === undefined) {
          index = containers.size;
          containers.set(current as Element, index);
        }
        return index;
      }
    }
    return -1;
  }

  function exclusion(element: Element): boolean {
    if (options.probeExcludeSelector === '') return false;
    try {
      for (let current: Element | null = element; current; current = hostOf(current.getRootNode()) ?? null) {
        if (current.closest(options.probeExcludeSelector)) return true;
      }
    } catch {
      // A selector the browser does not take matches nothing.
    }
    return false;
  }

  function describeElement(element: Element, ord: number, sources: string[], frameworkTypes: string[]): AgentNrvElement {
    const rect = viewportRect(element);
    const hasBox = rect.width > 0 && rect.height > 0;
    const visible = hasBox && element.checkVisibility({ visibilityProperty: true });
    const tag = element.localName;
    const tabindexAttr = element.getAttribute('tabindex');
    const tabindex = tabindexAttr !== null && /^\s*-?\d+\s*$/.test(tabindexAttr) ? parseInt(tabindexAttr, 10) : null;
    const text = hasBox ? textOf(element) : '';
    const attrs: Record<string, string> = {};
    for (const name of ['aria-expanded', 'aria-pressed', 'aria-checked', 'aria-selected', 'aria-valuenow', 'aria-valuetext', 'aria-controls', 'aria-haspopup']) {
      const value = element.getAttribute(name);
      if (value !== null) attrs[name] = value.trim();
    }
    let controlsHidden = false;
    const root = element.getRootNode() as Document | ShadowRoot;
    for (const id of (attrs['aria-controls'] ?? '').split(/\s+/)) {
      if (id === '') continue;
      const target = root.getElementById?.(id) ?? element.ownerDocument.getElementById(id);
      if (target && !target.checkVisibility({ visibilityProperty: true })) controlsHidden = true;
    }
    const form = (element as HTMLButtonElement).form ?? null;
    const type =
      tag === 'input' ? ((element as HTMLInputElement).type || 'text').toLowerCase() : tag === 'button' ? ((element as HTMLButtonElement).type || 'submit').toLowerCase() : '';
    const submits = form !== null && ((tag === 'button' && type === 'submit') || (tag === 'input' && (type === 'submit' || type === 'image')));
    let disabled: boolean;
    try {
      disabled = element.matches(':disabled') || element.closest('[aria-disabled="true"]') !== null;
    } catch {
      disabled = false;
    }
    const out: AgentNrvElement = {
      ord,
      box: hasBox ? { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height } : null,
      visible,
      tag,
      type,
      roleAttr: roleOf(element),
      sources,
      listeners: [...(listened.get(element) ?? [])].sort(),
      framework: frameworkTypes,
      delegated: delegatedFor(element),
      tabindex,
      disabled,
      submits,
      inForm: form !== null || element.closest('form') !== null,
      isLabel: tag === 'label' || element.hasAttribute('for'),
      insideControl: insideControl(element),
      interactiveDescendants: hasInteractiveInside(element) ? 1 : 0,
      text: text.slice(0, options.itemTextMaxChars),
      textChars: text.length,
      areaShare: hasBox ? Math.min(1, (rect.width * rect.height) / Math.max(1, window.innerWidth * window.innerHeight)) : 0,
      iconFont: hasBox && iconFontIn(element),
      attrs,
      controlsHidden,
      excluded: exclusion(element),
      container: containerOf(element),
    };
    if (tag === 'a' || tag === 'area') out.href = hrefOf(element);
    if (isFrame(element)) {
      const doc = frameDocument(element);
      out.frameContent = { readable: doc !== null, focusables: doc ? doc.querySelectorAll(FOCUSABLE).length : 0 };
    }
    return out;
  }

  function ensureVisible(element: Element): void {
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  }

  return {
    markListeners(node, types) {
      if (!node || ((node as Node).nodeType !== 1 && (node as Node).nodeType !== 9)) return false;
      const set = listened.get(node as Node) ?? new Set<string>();
      for (const type of types) if (ACTIVATION.includes(type)) set.add(type);
      listened.set(node as Node, set);
      return true;
    },

    windows() {
      const found: Window[] = [window];
      walk(document, (element) => {
        if (!isFrame(element)) return;
        const doc = frameDocument(element);
        if (doc?.defaultView) found.push(doc.defaultView);
      });
      return found;
    },

    markWindow(view, types) {
      if (!view || types.every((type) => !ACTIVATION.includes(type))) return true;
      windowListened.add(view as Window);
      return true;
    },

    survey() {
      const agent = main();
      const elements: AgentNrvElement[] = [];
      const chosen: Element[] = [];
      let total = 0;
      walk(document, (element) => {
        const frameworkAttr = element.getAttribute(HANDLER_ATTRIBUTE);
        if (frameworkAttr !== null) element.removeAttribute(HANDLER_ATTRIBUTE);
        const tag = element.localName;
        if (tag === 'html' || tag === 'head' || tag === 'script' || tag === 'style' || tag === 'template' || tag === 'noscript') return;
        const sources: string[] = [];
        if (isNative(element)) sources.push('native');
        if (agent.wasTabbed(element)) sources.push('tab');
        const tabindex = element.getAttribute('tabindex');
        if (tabindex !== null && /^\s*\d+\s*$/.test(tabindex)) sources.push('tabindex');
        const editable = (element as HTMLElement).isContentEditable;
        if (editable && !(element.parentElement)?.isContentEditable) sources.push('contenteditable');
        if ((listened.get(element)?.size ?? 0) > 0) sources.push('listener');
        const framework = frameworkAttr ? frameworkAttr.split(/\s+/).filter(Boolean) : [];
        if (element.hasAttribute('data-ember-action')) framework.push('ember:action');
        if (framework.length > 0) sources.push('framework');
        if (isFrame(element)) sources.push('frame');
        const role = roleOf(element);
        const view = element.ownerDocument.defaultView;
        if (view && tag !== 'body') {
          const cursor = view.getComputedStyle(element).cursor;
          if (cursor === 'pointer') {
            const parent = composedParent(element);
            const parentCursor = parent && parent.nodeType === 1 ? (parent as Element).ownerDocument.defaultView?.getComputedStyle(parent as Element).cursor : '';
            if (parentCursor !== 'pointer') sources.push('cursor');
          }
        }
        if (sources.length === 0 && !CONTROL_ROLE_ATTRS.includes(role) && role !== 'listbox' && role !== 'scrollbar') return;
        // Not rendered, and not reached by the Tab walk: nothing to say about it here.
        if (!sources.includes('tab') && !element.checkVisibility({ visibilityProperty: true })) return;
        total++;
        if (chosen.length >= options.maxElements) return;
        // Sorted and without repeats, so that two runs give the same lists.
        elements.push(describeElement(element, chosen.length, sources, [...new Set(framework)].sort()));
        chosen.push(element);
      });
      surveyedElements = chosen;
      return { elements, total };
    },

    surveyed() {
      return surveyedElements;
    },

    name(ords) {
      const agent = main();
      return ords.map((ord) => {
        const element = surveyedElements[ord];
        if (!element || !element.isConnected) return null;
        agent.keyFor(element);
        return agent.named(element);
      });
    },

    async prepare(ord) {
      const none = { clip: null, covered: false };
      const element = surveyedElements[ord];
      if (!element || !element.isConnected) return none;
      const agent = main();
      agent.keyFor(element);
      agent.stableAround(element);
      ensureVisible(element);
      await agent.settle();
      if (!element.isConnected) return none;
      const rect = viewportRect(element);
      if (rect.width <= 0 || rect.height <= 0) return none;
      // A capture is evidence only if it shows the element: not when a banner or a dialog lies over its middle.
      const own = element.getBoundingClientRect();
      const doc = element.ownerDocument;
      const view = doc.defaultView;
      const middleX = own.left + own.width / 2;
      const middleY = own.top + own.height / 2;
      if (view && middleX >= 0 && middleY >= 0 && middleX < view.innerWidth && middleY < view.innerHeight) {
        let top: Element | null = doc.elementFromPoint(middleX, middleY);
        while (top?.shadowRoot) {
          const inner: Element | null = top.shadowRoot.elementFromPoint(middleX, middleY);
          if (!inner || inner === top) break;
          top = inner;
        }
        let floating = false;
        for (let current: Node | null = top; current; current = composedParent(current)) {
          if (current.nodeType !== 1) continue;
          let contains = false;
          for (let node: Node | null = element; node; node = composedParent(node)) {
            if (node === current) {
              contains = true;
              break;
            }
          }
          if (contains) break;
          const position = view.getComputedStyle(current as Element).position;
          if (position === 'fixed' || position === 'sticky') floating = true;
        }
        if (floating) return { clip: null, covered: true };
      }
      const margin = options.clipMarginCssPx;
      const left = Math.max(0, rect.x - margin);
      const right = Math.min(window.innerWidth, rect.x + rect.width + margin);
      const upper = Math.max(0, rect.y - margin);
      const lower = Math.min(window.innerHeight, rect.y + rect.height + margin);
      if (right - left < 1 || lower - upper < 1) return none;
      const x0 = Math.floor(left + window.scrollX);
      const y0 = Math.floor(upper + window.scrollY);
      const x1 = Math.ceil(right + window.scrollX);
      const y1 = Math.ceil(lower + window.scrollY);
      return {
        clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
        target: { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height },
        covered: false,
      };
    },
  };
}
