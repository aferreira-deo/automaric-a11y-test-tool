import { adjudicateFindings } from '@a11y-vision/adjudicators';
import type { Adjudicator, AdjudicationStats, VerdictCache } from '@a11y-vision/adjudicators';
import { collectSnapshot } from '@a11y-vision/collector-cdp';
import type { CdpSession } from '@a11y-vision/collector-cdp';
import { buildResult } from '@a11y-vision/core';
import type { Config, Png, ScanResult, Snapshot } from '@a11y-vision/core';
import type { ChromeApi } from './chrome-api.js';
import type { ExtensionConfig } from './config.js';
import { createDebuggerSession, DebuggerAttachError, DebuggerDetachedError } from './debugger-session.js';
import type { DebuggerSession } from './debugger-session.js';
import { watchInterference } from './interference.js';
import type { InterferenceKind } from './interference.js';

/** Why a scan ended without a result. */
export type StopKind = InterferenceKind | 'user' | 'detached-by-user' | 'detached' | 'cannot-attach' | 'panel-closed';

/** A scan that was stopped. Nothing is reported for a page that was read in part. */
export class ScanStopped extends Error {
  override name = 'ScanStopped';
  constructor(
    readonly kind: StopKind,
    /** What Chrome said, for `cannot-attach`. */
    readonly detail = '',
  ) {
    super(`The scan was stopped (${kind}).`);
  }
}

export type ScanPhase = 'attaching' | 'reading' | 'restoring' | 'evaluating' | 'judging';

/** What the collector has done so far, counted from the commands it sent. */
export interface ScanCounts {
  tabPresses: number;
  captures: number;
}

export interface ScanOptions {
  api: Pick<ChromeApi, 'debugger' | 'tabs'>;
  tabId: number;
  config: Config;
  extension: ExtensionConfig;
  /** Null: no model is asked. */
  adjudicator?: Adjudicator | null;
  cache?: VerdictCache;
  /** Fired by the Stop button, or when the panel goes away. Its reason is a `ScanStopped`. */
  signal: AbortSignal;
  onPhase?: (phase: ScanPhase) => void;
  onCounts?: (counts: ScanCounts) => void;
  /** Stand-ins for tests. */
  collect?: typeof collectSnapshot;
  now?: () => Date;
}

export interface ScanOutcome {
  result: ScanResult;
  /** The captures the findings refer to, by the ids in `evidence.crops`. */
  crops: Record<string, Png>;
  adjudication?: AdjudicationStats;
  /** True when a model was being asked and the user stopped that: the findings are those of deterministic code. */
  judgingStopped?: boolean;
}

function asStopped(reason: unknown): ScanStopped | null {
  if (reason instanceof ScanStopped) return reason;
  if (reason instanceof DebuggerDetachedError) return new ScanStopped(reason.reason === 'canceled_by_user' ? 'detached-by-user' : reason.reason === 'target_closed' ? 'tab-closed' : 'detached');
  return null;
}

const SETTLE_WORLD = 'a11y-vision-settle';

/**
 * Waits until the viewport of the page has kept its size for `viewportSettleMs`: Chrome's
 * debugging bar comes up shortly after attaching and makes the page shorter, and a scan that
 * read the size before it and one that read it after would not be scans of the same viewport.
 * Asked in an isolated world: a page cannot answer for the browser.
 */
export async function viewportSettled(cdp: CdpSession, config: ExtensionConfig['debugger'], sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<void> {
  const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
  const { executionContextId } = (await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: SETTLE_WORLD })) as { executionContextId: number };
  const size = async (): Promise<unknown> =>
    ((await cdp.send('Runtime.evaluate', { expression: "window.innerWidth + 'x' + window.innerHeight", contextId: executionContextId, returnByValue: true })) as { result?: { value?: unknown } }).result?.value;
  let last = await size();
  let stableFor = 0;
  for (let waited = 0; stableFor < config.viewportSettleMs && waited < config.viewportSettleTimeoutMs; waited += config.viewportPollMs) {
    await sleep(config.viewportPollMs);
    const now = await size();
    stableFor = now === last ? stableFor + config.viewportPollMs : 0;
    last = now;
  }
}

