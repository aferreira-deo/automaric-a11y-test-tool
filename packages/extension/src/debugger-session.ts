import type { CdpSession } from '@a11y-vision/collector-cdp';
import type { DebuggerApi, DebuggerSource } from './chrome-api.js';

/** Why the debugger is no longer attached to the tab. */
export type DetachReason = 'canceled_by_user' | 'target_closed' | 'not_attached';

/** The session is gone: nothing more can be asked of the tab, and nothing can be put back through it. */
export class DebuggerDetachedError extends Error {
  override name = 'DebuggerDetachedError';
  constructor(readonly reason: DetachReason) {
    super(`The debugger is no longer attached to the tab (${reason}).`);
  }
}

/** The debugger could not be attached. `message` is what Chrome said. */
export class DebuggerAttachError extends Error {
  override name = 'DebuggerAttachError';
}

/** A CDP command that Chrome answered with an error. `message` is the message of the protocol error. */
export class CdpCommandError extends Error {
  override name = 'CdpCommandError';
  constructor(
    message: string,
    readonly method: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

export interface DebuggerSession extends CdpSession {
  readonly tabId: number;
  readonly attached: boolean;
  /** Attaches to the tab. Rejects with `DebuggerAttachError` when Chrome refuses. */
  attach(): Promise<void>;
  /** Detaches and stops listening. Safe to call twice, and when the session is already gone. */
  detach(): Promise<void>;
  /** Called once when the session ends without `detach()`: the user closed the bar, or the tab went away. */
  onDetached(listener: (reason: DetachReason) => void): void;
}

export interface DebuggerSessionOptions {
  protocolVersion: string;
  /** Called for every command as it is sent: what the progress display counts. */
  onCommand?: (method: string, params: Record<string, unknown> | undefined) => void;
}

/**
 * `chrome.debugger` rejects with an `Error` whose message is the protocol error as JSON
 * (`{"code":-32000,"message":"..."}`), or a plain sentence for errors of the extension API itself.
 */
function parseError(error: unknown): { message: string; code: number | null } {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; code?: unknown };
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.message === 'string') {
      return { message: parsed.message, code: typeof parsed.code === 'number' ? parsed.code : null };
    }
  } catch {
    // Not JSON: the sentence is the message.
  }
  return { message: raw === '' ? 'Unknown error' : raw, code: null };
}

/** What Chrome says when a command is sent to a tab the extension is not attached to. */
const NOT_ATTACHED = /not attached|detached while handling|no tab with given id|cannot find a tab/i;

/**
 * The `CdpSession` of the collector over `chrome.debugger`, for one tab.
 *
 * Only the tab's own session is used: no child sessions, so events that carry a `sessionId`
 * (they would come from `Target.setAutoAttach` with `flatten`, which nothing here sends) are not
 * passed on. That is the scope the collector has with Playwright's CDPSession too: frames in
 * another process are not entered.
 */
export function createDebuggerSession(api: DebuggerApi, tabId: number, options: DebuggerSessionOptions): DebuggerSession {
  const target = { tabId };
  const handlers = new Map<string, Set<(params: unknown) => void>>();
  const detachedListeners: ((reason: DetachReason) => void)[] = [];
  let attached = false;
  let gone: DetachReason | null = null;
  /** Rejects the commands that are waiting when the session ends: their answers will not come. */
  let failPending: ((error: DebuggerDetachedError) => void)[] = [];

  const end = (reason: DetachReason): void => {
    if (gone) return;
    gone = reason;
    attached = false;
    api.onEvent.removeListener(onEvent);
    api.onDetach.removeListener(onDetach);
    const error = new DebuggerDetachedError(reason);
    for (const fail of failPending) fail(error);
    failPending = [];
    for (const listener of detachedListeners) listener(reason);
  };

  function onEvent(source: DebuggerSource, method: string, params?: unknown): void {
    if (source.tabId !== tabId || source.sessionId !== undefined) return;
    for (const handler of [...(handlers.get(method) ?? [])]) handler(params);
  }

  function onDetach(source: DebuggerSource, reason: string): void {
    if (source.tabId !== tabId) return;
    end(reason === 'canceled_by_user' ? 'canceled_by_user' : 'target_closed');
  }

  return {
    tabId,
    get attached() {
      return attached;
    },
    async attach() {
      if (attached) return;
      try {
        await api.attach(target, options.protocolVersion);
      } catch (error) {
        throw new DebuggerAttachError(parseError(error).message);
      }
      gone = null;
      attached = true;
      api.onEvent.addListener(onEvent);
      api.onDetach.addListener(onDetach);
    },
    async detach() {
      if (!attached) return;
      attached = false;
      gone = 'not_attached';
      api.onEvent.removeListener(onEvent);
      api.onDetach.removeListener(onDetach);
      const error = new DebuggerDetachedError('not_attached');
      for (const fail of failPending) fail(error);
      failPending = [];
      // Already detached by the user or with the tab: there is nothing left to detach.
      await api.detach(target).catch(() => undefined);
    },
    onDetached(listener) {
      detachedListeners.push(listener);
    },
    send(method, params) {
      if (gone) return Promise.reject(new DebuggerDetachedError(gone));
      if (!attached) return Promise.reject(new DebuggerDetachedError('not_attached'));
      options.onCommand?.(method, params);
      return new Promise((resolve, reject) => {
        const fail = (error: DebuggerDetachedError): void => reject(error);
        failPending.push(fail);
        const settle = (): void => {
          failPending = failPending.filter((entry) => entry !== fail);
        };
        api.sendCommand(target, method, params).then(
          (value) => {
            settle();
            // A command without a result resolves with undefined; the collector reads `{}`.
            resolve(value ?? {});
          },
          (error: unknown) => {
            settle();
            const { message, code } = parseError(error);
            // Detached by something that raises no event here (this extension detaching from
            // another page of its own): the session is over all the same.
            if (code === null && NOT_ATTACHED.test(message)) {
              end('not_attached');
              reject(new DebuggerDetachedError('not_attached'));
              return;
            }
            reject(new CdpCommandError(message, method, code));
          },
        );
      });
    },
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) handlers.set(event, (set = new Set()));
      set.add(handler);
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
    },
  };
}
