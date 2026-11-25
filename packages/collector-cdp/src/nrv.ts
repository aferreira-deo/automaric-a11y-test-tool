import { fnv1a64, isControlRole, nameRoleValueProbeTargets, nameRoleValueReport } from '@a11y-vision/core';
import type { Config, NameRoleValueSurvey, NrvAx, NrvElement, NrvProbeLog, NrvSource } from '@a11y-vision/core';
import { AGENT_GLOBAL } from './agent.js';
import type { AgentElementInfo, AgentHeadingPrepared } from './agent.js';
import { inDocumentOrder } from './accessibility.js';
import { NRV_AGENT_GLOBAL, nrvAgentFactory } from './nrv-agent.js';
import type { AgentNrvOptions, AgentNrvSurvey } from './nrv-agent.js';
import type { StablePage } from './page.js';

/** Activation listeners: what a click, a tap or a key press on the element itself reaches. */
const ACTIVATION_TYPES = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'touchstart', 'touchend', 'auxclick', 'dblclick'];
/** Remote objects of this collection are held under this group and released at the end. */
const OBJECT_GROUP = 'a11y-vision-nrv';
/** Calls sent at once. */
const BATCH = 24;
const TAB_KEY = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };

/**
 * Marks the elements a framework holds handlers for, when the browser sees the listener on an
 * ancestor only (event delegation). Runs in the main world of the page, which is the only place
 * where framework data is: React keeps the props of an element on the element itself
 * (`__reactProps$…`, `__reactEventHandlers$…` before React 17), and jQuery keeps its delegated
 * handlers with their selectors on the element they are bound to. Each marked element gets the
 * attribute `data-a11y-vision-handler` with the handlers, which the isolated world reads and
 * removes in the same collection. Nothing else is changed; jQuery data is only read where it
 * already exists, since reading it elsewhere would create it.
 *
 * This is data from the page's own world, which a page could falsify: it only ever adds an
 * element to the inventory and is never enough for a `fail` on its own.
 */
export const NRV_FRAMEWORK_SCRIPT = `(() => {
  const ATTR = 'data-a11y-vision-handler';
  const REACT = ['onClick', 'onClickCapture', 'onMouseDown', 'onMouseUp', 'onPointerDown', 'onPointerUp', 'onKeyDown', 'onKeyUp', 'onKeyPress', 'onTouchStart', 'onTouchEnd', 'onDoubleClick'];
  const JQUERY = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'touchstart', 'touchend', 'dblclick'];
  const marks = new Map();
  const add = (element, tag) => {
    let set = marks.get(element);
    if (!set) marks.set(element, (set = new Set()));
    set.add(tag);
  };
  let seen = 0;
  const visitDocument = (doc, view) => {
    let jq = null;
    try {
      const candidate = view && (view.jQuery || view.$);
      if (candidate && typeof candidate._data === 'function') jq = candidate;
    } catch {}
    const delegated = (node) => {
      if (!jq) return;
      let events = null;
      try { events = jq._data(node, 'events'); } catch {}
      if (!events || typeof events !== 'object') return;
      for (const type of JQUERY) {
        for (const handler of events[type] || []) {
          if (!handler || typeof handler.selector !== 'string' || handler.selector === '') continue;
          try { for (const match of node.querySelectorAll(handler.selector)) add(match, 'jquery:' + type); } catch {}
        }
      }
    };
    const visit = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (++seen > 60000) return;
        let keys = [];
        try { keys = Object.keys(element); } catch {}
        for (const key of keys) {
          if (key.startsWith('__reactProps$') || key.startsWith('__reactEventHandlers$')) {
            const props = element[key];
            if (props && typeof props === 'object') for (const name of REACT) if (typeof props[name] === 'function') add(element, 'react:' + name);
          } else if (jq && /^jQuery\\d+$/.test(key)) delegated(element);
        }
        if (element.shadowRoot) visit(element.shadowRoot);
        if (element.localName === 'iframe' || element.localName === 'frame') {
          try {
            const inner = element.contentDocument;
            if (inner) visitDocument(inner, element.contentWindow);
          } catch {}
        }
      }
    };
    if (jq) delegated(doc);
    visit(doc);
  };
  visitDocument(document, window);
  for (const [element, set] of marks) element.setAttribute(ATTR, [...set].sort().join(' '));
  return marks.size;
})()`;