/**
 * One scan of one tab: attach, read the page, give it back, detach, evaluate, and ask the model
 * when one is configured.
 *
 * The debugger is attached for the reading only, and detached in every case: finished, failed
 * or stopped. The model is asked afterwards, from this context (the side panel), from the
 * snapshot alone; the page is not involved and no request is made from it.
 */
export async function runScan(options: ScanOptions): Promise<ScanOutcome> {
  const { api, tabId, config, extension, signal } = options;
  const collect = options.collect ?? collectSnapshot;
  const counts: ScanCounts = { tabPresses: 0, captures: 0 };
  // The collector stops on this signal: the user's, or what the watch or the session reports.
  const stop = new AbortController();
  const stopWith = (reason: ScanStopped): void => {
    if (!stop.signal.aborted) stop.abort(reason);
  };
  const onUserStop = (): void => stopWith(asStopped(signal.reason) ?? new ScanStopped('user'));
  if (signal.aborted) throw asStopped(signal.reason) ?? new ScanStopped('user');
  signal.addEventListener('abort', onUserStop, { once: true });

  const session: DebuggerSession = createDebuggerSession(api.debugger, tabId, {
    protocolVersion: extension.debugger.protocolVersion,
    onCommand(method, params) {
      if (method === 'Input.dispatchKeyEvent' && params?.['type'] === 'keyDown') counts.tabPresses += 1;
      else if (method === 'Page.captureScreenshot') counts.captures += 1;
      else return;
      options.onCounts?.({ ...counts });
    },
  });
  session.onDetached((reason) => stopWith(new ScanStopped(reason === 'canceled_by_user' ? 'detached-by-user' : reason === 'target_closed' ? 'tab-closed' : 'detached')));

  let snapshot: Snapshot;
  try {
    options.onPhase?.('attaching');
    try {
      await session.attach();
    } catch (error) {
      if (error instanceof DebuggerAttachError) throw new ScanStopped('cannot-attach', error.message);
      throw error;
    }
    await viewportSettled(session, extension.debugger);
    let watch: Awaited<ReturnType<typeof watchInterference>> | undefined;
    try {
      watch = await watchInterference(session, api.tabs, tabId, extension.interference, (kind) => stopWith(new ScanStopped(kind)));
      options.onPhase?.('reading');
      snapshot = await collect(session, config, { signal: stop.signal, inFlightTimeoutMs: extension.interference.inFlightTimeoutMs });
    } finally {
      options.onPhase?.('restoring');
      await watch?.stop();
    }
  } catch (error) {
    // What stopped the scan says more than the command that happened to fail because of it.
    throw (stop.signal.aborted ? asStopped(stop.signal.reason) : null) ?? asStopped(error) ?? error;
  } finally {
    signal.removeEventListener('abort', onUserStop);
    await session.detach();
  }
  // Stopped at the very end, after the last command: still not a scan that ran undisturbed.
  if (stop.signal.aborted) throw asStopped(stop.signal.reason) ?? new ScanStopped('user');
  // The collector reads the document a page went on to, once. The watch may not have asked in
  // the time that took: what the collector says about it is certain.
  if (extension.interference.stopOnNavigation && snapshot.environment.navigatedFrom !== undefined) throw new ScanStopped('navigation');

  options.onPhase?.('evaluating');
  const result = buildResult(snapshot, config, (options.now ?? (() => new Date()))());
  const outcome: ScanOutcome = { result, crops: {} };

  if (options.adjudicator) {
    options.onPhase?.('judging');
    const stopped = new Promise<'stopped'>((resolve) => {
      if (signal.aborted) resolve('stopped');
      else signal.addEventListener('abort', () => resolve('stopped'), { once: true });
    });
    const judged = await Promise.race([
      adjudicateFindings({ snapshot, findings: result.findings, config, adjudicator: options.adjudicator, ...(options.cache ? { cache: options.cache } : {}) }),
      stopped,
    ]);
    if (judged === 'stopped') outcome.judgingStopped = true;
    else {
      result.findings = judged.findings;
      outcome.adjudication = judged.stats;
    }
  }

  for (const id of result.findings.flatMap((finding) => finding.evidence.crops)) {
    const clip = snapshot.screenshots.clips[id];
    if (clip) outcome.crops[id] = clip.png;
  }
  return outcome;
}
