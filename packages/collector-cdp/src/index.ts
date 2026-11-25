import { elementSignature } from '@a11y-vision/core';
import type { Config, Snapshot } from '@a11y-vision/core';
import type { AgentSignature } from './agent.js';
import { createWorld, readEnvironment } from './environment.js';
import { collectFocus } from './focus.js';
import { collectGrouping } from './grouping.js';
import { collectHeadings } from './headings.js';
import { collectIcons } from './icons.js';
import { collectLists } from './lists.js';
import { collectNameRoleValue, nrvTabWalk } from './nrv.js';
import { probeNameRoleValue, readCloneSource } from './nrv-probe.js';
import { NRV_BEFORE_SCRIPT } from './nrv-agent.js';
import type { CloneSource } from './nrv-probe.js';
import type { ProbeHost } from './probe-host.js';
import { markAccessibility } from './accessibility.js';
import { collectReflow } from './reflow.js';
import { withStablePage } from './page.js';
import { gateSession, stopReason } from './session.js';
import type { CdpSession, StopSignal } from './session.js';

export { CollectionStoppedError } from './session.js';
export { pageRestore } from './page.js';
export type { CdpSession, StopSignal } from './session.js';
export type { CloneSettings, ProbeBrowser, ProbeFetchRequest, ProbeFetchResponse, ProbeHost, ProbePage, ProbeReadLimits } from './probe-host.js';
export { ProbeReadRefused, ProbeReadTooLarge, ProbeRoutingError, isProbeReadRefused, isProbeReadTooLarge, isProbeRoutingError } from './probe-host.js';

/** How a collection is run. All optional. */
export interface CollectOptions {
  /**
   * Stops the collection when it fires (an `AbortSignal` fits): the collector stops sending,
   * puts the page back as after a full collection, and `collectSnapshot` rejects with the
   * reason of the signal. Nothing is returned for a page that was read in part.
   */
  signal?: StopSignal;
  /**
   * After a stop, how long the commands that were under way are waited for before the page is
   * put back, in milliseconds (see `GatedSession.release`). Defaults to `IN_FLIGHT_TIMEOUT_MS`.
   */
  inFlightTimeoutMs?: number;
  /**
   * After a stop, how long a step of putting the page back is waited for, in milliseconds (see
   * `RestoreOptions.stepTimeoutMs`). Defaults to `RESTORE_STEP_TIMEOUT_MS`.
   *
   * Only after a stop. A collection that ran to its end waits for each step as long as it
   * takes, as it always did: whoever called it (the CLI, a test through the Playwright wrapper)
   * goes on with the page afterwards and relies on it being as it was, and no limit on that
   * side would be right for every page. After a stop nobody goes on with the result, and the
   * page not answering is the likely reason for the stop in the first place.
   */
  restoreStepTimeoutMs?: number;
  /** Called when, after a stop, the page did not answer in time while it was put back: it may not be as it was. */
  onRestoreIncomplete?: () => void;
  /**
   * Where the name-role-value check may activate controls: a browser of its own, in which copies of
   * the page are loaded (see `ProbeHost`). Without it nothing is activated, whatever
   * `nameRoleValue.probe` says, and the survey says so. The page under test is never probed.
   */
  probeHost?: ProbeHost;
  /**
   * For the tests of the probing safety only: reads whose address matches are fetched from the
   * server for the copies while they are probed, so that a test can show that a request that gets
   * through is seen. Never set by the Playwright API, the CLI or a configuration file.
   */
  probeTestUnblock?: RegExp;
}

/** Long enough for a capture that is being taken to come back, short enough for a stop to feel like one. */
export const IN_FLIGHT_TIMEOUT_MS = 3000;

/** Putting a page back takes milliseconds when the page answers at all. */
export const RESTORE_STEP_TIMEOUT_MS = 2000;

/** The document in the main frame: `loaderId` changes when the frame goes to another document, and not when it only changes its address. */
interface MainDocument {
  loaderId: string;
  url: string;
}

async function mainDocument(cdp: CdpSession): Promise<MainDocument> {
  const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { loaderId: string; url: string } } };
  return { loaderId: frameTree.frame.loaderId, url: frameTree.frame.url };
}

/** Documents waited for in a row before giving up: the page goes on from one to the next. */
const LOAD_ATTEMPTS = 3;

/**
 * Waits for the document in the main frame, `timeoutMs` at most: until it is `parsed`
 * (`DOMContentLoaded`), or until it is `loaded` with its images and style sheets (`load`).
 */
