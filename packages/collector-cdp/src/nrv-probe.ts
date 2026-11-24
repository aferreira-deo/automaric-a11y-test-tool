import { changedPixels, decodePng, fnv1a64, nameRoleValueProbeTargets } from '@a11y-vision/core';
import type { Config, NameRoleValueSurvey, NrvAxState, NrvNavigation, NrvProbe, NrvProbeLog, NrvStep } from '@a11y-vision/core';
import { GUARD_SCRIPT, PROBE_AGENT_GLOBAL, PROBE_WORLD_NAME, probeAgentFactory } from './nrv-probe-agent.js';
import type { ProbeAgentOptions, ProbeObserved, ProbePrepared, ProbeStorage } from './nrv-probe-agent.js';
import type { Capture, StablePage } from './page.js';

/**
 * Probing: activating controls to see what they do, so that what a link or a button is, and
 * whether a state is exposed, can be measured instead of guessed. The safety model, in order:
 *
 * 1. Nothing a click starts reaches the network as a write. The Fetch domain pauses every request
 *    of the page (its frames in this process, its dedicated workers) and lets through only GET and
 *    HEAD of `probeAllowedResourceTypes` (style sheets, scripts, images, fonts, media): reads that
 *    render the page. Every other method, every request of a script (`Fetch`, `XHR`), beacons and
 *    `<a ping>` (`Ping`), `EventSource`, `Other`, and every navigation (`Document`) is stopped, and
 *    recorded. A navigation that is stopped is the evidence that a control navigates.
 * 2. Requests that this session cannot see are taken away before they can be made: frames of
 *    another origin (other processes) are emptied while probing; the service worker is bypassed
 *    (`Network.setBypassServiceWorker`), so the page's requests reach the network, and the Fetch
 *    domain, directly; what the page could send to it, to a shared worker, over a WebSocket, a data
 *    channel or a BroadcastChannel is stopped by the guard of the main world (`GUARD_SCRIPT`).
 * 3. Activation is synthetic: events dispatched from script carry no user activation, so the
 *    browser keeps closed what needs one (popups, file pickers, fullscreen, payment, clipboard).
 *    The guard also stops new windows, downloads, printing, dialogs, form submission, permission
 *    prompts and writes to IndexedDB and the Cache API. A window that opens all the same is closed
 *    and counted (`popups`), and JavaScript dialogs are dismissed.
 * 4. The page is put back: cookies, local and session storage are read before probing and written
 *    back after it (and before every reload); a probe that changed the page (its markup, its
 *    address) is followed by a reload, so that each probe starts from the page as it loads; the
 *    emptied frames are filled again. When an element was activated on the document the page is on
 *    at the end, the page is reloaded once more (writes still stopped while it unloads), which also
 *    ends whatever a script of that document still had pending.
 *
 * Never activated: anything inside or as a submit button of a form, fields, file inputs, links
 * to a new window or a download, disabled and hidden elements, frames, media, and what matches
 * `probeExcludeSelector`. What a page does on its own, without a click (timers), is not
 * stopped by any of this except the network block, which holds for the whole of probing.
 */

interface FrameTree {
  /** `url` has no fragment; `urlFragment` is the fragment with its `#`. */
  frame: { id: string; url: string; urlFragment?: string; loaderId: string };
  childFrames?: FrameTree[];
}

interface PausedRequest {
  requestId: string;
  request: { url: string; method: string };
  resourceType: string;
  frameId?: string;
}

interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: string;
  priority?: string;
  sourceScheme?: string;
  sourcePort?: number;
  partitionKey?: unknown;
}

export interface ProbeResult {
  log: NrvProbeLog;
  /** The loader of the document the page ends on, when probing reloaded it: the collection must not take that for a navigation. */
  loaderId?: string;
}

