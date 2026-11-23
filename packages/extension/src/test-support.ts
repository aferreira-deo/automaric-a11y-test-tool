import type { ChromeEvent, DebuggerApi, DebuggerSource, StorageArea, TabsApi } from './chrome-api.js';

/** Stand-ins for `chrome.*` and for a document, for the unit tests. Not part of the extension: the bundles do not import this file. */

export interface FakeEvent<Listener extends (...args: never[]) => void> extends ChromeEvent<Listener> {
  listeners: Listener[];
  fire(...args: Parameters<Listener>): void;
}

export function fakeEvent<Listener extends (...args: never[]) => void>(): FakeEvent<Listener> {
  const listeners: Listener[] = [];
  return {
    listeners,
    addListener: (listener) => void listeners.push(listener),
    removeListener(listener) {
      const at = listeners.indexOf(listener);
      if (at !== -1) listeners.splice(at, 1);
    },
    fire: (...args) => {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

export interface FakeDebugger extends DebuggerApi {
  onEvent: FakeEvent<(source: DebuggerSource, method: string, params?: unknown) => void>;
  onDetach: FakeEvent<(source: DebuggerSource, reason: string) => void>;
  calls: { name: 'attach' | 'detach' | 'sendCommand'; tabId: number; method?: string; params?: Record<string, unknown> }[];
  /** Answers a command. Throw to reject as `chrome.debugger` does. */
  respond: (method: string, params: Record<string, unknown> | undefined) => unknown;
  failAttach: string | null;
}

export function fakeDebugger(): FakeDebugger {
  const api: FakeDebugger = {
    onEvent: fakeEvent(),
    onDetach: fakeEvent(),
    calls: [],
    respond: () => ({}),
    failAttach: null,
    attach(target) {
      api.calls.push({ name: 'attach', tabId: target.tabId });
      return api.failAttach === null ? Promise.resolve() : Promise.reject(new Error(api.failAttach));
    },
    detach(target) {
      api.calls.push({ name: 'detach', tabId: target.tabId });
      return Promise.resolve();
    },
    sendCommand(target, method, params) {
      api.calls.push({ name: 'sendCommand', tabId: target.tabId, method, ...(params ? { params } : {}) });
      try {
        return Promise.resolve(api.respond(method, params));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  return api;
}

export interface FakeStorage extends StorageArea {
  items: Record<string, unknown>;
  writes: number;
}

/** `chrome.storage.local` in memory. Values are copied in and out as JSON, as the real one does. */
export function fakeStorage(initial: Record<string, unknown> = {}): FakeStorage {
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const area: FakeStorage = {
    items: copy(initial),
    writes: 0,
    get(keys) {
      const names = keys === undefined || keys === null ? Object.keys(area.items) : typeof keys === 'string' ? [keys] : keys;
      const out: Record<string, unknown> = {};
      for (const name of names) if (Object.hasOwn(area.items, name)) out[name] = copy(area.items[name]);
      return Promise.resolve(out);
    },
    set(items) {
      area.writes += 1;
      Object.assign(area.items, copy(items));
      return Promise.resolve();
    },
    remove(keys) {
      for (const name of typeof keys === 'string' ? [keys] : keys) delete area.items[name];
      return Promise.resolve();
    },
  };
  return area;
}

export interface FakeTabs extends TabsApi {
  onActivated: FakeEvent<(info: { tabId: number; windowId: number }) => void>;
  onRemoved: FakeEvent<(tabId: number) => void>;
}

export function fakeTabs(windowId = 1): FakeTabs {
  return {
    onActivated: fakeEvent(),
    onRemoved: fakeEvent(),
    query: () => Promise.resolve([]),
    get: (tabId) => Promise.resolve({ id: tabId, windowId }),
  };
}

/**
 * A document that keeps what is done to it, and does nothing else: no parser, so nothing given
 * to it can become markup, and an attempt to use one fails the test.
 */
export class FakeElement {
  readonly children: (FakeElement | FakeText)[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, (() => void)[]>();
  className = '';
  id = '';
  value = '';
  src = '';
  checked = false;
  hidden = false;
  #text = '';

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.#text + this.children.map((child) => child.textContent).join('');
  }
  set textContent(text: string) {
    this.children.length = 0;
    this.#text = text;
  }
  get childNodes(): (FakeElement | FakeText)[] {
    return this.children;
  }
  get innerHTML(): string {
    throw new Error('innerHTML was read');
  }
  set innerHTML(_markup: string) {
    throw new Error('innerHTML was set');
  }
  set outerHTML(_markup: string) {
    throw new Error('outerHTML was set');
  }
  insertAdjacentHTML(): void {
    throw new Error('insertAdjacentHTML was called');
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  append(...nodes: (FakeElement | FakeText)[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: (FakeElement | FakeText)[]): void {
    this.#text = '';
    this.children.length = 0;
    this.children.push(...nodes);
  }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  /** Every element under this one, itself included, in document order. */
  all(): FakeElement[] {
    return [this, ...this.children.flatMap((child) => (child instanceof FakeElement ? child.all() : []))];
  }
  /** Class selectors only (`.name`), which is all the renderer asks for. */
  querySelector(selector: string): FakeElement | null {
    const name = selector.replace(/^\./, '');
    return this.all().find((element) => element !== this && element.className.split(' ').includes(name)) ?? null;
  }
}

export class FakeText {
  constructor(readonly textContent: string) {}
}

export function fakeDocument(): Document & { created: FakeElement[] } {
  const created: FakeElement[] = [];
  const doc = {
    created,
    createElement(tag: string) {
      const element = new FakeElement(tag);
      created.push(element);
      return element;
    },
    createTextNode: (text: string) => new FakeText(text),
  };
  return doc as unknown as Document & { created: FakeElement[] };
}
