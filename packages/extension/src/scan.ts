import { adjudicateFindings } from '@a11y-vision/adjudicators';
import type { Adjudicator, AdjudicationStats, VerdictCache } from '@a11y-vision/adjudicators';
import { collectSnapshot } from '@a11y-vision/collector-cdp';
import { buildResult } from '@a11y-vision/core';
import type { Config, Png, ScanResult, Snapshot } from '@a11y-vision/core';
import type { ChromeApi } from './chrome-api.js';
import type { ExtensionConfig } from './config.js';
import { createDebuggerSession, DebuggerAttachError, DebuggerDetachedError } from './debugger-session.js';
import type { DebuggerSession } from './debugger-session.js';
import { watchInterference } from './interference.js';
import type { InterferenceKind } from './interference.js';
import { viewportSettled } from './viewport.js';

/** Why a scan ended without a result. */
export type StopKind = InterferenceKind | 'user' | 'detached-by-user' | 'detached' | 'cannot-attach' | 'panel-closed';

/** A scan that was stopped. Nothing is reported for a page that was read in part. */
export class ScanStopped extends Error {
  override name = 'ScanStopped';
  constructor(
    readonly kind: StopKind,
    /** What Chrome said, for `cannot-attach`. */
    readonly detail = '',
    /**
     * True when the page did not answer in time while it was being put back, through a session
     * that was still there: it may not be as it was. (A session that is gone is another matter,
     * and `kind` says it.)
     */
    readonly restoreIncomplete = false,
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
  adjudicate?: typeof adjudicateFindings;
  now?: () => Date;
}

export interface ScanOutcome {
  result: ScanResult;
  /**
   * What was read: the tab, and the document in its main frame by the id Chrome gives its
   * loader. A finding is about an element of that document and of no other (see `showHighlight`).
   */
  document: { tabId: number; loaderId: string };
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

export { viewportSettled };

/**
 * One scan of one tab: attach, read the page, give it back, detach, evaluate, and ask the model
 * when one is configured.
 *
 * The debugger is attached for the reading only, and detached in every case: finished, failed
 * or stopped, also when the page stopped answering (putting it back then has a time limit, see
 * `interference.restoreStepTimeoutMs`, and the `ScanStopped` says that it may not be as it was). The model is asked afterwards, from this context (the side panel), from the
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

  /**
   * `work`, given up on when the scan is stopped. For what is asked of the page outside the
   * collector (which has a gate of its own): a page that stops answering in the middle of it
   * would otherwise hold the scan where no stop could reach it.
   */
  const unlessStopped = <T>(work: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const onStop = (): void => reject(asStopped(stop.signal.reason) ?? new ScanStopped('user'));
      if (stop.signal.aborted) onStop();
      else stop.signal.addEventListener('abort', onStop, { once: true });
      work.then(resolve, reject).finally(() => stop.signal.removeEventListener('abort', onStop));
    });

  let snapshot: Snapshot;
  let loaderId: string;
  let restoreIncomplete = false;
  try {
    options.onPhase?.('attaching');
    try {
      await session.attach();
    } catch (error) {
      if (error instanceof DebuggerAttachError) throw new ScanStopped('cannot-attach', error.message);
      throw error;
    }
    await unlessStopped(viewportSettled(session, extension.debugger));
    let watch: Awaited<ReturnType<typeof watchInterference>> | undefined;
    const watching = watchInterference(session, api.tabs, tabId, extension.interference, (kind) => stopWith(new ScanStopped(kind)));
    try {
      watch = await unlessStopped(watching);
      options.onPhase?.('reading');
      snapshot = await collect(session, config, {
        signal: stop.signal,
        inFlightTimeoutMs: extension.interference.inFlightTimeoutMs,
        restoreStepTimeoutMs: extension.interference.restoreStepTimeoutMs,
        onRestoreIncomplete() {
          restoreIncomplete = true;
        },
      });
      // The document the snapshot is of: asked while the session is there.
      ({ loaderId } = ((await unlessStopped(session.send('Page.getFrameTree'))) as { frameTree: { frame: { loaderId: string } } }).frameTree.frame);
    } finally {
      options.onPhase?.('restoring');
      if (watch) {
        if (!(await watch.stop())) restoreIncomplete = true;
      } else {
        // Stopped while the watch was being set up: it is taken off again if it ever gets that far.
        watching.then(
          (late) => void late.stop(),
          () => undefined,
        );
      }
    }
  } catch (error) {
    // What stopped the scan says more than the command that happened to fail because of it.
    const stopped = (stop.signal.aborted ? asStopped(stop.signal.reason) : null) ?? asStopped(error);
    if (!stopped) throw error;
    let { kind } = stopped;
    // A session that ended without Chrome saying why (a command was refused as "not attached"
    // before the event of the tab closing came): the tab is asked for, so that a closed tab is
    // always said to be that, whichever of the two was noticed first.
    if (kind === 'detached' && !(await api.tabs.get(tabId).then(
      () => true,
      () => false,
    ))) kind = 'tab-closed';
    throw new ScanStopped(kind, stopped.detail, restoreIncomplete);
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
  const outcome: ScanOutcome = { result, document: { tabId, loaderId }, crops: {} };

  if (options.adjudicator) {
    options.onPhase?.('judging');
    const stopped = new Promise<'stopped'>((resolve) => {
      if (signal.aborted) resolve('stopped');
      else signal.addEventListener('abort', () => resolve('stopped'), { once: true });
    });
    // The signal ends the asking itself: nothing more is sent, and what is under way is aborted.
    // The race is for an adjudicator that does not listen to it: the scan ends at once all the same.
    const judged = await Promise.race([
      (options.adjudicate ?? adjudicateFindings)({ snapshot, findings: result.findings, config, adjudicator: options.adjudicator, signal, ...(options.cache ? { cache: options.cache } : {}) }),
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