interface AxValue {
  type?: string;
  value?: unknown;
}

interface AxNameSource {
  type?: string;
  attribute?: string;
  nativeSource?: string;
  superseded?: boolean;
  value?: AxValue;
}

interface RawAxNode {
  nodeId?: string;
  parentId?: string;
  childIds?: string[];
  ignored?: boolean;
  ignoredReasons?: { name: string }[];
  role?: { value?: unknown };
  name?: { value?: unknown; sources?: AxNameSource[] };
  properties?: { name: string; value?: { value?: unknown } }[];
  backendDOMNodeId?: number;
}

interface FrameTree {
  frame: { id: string; url: string };
  childFrames?: FrameTree[];
}

/** Roles left out of the context of a node: they hold nothing of their own. */
const TRANSPARENT_ROLES = ['generic', 'none', 'StaticText', 'InlineTextBox', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell', 'Section', 'paragraph'];
const STATE_PROPERTIES = ['expanded', 'pressed', 'checked', 'selected', 'valuenow', 'valuetext', 'valuemin', 'valuemax', 'hasPopup', 'editable'];

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** What a node of the tree says, as the check needs it. */
export function axOf(node: RawAxNode, byId: Map<string, RawAxNode>, maxNameChars: number): NrvAx {
  const property = (name: string): unknown => node.properties?.find((entry) => entry.name === name)?.value?.value;
  const states: Record<string, string> = {};
  for (const name of STATE_PROPERTIES) {
    const value = property(name);
    if (value !== undefined && value !== null) states[name] = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
  }
  const name = text(node.name?.value, maxNameChars);
  const source = name === '' ? undefined : node.name?.sources?.find((entry) => !entry.superseded && typeof entry.value?.value === 'string' && entry.value.value.trim() !== '');
  const context: string[] = [];
  for (let parent = node.parentId ? byId.get(node.parentId) : undefined; parent && context.length < 4; parent = parent.parentId ? byId.get(parent.parentId) : undefined) {
    const role = typeof parent.role?.value === 'string' ? parent.role.value : '';
    if (parent.ignored || role === '' || TRANSPARENT_ROLES.includes(role)) continue;
    context.push(role);
  }
  const ax: NrvAx = {
    role: typeof node.role?.value === 'string' ? node.role.value : '',
    name,
    nameSource: source ? `${source.type ?? ''}:${source.attribute ?? source.nativeSource ?? ''}` : '',
    focusable: property('focusable') === true,
    disabled: property('disabled') === true,
    states,
    context,
  };
  if (node.ignored) ax.ignored = (node.ignoredReasons ?? []).map((reason) => reason.name).sort();
  return ax;
}

/** The options of the in-page part of the survey. */
export function nrvAgentOptions(config: Config): AgentNrvOptions {
  return {
    maxElements: config.nameRoleValue.maxElements,
    itemTextMaxChars: config.nameRoleValue.itemTextMaxChars,
    iconFontFamilyPattern: config.icon.iconFontFamilyPattern,
    probeExcludeSelector: config.nameRoleValue.probeExcludeSelector,
    clipMarginCssPx: config.nameRoleValue.clipMarginCssPx,
  };
}

async function evaluate<T>(page: StablePage, expression: string, byValue = true): Promise<{ value?: T; objectId?: string }> {
  const response = (await page.cdp.send('Runtime.evaluate', {
    expression,
    contextId: page.contextId,
    returnByValue: byValue,
    awaitPromise: true,
    ...(byValue ? {} : { objectGroup: OBJECT_GROUP }),
  })) as { result: { value?: T; objectId?: string }; exceptionDetails?: { text: string; exception?: { description?: string } } };
  if (response.exceptionDetails) throw new Error(`Page evaluation failed: ${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}`);
  return response.result;
}

/** The elements of an array held in the page, as remote objects, in index order. */
async function arrayItems(page: StablePage, objectId: string): Promise<string[]> {
  const { result } = (await page.cdp.send('Runtime.getProperties', { objectId, ownProperties: true })) as { result: { name: string; value?: { objectId?: string } }[] };
  return result
    .filter((entry) => /^\d+$/.test(entry.name) && entry.value?.objectId)
    .sort((a, b) => Number(a.name) - Number(b.name))
    .map((entry) => entry.value!.objectId!);
}

async function inBatches<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += BATCH) out.push(...(await Promise.all(items.slice(start, start + BATCH).map(work))));
  return out;
}

