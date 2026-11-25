/**
 * The in-page part of the reflow check. It lives in the isolated world of the main agent
 * (`agent.ts`), as a global of its own, and asks the main agent for selectors only. Like it, it is
 * serialised with `toString()` and must stay self-contained: the imports below are types.
 *
 * It reads the layout and does not change the page, with three exceptions, each undone by
 * `restore()`: it scrolls the window (to look at fixed and sticky elements at several positions,
 * and to bring what it captures into view), it adopts style sheets for the time of one pixel test
 * (text made transparent, an element hidden), and the scroll positions the narrow layout clamps
 * are put back. The viewport itself is the collector's business (`reflow.ts`).
 */

import type { ReflowBeyond, ReflowBox, ReflowClipBox, ReflowExceptKind, ReflowLayer, ReflowOverflow, ReflowRect, ReflowText, ReflowViewport } from '@a11y-vision/core';

export interface AgentReflowOptions {
  maxElements: number;
  maxTextItems: number;
  maxBoxes: number;
  maxLinesPerText: number;
  maxBeyond: number;
  sampleChars: number;
  toleranceCssPx: number;
  minVisibleTextCssPx: number;
  settleMinMs: number;
  settleQuietMs: number;
  settleMaxMs: number;
  scrollSettleMs: number;
  scrollSettleMaxMs: number;
  fontsTimeoutMs: number;
  layerMaxDescendants: number;
}

/** What `measure()` reads: a `ReflowLayout` without what the collector adds. */
export interface AgentReflowMeasure {
  viewport: ReflowViewport;
  texts: ReflowText[];
  boxes: ReflowBox[];
  clips: ReflowClipBox[];
  chains: number[][];
  beyond: ReflowBeyond[];
  beyondAxis: 'x' | 'y' | null;
  disclosures: number[];
  maxScroll: { x: number; y: number };
  elements: number;
  truncated: boolean;
  textsBeyond: number;
  boxesBeyond: number;
  frames: { readable: number; opaque: number };
}

export interface ReflowAgent {
  /** Records the scroll positions `restore()` puts back. Called once, before the first measurement. */
  begin(): void;
  /** Waits for the layout after the viewport changed: `settleMinMs`, then `settleQuietMs` without change, `settleMaxMs` at most. True when the size of the document kept still. */
  settle(min: boolean): Promise<boolean>;
  /** Scrolls the window to the start and reads the layout. */
  measure(beyondAxis: 'x' | 'y' | null): AgentReflowMeasure;
  /** Fixed and sticky elements at the current scroll position. */
  layers(): ReflowLayer[];
  /** Scrolls the window and waits for what scrolling sets off. Returns where it went. */
  scrollTo(x: number, y: number): Promise<{ x: number; y: number }>;
  /** Scrolls a region of the page (page coordinates of the layout at 0,0) into the middle of the viewport; returns what of it is in view, in page coordinates, or null. `userOnly`: only along axes the user can scroll. */
  reveal(region: ReflowRect, userOnly: boolean): Promise<{ clip: { x: number; y: number; width: number; height: number } | null; scrollX: number; scrollY: number }>;
  /** The viewport at the current scroll position, in page coordinates. */
  viewportClip(): { x: number; y: number; width: number; height: number };
  /** Which of two elements the hit test finds on top over a region in view: `a`, `b`, `layer` (a fixed or sticky element over both), or `unknown`. */
  order(a: number, b: number, region: ReflowRect): 'a' | 'b' | 'layer' | 'unknown';
  /** Makes the text of `clear` transparent and hides `hide`, with style sheets adopted until `unpaint()`. False when one of them cannot be named or is gone. */
  paint(clear: number[], hide: number[]): Promise<boolean>;
  unpaint(): Promise<void>;
  /** Selector and frame of elements, as findings name them. */
  name(keys: number[]): ({ selector: string; frame: string } | null)[];
  /** Puts back what `begin()` recorded and takes away every style sheet of this agent. */
  restore(): Promise<void>;
}

export const REFLOW_AGENT_GLOBAL = '__a11yVisionReflow';

