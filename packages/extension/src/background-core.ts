import type { ChromeApi, DebuggerApi, Port } from './chrome-api.js';
import { viewportSettled } from './viewport.js';
import type { SettleConfig } from './viewport.js';

/** Name of the port a panel keeps open to the service worker while it lives. */
export const PANEL_PORT = 'panel';

/** What a panel tells the service worker: which tab it is about to attach the debugger to, and when it has let go of it. */
export type PanelMessage = { type: 'attaching'; tabId: number } | { type: 'released'; tabId: number };

function isPanelMessage(value: unknown): value is PanelMessage {
  if (value === null || typeof value !== 'object') return false;
  const message = value as { type?: unknown; tabId?: unknown };
  return (message.type === 'attaching' || message.type === 'released') && typeof message.tabId === 'number' && Number.isInteger(message.tabId);
}

/**
 * What the service worker has a page do before it detaches from it: each `expression` is
 * evaluated in the isolated world `worldName` of the main frame. The expressions are constants
 * of this extension (see `background.ts`), never anything a message carried.
 */
export interface PanelClosedRestore {
  steps: readonly { worldName: string; expression: string }[];
  /** The page is given this long, in milliseconds, for all of it. */
  timeoutMs: number;
  /** How still the viewport has to be before the debugger is detached (see `viewportSettled`). */
  settle: SettleConfig;
}

/** `work`, or false when it took longer than `ms` or failed. */
async function within(ms: number, work: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const done = await Promise.race([
    work.then(
      () => true,
      () => false,
    ),
    late,
  ]);
  clearTimeout(timer);
  return done;
}

/** Has the page of `tabId` undo what a scan did inside it. Rejects when the page cannot be asked. */
async function restorePage(api: DebuggerApi, tabId: number, steps: PanelClosedRestore['steps']): Promise<void> {
  const target = { tabId };
  const { frameTree } = (await api.sendCommand(target, 'Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
  for (const { worldName, expression } of steps) {
    // The session of the extension on this tab is the one the panel used: the same name is the same world.
    const { executionContextId } = (await api.sendCommand(target, 'Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName })) as { executionContextId: number };
    await api.sendCommand(target, 'Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true });
  }
}

/**
 * The whole of the service worker.
 *
 * It does three things. It makes the toolbar button open the side panel. It closes the storage
 * of the extension to anything but the extension's own pages. And it lets go of a tab when a
 * panel goes away while attached to it: a debugger session belongs to the extension, not to the
 * page that started it, so closing the side panel in the middle of a scan would otherwise leave
 * the tab attached, with Chrome's bar, until the tab is closed (verified in Chromium).
 *
 * Letting go is three steps. First the page is asked to undo what the scan did inside it (focus,
 * scroll positions, the style sheet that stops animations, the listeners of the watch): the
 * panel that would have done it is gone, and the code that does it is already in the page, in
 * the isolated worlds of the scan. That is best effort, and has a time limit: a page that does
 * not answer is not waited for. Then the viewport is waited for until it keeps still: what the
 * panel had asked of Chrome when it went away is still being done, and detaching in the middle
 * of a capture leaves the page with the viewport of that capture. Then the debugger is
 * detached, which ends the session and with it every override the scan had set on the tab.
 * All of it goes through the `debugger` permission the extension has; nothing else is needed.
 *
 * It never scans, never reads anything from a page, never talks to a model and holds no data.
 * While a debugger session is open Chrome keeps the worker alive (Chrome 118 and later), which
 * is the only time it has something to do.
 */
export function registerBackground(api: Pick<ChromeApi, 'debugger' | 'runtime' | 'sidePanel' | 'storage'>, restore: PanelClosedRestore): void {
  // Both calls can fail on a browser that lacks them; neither failure stops the extension working.
  api.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  // The default lets content scripts read `storage.local`. The extension has none; this closes the door anyway.
  api.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);

  const letGo = async (tabId: number): Promise<void> => {
    // False: the page cannot be asked (not attached, the tab is gone) or does not answer. There is then nothing to wait for.
    const answered = await within(restore.timeoutMs, restorePage(api.debugger, tabId, restore.steps));
    if (answered) {
      const cdp = { send: (method: string, params?: Record<string, unknown>) => api.debugger.sendCommand({ tabId }, method, params), on: () => undefined, off: () => undefined };
      // The limit of the wait itself, and one poll more for a page that stops answering during it.
      await within(restore.settle.viewportSettleTimeoutMs + restore.timeoutMs, viewportSettled(cdp, restore.settle));
    }
    await api.debugger.detach({ tabId }).catch(() => undefined);
  };

  api.runtime.onConnect.addListener((port: Port) => {
    if (port.name !== PANEL_PORT) return;
    const tabs = new Set<number>();
    port.onMessage.addListener((message) => {
      if (!isPanelMessage(message)) return;
      if (message.type === 'attaching') tabs.add(message.tabId);
      else tabs.delete(message.tabId);
    });
    port.onDisconnect.addListener(() => {
      for (const tabId of tabs) void letGo(tabId);
      tabs.clear();
    });
  });
}