function probeAgentOptions(config: Config): ProbeAgentOptions {
  const settings = config.nameRoleValue;
  return {
    settleFrames: config.focus.settleFrames,
    settleTimeoutMs: config.focus.settleTimeoutMs,
    maxVisibilityElements: settings.maxVisibilityElements,
    revealMinAreaCssPx2: settings.revealMinAreaCssPx2,
    regionMaxAncestorLevels: settings.regionMaxAncestorLevels,
    clipSideCssPx: settings.probeClipSideCssPx,
    clipAboveCssPx: settings.probeClipAboveCssPx,
    clipBelowCssPx: settings.probeClipBelowCssPx,
  };
}

/** Origin and path of an address: no query, no fragment, no credentials. */
function shownUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return `${parsed.protocol}…`;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(not an address)';
  }
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function withoutFragment(url: string): string {
  const index = url.indexOf('#');
  return index < 0 ? url : url.slice(0, index);
}

/** A value of the accessibility tree as text: strings, numbers and booleans as they are, anything else as JSON. */
function valueText(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Activates the elements core chose (`nameRoleValueProbeTargets`) and records what each did, in
 * `survey.probe`. Runs at the end of a collection, inside `withStablePage`, after every other
 * collector has read the page and after the signatures of the elements were taken: from here on
 * the page is changed, and may be reloaded. The emulation of `withStablePage` (scale, reduced
 * motion, focus) holds across reloads; the isolated world of the main agent does not, and is not
 * used any more.
 */
export async function probeNameRoleValue(page: StablePage, config: Config, survey: NameRoleValueSurvey): Promise<ProbeResult> {
  const { cdp } = page;
  const settings = config.nameRoleValue;
  const log = survey.probe;
  const targets = nameRoleValueProbeTargets(survey, settings).filter((target) => survey.elements[target.ord]?.selector);
  log.planned = targets.length;
  if (settings.probe !== 'safe' || targets.length === 0 || settings.maxProbes === 0) return { log };
  log.ran = true;
  const started = Date.now();

  const blocked = new Set<string>();
  const handlers: { event: string; handler: (params: unknown) => void }[] = [];
  const on = (event: string, handler: (params: unknown) => void): void => {
    cdp.on(event, handler);
    handlers.push({ event, handler });
  };
  let mainFrameId = '';
  /**
   * `probe`: only the reads of `probeAllowedResourceTypes` pass. `reload`: while the page is loaded
   * again, every GET and HEAD passes (the new document needs its content), and every other method
   * is still stopped: what the document that goes away sends as it unloads (a beacon, a keepalive
   * request) does not get out.
   */
  let mode: 'probe' | 'reload' = 'probe';
  let pending = 0;
  /** What the current probe recorded through the protocol. */
  let navigations: NrvNavigation[] = [];
  let dialogs = 0;
  /** Requests of another method than GET and HEAD that the current probe tried to send. */
  let writes = 0;
  let current = { url: '', fields: [] as string[] };

  const fieldValueIn = (url: string): boolean => {
    try {
      const query = decodeURIComponent(new URL(url).search.replace(/\+/g, ' ')).toLowerCase();
      return current.fields.some((value) => query.includes(value.toLowerCase()));
    } catch {
      return false;
    }
  };

  const onPaused = (params: unknown): void => {
    const event = params as PausedRequest;
    pending++;
    const method = event.request.method.toUpperCase();
    let query: boolean;
    try {
      query = new URL(event.request.url).search !== '';
    } catch {
      query = true;
    }
    const read = method === 'GET' || method === 'HEAD';
    const safe = read && settings.probeAllowedResourceTypes.includes(event.resourceType) && (settings.probeAllowQueryStrings || !query);
    const done = (): void => {
      pending--;
    };
    if (safe || (mode === 'reload' && read)) {
      if (mode === 'probe') log.allowed++;
      // A self-check: nothing but a read is ever let through.
      if (!read) log.unsafe++;
      cdp.send('Fetch.continueRequest', { requestId: event.requestId }).then(done, done);
      return;
    }
    if (!read) writes++;
    blocked.add(`${method} ${event.resourceType} ${shownUrl(event.request.url)}`);
    if (event.resourceType === 'Document') {
      navigations.push({
        kind: !event.frameId || event.frameId === mainFrameId ? 'document' : 'frame',
        url: shownUrl(event.request.url),
        method,
        otherPath: pathOf(event.request.url) !== pathOf(current.url),
        carriesFieldValue: fieldValueIn(event.request.url),
      });
    }
    // Aborted, not BlockedByClient: a stopped navigation then leaves the page as it is instead of committing an error page (verified in Chromium).
    cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: event.resourceType === 'Document' ? 'Aborted' : 'BlockedByClient' }).then(done, done);
  };

  let targetId = '';
  const setUp = async (): Promise<void> => {
    on('Fetch.requestPaused', onPaused);
    on('Page.javascriptDialogOpening', () => {
      dialogs++;
      cdp.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => undefined);
    });
    on('Page.navigatedWithinDocument', (params) => {
      const { frameId, url, navigationType } = params as { frameId: string; url: string; navigationType?: string };
      if (frameId !== mainFrameId || navigationType === 'historyApi') return;
      const hash = url.includes('#') ? url.slice(url.indexOf('#')) : '';
      if (withoutFragment(url) === withoutFragment(current.url)) navigations.push({ kind: 'fragment', url: hash });
    });
    on('Page.frameRequestedNavigation', (params) => {
      const { url, disposition, frameId } = params as { url: string; disposition: string; frameId: string };
      if (/^javascript:/i.test(url)) return;
      if (disposition !== 'currentTab') navigations.push({ kind: 'window', url: shownUrl(url) });
      else if (frameId === mainFrameId && withoutFragment(url) !== withoutFragment(current.url)) {
        // Recorded in case the request never comes (a beforeunload handler that was dismissed).
        navigations.push({ kind: 'document', url: shownUrl(url), method: 'GET', otherPath: pathOf(url) !== pathOf(current.url), carriesFieldValue: fieldValueIn(url) });
      }
    });
    on('Target.targetCreated', (params) => {
      const info = (params as { targetInfo: { targetId: string; openerId?: string; type: string } }).targetInfo;
      if (info.openerId !== targetId || info.targetId === targetId) return;
      log.popups++;
      cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => undefined);
    });
    await cdp.send('Network.enable').catch(() => undefined);
    await cdp.send('Network.setBypassServiceWorker', { bypass: true }).catch(() => undefined);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await cdp.send('Page.enable');
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => undefined);
    await cdp.send('Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => undefined);
    targetId = ((await cdp.send('Target.getTargetInfo').catch(() => ({ targetInfo: { targetId: '' } }))) as { targetInfo: { targetId: string } }).targetInfo.targetId;
    await cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => undefined);
  };

  // The isolated world of the probe agent, for the document the page is on.
  let contextId = 0;
  const evaluate = async <T>(expression: string, byValue = true): Promise<{ value?: T; objectId?: string }> => {
    const response = (await cdp.send('Runtime.evaluate', { expression, contextId, returnByValue: byValue, awaitPromise: true })) as {
      result: { value?: T; objectId?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (response.exceptionDetails) throw new Error(`Page evaluation failed: ${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}`);
    return response.result;
  };
  const agent = async <T>(call: string): Promise<T> => (await evaluate<T>(`globalThis.${PROBE_AGENT_GLOBAL}.${call}`)).value as T;
  const guard = (expression: string): Promise<unknown> => cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).catch(() => undefined);
  const takeGuard = async (): Promise<{ kind: string; url: string }[]> => {
    const response = (await guard('globalThis.__a11yVisionGuard ? globalThis.__a11yVisionGuard.take() : []')) as { result?: { value?: { kind: string; url: string }[] } } | undefined;
    return response?.result?.value ?? [];
  };

  let emptied = 0;
  const install = async (): Promise<void> => {
    const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: FrameTree };
    mainFrameId = frameTree.frame.id;
    const world = (await cdp.send('Page.createIsolatedWorld', { frameId: mainFrameId, worldName: PROBE_WORLD_NAME })) as { executionContextId: number };
    contextId = world.executionContextId;
    await evaluate(`globalThis.${PROBE_AGENT_GLOBAL} = (${probeAgentFactory.toString()})(${JSON.stringify(probeAgentOptions(config))}); 1`);
    await guard(GUARD_SCRIPT);
    emptied = await agent<number>('install()');
    log.framesEmptied = Math.max(log.framesEmptied, emptied);
    // A page that is still building itself (content added after load) is waited for: what it adds then is not an effect of a probe.
    await agent(`quiet(${settings.quietMs}, ${settings.quietMaxMs})`);
    await cdp.send('DOM.getDocument', { depth: 0 }).catch(() => undefined);
  };

  const frameUrls = async (): Promise<string[]> => {
    const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: FrameTree };
    const urls: string[] = [];
    const visit = (tree: FrameTree): void => {
      if (/^https?:/.test(tree.frame.url)) urls.push(tree.frame.url);
      for (const child of tree.childFrames ?? []) visit(child);
    };
    visit(frameTree);
    return [...new Set(urls)];
  };
  const getCookies = async (urls: string[]): Promise<Cookie[]> => ((await cdp.send('Network.getCookies', { urls }).catch(() => ({ cookies: [] }))) as { cookies: Cookie[] }).cookies;
  const cookieKey = (cookie: Cookie): string => `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`;

  // What is kept to be put back.
  let savedStorage: ProbeStorage[] = [];
  let savedCookies: Cookie[] = [];
  let cookieUrls: string[] = [];
  const restoreStorage = async (): Promise<void> => {
    try {
      const counts = await agent<{ local: number; session: number }>(`restoreStorage(${JSON.stringify(savedStorage)})`);
      log.storageRestored.localStorage += counts.local;
      log.storageRestored.sessionStorage += counts.session;
    } catch {
      // The document is gone: what it wrote to storage is put back by the next document's restore.
    }
    const now = await getCookies(cookieUrls);
    const before = new Map(savedCookies.map((cookie) => [cookieKey(cookie), cookie]));
    for (const cookie of now) {
      const was = before.get(cookieKey(cookie));
      if (was && was.value === cookie.value) continue;
      log.storageRestored.cookies++;
      if (!was) await cdp.send('Network.deleteCookies', { name: cookie.name, domain: cookie.domain, path: cookie.path }).catch(() => undefined);
    }
    const nowKeys = new Set(now.map(cookieKey));
    for (const cookie of savedCookies) {
      const changed = now.find((other) => cookieKey(other) === cookieKey(cookie));
      if (changed && changed.value === cookie.value) continue;
      if (!changed && nowKeys.has(cookieKey(cookie))) continue;
      if (!changed) log.storageRestored.cookies++;
      const { session, expires, partitionKey, ...rest } = cookie;
      await cdp
        .send('Network.setCookie', { ...rest, ...(session ? {} : { expires }), ...(partitionKey && typeof partitionKey === 'object' ? { partitionKey } : {}) })
        .catch(() => undefined);
    }
  };

  let loaderId: string | undefined;
  const waitForLoad = async (previous: string): Promise<boolean> => {
    const deadline = Date.now() + settings.reloadTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: FrameTree };
        if (frameTree.frame.loaderId !== previous) {
          const state = (await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })) as { result: { value?: unknown } };
          if (state.result.value === 'complete') {
            loaderId = frameTree.frame.loaderId;
            return true;
          }
        }
      } catch {
        // Between two documents.
      }
      await sleep(50);
    }
    return false;
  };

  /**
   * Loads the page again at the address it was given. Reads pass while it loads, writes are still
   * stopped (`mode`); the document that goes away takes with it whatever its scripts still had
   * pending (a timer that would have sent something later). With `again`, the page is made ready
   * for the next probe; without, the network is given back once the new document has loaded.
   */
  const reload = async (again: boolean): Promise<boolean> => {
    await restoreStorage();
    const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: FrameTree };
    mode = 'reload';
    log.reloads++;
    activated = false;
    const original = currentUrlAtStart;
    const now = frameTree.frame.url + (frameTree.frame.urlFragment ?? '');
    if (now === original) await cdp.send('Page.reload', { ignoreCache: false });
    else if (withoutFragment(now) === withoutFragment(original) && original.includes('#')) {
      // Only the fragment differs: going to it loads nothing, so the page is reloaded once it is there.
      await cdp.send('Page.navigate', { url: original }).catch(() => undefined);
      await sleep(50);
      await cdp.send('Page.reload', { ignoreCache: false });
    } else {
      // Another address, or the same one without the fragment it was given: a load of its own.
      await cdp.send('Page.navigate', { url: original });
    }
    if (!(await waitForLoad(frameTree.frame.loaderId))) return false;
    // What the page loads once it has loaded (content fetched by its scripts) is given a moment.
    await sleep(settings.probeSettleMs);
    if (!again) {
      await cdp.send('Fetch.disable').catch(() => undefined);
      return true;
    }
    mode = 'probe';
    await install();
    return true;
  };

  const axState = async (backendNodeId: number | null): Promise<NrvAxState | null> => {
    if (backendNodeId === null) return null;
    try {
      const { nodes } = (await cdp.send('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false })) as {
        nodes: { ignored?: boolean; role?: { value?: unknown }; name?: { value?: unknown }; properties?: { name: string; value?: { value?: unknown } }[]; backendDOMNodeId?: number }[];
      };
      const node = nodes.find((entry) => entry.backendDOMNodeId === backendNodeId) ?? nodes[0];
      if (!node || node.ignored) return null;
      const states: Record<string, string> = {};
      for (const property of node.properties ?? []) {
        if (['expanded', 'pressed', 'checked', 'selected', 'valuenow', 'valuetext', 'disabled'].includes(property.name) && property.value?.value !== undefined) {
          states[property.name] = valueText(property.value.value);
        }
      }
      const name = typeof node.name?.value === 'string' ? node.name.value.replace(/\s+/g, ' ').trim().slice(0, settings.maxNameChars) : '';
      return { role: typeof node.role?.value === 'string' ? node.role.value : '', name, states };
    } catch {
      return null;
    }
  };

  const backendOf = async (key: number): Promise<number | null> => {
    try {
      const { objectId } = await evaluate(`globalThis.${PROBE_AGENT_GLOBAL}.element(${key})`, false);
      const { node } = (await cdp.send('DOM.describeNode', { objectId })) as { node: { backendNodeId: number } };
      return node.backendNodeId;
    } catch {
      return null;
    }
  };

  const waitQuiet = async (): Promise<void> => {
    await sleep(settings.probeSettleMs);
    await agent('settle()');
    for (let tries = 0; pending > 0 && tries < 40; tries++) await sleep(25);
  };

  /**
   * Pixels that changed in the box of the element between two captures of one clip, in CSS px².
   * When content appeared above it and moved it, the element is compared where it is in each
   * capture; when its size changed, or it left the clip, nothing is concluded (null).
   */
  const ownChange = (before: Capture, after: Capture, prepared: ProbePrepared, now: { x: number; y: number; width: number; height: number } | null): number | null => {
    if (!prepared.inClip || !prepared.box || !now) return null;
    if (Math.abs(now.width - prepared.box.width) > 1 || Math.abs(now.height - prepared.box.height) > 1) return null;
    const scale = before.scale;
    if (after.scale !== scale) return null;
    const rect = { x: prepared.inClip.x * scale, y: prepared.inClip.y * scale, width: prepared.inClip.width * scale, height: prepared.inClip.height * scale };
    const moved = { ...rect, x: (prepared.inClip.x + now.x - prepared.box.x) * scale, y: (prepared.inClip.y + now.y - prepared.box.y) * scale };
    const changed = changedPixels(decodePng(before.png), decodePng(after.png), rect, config.focus.diffDeltaE, Math.max(1, Math.round(config.focus.minComponentAreaCssPx2 * scale * scale)), moved);
    return changed === null ? null : changed / (scale * scale);
  };

  /** What the protocol, the guard and the page say one activation did. */
  const stepOf = async (observed: ProbeObserved, backend: number | null): Promise<NrvStep> => {
    for (const entry of await takeGuard()) {
      log.guarded[entry.kind] = (log.guarded[entry.kind] ?? 0) + 1;
      switch (entry.kind) {
        case 'window':
          navigations.push({ kind: 'window', url: shownUrl(entry.url) });
          break;
        case 'download':
          navigations.push({ kind: 'download', url: shownUrl(entry.url) });
          break;
        case 'submit':
          navigations.push({ kind: 'submit', url: shownUrl(entry.url) });
          break;
        case 'history':
        case 'replace':
          navigations.push({ kind: entry.kind, url: shownUrl(entry.url), otherPath: pathOf(entry.url) !== pathOf(current.url), carriesFieldValue: fieldValueIn(entry.url) });
          break;
        case 'dialog':
        case 'print':
          dialogs++;
          break;
        default:
          break;
      }
    }
    for (const navigation of navigations) if (navigation.kind === 'fragment') navigation.targetFound = observed.fragmentTarget;
    // One entry per kind and address.
    const unique = new Map<string, NrvNavigation>();
    for (const navigation of navigations) unique.set(`${navigation.kind} ${navigation.url} ${navigation.method ?? ''}`, navigation);
    const step: NrvStep = {
      ax: observed.removed ? null : await axState(backend),
      removed: observed.removed,
      ...(observed.selfHidden ? { selfHidden: true } : {}),
      navigations: [...unique.values()].sort((a, b) => (a.kind + a.url < b.kind + b.url ? -1 : 1)),
      revealed: observed.revealed,
      hidden: observed.hidden,
      textChanged: observed.textChanged,
      ownChange: null,
      scrolled: observed.scrolled,
      focusMoved: observed.focusMoved,
      dialogs,
      writes,
    };
    navigations = [];
    dialogs = 0;
    writes = 0;
    return step;
  };

  let currentUrlAtStart = '';
  let dirty = false;
  /** An element was activated on the document the page is on now. */
  let activated = false;
  try {
    await setUp();
    await install();
    const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: FrameTree };
    currentUrlAtStart = frameTree.frame.url + (frameTree.frame.urlFragment ?? "");
    cookieUrls = await frameUrls();
    savedCookies = await getCookies(cookieUrls);
    savedStorage = await agent<ProbeStorage[]>('storage()');

    for (const target of targets) {
      const element = survey.elements[target.ord]!;
      const probe: NrvProbe = { ord: target.ord, selector: element.selector, frame: element.frame, reason: target.reason, outcome: 'budget' };
      log.probes.push(probe);
      if (log.stopped) continue;
      if (log.probes.filter((entry) => entry.outcome !== 'budget').length >= settings.maxProbes) {
        log.stopped = 'maxProbes';
        continue;
      }
      if (Date.now() - started > settings.probeBudgetMs) {
        log.stopped = 'budget';
        continue;
      }
      try {
        const key = await agent<number>(`locate(${JSON.stringify(element.frame)}, ${JSON.stringify(element.selector)}, ${JSON.stringify(element.tag)})`);
        if (key < 0) {
          probe.outcome = 'not-found';
          continue;
        }
        const prepared = await agent<ProbePrepared>(`prepare(${key})`);
        if (!prepared.visible || !prepared.clip) {
          probe.outcome = 'not-visible';
          await agent('restoreScroll()');
          continue;
        }
        const backend = await backendOf(key);
        probe.before = await axState(backend);
        const begun = await agent<{ fields: string[]; url: string; fingerprint: string }>(`begin(${key})`);
        current = { url: begun.url, fields: begun.fields };
        navigations = [];
        dialogs = 0;
        writes = 0;
        await takeGuard();
        const name = fnv1a64(JSON.stringify([element.frame, element.selector]));
        const ids = { before: `name-role-value/${name}-before.png`, after: `name-role-value/${name}-after.png`, again: `name-role-value/${name}-again.png` };
        const before = await page.capture(ids.before, prepared.clip);

        activated = true;
        await agent(`activate(${key})`);
        await waitQuiet();
        let observed = await agent<ProbeObserved>(`observe(${key})`);
        const after = await page.capture(ids.after, prepared.clip);
        const step = await stepOf(observed, backend);
        step.ownChange = observed.scrolled || observed.removed ? null : ownChange(before, after, prepared, await agent<ProbePrepared['box']>(`boxOf(${key})`));
        // Text that changes on its own (a clock, a counter of a carousel) is not an effect of the
        // activation. What is shown or hidden is confirmed by a second activation instead.
        if (step.textChanged > 0) {
          const noise = await agent<{ text: number; visibility: number }>(`noise(${settings.probeSettleMs})`);
          if (noise.text > 0) step.textChanged = 0;
          if (noise.visibility > 0) {
            step.revealed = [];
            step.hidden = [];
          }
        }
        probe.after = step;
        probe.crops = { before: ids.before, after: ids.after };

        const navigated = step.navigations.some((navigation) => navigation.kind !== 'replace');
        const dialog = step.revealed.some((region) => region.kind === 'dialog');
        const own = step.ownChange !== null && step.ownChange >= settings.ownChangeMinAreaCssPx2;
        if (settings.probeConfirmToggle && !navigated && !dialog && !step.removed && (step.revealed.length > 0 || own)) {
          await agent(`activate(${key})`);
          await waitQuiet();
          observed = await agent<ProbeObserved>(`observe(${key})`);
          const reverted = await agent<boolean>('revealReverted()');
          const third = await page.capture(ids.again, prepared.clip);
          const second = await stepOf(observed, backend);
          const back = observed.scrolled || observed.removed ? null : ownChange(before, third, prepared, await agent<ProbePrepared['box']>(`boxOf(${key})`));
          probe.again = { ...second, ownChange: back, revealReverted: reverted, ownReverted: back !== null && back < settings.ownChangeMinAreaCssPx2 };
          probe.crops.again = ids.again;
        }
        probe.outcome = 'done';
        // What changed the page is not taken into the next probe.
        const changed = observed.fingerprint !== begun.fingerprint || observed.url !== begun.url;
        await agent('restoreScroll()').catch(() => undefined);
        if (changed) {
          dirty = true;
          if (log.reloads >= settings.maxProbeReloads) {
            log.stopped = 'reloads';
            continue;
          }
          if (!(await reload(true))) {
            log.stopped = 'error';
            continue;
          }
          dirty = false;
        }
      } catch {
        probe.outcome = 'error';
        // The page may be gone or changed: it is loaded again before the next probe.
        dirty = true;
        if (log.reloads >= settings.maxProbeReloads || !(await reload(true).catch(() => false))) log.stopped = 'error';
        else dirty = false;
      }
    }
  } finally {
    // Put back: storage first, then either a reload or what was taken out of the page.
    try {
      if (dirty || activated) {
        await reload(false);
      } else {
        // A fresh document that nothing was activated on: what probing set up in it is taken away, and the frames it emptied are filled again once the network is given back.
        await restoreStorage();
        await guard('globalThis.__a11yVisionGuard ? globalThis.__a11yVisionGuard.restore() : true');
        await agent('restoreScroll()').catch(() => undefined);
        await agent('cleanup()').catch(() => undefined);
        await cdp.send('Fetch.disable').catch(() => undefined);
        await agent<number>('unblank()').catch(() => undefined);
      }
    } catch {
      // Whatever could not be put back is said by the page itself; nothing more can be done here.
    }
    for (const { event, handler } of handlers) cdp.off(event, handler);
    await cdp.send('Fetch.disable').catch(() => undefined);
    await cdp.send('Network.setBypassServiceWorker', { bypass: false }).catch(() => undefined);
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => undefined);
    await cdp.send('Target.setDiscoverTargets', { discover: false }).catch(() => undefined);
    log.blocked = [...blocked].sort();
  }
  return { log, ...(loaderId ? { loaderId } : {}) };
}
