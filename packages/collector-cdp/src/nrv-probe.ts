import { changedPixels, decodePng, fnv1a64, nameRoleValueProbeTargets } from '@a11y-vision/core';
import type { Box, Config, NameRoleValueSurvey, NrvAxState, NrvElement, NrvNavigation, NrvProbe, NrvProbeLog, NrvStep, Screenshot } from '@a11y-vision/core';
import { GUARD_GLOBAL, GUARD_SCRIPT, PROBE_AGENT_GLOBAL, PROBE_WORLD_NAME, cloneSourceReader, probeAgentFactory, storageSeedScript } from './nrv-probe-agent.js';
import type { CloneSourceRead, ProbeAgentOptions, ProbeObserved, ProbePrepared, ProbeStorage } from './nrv-probe-agent.js';
import { captureScale, decodeBase64 } from './page.js';
import type { Capture, StablePage } from './page.js';
import { isProbeRoutingError } from './probe-host.js';
import type { CloneSettings, ProbeBrowser, ProbeHost, ProbePage } from './probe-host.js';
import { ProbeNetwork, pathOf, shownUrl } from './probe-network.js';
import type { ActivationNetwork } from './probe-network.js';
import type { CdpSession, StopSignal } from './session.js';

/**
 * Probing: activating controls to see what they do, so that what a link or a button is, and
 * whether a state is exposed, can be measured instead of guessed. It never happens in the page
 * under test. The safety model, in order:
 *
 * 1. A browser of its own. The host starts a browser for probing only (`ProbeHost`), whose
 *    network goes nowhere: every connection it opens by itself goes to a proxy that refuses it.
 * 2. Every request held at the browser target (`ProbeNetwork`), from before the first copy loads
 *    until the browser is closed: pages, frames of every origin, dedicated, shared and service
 *    workers, beacons, requests sent as a page goes away. None is ever continued to the network.
 *    A copy that loads gets its GET and HEAD reads fetched by the collector (a page view), sent by
 *    the host where the page under test's own requests go (its proxy, its host rules) or not at
 *    all (what the page routes itself, `probeLoadDeny`, a private address for a public page);
 *    afterwards, only what was already fetched (`probeReads: cache`), and nothing else. When that
 *    routing cannot be followed, or the page under test is offline, no copy is loaded (`routing`).
 * 3. Copies of the page. Each copy is a page in a new, empty context of that browser, given the
 *    cookies, local and session storage, viewport, language, time zone, user agent and colour
 *    scheme of the page under test, and loaded at its address. Probes run there. A probe that
 *    changed its copy (or may have: a request, a timer, a write to storage) ends with the copy
 *    destroyed; the next copy loads only once the old one is gone and `probeUnloadGraceMs` has
 *    passed, with everything stopped. A probe that demonstrably changed nothing leaves its copy
 *    to the next probe. When probing is over, the browser is closed with every request still held.
 * 4. The guard (`GUARD_SCRIPT`), in every document of a copy before the page's scripts: windows,
 *    dialogs, downloads, form submission, sockets, permission prompts are stopped and recorded.
 *    Defence in depth: the network holds whatever the guard does.
 *
 * The page under test is read (`readCloneSource`: cookies, storage, settings) and never changed,
 * activated or reloaded by probing.
 */

export interface ProbeResult {
  log: NrvProbeLog;
}

/** What a copy needs from the page under test. */
export interface CloneSource {
  settings: CloneSettings;
  cookies: Record<string, unknown>[];
  storage: ProbeStorage[];
  /** The page under test is online (`navigator.onLine`): an offline page's own requests go nowhere, and so must the copies'. */
  online: boolean;
}

export interface ProbeOptions {
  signal?: StopSignal;
  /** Test only: reads whose address matches are fetched for the copies while probing (see `CollectOptions.probeTestUnblock`). */
  testUnblock?: RegExp;
}

class ProbeTimeout extends Error {
  constructor(readonly budget: boolean) {
    super(budget ? 'The probing budget ran out.' : 'The copy of the page did not answer in time.');
  }
}

class CopyFailed extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** A value of the accessibility tree as text: strings, numbers and booleans as they are, anything else as JSON. */
function valueText(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
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
    itemTextMaxChars: settings.itemTextMaxChars,
  };
}