/**
 * A Tab walk of its own, when the focus check does not run in the same scan: real Tab presses,
 * from wherever the page left focus, until focus comes back to an element or `maxTabStops`. It
 * records which elements Tab reaches and captures nothing. Cross-origin frames are stepped past
 * as the focus walk does.
 */
export async function nrvTabWalk(page: StablePage, config: Config): Promise<NonNullable<NameRoleValueSurvey['walkStoppedBy']>> {
  const { cdp, agent } = page;
  const visited = new Set<number>();
  let empty = 0;
  let opaqueKey: number | undefined;
  let opaqueStreak = 0;
  const opaqueKeys: number[] = [];
  const skipped = new Set<number>();
  let lastOwn: number | null = null;
  let previousKey: number | null = null;
  let sameStreak = 0;
  let stoppedBy: NonNullable<NameRoleValueSurvey['walkStoppedBy']> = 'limit';
  for (let stops = 0; stops < config.nameRoleValue.maxTabStops; ) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...TAB_KEY });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...TAB_KEY });
    await agent('settle()');
    const info = await agent<AgentElementInfo | null>('active()');
    if (!info) {
      previousKey = null;
      if (++empty >= 2) {
        stoppedBy = visited.size > 0 ? 'cycle' : 'no-focusable';
        break;
      }
      continue;
    }
    empty = 0;
    // Tab moved inside the element it was on (the fields of a date input share one activeElement): not a cycle.
    if (!info.opaqueFrame && info.key === previousKey) {
      if (++sameStreak > config.focus.maxTabsInElement) {
        stoppedBy = 'trapped';
        break;
      }
      continue;
    }
    sameStreak = 0;
    previousKey = info.key;
    if (info.opaqueFrame && skipped.has(info.key)) {
      stoppedBy = 'opaque-frame';
      break;
    }
    if (info.opaqueFrame && info.key === opaqueKey) {
      if (++opaqueStreak > config.focus.maxTabsInOpaqueFrame) {
        for (const key of opaqueKeys) skipped.add(key);
        await agent(`skipFrames(${JSON.stringify(opaqueKeys)}, ${lastOwn})`);
        opaqueKey = undefined;
      }
      continue;
    }
    if (visited.has(info.key)) {
      stoppedBy = 'cycle';
      break;
    }
    visited.add(info.key);
    opaqueKey = info.opaqueFrame ? info.key : undefined;
    opaqueStreak = 0;
    if (info.opaqueFrame) opaqueKeys.push(info.key);
    else lastOwn = info.key;
    stops++;
  }
  await agent('blurActive()');
  return stoppedBy;
}

/** The documents whose tree is read: the top one, and each frame the agent can look into. */
async function readableFrames(page: StablePage): Promise<FrameTree[]> {
  const { frameTree } = (await page.cdp.send('Page.getFrameTree')) as { frameTree: FrameTree };
  const out: FrameTree[] = [];
  const visit = async (tree: FrameTree, top: boolean): Promise<void> => {
    if (!top) {
      const readable = await page.cdp
        .send('DOM.getFrameOwner', { frameId: tree.frame.id })
        .then(async (owner) => {
          const { object } = (await page.cdp.send('DOM.resolveNode', { backendNodeId: (owner as { backendNodeId: number }).backendNodeId, executionContextId: page.contextId, objectGroup: OBJECT_GROUP })) as { object: { objectId?: string } };
          const { result } = (await page.cdp.send('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: `function () { return globalThis.${AGENT_GLOBAL}.frameReadable(this); }`,
            returnByValue: true,
          })) as { result: { value?: unknown } };
          return result.value === true;
        })
        .catch(() => false);
      if (!readable) return;
    }
    out.push(tree);
    for (const child of tree.childFrames ?? []) await visit(child, false);
  };
  await visit(frameTree, true);
  return out;
}

/**
 * Reads the inventory of the name-role-value check: every element that is, or may be, a control,
 * with why (see `NrvSource`), what the accessibility tree says about it, and what the markup
 * says. Then core decides what is reported and what is activated; selectors are made for exactly
 * those, and captures taken for the findings that need one.
 *
 * Runs on a page prepared by `withStablePage`, after the other collectors. It scrolls what it
 * captures into view; scroll positions are put back by `withStablePage`. Nothing on the page is
 * activated here: probing is `probeNameRoleValue`, later.
 */
