/**
 * The part of the `chrome.*` API the extension uses, typed by hand: no type package is needed,
 * and every module takes this as a parameter, so tests pass a stand-in. Signatures follow the
 * reference at https://developer.chrome.com/docs/extensions/reference/api (promise forms).
 */
export interface ChromeEvent<Listener> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

export interface Debuggee {
  tabId: number;
}

/** `DebuggerSession` of the reference: a child session of a flat session carries a `sessionId`. */
export interface DebuggerSource {
  tabId?: number;
  sessionId?: string;
}

export interface DebuggerApi {
  attach(target: Debuggee, requiredVersion: string): Promise<void>;
  detach(target: Debuggee): Promise<void>;
  sendCommand(target: Debuggee, method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent: ChromeEvent<(source: DebuggerSource, method: string, params?: unknown) => void>;
  /** `reason` is `target_closed` or `canceled_by_user`. */
  onDetach: ChromeEvent<(source: DebuggerSource, reason: string) => void>;
}

export interface StorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  setAccessLevel?(options: { accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }): Promise<void>;
}

export interface Tab {
  id?: number;
  windowId?: number;
  active?: boolean;
  /** Present only with a permission for the tab (`activeTab` after the user invoked the extension on it). */
  url?: string;
  title?: string;
}

export interface TabsApi {
  query(query: { active?: boolean; lastFocusedWindow?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
  /** Rejects when there is no such tab. */
  get(tabId: number): Promise<Tab>;
  onActivated: ChromeEvent<(info: { tabId: number; windowId: number }) => void>;
  /** Fired for every tab, with or without a permission for it; the address and the title are in `change` only with one. */
  onUpdated: ChromeEvent<(tabId: number, change: { status?: string; url?: string; title?: string }) => void>;
  onRemoved: ChromeEvent<(tabId: number) => void>;
}

export interface PermissionsApi {
  contains(permissions: { origins: string[] }): Promise<boolean>;
  request(permissions: { origins: string[] }): Promise<boolean>;
  remove(permissions: { origins: string[] }): Promise<boolean>;
}

export interface Port {
  name: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: ChromeEvent<(message: unknown) => void>;
  onDisconnect: ChromeEvent<() => void>;
}

export interface RuntimeApi {
  connect(info: { name: string }): Port;
  onConnect: ChromeEvent<(port: Port) => void>;
  getManifest(): { version: string; name: string };
}

export interface SidePanelApi {
  setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
}

export interface ChromeApi {
  debugger: DebuggerApi;
  /** `session` is kept in memory until the browser closes, and is open to the extension's own contexts only. */
  storage: { local: StorageArea; session?: StorageArea };
  tabs: TabsApi;
  permissions: PermissionsApi;
  runtime: RuntimeApi;
  sidePanel?: SidePanelApi;
}