/**
 * Reads, in the page under test, what its copies need: its cookies (all of its browser context,
 * HttpOnly and partitioned ones included), the local and session storage of its documents, and
 * its settings. Only reads.
 *
 * The cookies come from `Network.getAllCookies` on the session of the page, which reads the
 * context of the page. Not `Storage.getCookies`: without a `browserContextId` it reads the
 * default context of the browser (empty for a context Playwright made), and a page session may not
 * name another. When that command is gone, the cookies for the addresses of the page's frames.
 */
export async function readCloneSource(page: StablePage, environment: { url: string; viewport: { width: number; height: number }; colorScheme: 'light' | 'dark' }, config: Config): Promise<CloneSource> {
  const response = (await page.cdp.send('Runtime.evaluate', {
    expression: `(${cloneSourceReader.toString()})()`,
    contextId: page.contextId,
    returnByValue: true,
  })) as { result: { value?: CloneSourceRead } };
  const read = response.result.value ?? { storage: [], userAgent: '', language: '', timezone: '', online: true };
  const frameUrls = async (): Promise<string[]> => {
    const urls = new Set<string>([environment.url]);
    const visit = (tree: FrameTree): void => {
      if (/^https?:/i.test(tree.frame.url)) urls.add(tree.frame.url);
      for (const child of tree.childFrames ?? []) visit(child);
    };
    const { frameTree } = (await page.cdp.send('Page.getFrameTree').catch(() => ({ frameTree: null }))) as { frameTree: FrameTree | null };
    if (frameTree) visit(frameTree);
    return [...urls];
  };
  const cookies = await page.cdp
    .send('Network.getAllCookies')
    .then((result) => (result as { cookies: Record<string, unknown>[] }).cookies)
    .catch(async () =>
      page.cdp
        .send('Network.getCookies', { urls: await frameUrls() })
        .then((result) => (result as { cookies: Record<string, unknown>[] }).cookies)
        .catch(() => [] as Record<string, unknown>[]),
    );
  return {
    settings: {
      url: environment.url,
      viewport: environment.viewport,
      deviceScaleFactor: config.focus.deviceScaleFactor,
      userAgent: read.userAgent,
      locale: read.language,
      colorScheme: environment.colorScheme,
      timezoneId: read.timezone,
    },
    cookies,
    storage: read.storage,
    online: read.online !== false,
  };
}

interface FrameTree {
  frame: { url: string };
  childFrames?: FrameTree[];
}

/** A cookie as `Storage.getCookies` gives it, as `Network.setCookies` takes it. */
function cookieParam(cookie: Record<string, unknown>): Record<string, unknown> {
  const { size, session, expires, partitionKeyOpaque, sameParty, ...rest } = cookie;
  void size;
  void partitionKeyOpaque;
  void sameParty;
  return { ...rest, ...(session === true || typeof expires !== 'number' || expires <= 0 ? {} : { expires }) };
}

/** A copy of the page, in a context of its own. */
interface Copy {
  page: ProbePage;
  /** The page session, every command bounded (`ProbeTimeout`). */
  cdp: CdpSession;
  contextId: number;
  frames: Set<string>;
  /** A JavaScript dialog opened (one that got past the guard, or `beforeunload`). */
  dialog: boolean;
  crashed: boolean;
  /** An earlier probe may have changed it: it is not used again. */
  dirty: boolean;
  /** Navigations the page session reported (a fragment, a navigation that a dialog cancelled). */
  navigations: NrvNavigation[];
  /** Probes it served. */
  served: number;
}

/**
 * Activates the elements core chose (`nameRoleValueProbeTargets`) in copies of the page, and
 * records what each did. Without a host, nothing is activated (`unavailable`).
 */