/** What probing records before it has done anything. */
export function emptyProbeLog(mode: NrvProbeLog['mode']): NrvProbeLog {
  return { mode, ran: false, probes: [], planned: 0, blocked: [], allowed: 0, fetched: 0, unsafe: 0, escapes: 0, popups: 0, guarded: {}, clones: 0, reused: 0 };
}

export async function collectNameRoleValue(
  page: StablePage,
  config: Config,
  walk: NameRoleValueSurvey['walk'],
  walkStoppedBy?: NameRoleValueSurvey['walkStoppedBy'],
  /** Interactive elements by markup before the collection began (`NRV_BEFORE_SCRIPT`). */
  interactiveBefore?: number,
): Promise<NameRoleValueSurvey> {
  const { cdp } = page;
  const settings = config.nameRoleValue;
  await page.agent('renderAll()');
  await evaluate(page, `globalThis.${NRV_AGENT_GLOBAL} = (${nrvAgentFactory.toString()})(${JSON.stringify(nrvAgentOptions(config))}); 1`);
  const nrv = async <T>(call: string): Promise<T> => (await evaluate<T>(page, `globalThis.${NRV_AGENT_GLOBAL}.${call}`)).value as T;

  let listenersRead = true;
  let listenersBeyond = 0;
  try {
    // Handlers a framework keeps for elements whose listener is on an ancestor. In the main world.
    await cdp.send('Runtime.evaluate', { expression: NRV_FRAMEWORK_SCRIPT, returnByValue: true }).catch(() => undefined);

    // Listeners of every element of the document and of the frames and shadow trees in it, in one call.
    const doc = await evaluate(page, 'document', false);
    const { listeners } = (await cdp.send('DOMDebugger.getEventListeners', { objectId: doc.objectId, depth: -1, pierce: true })) as {
      listeners: { type: string; backendNodeId?: number }[];
    };
    const byNode = new Map<number, Set<string>>();
    for (const listener of listeners) {
      if (listener.backendNodeId === undefined || !ACTIVATION_TYPES.includes(listener.type)) continue;
      const set = byNode.get(listener.backendNodeId) ?? new Set<string>();
      set.add(listener.type);
      byNode.set(listener.backendNodeId, set);
    }
    const nodes = [...byNode.keys()].sort((a, b) => a - b);
    listenersBeyond = Math.max(0, nodes.length - settings.maxListenerElements);
    const marked = await inBatches(nodes.slice(0, settings.maxListenerElements), async (backendNodeId) => {
      try {
        const { object } = (await cdp.send('DOM.resolveNode', { backendNodeId, executionContextId: page.contextId, objectGroup: OBJECT_GROUP })) as { object: { objectId?: string } };
        const { result } = (await cdp.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: `function (types) { return globalThis.${NRV_AGENT_GLOBAL}.markListeners(this, types); }`,
          arguments: [{ value: [...byNode.get(backendNodeId)!].sort() }],
          returnByValue: true,
        })) as { result: { value?: unknown } };
        return result.value === true;
      } catch {
        return false;
      }
    });
    if (marked.some((value) => !value)) listenersRead = false;

    // Listeners on the windows, which are not nodes.
    const windows = await evaluate(page, `globalThis.${NRV_AGENT_GLOBAL}.windows()`, false);
    for (const objectId of windows.objectId ? await arrayItems(page, windows.objectId) : []) {
      try {
        const read = (await cdp.send('DOMDebugger.getEventListeners', { objectId, depth: 0 })) as { listeners: { type: string }[] };
        const types = [...new Set(read.listeners.map((listener) => listener.type))].filter((type) => ACTIVATION_TYPES.includes(type)).sort();
        await cdp.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function (types) { return globalThis.${NRV_AGENT_GLOBAL}.markWindow(this, types); }`,
          arguments: [{ value: types }],
          returnByValue: true,
        });
      } catch {
        listenersRead = false;
      }
    }
  } catch {
    listenersRead = false;
  }

  const read = await nrv<AgentNrvSurvey>('survey()');

  // The node of each element, to look it up in the accessibility tree; for a custom element, whether its shadow root is closed.
  const backendIds: (number | null)[] = [];
  const closedShadow = new Set<number>();
  const list = await evaluate(page, `globalThis.${NRV_AGENT_GLOBAL}.surveyed()`, false);
  if (list.objectId) {
    const items = await arrayItems(page, list.objectId);
    backendIds.push(
      ...(await inBatches(items.map((objectId, index) => ({ objectId, index })), async ({ objectId, index }) => {
        try {
          const custom = read.elements[index]?.tag.includes('-') === true;
          const { node } = (await cdp.send('DOM.describeNode', { objectId, depth: custom ? 1 : 0 })) as {
            node: { backendNodeId: number; shadowRoots?: { shadowRootType?: string }[] };
          };
          if (custom && node.shadowRoots?.some((root) => root.shadowRootType === 'closed')) closedShadow.add(index);
          return node.backendNodeId;
        } catch {
          return null;
        }
      })),
    );
  }

  // The accessibility tree of every document the agent can look into.
  let axComplete = true;
  const axByNode = new Map<number, NrvAx>();
  try {
    for (const frame of await readableFrames(page)) {
      try {
        const { nodes } = (await cdp.send('Accessibility.getFullAXTree', { frameId: frame.frame.id })) as { nodes: RawAxNode[] };
        const ordered = inDocumentOrder(nodes);
        const byId = new Map<string, RawAxNode>();
        for (const node of ordered) if (node.nodeId !== undefined) byId.set(node.nodeId, node);
        for (const node of ordered) {
          if (node.backendDOMNodeId === undefined || axByNode.has(node.backendDOMNodeId)) continue;
          axByNode.set(node.backendDOMNodeId, axOf(node, byId, settings.maxNameChars));
        }
      } catch {
        axComplete = false;
      }
    }
  } catch {
    axComplete = false;
  }

  const elements: NrvElement[] = read.elements.map((element, index) => {
    const backend = backendIds[index];
    const ax = backend === null || backend === undefined ? null : (axByNode.get(backend) ?? null);
    const sources = [...element.sources] as NrvSource[];
    if (ax && !ax.ignored && isControlRole(ax.role) && !sources.includes('role')) sources.push('role');
    return { ...element, selector: '', frame: '', ax, sources: sources.sort(), ...(closedShadow.has(index) ? { closedShadow: true } : {}) };
  });
  const survey: NameRoleValueSurvey = {
    elements,
    total: read.total,
    axComplete,
    walk,
    ...(walkStoppedBy ? { walkStoppedBy } : {}),
    interactiveCount: interactiveBefore ?? read.interactive,
    listenersRead,
    listenersBeyond,
    captures: {},
    probe: emptyProbeLog(settings.probe),
  };

  // Names for what is reported, and for what may be activated: core says which.
  const report = nameRoleValueReport(survey, settings);
  const targets = settings.probe === 'safe' ? nameRoleValueProbeTargets(survey, settings) : [];
  const wanted = [...new Set([...report.candidates.map((candidate) => candidate.ord), ...targets.map((target) => target.ord)])].sort((a, b) => a - b);
  if (wanted.length > 0) {
    const names = await nrv<({ selector: string; frame: string } | null)[]>(`name(${JSON.stringify(wanted)})`);
    wanted.forEach((ord, index) => {
      const named = names[index];
      const element = elements[ord];
      if (named && element) {
        element.selector = named.selector;
        element.frame = named.frame;
      }
    });
  }

  // Captures of the elements in context, for the findings that rest on the page as it is.
  const captured = report.candidates.filter((candidate) => candidate.status !== 'info' && elements[candidate.ord]?.selector);
  const seen = new Set<number>();
  for (const candidate of captured) {
    if (seen.has(candidate.ord) || seen.size >= settings.maxCaptures) continue;
    seen.add(candidate.ord);
    const element = elements[candidate.ord]!;
    const prepared = await nrv<AgentHeadingPrepared>(`prepare(${candidate.ord})`);
    if (!prepared.clip) {
      survey.captures[String(candidate.ord)] = { crop: null, ...(prepared.covered ? { covered: true } : {}) };
      continue;
    }
    const id = `name-role-value/${fnv1a64(JSON.stringify([element.frame, element.selector]))}.png`;
    await page.capture(id, prepared.clip);
    survey.captures[String(candidate.ord)] = { crop: id };
  }
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => undefined);
  return survey;
}