async function waitForDocument(cdp: CdpSession, state: 'parsed' | 'loaded', timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) return;
    const expression = `new Promise((resolve) => {
      const parsed = ${JSON.stringify(state === 'parsed')};
      if (document.readyState === 'complete' || (parsed && document.readyState === 'interactive')) resolve(true);
      else {
        if (parsed) document.addEventListener('DOMContentLoaded', () => resolve(true), { once: true });
        addEventListener('load', () => resolve(true), { once: true });
        setTimeout(() => resolve(false), ${Math.floor(left)});
      }
    })`;
    try {
      await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      return;
    } catch {
      // That document was replaced while it loaded: the next one is waited for.
    }
  }
}

/**
 * Collects what the configured checks need, and nothing else.
 *
 * A page can go to another document while it is read: a redirect by script or by
 * `meta refresh` that fires after `load` (seen on a site that had moved to a new domain: the
 * old address loads, then sends the browser on a moment later). Everything the collector holds
 * then belongs to a document that is gone, and Chrome answers "Cannot find context with
 * specified id" or "Could not find node with given id"; or nothing fails and what was read is
 * half of one page and half of another. So the document of the main frame is compared before
 * and after: when it changed, the new one is waited for and read from the start, once, and the
 * snapshot says where the scan started (`environment.navigatedFrom`). A page that navigates
 * again during the second reading is an error that says so.
 *
 * A document that is still being parsed is waited for before it is read, for the same reason:
 * Chrome renumbers the nodes of a document when it has parsed it, and what was asked about a
 * node before that then fails.
 */