export function reflowAgentFactory(options: AgentReflowOptions): ReflowAgent {
  const MAIN = '__a11yVisionAgent';
  const main = (): { named(element: Element): { selector: string; frame: string }; keyFor(element: Element): number } =>
    (globalThis as unknown as Record<string, { named(element: Element): { selector: string; frame: string }; keyFor(element: Element): number }>)[MAIN]!;
  const JOIN = ' >>> ';
  const SKIP_TAGS = ['script', 'style', 'template', 'noscript', 'head', 'title', 'meta', 'link', 'option', 'optgroup', 'datalist', 'textarea', 'select', 'br', 'wbr', 'source', 'track', 'param', 'area', 'map'];
  const REPLACED = ['img', 'video', 'canvas', 'iframe', 'frame', 'object', 'embed', 'svg', 'input', 'textarea', 'select', 'button', 'picture'];
  const CONTROL_ROLES = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton'];
  const POPUP_ROLES = ['dialog', 'alertdialog', 'menu', 'listbox', 'tooltip'];
  const LANDMARK_TAGS = ['header', 'footer', 'nav', 'aside'];
  const LANDMARK_ROLES = ['banner', 'contentinfo', 'navigation', 'complementary'];

  const keys = new WeakMap<Element, number>();
  const elements = new Map<number, Element>();
  let nextKey = 1;
  const paintSheets: { owner: Document | ShadowRoot; sheet: CSSStyleSheet }[] = [];
  let recorded: { x: number; y: number; scrolls: Map<Element | Window, { x: number; y: number }> } | null = null;

  function keyOf(element: Element): number {
    let key = keys.get(element);
    if (key === undefined) {
      key = nextKey++;
      keys.set(element, key);
      elements.set(key, element);
    }
    return key;
  }

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

  function contentOrigin(frame: Element): { x: number; y: number } {
    const outer = frame.getBoundingClientRect();
    const style = frame.ownerDocument.defaultView?.getComputedStyle(frame);
    return {
      x: outer.left + frame.clientLeft + (style ? parseFloat(style.paddingLeft) || 0 : 0),
      y: outer.top + frame.clientTop + (style ? parseFloat(style.paddingTop) || 0 : 0),
    };
  }

  function roleOf(element: Element): string {
    return (element.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  }

  function alphaOf(color: string): number {
    const slash = color.lastIndexOf('/');
    if (slash >= 0) return parseFloat(color.slice(slash + 1));
    const legacy = /^rgba\(.*,\s*([\d.e+-]+)\)$/.exec(color);
    if (legacy) return parseFloat(legacy[1]!);
    return color === 'transparent' ? 0 : 1;
  }

  function overflowOf(value: string): ReflowOverflow {
    if (value === 'hidden' || value === 'clip' || value === 'auto' || value === 'scroll') return value;
    if (value === 'overlay') return 'auto';
    return 'visible';
  }

  const r2 = (value: number): number => Math.round(value * 100) / 100;
  const rect = (x: number, y: number, width: number, height: number): ReflowRect => [r2(x), r2(y), r2(width), r2(height)];

  function frame(): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      requestAnimationFrame(finish);
      setTimeout(finish, 50);
    });
  }

  /**
   * Waits for the page after a change: until nothing in the document changed for `quietMs`, at
   * least `minMs`, at most `maxMs`. True when the size of the root and of `body` kept still for
   * `quietMs` at the end: a page that keeps changing its content (a ticker) without moving its
   * layout counts as settled.
   */
  async function waitQuiet(minMs: number, quietMs: number, maxMs: number): Promise<boolean> {
    const start = performance.now();
    let lastChange = start;
    let lastResize = start;
    const observer = new MutationObserver(() => {
      lastChange = performance.now();
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    const resize = new ResizeObserver(() => {
      lastResize = performance.now();
      lastChange = lastResize;
    });
    resize.observe(document.documentElement);
    if (document.body) resize.observe(document.body);
    let fontsDone = false;
    void Promise.race([document.fonts?.ready ?? Promise.resolve(), new Promise((resolve) => setTimeout(resolve, options.fontsTimeoutMs))]).then(() => {
      fontsDone = true;
    });
    let quiet = false;
    for (;;) {
      await frame();
      const now = performance.now();
      if (now - start >= minMs && now - lastChange >= quietMs && fontsDone) {
        quiet = true;
        break;
      }
      if (now - start >= maxMs) break;
    }
    observer.disconnect();
    resize.disconnect();
    return quiet || performance.now() - lastResize >= quietMs;
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

  function viewportInfo(): ReflowViewport {
    const root = document.documentElement;
    const scrolling = document.scrollingElement ?? root;
    const rootStyle = getComputedStyle(root);
    let overflowX = overflowOf(rootStyle.overflowX);
    let overflowY = overflowOf(rootStyle.overflowY);
    // A root that leaves overflow visible takes that of body (propagation to the viewport).
    if (overflowX === 'visible' && overflowY === 'visible' && document.body) {
      const bodyStyle = getComputedStyle(document.body);
      overflowX = overflowOf(bodyStyle.overflowX);
      overflowY = overflowOf(bodyStyle.overflowY);
    }
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      clientWidth: root.clientWidth,
      clientHeight: root.clientHeight,
      scrollWidth: scrolling.scrollWidth,
      scrollHeight: scrolling.scrollHeight,
      overflowX,
      overflowY,
      rtl: rootStyle.direction === 'rtl',
    };
  }

  function exceptKindOf(element: Element, style: CSSStyleDeclaration): ReflowExceptKind | undefined {
    const tag = element.localName;
    const role = roleOf(element);
    if (role === 'presentation' || role === 'none') return undefined;
    if (tag === 'table' || role === 'table') return 'table';
    if (role === 'grid' || role === 'treegrid') return 'grid';
    if (tag === 'img' || tag === 'picture' || role === 'img') return 'image';
    if (tag === 'video') return 'video';
    if (tag === 'canvas') return 'canvas';
    if (tag === 'svg') return 'svg';
    if (tag === 'iframe' || tag === 'frame') return 'frame';
    if (tag === 'object' || tag === 'embed') return 'object';
    if (tag === 'pre' || (tag === 'code' && style.display !== 'inline')) return 'code';
    if (role === 'toolbar') return 'toolbar';
    if (tag === 'math') return 'math';
    if (role === 'application') return 'application';
    return undefined;
  }

  function isControl(element: Element): boolean {
    const tag = element.localName;
    if ((tag === 'a' || tag === 'area') && element.hasAttribute('href')) return true;
    if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true;
    if (tag === 'input') return (element.getAttribute('type') ?? '').toLowerCase() !== 'hidden';
    if (CONTROL_ROLES.includes(roleOf(element))) return true;
    const tabindex = element.getAttribute('tabindex');
    return tabindex !== null && /^\s*\d+\s*$/.test(tabindex);
  }

  function isPopup(element: Element): boolean {
    if (POPUP_ROLES.includes(roleOf(element)) || element.getAttribute('aria-modal') === 'true') return true;
    return element.localName === 'dialog';
  }

  function paintsOwn(element: Element, style: CSSStyleDeclaration): boolean {
    return alphaOf(style.backgroundColor) > 0 || style.backgroundImage !== 'none' || (style.backdropFilter !== '' && style.backdropFilter !== 'none') || REPLACED.includes(element.localName);
  }

  /** Not a pure translation: rectangles from the browser are then bounding boxes. */
  function transformedBy(style: CSSStyleDeclaration): boolean {
    if (style.rotate !== 'none' && style.rotate !== '') return true;
    if (style.transform === 'none' || style.transform === '') return false;
    return !/^matrix\(1, 0, 0, 1, [^,]+, [^,]+\)$/.test(style.transform) && !/^matrix\([\d.e+-]+, 0, 0, [\d.e+-]+, [^,]+, [^,]+\)$/.test(style.transform);
  }

  /** A containing block for fixed descendants (and so for absolute ones). */
  function containsFixed(style: CSSStyleDeclaration): boolean {
    if (style.transform !== 'none' || style.perspective !== 'none' || style.filter !== 'none') return true;
    if (style.backdropFilter !== '' && style.backdropFilter !== 'none') return true;
    if (/paint|layout|strict|content/.test(style.contain)) return true;
    if (/transform|perspective|filter/.test(style.willChange)) return true;
    return style.containerType !== '' && style.containerType !== 'normal';
  }

  function parseClip(value: string, border: DOMRect): [number, number, number, number] | null {
    const match = /^rect\(([^)]*)\)$/.exec(value.trim());
    if (!match) return null;
    const parts = match[1]!.split(/[\s,]+/).filter(Boolean);
    if (parts.length !== 4) return null;
    const read = (part: string, fallback: number): number => (part === 'auto' ? fallback : parseFloat(part));
    const top = read(parts[0]!, 0);
    const rightEdge = read(parts[1]!, border.width);
    const bottomEdge = read(parts[2]!, border.height);
    const left = read(parts[3]!, 0);
    return [left, top, Math.max(0, rightEdge - left), Math.max(0, bottomEdge - top)];
  }

  interface Context {
    chain: number;
    absChain: number;
    fixedChain: number;
    layer: number | undefined;
    except: ReflowExceptKind | undefined;
    transformed: boolean;
    ruby: number | undefined;
    popup: boolean;
    invisible: boolean;
    clipPath: boolean;
    offset: { x: number; y: number };
    top: boolean;
  }

  return {
    begin() {
      const scrolls = new Map<Element | Window, { x: number; y: number }>();
      eachElement(document, (element) => {
        if (element.scrollLeft !== 0 || element.scrollTop !== 0) scrolls.set(element, { x: element.scrollLeft, y: element.scrollTop });
        const view = isFrame(element) ? frameDocument(element)?.defaultView : null;
        if (view && (view.scrollX !== 0 || view.scrollY !== 0)) scrolls.set(view, { x: view.scrollX, y: view.scrollY });
      });
      recorded = { x: window.scrollX, y: window.scrollY, scrolls };
    },

    async settle(min) {
      return waitQuiet(min ? options.settleMinMs : 0, options.settleQuietMs, options.settleMaxMs);
    },

    measure(beyondAxis) {
      window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
      const viewport = viewportInfo();
      const texts: ReflowText[] = [];
      const boxes: ReflowBox[] = [];
      const clips: ReflowClipBox[] = [];
      const chains: number[][] = [[]];
      const chainIds = new Map<string, number>([['', 0]]);
      const beyond: ReflowBeyond[] = [];
      const disclosures: number[] = [];
      const frames = { readable: 0, opaque: 0 };
      let order = 0;
      let walked = 0;
      let truncated = false;
      let textsBeyond = 0;
      let boxesBeyond = 0;
      const tolerance = options.toleranceCssPx;
      const range = document.createRange();
      const bodyPropagates = (() => {
        const style = getComputedStyle(document.documentElement);
        return overflowOf(style.overflowX) === 'visible' && overflowOf(style.overflowY) === 'visible';
      })();

      const chainWith = (parent: number, key: number): number => {
        const list = [key, ...(chains[parent] ?? [])];
        const id = list.join(',');
        let index = chainIds.get(id);
        if (index === undefined) {
          index = chains.length;
          chains.push(list);
          chainIds.set(id, index);
        }
        return index;
      };

      const childrenOf = (element: Element): Node[] => {
        if (element.shadowRoot) return [...element.shadowRoot.childNodes];
        if (element.localName === 'slot') {
          const assigned = (element as HTMLSlotElement).assignedNodes({ flatten: false });
          return assigned.length > 0 ? assigned : [...element.childNodes];
        }
        return [...element.childNodes];
      };

      const visit = (element: Element, context: Context): void => {
        if (truncated) return;
        if (++walked > options.maxElements) {
          truncated = true;
          return;
        }
        const tag = element.localName;
        if (SKIP_TAGS.includes(tag)) return;
        const view = element.ownerDocument.defaultView;
        if (!view) return;
        const style = view.getComputedStyle(element);
        if (style.display === 'none') return;
        const key = keyOf(element);
        const pre = ++order;
        const position = style.position;
        const ownChain = position === 'fixed' ? context.fixedChain : position === 'absolute' ? context.absChain : context.chain;
        const client = element.getBoundingClientRect();
        const page = rect(client.left + context.offset.x, client.top + context.offset.y, client.width, client.height);
        const layer = context.layer ?? (context.top && (position === 'fixed' || position === 'sticky') ? key : undefined);
        const transformed = context.transformed || transformedBy(style);
        const ownExcept = context.except ? undefined : exceptKindOf(element, style);
        const except = context.except ?? ownExcept;
        const popup = context.popup || isPopup(element);
        const ruby = tag === 'ruby' ? key : context.ruby;
        const invisible = context.invisible || parseFloat(style.opacity) <= 0;
        // What `content-visibility: hidden` holds is not painted, and still answers with the boxes of its last layout.
        const contentInvisible = invisible || style.contentVisibility === 'hidden';
        const clipPath = context.clipPath || (style.clipPath !== 'none' && style.clipPath !== '');

        // What it clips.
        let contentChain = ownChain;
        const replaced = REPLACED.includes(tag) && tag !== 'button';
        if (tag !== 'html' && !(tag === 'body' && bodyPropagates) && style.display !== 'inline' && style.display !== 'contents' && !replaced) {
          let x = overflowOf(style.overflowX);
          let y = overflowOf(style.overflowY);
          if (/paint|strict|content/.test(style.contain)) {
            if (x === 'visible') x = 'clip';
            if (y === 'visible') y = 'clip';
          }
          let shown: ReflowRect = rect(client.left + element.clientLeft + context.offset.x, client.top + element.clientTop + context.offset.y, element.clientWidth, element.clientHeight);
          if ((position === 'absolute' || position === 'fixed') && style.clip && style.clip !== 'auto') {
            const clipped = parseClip(style.clip, client);
            if (clipped) {
              shown = rect(page[0] + clipped[0], page[1] + clipped[1], clipped[2], clipped[3]);
              x = 'clip';
              y = 'clip';
            }
          }
          if (x !== 'visible' || y !== 'visible') {
            const truncates = style.textOverflow === 'ellipsis' && /nowrap|pre/.test(style.whiteSpace) ? 'ellipsis' : style.webkitLineClamp && style.webkitLineClamp !== 'none' ? 'line-clamp' : undefined;
            const reveal = element.querySelector('button,summary,[aria-expanded],[role="button"]') !== null || (element.parentElement?.querySelector(':scope > button, :scope > [aria-expanded], :scope > [role="button"]') ?? null) !== null;
            const carousel = (style.scrollSnapType !== 'none' && style.scrollSnapType !== '') || element.closest('[aria-roledescription]') !== null;
            const clip: ReflowClipBox = {
              key,
              rect: shown,
              x,
              y,
              scroll: [element.scrollWidth, element.scrollHeight, r2(element.scrollLeft), r2(element.scrollTop), element.clientWidth, element.clientHeight],
              tag,
              role: roleOf(element),
              ...(truncates ? { truncates } : {}),
              ...(reveal ? { revealControl: true } : {}),
              ...(carousel ? { carousel: true } : {}),
              ...(element.querySelector('table,[role="table"],[role="grid"],[role="treegrid"]') ? { holdsTable: true } : {}),
              ...(except ? { except } : {}),
              ...(layer !== undefined ? { layer } : {}),
            };
            clips.push(clip);
            contentChain = chainWith(ownChain, key);
          }
        }
        const child: Context = {
          ...context,
          chain: contentChain,
          absChain: position !== 'static' || containsFixed(style) ? contentChain : context.absChain,
          fixedChain: containsFixed(style) ? contentChain : context.fixedChain,
          layer,
          except,
          transformed,
          ruby,
          popup,
          invisible: contentInvisible,
          clipPath,
        };

        // Its own text.
        const lines: ReflowRect[] = [];
        let chars = 0;
        let sample = '';
        // Text that paints: not under opacity 0 or a clip-path, visible, of a colour that is not transparent.
        const textShown = !contentInvisible && !clipPath && style.visibility === 'visible' && alphaOf(style.webkitTextFillColor || style.color) > 0;
        for (const node of childrenOf(element)) {
          if (node.nodeType === 3) {
            if (!textShown) continue;
            const data = (node as Text).data;
            const collapsed = data.replace(/\s+/g, ' ').trim();
            if (collapsed === '') continue;
            range.selectNodeContents(node);
            let any = false;
            for (const box of range.getClientRects()) {
              if (box.width < 0.5 || box.height < options.minVisibleTextCssPx) continue;
              any = true;
              if (lines.length >= options.maxLinesPerText) break;
              const line = rect(box.left + context.offset.x, box.top + context.offset.y, box.width, box.height);
              const last = lines[lines.length - 1];
              if (last && Math.abs(last[1] - line[1]) < 1 && Math.abs(last[3] - line[3]) < 1 && line[0] - (last[0] + last[2]) < 1 && line[0] >= last[0]) {
                lines[lines.length - 1] = rect(last[0], last[1], Math.max(last[2], line[0] + line[2] - last[0]), last[3]);
              } else lines.push(line);
            }
            if (any) {
              chars += collapsed.length;
              if (sample.length < options.sampleChars) sample = `${sample} ${collapsed}`.trim().slice(0, options.sampleChars);
            }
          } else if (node.nodeType === 1) {
            visit(node as Element, child);
          }
        }

        // The document of a frame, inside the content box of the frame.
        if (isFrame(element)) {
          const doc = frameDocument(element);
          if (doc?.documentElement) {
            frames.readable++;
            const origin = contentOrigin(element);
            const frameKey = keyOf(doc.documentElement);
            clips.push({
              key: frameKey,
              rect: rect(origin.x + context.offset.x, origin.y + context.offset.y, element.clientWidth, element.clientHeight),
              x: 'auto',
              y: 'auto',
              scroll: [doc.documentElement.scrollWidth, doc.documentElement.scrollHeight, 0, 0, element.clientWidth, element.clientHeight],
              tag: 'iframe',
              role: '',
              frame: true,
              ...(layer !== undefined ? { layer } : {}),
            });
            const inner = chainWith(contentChain, frameKey);
            const offset = { x: origin.x + context.offset.x, y: origin.y + context.offset.y };
            visit(doc.documentElement, { ...child, chain: inner, absChain: inner, fixedChain: inner, offset, top: false });
          } else frames.opaque++;
        }

        const post = ++order;
        const span: [number, number] = [pre, post];
        if (lines.length > 0) {
          if (texts.length < options.maxTextItems) {
            const fontSize = parseFloat(style.fontSize) || 16;
            texts.push({
              key,
              span,
              lines,
              chars,
              fontSize,
              // Its own text is its content: what it clips, it clips too.
              chain: contentChain,
              ...(layer !== undefined ? { layer } : {}),
              ...(except ? { except } : {}),
              ...(transformed ? { transformed: true } : {}),
              ...(ruby !== undefined ? { ruby } : {}),
              ...(popup ? { popup: true } : {}),
              sample,
            });
          } else textsBeyond++;
        }
        // A box that shows: not under opacity 0 or a clip-path, and not `visibility: hidden` (an off-canvas menu that is closed).
        if (tag !== 'html' && tag !== 'body' && page[2] > 0 && page[3] > 0 && !invisible && !clipPath && style.visibility === 'visible') {
          const kind: ReflowBox['kind'] | null = isControl(element) ? 'control' : ownExcept ? ownExcept : paintsOwn(element, style) && style.visibility === 'visible' ? 'box' : null;
          if (kind) {
            if (boxes.length < options.maxBoxes) {
              boxes.push({
                key,
                span,
                rect: page,
                kind,
                chain: ownChain,
                ...(layer !== undefined ? { layer } : {}),
                ...(transformed ? { transformed: true } : {}),
                ...(popup ? { popup: true } : {}),
                paints: paintsOwn(element, style) && style.visibility === 'visible',
                ...(style.display === 'inline' ? { inline: true } : {}),
                tag,
              });
            } else boxesBeyond++;
          }
          if (beyondAxis && context.top && beyond.length < options.maxBeyond) {
            const out = beyondAxis === 'y' ? page[1] + page[3] > viewport.clientHeight + tolerance : viewport.rtl ? page[0] < -tolerance : page[0] + page[2] > viewport.clientWidth + tolerance;
            if (out) beyond.push({ key, span, rect: page, tag });
          }
          const expanded = element.getAttribute('aria-expanded');
          const popupAttr = element.getAttribute('aria-haspopup');
          if (
            style.visibility === 'visible' &&
            (expanded !== null || (popupAttr !== null && popupAttr !== 'false') || tag === 'summary' || ((tag === 'button' || roleOf(element) === 'button') && element.hasAttribute('aria-controls')))
          ) {
            disclosures.push(key);
          }
        }
      };

      visit(document.documentElement, {
        chain: 0,
        absChain: 0,
        fixedChain: 0,
        layer: undefined,
        except: undefined,
        transformed: false,
        ruby: undefined,
        popup: false,
        invisible: false,
        clipPath: false,
        offset: { x: window.scrollX, y: window.scrollY },
        top: true,
      });
      range.detach();
      const scrolling = document.scrollingElement ?? document.documentElement;
      return {
        viewport,
        texts,
        boxes,
        clips,
        chains,
        beyond,
        beyondAxis,
        disclosures,
        maxScroll: {
          x: viewport.overflowX === 'hidden' || viewport.overflowX === 'clip' ? 0 : Math.max(0, scrolling.scrollWidth - document.documentElement.clientWidth),
          y: viewport.overflowY === 'hidden' || viewport.overflowY === 'clip' ? 0 : Math.max(0, scrolling.scrollHeight - document.documentElement.clientHeight),
        },
        elements: walked,
        truncated,
        textsBeyond,
        boxesBeyond,
        frames,
      };
    },

    layers() {
      const found: Element[] = [];
      let walked = 0;
      const walk = (root: Document | ShadowRoot | Element): void => {
        const children = root.nodeType === 1 ? (root as Element).children : (root as Document | ShadowRoot).children;
        for (const element of children) {
          if (++walked > options.maxElements) return;
          const style = getComputedStyle(element);
          if (style.display === 'none') continue;
          if (style.position === 'fixed' || style.position === 'sticky') {
            found.push(element);
            continue;
          }
          walk(element);
          if (element.shadowRoot) walk(element.shadowRoot);
        }
      };
      walk(document);
      const range = document.createRange();
      const out: ReflowLayer[] = [];
      for (const element of found) {
        const style = getComputedStyle(element);
        const visible = element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
        if (!visible) continue;
        const own = element.getBoundingClientRect();
        let painted: ReflowRect[] = [];
        if (paintsOwn(element, style) && own.width > 0 && own.height > 0) painted = [rect(own.left, own.top, own.width, own.height)];
        else {
          let seen = 0;
          const inner = (parent: Element): void => {
            for (const node of parent.shadowRoot ? parent.shadowRoot.childNodes : parent.childNodes) {
              if (seen > options.layerMaxDescendants) return;
              if (node.nodeType === 3) {
                if ((node as Text).data.trim() === '') continue;
                const parentStyle = getComputedStyle(parent);
                if (parentStyle.visibility !== 'visible' || alphaOf(parentStyle.color) === 0) continue;
                range.selectNodeContents(node);
                for (const box of range.getClientRects()) if (box.width > 0 && box.height > 0) painted.push(rect(box.left, box.top, box.width, box.height));
                continue;
              }
              if (node.nodeType !== 1) continue;
              seen++;
              const child = node as Element;
              const childStyle = getComputedStyle(child);
              if (childStyle.display === 'none' || parseFloat(childStyle.opacity) <= 0) continue;
              const box = child.getBoundingClientRect();
              if (paintsOwn(child, childStyle) && childStyle.visibility === 'visible' && box.width > 0 && box.height > 0) {
                painted.push(rect(box.left, box.top, box.width, box.height));
                continue;
              }
              inner(child);
            }
          };
          inner(element);
        }
        if (painted.length > 60) {
          const x = Math.min(...painted.map((r) => r[0]));
          const y = Math.min(...painted.map((r) => r[1]));
          painted = [rect(x, y, Math.max(...painted.map((r) => r[0] + r[2])) - x, Math.max(...painted.map((r) => r[1] + r[3])) - y)];
        }
        if (painted.length === 0) continue;
        const role = roleOf(element);
        const buttons = element.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"],input[type="reset"]').length + (element.localName === 'button' ? 1 : 0);
        const controls = [...element.querySelectorAll('*')].filter(isControl).length;
        const landmark = LANDMARK_TAGS.includes(element.localName) || LANDMARK_ROLES.includes(role) || element.querySelector(':scope > header, :scope > footer, :scope > nav') !== null;
        const dialog = ['dialog', 'alertdialog'].includes(role) || element.getAttribute('aria-modal') === 'true' || (element.localName === 'dialog' && element.hasAttribute('open')) || element.querySelector('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open]') !== null;
        out.push({
          key: keyOf(element),
          position: style.position === 'fixed' ? 'fixed' : 'sticky',
          rect: rect(own.left, own.top, own.width, own.height),
          painted,
          ...(dialog ? { dialog: true } : {}),
          ...(landmark ? { landmark: true } : {}),
          buttons,
          controls,
        });
      }
      range.detach();
      return out;
    },

    async scrollTo(x, y) {
      window.scrollTo({ left: x, top: y, behavior: 'instant' });
      await waitQuiet(options.scrollSettleMs, options.scrollSettleMs, options.scrollSettleMaxMs);
      return { x: window.scrollX, y: window.scrollY };
    },

    async reveal(region, userOnly) {
      const view = viewportInfo();
      const scrolling = document.scrollingElement ?? document.documentElement;
      const maxX = userOnly && (view.overflowX === 'hidden' || view.overflowX === 'clip') ? 0 : Math.max(0, scrolling.scrollWidth - view.clientWidth);
      const maxY = userOnly && (view.overflowY === 'hidden' || view.overflowY === 'clip') ? 0 : Math.max(0, scrolling.scrollHeight - view.clientHeight);
      const x = Math.max(0, Math.min(maxX, Math.round(region[0] + region[2] / 2 - view.clientWidth / 2)));
      const y = Math.max(0, Math.min(maxY, Math.round(region[1] + region[3] / 2 - view.clientHeight / 2)));
      window.scrollTo({ left: x, top: y, behavior: 'instant' });
      await waitQuiet(options.scrollSettleMs, options.scrollSettleMs, options.scrollSettleMaxMs);
      const left = Math.max(region[0], window.scrollX);
      const top = Math.max(region[1], window.scrollY);
      const rightEdge = Math.min(region[0] + region[2], window.scrollX + view.clientWidth);
      const bottomEdge = Math.min(region[1] + region[3], window.scrollY + view.clientHeight);
      if (rightEdge - left < 1 || bottomEdge - top < 1) return { clip: null, scrollX: window.scrollX, scrollY: window.scrollY };
      const x0 = Math.floor(left);
      const y0 = Math.floor(top);
      return { clip: { x: x0, y: y0, width: Math.ceil(rightEdge) - x0, height: Math.ceil(bottomEdge) - y0 }, scrollX: window.scrollX, scrollY: window.scrollY };
    },

    viewportClip() {
      const root = document.documentElement;
      return { x: Math.round(window.scrollX), y: Math.round(window.scrollY), width: root.clientWidth, height: root.clientHeight };
    },

    order(a, b, region) {
      const first = elements.get(a);
      const second = elements.get(b);
      if (!first || !second || !first.isConnected || !second.isConnected) return 'unknown';
      if (first.ownerDocument !== document || second.ownerDocument !== document) return 'unknown';
      if (first.getRootNode() !== document || second.getRootNode() !== document) return 'unknown';
      const votes = { a: 0, b: 0, layer: 0 };
      // Layers that let the pointer through (`pointer-events: none`) are hit too: a style sheet that
      // turns pointer events on is adopted and dropped within this one task, so nothing is painted with it.
      const force = new CSSStyleSheet();
      force.replaceSync('*,*::before,*::after{pointer-events:auto!important}');
      const adopted = document.adoptedStyleSheets;
      document.adoptedStyleSheets = [...adopted, force];
      const vote = (x: number, y: number): void => {
        for (const hit of document.elementsFromPoint(x, y)) {
          const inA = composedContains(first, hit);
          const inB = composedContains(second, hit);
          if (inA && !inB) {
            votes.a++;
            return;
          }
          if (inB && !inA) {
            votes.b++;
            return;
          }
          if (inA && inB) return;
          // Above both: a fixed or sticky element that is not one of them is in the way.
          let floating = false;
          for (let current: Node | null = hit; current; current = composedParent(current)) {
            if (current.nodeType !== 1) continue;
            const position = getComputedStyle(current as Element).position;
            if (position === 'fixed' || position === 'sticky') floating = true;
          }
          if (floating && paintsOwn(hit, getComputedStyle(hit))) {
            votes.layer++;
            return;
          }
        }
      };
      try {
        for (const fx of [0.25, 0.5, 0.75]) {
          for (const fy of [0.25, 0.5, 0.75]) {
            const x = region[0] + region[2] * fx - window.scrollX;
            const y = region[1] + region[3] * fy - window.scrollY;
            if (x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight) vote(x, y);
          }
        }
      } finally {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== force);
      }
      if (votes.layer > 0) return 'layer';
      if (votes.a > votes.b) return 'a';
      if (votes.b > votes.a) return 'b';
      return 'unknown';
    },

    async paint(clear, hide) {
      const rules = new Map<Document | ShadowRoot, string[]>();
      const add = (key: number, css: (selector: string) => string[]): boolean => {
        const element = elements.get(key);
        if (!element || !element.isConnected) return false;
        const named = main().named(element).selector.split(JOIN);
        const selector = named[named.length - 1]!;
        const root = element.getRootNode() as Document | ShadowRoot;
        try {
          if (root.querySelector(selector) !== element) return false;
        } catch {
          return false;
        }
        rules.set(root, [...(rules.get(root) ?? []), ...css(selector)]);
        return true;
      };
      const CLEAR =
        '{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;text-decoration-color:transparent!important;-webkit-text-stroke-color:transparent!important;caret-color:transparent!important}';
      const HIDE = '{visibility:hidden!important}';
      for (const key of clear) {
        if (!add(key, (s) => [s, `${s} *`, `${s}::before`, `${s}::after`, `${s} *::before`, `${s} *::after`, `${s}::marker`, `${s} *::marker`, `${s}::first-letter`, `${s}::first-line`, `${s}::placeholder`].map((selector) => selector + CLEAR))) return false;
      }
      for (const key of hide) {
        if (!add(key, (s) => [s, `${s} *`, `${s}::before`, `${s}::after`, `${s} *::before`, `${s} *::after`].map((selector) => selector + HIDE))) return false;
      }
      for (const [root, list] of rules) {
        const doc = root.nodeType === 9 ? (root as Document) : root.ownerDocument;
        const view = doc?.defaultView as (Window & { CSSStyleSheet: typeof CSSStyleSheet }) | null | undefined;
        if (!view) return false;
        const sheet = new view.CSSStyleSheet();
        for (const rule of list) {
          try {
            sheet.insertRule(rule, sheet.cssRules.length);
          } catch {
            // A pseudo-element this browser does not take after that selector: the others still apply.
          }
        }
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
        paintSheets.push({ owner: root, sheet });
      }
      await frame();
      await frame();
      return true;
    },

    async unpaint() {
      for (const { owner, sheet } of paintSheets) owner.adoptedStyleSheets = owner.adoptedStyleSheets.filter((adopted) => adopted !== sheet);
      paintSheets.length = 0;
      await frame();
    },

    name(list) {
      return list.map((key) => {
        const element = elements.get(key);
        if (!element || !element.isConnected) return null;
        main().keyFor(element);
        return main().named(element);
      });
    },

    async restore() {
      for (const { owner, sheet } of paintSheets) owner.adoptedStyleSheets = owner.adoptedStyleSheets.filter((adopted) => adopted !== sheet);
      paintSheets.length = 0;
      await waitQuiet(0, options.scrollSettleMs, options.settleMaxMs);
      if (!recorded) return;
      const { scrolls } = recorded;
      const put = (target: Element | Window, current: { x: number; y: number }): void => {
        const want = scrolls.get(target) ?? { x: 0, y: 0 };
        if (current.x !== want.x || current.y !== want.y) target.scrollTo({ left: want.x, top: want.y, behavior: 'instant' });
      };
      eachElement(document, (element) => {
        if (element.scrollLeft !== 0 || element.scrollTop !== 0 || scrolls.has(element)) put(element, { x: element.scrollLeft, y: element.scrollTop });
        const view = isFrame(element) ? frameDocument(element)?.defaultView : null;
        if (view && (view.scrollX !== 0 || view.scrollY !== 0 || scrolls.has(view))) put(view, { x: view.scrollX, y: view.scrollY });
      });
      window.scrollTo({ left: recorded.x, top: recorded.y, behavior: 'instant' });
    },
  };
}
