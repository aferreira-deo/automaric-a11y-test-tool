/**
 * The slice of a CDP client the collector needs.
 * Playwright's CDPSession and a thin wrapper over chrome.debugger both satisfy it.
 */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (params: unknown) => void): void;
  off(event: string, handler: (params: unknown) => void): void;
}

/**
 * A way to stop a collection from outside: an `AbortSignal`, or anything shaped like one. Kept
 * structural so that nothing here depends on where the signal comes from.
 */
export interface StopSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/** What a stopped collection throws when the signal carries no reason of its own. */
export class CollectionStoppedError extends Error {
  override name = 'CollectionStoppedError';
  constructor() {
    super('The collection was stopped.');
  }
}

/** The reason of a signal that fired, as an error: its own when it is one. */
export function stopReason(signal: StopSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new CollectionStoppedError();
}

/** A session behind a gate: see `gateSession`. */
export interface GatedSession {
  session: CdpSession;
  /**
   * From here on commands pass again, stopped or not: what is sent now puts the page back.
   *
   * After a stop, the commands that were under way are waited for first, `timeoutMs` at most.
   * Their callers were already told that the collection stopped, but Chrome is still working on
   * them, and putting the page back while it does went wrong in a browser test: once in some
   * tens of stopped scans the page was left with a viewport twice as wide, at a device pixel
   * ratio of 1. The likely cause, not proven: a capture changes the emulation of the page while
   * it is taken and puts back what it found when it is done, so an override cleared meanwhile
   * comes back. With this wait it was not seen again.
   * The wait has a limit because some answers never come (a capture of a hidden tab).
   */
  release(timeoutMs: number): Promise<void>;
}

/**
 * `cdp` as the collectors see it while a collection can be stopped. Once the signal has fired,
 * a command that is waiting for its answer rejects with the reason of the signal (an answer that
 * never comes, as that of a capture of a hidden tab, would otherwise hold the collection for
 * good), and every further command rejects without being sent: whatever part of the collector is
 * running unwinds. `release()` is called where the unwinding reaches the code that restores the
 * page, which has to get through.
 */
export function gateSession(cdp: CdpSession, signal: StopSignal | undefined): GatedSession {
  if (!signal) return { session: cdp, release: () => Promise.resolve() };
  let released = false;
  const underWay = new Set<Promise<unknown>>();
  return {
    async release(timeoutMs) {
      if (signal.aborted && underWay.size > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const limit = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        });
        await Promise.race([Promise.allSettled([...underWay]), limit]);
        clearTimeout(timer);
      }
      released = true;
    },
    session: {
      on: (event, handler) => cdp.on(event, handler),
      off: (event, handler) => cdp.off(event, handler),
      send(method, params) {
        if (released) return cdp.send(method, params);
        if (signal.aborted) return Promise.reject(stopReason(signal));
        const sent = cdp.send(method, params);
        underWay.add(sent);
        const done = (): void => void underWay.delete(sent);
        sent.then(done, done);
        return new Promise((resolve, reject) => {
          const onAbort = (): void => reject(stopReason(signal));
          signal.addEventListener('abort', onAbort, { once: true });
          sent.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
        });
      },
    },
  };
}