export async function collectSnapshot(cdp: CdpSession, config: Config, options: CollectOptions = {}): Promise<Snapshot> {
  const { signal } = options;
  // Waiting for a document can take as long as a navigation may: a stop ends that wait too.
  const waiting = gateSession(cdp, signal).session;
  const stopped = (): void => {
    if (signal?.aborted) throw stopReason(signal);
  };
  const attempt = async (): Promise<{ from: MainDocument; to: MainDocument | null; snapshot?: Snapshot; source?: CloneSource; error?: unknown }> => {
    // The document that is read is one that has been parsed: asked again after the wait, as
    // the page may have gone to another document while it was waited for.
    stopped();
    let from = await mainDocument(waiting);
    for (let round = 0; round < LOAD_ATTEMPTS; round++) {
      await waitForDocument(waiting, 'parsed', config.focus.navigationTimeoutMs);
      stopped();
      const now = await mainDocument(waiting);
      if (now.loaderId === from.loaderId) break;
      from = now;
    }
    let snapshot: Snapshot | undefined;
    let source: CloneSource | undefined;
    let error: unknown;
    try {
      const once = await collectOnce(cdp, config, signal, options);
      snapshot = once.snapshot;
      source = once.source;
    } catch (caught) {
      error = caught ?? new Error('Collection failed.');
    }
    // Stopped: not a page that went elsewhere, and nothing to read again.
    stopped();
    const now = await mainDocument(cdp).catch(() => null);
    return {
      from,
      to: now && now.loaderId !== from.loaderId ? now : null,
      ...(snapshot ? { snapshot } : {}),
      ...(source ? { source } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  };

  /**
   * Probing comes once the page under test has been read and put back, and never touches it: it
   * happens in copies of the page, in a browser of the host (see `nrv-probe.ts`).
   */
  const probed = async (snapshot: Snapshot, source: CloneSource | undefined): Promise<Snapshot> => {
    if (snapshot.nameRoleValue && config.nameRoleValue.probe === 'safe') {
      const { log } = await probeNameRoleValue(options.probeHost, source, config, snapshot.nameRoleValue, snapshot.screenshots.clips, {
        ...(signal ? { signal } : {}),
        ...(options.probeTestUnblock ? { testUnblock: options.probeTestUnblock } : {}),
      });
      snapshot.nameRoleValue.probe = log;
      stopped();
    }
    return snapshot;
  };

  const first = await attempt();
  if (!first.to) {
    if (first.snapshot) return probed(first.snapshot, first.source);
    throw first.error;
  }
  await waitForDocument(waiting, 'loaded', config.focus.navigationTimeoutMs);
  stopped();
  const second = await attempt();
  if (second.to) {
    throw new Error(
      `The page went from ${first.from.url} to ${first.to.url} while it was being read, and on to ${second.to.url} while it was read again. Scan it once it has settled, or scan the address it ends on.`,
    );
  }
  if (!second.snapshot) {
    const reason = second.error instanceof Error ? second.error.message : String(second.error);
    throw new Error(`The page went from ${first.from.url} to ${first.to.url} while it was being read, and reading it there failed: ${reason}`);
  }
  second.snapshot.environment.navigatedFrom = first.from.url;
  return probed(second.snapshot, second.source);
}

async function collectOnce(raw: CdpSession, config: Config, signal: StopSignal | undefined, options: CollectOptions): Promise<{ snapshot: Snapshot; source?: CloneSource }> {
  // Everything below goes through the gate, the restoring of the page included: it is opened for that.
  const gate = gateSession(raw, signal);
  const cdp = gate.session;
  const world = await createWorld(cdp);
  // The page as it is before anything is done to it: what a copy of it is compared with.
  let interactiveBefore: number | undefined;
  if (config.checks.includes('name-role-value')) {
    const counted = (await world.evaluate(NRV_BEFORE_SCRIPT).catch(() => null))?.result.value;
    if (typeof counted === 'number') interactiveBefore = counted;
  }
  const { reducedMotion, mediaType, ...environment } = await readEnvironment(world);
  const snapshot: Snapshot = {
    environment,
    nodes: [],
    axTree: [],
    screenshots: { tiles: [], clips: {} },
  };
  const focus = config.checks.includes('focus-indicator');
  const icons = config.checks.includes('icon-contrast');
  const headings = config.checks.includes('headings');
  const lists = config.checks.includes('lists');
  const grouping = config.checks.includes('grouping');
  const nrv = config.checks.includes('name-role-value');
  const reflow = config.checks.includes('reflow');
  let source: CloneSource | undefined;
  if (focus || icons || headings || lists || grouping || nrv || reflow) {
    const original = { ...environment, reducedMotion, mediaType };
    await withStablePage(cdp, world, original, config, snapshot.screenshots.clips, async (page) => {
      // The focus walk goes first: it needs focus where the page left it, and ends with nothing focused.
      if (focus) snapshot.focus = await collectFocus(page, config.focus);
      // The name-role-value check reuses that walk; without it, it walks the page itself, also first.
      const walk = focus ? 'focus' : nrv && config.nameRoleValue.tabWalk ? 'own' : 'none';
      const walkStoppedBy = walk === 'own' ? await nrvTabWalk(page, config) : walk === 'focus' ? snapshot.focus?.stoppedBy : undefined;
      if (icons) snapshot.icons = await collectIcons(page, config.icon);
      // Last: they read the page as the other collectors left it and only scroll. What the
      // accessibility tree exposes as headings, lists, form controls and groups is read once for all, with everything
      // the browser skips rendering for (content-visibility: auto) rendered, as the text is.
      if (headings || lists || grouping) {
        await page.agent('renderAll()');
        const exposed = await markAccessibility(page, {
          lists,
          maxLists: config.lists.maxAxMarks,
          grouping: grouping ? { maxMarks: config.grouping.maxAxMarks, maxNameChars: config.grouping.maxNameChars } : null,
        });
        if (headings) snapshot.headings = await collectHeadings(page, config.headings, exposed.headings);
        if (lists) snapshot.lists = await collectLists(page, config, exposed.headings && exposed.lists);
        if (grouping) snapshot.grouping = await collectGrouping(page, config, exposed.headings && exposed.grouping, exposed.groupingUnmarked);
      }
      if (nrv) snapshot.nameRoleValue = await collectNameRoleValue(page, config, walk, walkStoppedBy, interactiveBefore);
      // Last: it changes the viewport, and puts it back before anything else reads the page.
      if (reflow) snapshot.reflow = await collectReflow(page, config, environment.viewport);
      // What each element that was named is, hashed here: the text it is made from stays in this function.
      const signatures: Record<string, string> = {};
      for (const [key, tag, role, material] of await page.agent<AgentSignature[]>('signatures()')) signatures[key] = elementSignature(tag, role, material);
      snapshot.signatures = signatures;
      // What copies of the page need to render like it, for probing. Read only.
      if (nrv && config.nameRoleValue.probe === 'safe' && options.probeHost) {
        source = await readCloneSource(page, { url: environment.url, viewport: environment.viewport, colorScheme: environment.colorScheme }, config);
      }
    }, {
      before: () => gate.release(options.inFlightTimeoutMs ?? IN_FLIGHT_TIMEOUT_MS),
      stepTimeoutMs: () => (signal?.aborted ? (options.restoreStepTimeoutMs ?? RESTORE_STEP_TIMEOUT_MS) : null),
      ...(options.onRestoreIncomplete ? { onIncomplete: options.onRestoreIncomplete } : {}),
    });
    // The captures were taken at this scale, whatever the page had before.
    snapshot.environment = { ...environment, devicePixelRatio: config.focus.deviceScaleFactor };
  }
  return { snapshot, ...(source ? { source } : {}) };
}
