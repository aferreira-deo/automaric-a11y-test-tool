import type { ChromeApi, Port } from './chrome-api.js';

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
 * The whole of the service worker.
 *
 * It does three things. It makes the toolbar button open the side panel. It closes the storage
 * of the extension to anything but the extension's own pages. And it detaches the debugger when
 * a panel goes away while attached: a debugger session belongs to the extension, not to the
 * page that started it, so closing the side panel in the middle of a scan would otherwise leave
 * the tab attached, with Chrome's bar, until the tab is closed (verified in Chromium).
 *
 * It never scans, never reads a page, never talks to a model and holds no data. While a
 * debugger session is open Chrome keeps the worker alive (Chrome 118 and later), which is the
 * only time it has something to do.
 */
export function registerBackground(api: Pick<ChromeApi, 'debugger' | 'runtime' | 'sidePanel' | 'storage'>): void {
  // Both calls can fail on a browser that lacks them; neither failure stops the extension working.
  api.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  // The default lets content scripts read `storage.local`. The extension has none; this closes the door anyway.
  api.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);

  api.runtime.onConnect.addListener((port: Port) => {
    if (port.name !== PANEL_PORT) return;
    const tabs = new Set<number>();
    port.onMessage.addListener((message) => {
      if (!isPanelMessage(message)) return;
      if (message.type === 'attaching') tabs.add(message.tabId);
      else tabs.delete(message.tabId);
    });
    port.onDisconnect.addListener(() => {
      // Detaching ends the session, and with it every override the scan had set on the tab.
      for (const tabId of tabs) api.debugger.detach({ tabId }).catch(() => undefined);
      tabs.clear();
    });
  });
}