export async function probeNameRoleValue(
  host: ProbeHost | undefined,
  source: CloneSource | undefined,
  config: Config,
  survey: NameRoleValueSurvey,
  clips: Record<string, Screenshot>,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const settings = config.nameRoleValue;
  const log = survey.probe;
  const targets = nameRoleValueProbeTargets(survey, settings).filter((target) => survey.elements[target.ord]?.selector);
  log.planned = targets.length;
  if (settings.probe !== 'safe' || targets.length === 0 || settings.maxProbes === 0) return { log };
  if (!host || !source) {
    log.unavailable = true;
    return { log };
  }
  const started = Date.now();
  const deadline = started + settings.probeBudgetMs;
  const aborted = (): boolean => options.signal?.aborted === true;
  /** How long the next step may take: `limit`, cut to what is left of the budget. */
  const allowance = (limit: number): number => (aborted() ? 0 : Math.max(0, Math.min(limit, deadline - Date.now())));
  const within = async <T>(promise: Promise<T>, limit = settings.probeStepTimeoutMs): Promise<T> => {
    const ms = allowance(limit);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProbeTimeout(aborted() || Date.now() >= deadline - 5)), ms);
    });
    try {
      return await Promise.race([promise, late]);
    } finally {
      clearTimeout(timer);
    }
  };
  const pause = async (ms: number): Promise<void> => {
    await sleep(allowance(ms));
    if (Date.now() >= deadline || aborted()) throw new ProbeTimeout(true);
  };
  const timed = (cdp: CdpSession, limit = settings.probeStepTimeoutMs): CdpSession => ({
    on: (event, handler) => cdp.on(event, handler),
    off: (event, handler) => cdp.off(event, handler),
    send: (method, params) => within(cdp.send(method, params), limit),
  });

  log.ran = true;
  for (const target of targets) {
    const element = survey.elements[target.ord]!;
    log.probes.push({ ord: target.ord, selector: element.selector, frame: element.frame, reason: target.reason, outcome: 'budget' });
  }
  /** Probing never started: every element to probe says so. */
  const notStarted = (stopped: NonNullable<NrvProbeLog['stopped']>, detail: string): ProbeResult => {
    for (const entry of log.probes) entry.outcome = 'not-started';
    log.stopped = stopped;
    log.stoppedDetail = detail;
    return { log };
  };
  // An offline page's own requests go nowhere: neither do the copies'.
  if (!source.online) return notStarted('routing', 'the page under test is offline (navigator.onLine is false): its own requests go nowhere, so no copy is loaded');

  let probe: ProbeBrowser;
  const starting = host.start();
  try {
    probe = await within(starting, settings.probeLoadTimeoutMs);
  } catch (error) {
    starting.then((late) => late.close(), () => undefined).catch(() => undefined);
    const message = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
    if (aborted()) return notStarted('aborted', 'stopped before the probing browser started');
    if (error instanceof ProbeTimeout) return notStarted(error.budget ? 'budget' : 'browserFailed', 'the probing browser did not start in time');
    if (isProbeRoutingError(error)) return notStarted('routing', message);
    return notStarted('browserFailed', `the probing browser did not start: ${message}`);
  }
  log.route = probe.route;
  const network = new ProbeNetwork(probe, settings, log, options.testUnblock);
  let copy: Copy | null = null;

  const evaluateIn = async <T>(target: Copy, expression: string, byValue = true): Promise<{ value?: T; objectId?: string }> => {
    const response = (await target.cdp.send('Runtime.evaluate', { expression, contextId: target.contextId, returnByValue: byValue, awaitPromise: true })) as {
      result: { value?: T; objectId?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (response.exceptionDetails) throw new Error(`Copy evaluation failed: ${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}`);
    return response.result;
  };
  const agent = async <T>(target: Copy, call: string): Promise<T> => (await evaluateIn<T>(target, `globalThis.${PROBE_AGENT_GLOBAL}.${call}`)).value as T;
  /** The guard lives in the main world of the copy. */
  const guard = async <T>(target: Copy, call: string): Promise<T | undefined> => {
    const response = (await target.cdp.send('Runtime.evaluate', { expression: `globalThis.${GUARD_GLOBAL} ? globalThis.${GUARD_GLOBAL}.${call} : undefined`, returnByValue: true })) as { result?: { value?: T } };
    return response.result?.value;
  };

  const screenshot = async (target: Copy, clip: Box): Promise<Capture> => {
    const { data } = (await target.cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false })) as { data: string };
    const png = decodeBase64(data);
    return { png, scale: captureScale(png, clip, config.focus.deviceScaleFactor, config.focus.captureSizeTolerancePx) };
  };
  const capture = async (target: Copy, id: string, clip: Box): Promise<Capture> => {
    const taken = await screenshot(target, clip);
    clips[id] = { box: clip, scale: taken.scale, png: taken.png };
    return taken;
  };

  const axState = async (target: Copy, backendNodeId: number | null): Promise<NrvAxState | null> => {
    if (backendNodeId === null) return null;
    try {
      const { nodes } = (await target.cdp.send('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false })) as {
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
    } catch (error) {
      if (error instanceof ProbeTimeout) throw error;
      return null;
    }
  };

  const backendOf = async (target: Copy, key: number): Promise<number | null> => {
    try {
      const { objectId } = await evaluateIn(target, `globalThis.${PROBE_AGENT_GLOBAL}.element(${key})`, false);
      const { node } = (await target.cdp.send('DOM.describeNode', { objectId })) as { node: { backendNodeId: number } };
      return node.backendNodeId;
    } catch (error) {
      if (error instanceof ProbeTimeout) throw error;
      return null;
    }
  };

  /** The element in the copy is the element of the page under test: same tag (`locate`), role and name, and text when it has no name. */
  const sameElement = async (target: Copy, element: NrvElement, key: number, backend: number | null): Promise<boolean> => {
    const state = await axState(target, backend);
    if (!state || !element.ax || state.role !== element.ax.role || state.name !== element.ax.name) return false;
    if (element.ax.name !== '') return true;
    const { text } = await agent<{ text: string }>(target, `identity(${key})`);
    return text === element.text;
  };

  const closeCopy = async (target: Copy, grace: boolean): Promise<void> => {
    // From here its requests are no copy's: everything of it is stopped, as it goes and after.
    network.setCurrent(null);
    network.closeLoad();
    const gone = network.destroyedOf(target.page.targetId, settings.probeStepTimeoutMs);
    await Promise.race([target.page.close(), sleep(settings.probeStepTimeoutMs)]).catch(() => undefined);
    await gone;
    if (grace) await sleep(settings.probeUnloadGraceMs);
  };

  const openCopy = async (): Promise<Copy> => {
    log.clones++;
    const opening = probe.newPage(source.settings);
    let page: ProbePage;
    try {
      page = await within(opening);
    } catch (error) {
      opening.then((late) => late.close(), () => undefined).catch(() => undefined);
      throw error;
    }
    const target = blankCopy(page);
    try {
      return await loadCopy(target);
    } catch (error) {
      await closeCopy(target, true).catch(() => undefined);
      throw error;
    }
  };

  const blankCopy = (page: ProbePage): Copy => ({ page, cdp: timed(page.cdp), contextId: 0, frames: new Set([page.targetId]), dialog: false, crashed: false, dirty: false, navigations: [], served: 0 });

  const loadCopy = async (target: Copy): Promise<Copy> => {
    const page = target.page;
    const raw = page.cdp;
    raw.on('Page.frameAttached', (params) => void target.frames.add((params as { frameId: string }).frameId));
    raw.on('Page.frameNavigated', (params) => void target.frames.add((params as { frame: { id: string } }).frame.id));
    raw.on('Page.javascriptDialogOpening', () => {
      target.dialog = true;
      raw.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => undefined);
    });
    raw.on('Inspector.targetCrashed', () => {
      target.crashed = true;
    });
    raw.on('Page.navigatedWithinDocument', (params) => {
      const { frameId, url, navigationType } = params as { frameId: string; url: string; navigationType?: string };
      if (frameId !== page.targetId || navigationType === 'historyApi') return;
      const hash = url.includes('#') ? url.slice(url.indexOf('#')) : '';
      target.navigations.push({ kind: 'fragment', url: hash });
    });
    raw.on('Page.frameRequestedNavigation', (params) => {
      const { url, disposition, frameId } = params as { url: string; disposition: string; frameId: string };
      if (/^javascript:/i.test(url)) return;
      if (disposition !== 'currentTab') target.navigations.push({ kind: 'window', url: shownUrl(url) });
      else if (frameId === page.targetId && !ProbeNetwork.sameDocument(url, source.settings.url)) {
        // Recorded in case the request never comes (a beforeunload handler that was dismissed).
        target.navigations.push({ kind: 'document', url: shownUrl(url), method: 'GET', otherPath: pathOf(url) !== pathOf(source.settings.url), carriesFieldValue: false });
      }
    });
    network.setCurrent({
      browserContextId: page.browserContextId,
      mainFrameId: page.targetId,
      frames: target.frames,
      url: source.settings.url,
      cookies: (url) => raw.send('Network.getCookies', { urls: [url] }).then((result) => (result as { cookies: [] }).cookies),
    });
    const cdp = target.cdp;
    await cdp.send('Page.enable');
    await cdp.send('Inspector.enable').catch(() => undefined);
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => undefined);
    if (source.cookies.length > 0) await cdp.send('Network.setCookies', { cookies: source.cookies.map(cookieParam) }).catch(() => undefined);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: storageSeedScript(source.storage) });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: GUARD_SCRIPT });
    // As the page under test is captured: the scale of the captures, motion reduced, focus kept.
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...source.settings.viewport, deviceScaleFactor: config.focus.deviceScaleFactor, mobile: false });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }).catch(() => undefined);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
    // The load: its reads are fetched for it, a page view.
    network.openLoad();
    const loading = timed(raw, settings.probeLoadTimeoutMs);
    const navigated = (await loading.send('Page.navigate', { url: source.settings.url })) as { errorText?: string };
    if (navigated.errorText) {
      // What went wrong when its document was read, not only the error the copy was given.
      const why = network.failureOf(source.settings.url);
      throw new CopyFailed(`the copy did not load (${navigated.errorText}${why ? `: ${why}` : ''})`);
    }
    const loadBy = Date.now() + settings.probeLoadTimeoutMs;
    for (;;) {
      const state = (await loading.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }).catch((error: unknown) => {
        if (error instanceof ProbeTimeout) throw error;
        return { result: {} };
      })) as { result: { value?: unknown } };
      if (state.result.value === 'complete') break;
      if (Date.now() > loadBy) throw new ProbeTimeout(Date.now() >= deadline);
      await pause(50);
    }
    const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string; url: string } } };
    const world = (await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: PROBE_WORLD_NAME })) as { executionContextId: number };
    target.contextId = world.executionContextId;
    await evaluateIn(target, `globalThis.${PROBE_AGENT_GLOBAL} = (${probeAgentFactory.toString()})(${JSON.stringify(probeAgentOptions(config))}); 1`);
    await agent(target, 'install()');
    // What the page fetches once it has loaded is part of the load; then the load is over.
    // The page under test was scrolled through by the collection (the Tab walk, the captures): what it loads as it is
    // scrolled is in it, so the copy is scrolled through too, while it loads.
    await within(agent(target, `scrollThrough(${settings.quietMaxMs})`), settings.quietMaxMs + settings.probeStepTimeoutMs);
    await within(agent(target, `quiet(${settings.quietMs}, ${settings.quietMaxMs})`), settings.quietMaxMs + settings.probeStepTimeoutMs);
    network.closeLoad();
    await cdp.send('DOM.getDocument', { depth: 0 }).catch(() => undefined);
    if (pathOf(frameTree.frame.url) !== pathOf(source.settings.url)) throw new CopyFailed(`the copy ended on another address (${shownUrl(frameTree.frame.url)})`);
    target.navigations = [];
    return target;
  };

  const waitQuiet = async (target: Copy): Promise<void> => {
    await pause(settings.probeSettleMs);
    await within(agent(target, `quiet(${settings.activationQuietMs}, ${settings.activationQuietMaxMs})`), settings.activationQuietMaxMs + settings.probeStepTimeoutMs);
    await agent(target, 'settle()');
    for (let tries = 0; network.busy() > 0 && tries < 40; tries++) await pause(25);
  };

  /**
   * Then the timers the activation set are waited for, as long as one is due within
   * `activationTimerMaxMs` of the activation (a link that shows a spinner and navigates 450 ms
   * later), and what each did is waited for as above. Nothing is waited for when the activation set
   * none. Returns whether one is still pending (due later, or an interval): something still to happen.
   */
  const waitTimers = async (target: Copy, activatedAt: number): Promise<boolean> => {
    const bound = activatedAt + settings.activationTimerMaxMs;
    for (;;) {
      const pending = await guard<{ count: number; next: number }>(target, 'pending()');
      if (!pending || pending.count === 0) return false;
      if (pending.next < 0 || Date.now() + pending.next > bound) return true;
      await pause(pending.next + 25);
      await waitQuiet(target);
    }
  };

  /** Pixels that changed in the box of the element between two captures of one clip, CSS px², or null when they cannot be compared. */
  const ownChange = (before: Capture, after: Capture, prepared: ProbePrepared, now: Box | null): number | null => {
    if (!prepared.inClip || !prepared.box || !now) return null;
    if (Math.abs(now.width - prepared.box.width) > 1 || Math.abs(now.height - prepared.box.height) > 1) return null;
    const scale = before.scale;
    if (after.scale !== scale) return null;
    const rect = { x: prepared.inClip.x * scale, y: prepared.inClip.y * scale, width: prepared.inClip.width * scale, height: prepared.inClip.height * scale };
    const moved = { ...rect, x: (prepared.inClip.x + now.x - prepared.box.x) * scale, y: (prepared.inClip.y + now.y - prepared.box.y) * scale };
    const changed = changedPixels(decodePng(before.png), decodePng(after.png), rect, config.focus.diffDeltaE, Math.max(1, Math.round(config.focus.minComponentAreaCssPx2 * scale * scale)), moved);
    return changed === null ? null : changed / (scale * scale);
  };

  /** Kinds the guard records that leave something changed in the copy. */
  const STATEFUL = ['storage', 'cookie', 'indexeddb', 'cache', 'opfs', 'history', 'replace', 'serviceworker', 'sync', 'close', 'websocket', 'datachannel', 'eventsource', 'webtransport', 'rtcpeerconnection'];

  /** What the network, the page session and the guard say one activation did. */
  const stepOf = (target: Copy, observed: ProbeObserved, ax: NrvAxState | null, guarded: { entries: { kind: string; url: string }[]; pendingTimers: number } | undefined, net: ActivationNetwork): { step: NrvStep; changed: boolean } => {
    const navigations: NrvNavigation[] = [...net.navigations, ...target.navigations];
    target.navigations = [];
    let dialogs = 0;
    let fieldRead = false;
    let traversed = false;
    let changed = net.requests > 0 || (guarded?.pendingTimers ?? 0) > 0;
    const fieldValueIn = (url: string): boolean => {
      try {
        const query = decodeURIComponent(new URL(url).search.replace(/\+/g, ' ')).toLowerCase();
        return net.fields.some((value) => query.includes(value.toLowerCase()));
      } catch {
        return false;
      }
    };
    for (const entry of guarded?.entries ?? []) {
      log.guarded[entry.kind] = (log.guarded[entry.kind] ?? 0) + 1;
      if (STATEFUL.includes(entry.kind)) changed = true;
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
          navigations.push({ kind: entry.kind, url: shownUrl(entry.url), otherPath: pathOf(entry.url) !== pathOf(net.url), carriesFieldValue: fieldValueIn(entry.url) });
          break;
        case 'dialog':
        case 'print':
          dialogs++;
          break;
        case 'field':
          fieldRead = true;
          break;
        case 'traverse':
          traversed = true;
          break;
        default:
          break;
      }
    }
    for (const navigation of navigations) if (navigation.kind === 'fragment') navigation.targetFound = observed.fragmentTarget;
    if (navigations.length > 0) changed = true;
    // One entry per kind and address.
    const unique = new Map<string, NrvNavigation>();
    for (const navigation of navigations) unique.set(`${navigation.kind} ${navigation.url} ${navigation.method ?? ''}`, navigation);
    const step: NrvStep = {
      ax: observed.removed ? null : ax,
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
      writes: net.writes,
      ...(net.blockedReads > 0 ? { blockedReads: net.blockedReads } : {}),
      ...(fieldRead ? { fieldRead: true } : {}),
      ...(traversed ? { traversed: true } : {}),
    };
    return { step, changed };
  };

  /** One probe in a copy. Returns whether the copy is as the probe found it. */
  const runProbe = async (target: Copy, element: NrvElement, entry: NrvProbe): Promise<boolean> => {
    const key = await agent<number>(target, `locate(${JSON.stringify(element.frame)}, ${JSON.stringify(element.selector)}, ${JSON.stringify(element.tag)})`);
    if (key === -1) {
      entry.outcome = 'not-found';
      return true;
    }
    if (key < 0) {
      entry.outcome = 'not-matched';
      return true;
    }
    const backend = await backendOf(target, key);
    if (!(await sameElement(target, element, key, backend))) {
      entry.outcome = 'not-matched';
      return true;
    }
    const prepared = await agent<ProbePrepared>(target, `prepare(${key})`);
    if (!prepared.visible || !prepared.clip) {
      entry.outcome = 'not-visible';
      await agent(target, 'restoreScroll()');
      return true;
    }
    await within(agent(target, `quiet(${settings.activationQuietMs}, ${settings.activationQuietMaxMs})`), settings.activationQuietMaxMs + settings.probeStepTimeoutMs);
    for (let tries = 0; network.busy() > 0 && tries < 40; tries++) await pause(25);
    entry.before = await axState(target, backend);
    const begun = await agent<{ fields: string[]; url: string; fingerprint: string }>(target, `begin(${key})`);
    network.startActivation(begun.url, begun.fields);
    target.navigations = [];
    const name = fnv1a64(JSON.stringify([element.frame, element.selector]));
    const ids = { before: `name-role-value/${name}-before.png`, after: `name-role-value/${name}-after.png`, again: `name-role-value/${name}-again.png` };
    const before = await capture(target, ids.before, prepared.clip);
    await guard(target, 'begin()');
    const activatedAt = Date.now();
    await agent(target, `activate(${key})`);
    await waitQuiet(target);
    const timerPending = await waitTimers(target, activatedAt);
    let observed = await agent<ProbeObserved>(target, `observe(${key})`);
    const after = await capture(target, ids.after, prepared.clip);
    const interval = Date.now() - activatedAt;
    const first = stepOf(target, observed, observed.removed ? null : await axState(target, backend), await guard(target, 'take()'), network.takeActivation());
    const step = first.step;
    if (timerPending) step.timerPending = true;
    let changed = first.changed;
    step.ownChange = observed.scrolled || observed.removed ? null : ownChange(before, after, prepared, await agent<Box | null>(target, `boxOf(${key})`));
    // Pixels that change over the same interval without an activation (an animation, a ticker)
    // are not the activation's doing.
    if (step.ownChange !== null && step.ownChange >= settings.ownChangeMinAreaCssPx2) {
      const still = await screenshot(target, prepared.clip);
      await pause(interval);
      const later = await screenshot(target, prepared.clip);
      const drift = ownChange(still, later, prepared, await agent<Box | null>(target, `boxOf(${key})`));
      if (drift === null || drift >= settings.ownChangeMinAreaCssPx2) step.selfAnimating = true;
    }
    // Text that changes on its own (a clock, a counter of a carousel) is not an effect of the
    // activation. What is shown or hidden is confirmed by a second activation instead.
    if (step.textChanged > 0) {
      const noise = await agent<{ text: number; visibility: number }>(target, `noise(${Math.max(settings.probeSettleMs, interval)})`);
      if (noise.text > 0) step.textChanged = 0;
      if (noise.visibility > 0) {
        step.revealed = [];
        step.hidden = [];
      }
    }
    entry.after = step;
    entry.crops = { before: ids.before, after: ids.after };

    const navigated = step.navigations.some((navigation) => navigation.kind !== 'replace');
    const dialog = step.revealed.some((region) => region.kind === 'dialog');
    const own = !step.selfAnimating && step.ownChange !== null && step.ownChange >= settings.ownChangeMinAreaCssPx2;
    // A second activation shows whether it comes back: a disclosure, a toggle. One whose state
    // changed is activated again too: if it is back as it was, its copy serves the next probe.
    const stateChanged = entry.before !== null && entry.before !== undefined && step.ax !== null && JSON.stringify(entry.before.states) !== JSON.stringify(step.ax.states);
    if (settings.probeConfirmToggle && !navigated && !dialog && !step.removed && (step.revealed.length > 0 || own || stateChanged)) {
      await guard(target, 'begin()');
      const againAt = Date.now();
      await agent(target, `activate(${key})`);
      await waitQuiet(target);
      const againPending = await waitTimers(target, againAt);
      observed = await agent<ProbeObserved>(target, `observe(${key})`);
      const reverted = await agent<boolean>(target, 'revealReverted()');
      const third = await capture(target, ids.again, prepared.clip);
      const second = stepOf(target, observed, observed.removed ? null : await axState(target, backend), await guard(target, 'take()'), network.takeActivation());
      if (second.changed) changed = true;
      const back = observed.scrolled || observed.removed ? null : ownChange(before, third, prepared, await agent<Box | null>(target, `boxOf(${key})`));
      entry.again = { ...second.step, ownChange: back, revealReverted: reverted, ownReverted: back !== null && back < settings.ownChangeMinAreaCssPx2, ...(againPending ? { timerPending: true } : {}) };
      entry.crops.again = ids.again;
    }
    network.endActivation();
    entry.outcome = 'done';
    await agent(target, 'restoreScroll()');
    // The copy serves the next probe only when nothing shows that it changed.
    return !changed && observed.fingerprint === begun.fingerprint && observed.url === begun.url;
  };

  try {
    try {
      await within(network.enable());
    } catch (error) {
      return notStarted('browserFailed', `the network of the probing browser could not be held: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
    let compared = false;
    for (const [index, entry] of log.probes.entries()) {
      if (log.stopped) break;
      if (aborted()) {
        log.stopped = 'aborted';
        break;
      }
      if (index >= settings.maxProbes) {
        log.stopped = 'maxProbes';
        break;
      }
      if (Date.now() >= deadline) {
        log.stopped = 'budget';
        break;
      }
      const element = survey.elements[entry.ord]!;
      try {
        if (copy && copy.dirty) {
          const old = copy;
          copy = null;
          await closeCopy(old, true);
        }
        if (!copy) {
          if (log.clones >= settings.maxProbeLoads) {
            log.stopped = 'loads';
            break;
          }
          copy = await openCopy();
          if (!compared) {
            // The copy must be the page under test: the same interactive elements, and the elements to probe found alike.
            const checked = log.probes.slice(0, settings.maxProbes);
            let matched = 0;
            let missing = 0;
            let added = 0;
            for (const candidate of checked) {
              const other = survey.elements[candidate.ord]!;
              const key = await agent<number>(copy, `locate(${JSON.stringify(other.frame)}, ${JSON.stringify(other.selector)}, ${JSON.stringify(other.tag)})`);
              if (key > 0 && (await sameElement(copy, other, key, await backendOf(copy, key)))) matched++;
              else {
                candidate.outcome = key === -1 ? 'not-found' : 'not-matched';
                // What the collection made appear in the page (a menu, suggestions) is not in a copy that was only loaded.
                if (key === -1 && !other.addedDuringScan) missing++;
                else if (key === -1) added++;
              }
            }
            const cloneInteractive = await agent<number>(copy, 'interactiveCount()');
            const pageInteractive = survey.interactiveCount ?? cloneInteractive;
            log.clone = { pageInteractive, cloneInteractive, checked: checked.length, matched, missing: missing + added };
            const delta = Math.abs(cloneInteractive - pageInteractive) / Math.max(1, pageInteractive);
            // Found and not alike (another variant, signed out) weighs more than not there at all (a menu the collection opened in the page).
            const found = checked.length - missing - added;
            if (matched < settings.probeCloneMinMatchShare * found || missing > settings.probeCloneMaxMissingShare * (checked.length - added) || delta > settings.probeCloneMaxCountDelta) {
              log.stopped = 'cloneDiffers';
              log.stoppedDetail = `the copy of the page does not render the page under test: of ${checked.length} elements to probe, ${matched} found alike, ${found - matched} found different, ${missing} not found, ${added} not found that appeared during the scan; ${cloneInteractive} interactive elements in the copy and ${pageInteractive} in the page`;
              break;
            }
            compared = true;
          }
        }
        if (copy.served++ > 0) log.reused++;
        const clean = await runProbe(copy, element, entry);
        if (copy.dialog || copy.crashed) {
          entry.outcome = copy.dialog ? 'dialog' : 'crash';
          log.stopped = entry.outcome;
          break;
        }
        if (!clean) copy.dirty = true;
      } catch (error) {
        const crashed = copy?.crashed === true;
        if (error instanceof ProbeTimeout) {
          entry.outcome = error.budget ? 'budget' : crashed ? 'crash' : 'timeout';
          log.stopped = aborted() ? 'aborted' : error.budget ? 'budget' : crashed ? 'crash' : 'timeout';
          break;
        }
        if (error instanceof CopyFailed) {
          entry.outcome = 'error';
          log.stopped = 'cloneFailed';
          log.stoppedDetail = error.message;
          break;
        }
        entry.outcome = crashed ? 'crash' : copy?.dialog ? 'dialog' : 'error';
        if (entry.outcome !== 'error' || !compared) {
          if (!compared && entry.outcome === 'error') log.stoppedDetail = 'the copy of the page could not be compared with the page under test';
          log.stopped = entry.outcome;
          break;
        }
        // An element that went away in the middle of its probe, a frame that was replaced: the copy is not used again.
        if (copy) copy.dirty = true;
      }
    }
  } finally {
    network.endActivation();
    if (copy) await closeCopy(copy, false).catch(() => undefined);
    network.disable();
    log.escapes = probe.refusedConnections();
    // Every request still held goes with the browser.
    await Promise.race([probe.close(), sleep(settings.probeStepTimeoutMs)]).catch(() => undefined);
  }
  return { log };
}
