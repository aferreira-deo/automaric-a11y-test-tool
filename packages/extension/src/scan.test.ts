import type { Adjudicator } from '@a11y-vision/adjudicators';
import type { collectSnapshot } from '@a11y-vision/collector-cdp';
import { resolveConfig } from '@a11y-vision/core';
import type { Snapshot } from '@a11y-vision/core';
import { describe, expect, it } from 'vitest';
import { PANEL_PORT, registerBackground } from './background-core.js';
import type { Port } from './chrome-api.js';
import { extensionConfig } from './config.js';
import { watchInterference } from './interference.js';
import type { InterferenceKind } from './interference.js';
import { runScan, ScanStopped, viewportSettled } from './scan.js';
import type { ScanPhase } from './scan.js';
import { fakeDebugger, fakeEvent, fakeStorage, fakeTabs } from './test-support.js';

const config = resolveConfig({ checks: ['noop'] });
const snapshot = (): Snapshot => ({
  environment: { url: 'https://example.test/', devicePixelRatio: 2, viewport: { width: 800, height: 600 }, colorScheme: 'light' },
  nodes: [],
  axTree: [],
  screenshots: { tiles: [], clips: {} },
});
type Collect = typeof collectSnapshot;

/** A debugger that answers what the watch asks, and says the page was not touched. */
function quietDebugger(hit: () => string = () => '') {
  const api = fakeDebugger();
  api.respond = (method, params) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F', loaderId: 'L1' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 3 };
    if (method === 'Runtime.evaluate') return { result: { value: String(params?.['expression']).includes('.stop()') ? undefined : hit() } };
    return {};
  };
  return api;
}

const base = (api: ReturnType<typeof fakeDebugger>, collect: Collect, signal = new AbortController().signal) => ({
  api: { debugger: api, tabs: fakeTabs() },
  tabId: 5,
  config,
  extension: { ...extensionConfig, debugger: { ...extensionConfig.debugger, viewportSettleMs: 2, viewportPollMs: 1 }, interference: { ...extensionConfig.interference, pollMs: 1 } },
  signal,
  collect,
  now: () => new Date('2026-01-02T03:04:05.000Z'),
});

describe('runScan', () => {
  it('attaches, reads, detaches, then evaluates: the debugger is gone before anything else is done', async () => {
    const api = quietDebugger();
    const phases: ScanPhase[] = [];
    let attachedWhileReading = false;
    const collect: Collect = () => {
      attachedWhileReading = api.calls.some((call) => call.name === 'attach') && !api.calls.some((call) => call.name === 'detach');
      return Promise.resolve(snapshot());
    };
    const outcome = await runScan({ ...base(api, collect), onPhase: (phase) => phases.push(phase) });
    expect(attachedWhileReading).toBe(true);
    expect(phases).toEqual(['attaching', 'reading', 'restoring', 'evaluating']);
    expect(api.calls.at(-1)).toEqual({ name: 'detach', tabId: 5 });
    expect(outcome.result.url).toBe('https://example.test/');
    expect(outcome.result.timestamp).toBe('2026-01-02T03:04:05.000Z');
    expect(outcome.adjudication).toBeUndefined();
    // Nothing is left listening.
    expect(api.onDetach.listeners).toEqual([]);
    expect(api.onEvent.listeners).toEqual([]);
  });

  it('counts what the collector does, for the progress display', async () => {
    const api = quietDebugger();
    const seen: unknown[] = [];
    const collect: Collect = async (cdp) => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp' });
      await cdp.send('Page.captureScreenshot', {});
      return snapshot();
    };
    await runScan({ ...base(api, collect), onCounts: (counts) => seen.push(counts) });
    expect(seen).toEqual([
      { tabPresses: 1, captures: 0 },
      { tabPresses: 1, captures: 1 },
    ]);
  });

  it('cannot attach: says so with what Chrome said, and touches nothing', async () => {
    const api = quietDebugger();
    api.failAttach = 'Cannot access a chrome:// URL';
    let collected = false;
    const error = await runScan(
      base(api, () => {
        collected = true;
        return Promise.resolve(snapshot());
      }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScanStopped);
    expect(error).toMatchObject({ kind: 'cannot-attach', detail: 'Cannot access a chrome:// URL' });
    expect(collected).toBe(false);
  });

  /** A collector that reads for ever, and stops as the real one does: at once when told to, also when it was told before it began. */
  const waitingCollect: Collect = (_cdp, _config, options) =>
    new Promise((_resolve, reject) => {
      const signal = options!.signal!;
      const stop = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error('stopped'));
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    });

  it('the Stop button: the collector is told to stop, the debugger is detached, nothing is reported', async () => {
    const api = quietDebugger();
    const user = new AbortController();
    const running = runScan(base(api, waitingCollect, user.signal));
    setTimeout(() => user.abort(new ScanStopped('user')), 5);
    await expect(running).rejects.toMatchObject({ name: 'ScanStopped', kind: 'user' });
    expect(api.calls.at(-1)).toEqual({ name: 'detach', tabId: 5 });
  });

  it('a signal that had already fired starts nothing', async () => {
    const api = quietDebugger();
    const user = new AbortController();
    user.abort(new ScanStopped('panel-closed'));
    await expect(runScan(base(api, waitingCollect, user.signal))).rejects.toMatchObject({ kind: 'panel-closed' });
    expect(api.calls).toEqual([]);
  });

  for (const [hit, kind] of [
    ['input', 'input'],
    ['hidden', 'hidden'],
    ['pointer-over-page', 'pointer-over-page'],
  ] as const) {
    it(`the page says "${hit}": the scan stops as ${kind}`, async () => {
      const api = quietDebugger(() => hit);
      await expect(runScan(base(api, waitingCollect))).rejects.toMatchObject({ name: 'ScanStopped', kind });
      expect(api.calls.at(-1)).toEqual({ name: 'detach', tabId: 5 });
    });
  }

  it('the bar of Chrome: cancelled by the user, and said as that rather than as the command that failed', async () => {
    const api = quietDebugger();
    const collect: Collect = async (cdp) => {
      setTimeout(() => api.onDetach.fire({ tabId: 5 }, 'canceled_by_user'), 2);
      // A command that will never be answered: the session ends under it.
      api.sendCommand = () => new Promise(() => undefined);
      await cdp.send('Page.captureScreenshot');
      return snapshot();
    };
    await expect(runScan(base(api, collect))).rejects.toMatchObject({ name: 'ScanStopped', kind: 'detached-by-user' });
    // Chrome has already detached: there is nothing to detach again.
    expect(api.calls.some((call) => call.name === 'detach')).toBe(false);
  });

  it('the tab closing ends the scan as that', async () => {
    const api = quietDebugger();
    const tabs = fakeTabs();
    const running = runScan({ ...base(api, waitingCollect), api: { debugger: api, tabs } });
    // Once the watch is listening. (Chrome also ends the debugger session of a tab that closes, which stops a scan at any moment.)
    const fire = (): void => void (tabs.onRemoved.listeners.length > 0 ? tabs.onRemoved.fire(5) : setTimeout(fire, 1));
    fire();
    await expect(running).rejects.toMatchObject({ kind: 'tab-closed' });
  });

  it('a page that went to another document is not reported, even when the collector read the new one', async () => {
    const api = quietDebugger();
    const moved = snapshot();
    moved.environment.navigatedFrom = 'https://example.test/old';
    await expect(runScan(base(api, () => Promise.resolve(moved)))).rejects.toMatchObject({ kind: 'navigation' });
    // With that switched off, the result of the collector stands.
    const lenient = base(api, () => Promise.resolve(moved));
    lenient.extension = { ...lenient.extension, interference: { ...lenient.extension.interference, stopOnNavigation: false } };
    expect((await runScan(lenient)).result.environment.navigatedFrom).toBe('https://example.test/old');
  });

  it('any other failure of the collector comes out as it is, after the debugger is detached', async () => {
    const api = quietDebugger();
    const failure = new Error('A capture fits no scale.');
    await expect(runScan(base(api, () => Promise.reject(failure)))).rejects.toBe(failure);
    expect(api.calls.at(-1)).toEqual({ name: 'detach', tabId: 5 });
  });

  it('asks the model only after the debugger is detached, and a stop then keeps the findings of deterministic code', async () => {
    const api = quietDebugger();
    const adjudicator: Adjudicator = { provider: 'p', model: 'm', promptVersion: '1', cacheIdentity: 'x', judge: () => new Promise(() => undefined) };
    const user = new AbortController();
    const phases: ScanPhase[] = [];
    const running = runScan({
      ...base(api, () => Promise.resolve(snapshot()), user.signal),
      adjudicator,
      onPhase(phase) {
        phases.push(phase);
        if (phase === 'judging') {
          expect(api.calls.at(-1)).toEqual({ name: 'detach', tabId: 5 });
          setTimeout(() => user.abort(new ScanStopped('user')), 2);
        }
      },
    });
    const outcome = await running;
    // No candidate on this page: the adjudicator layer returns at once, with nothing judged.
    expect(phases.at(-1)).toBe('judging');
    expect(outcome.result.findings.every((finding) => finding.status !== 'fail' || finding.ai === undefined)).toBe(true);
  });
});

describe('watchInterference', () => {
  const settings = { ...extensionConfig.interference, pollMs: 1 };
  const until = async (done: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  };

  it('watches from an isolated world of its own and takes its listeners off again', async () => {
    const api = quietDebugger();
    const sent: { method: string; params?: Record<string, unknown> }[] = [];
    const cdp = { send: (method: string, params?: Record<string, unknown>) => (sent.push({ method, ...(params ? { params } : {}) }), api.sendCommand({ tabId: 5 }, method, params)), on: () => undefined, off: () => undefined };
    const tabs = fakeTabs();
    const seen: InterferenceKind[] = [];
    const watch = await watchInterference(cdp, tabs, 5, settings, (kind) => seen.push(kind));
    expect(sent.find((call) => call.method === 'Page.createIsolatedWorld')?.params).toEqual({ frameId: 'F', worldName: 'a11y-vision-watch' });
    expect(tabs.onActivated.listeners).toHaveLength(1);
    await watch.stop();
    expect(String(sent.at(-1)?.params?.['expression'])).toContain('.stop()');
    expect(sent.at(-1)?.params?.['contextId']).toBe(3);
    expect(tabs.onActivated.listeners).toEqual([]);
    expect(tabs.onRemoved.listeners).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('reports once: another tab of the same window coming to the front hides this one', async () => {
    const api = quietDebugger();
    const cdp = { send: (method: string, params?: Record<string, unknown>) => api.sendCommand({ tabId: 5 }, method, params), on: () => undefined, off: () => undefined };
    const tabs = fakeTabs(1);
    const seen: InterferenceKind[] = [];
    const watch = await watchInterference(cdp, tabs, 5, settings, (kind) => seen.push(kind));
    tabs.onActivated.fire({ tabId: 9, windowId: 2 });
    tabs.onActivated.fire({ tabId: 5, windowId: 1 });
    expect(seen).toEqual([]);
    tabs.onActivated.fire({ tabId: 9, windowId: 1 });
    tabs.onRemoved.fire(5);
    expect(seen).toEqual(['hidden']);
    await watch.stop();
  });

  it('tells a page that went to another document from one that only lost the world', async () => {
    const api = quietDebugger();
    let loader = 'L1';
    let lost = true;
    let worlds = 0;
    api.respond = (method, params) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F', loaderId: loader } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: ++worlds };
      if (method === 'Runtime.evaluate' && !String(params?.['expression']).includes('__a11yVisionWatch;') && String(params?.['expression']).startsWith('(() => { const w')) {
        if (lost && params?.['contextId'] === 1) throw new Error('{"code":-32000,"message":"Cannot find context with specified id"}');
        return { result: { value: '' } };
      }
      return { result: {} };
    };
    const cdp = { send: (method: string, params?: Record<string, unknown>) => api.sendCommand({ tabId: 5 }, method, params), on: () => undefined, off: () => undefined };
    const seen: InterferenceKind[] = [];
    const watch = await watchInterference(cdp, fakeTabs(), 5, settings, (kind) => seen.push(kind));
    // Same document: the watch is set up again, in a new world, and nothing is reported.
    await until(() => worlds >= 2);
    expect(seen).toEqual([]);
    lost = false;
    // Another document.
    loader = 'L2';
    api.respond = (method) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F', loaderId: loader } } };
      throw new Error('{"code":-32000,"message":"Cannot find context with specified id"}');
    };
    await until(() => seen.length > 0);
    expect(seen).toEqual(['navigation']);
    await watch.stop();
  });
});

describe('the service worker', () => {
  function setup() {
    const debug = fakeDebugger();
    const onConnect = fakeEvent<(port: Port) => void>();
    const behaviours: unknown[] = [];
    const levels: unknown[] = [];
    const storage = fakeStorage();
    storage.setAccessLevel = (options) => (levels.push(options), Promise.resolve());
    registerBackground({
      debugger: debug,
      runtime: { onConnect, connect: () => { throw new Error('not used'); }, getManifest: () => ({ version: '0', name: 'x' }) },
      sidePanel: { setPanelBehavior: (behaviour) => (behaviours.push(behaviour), Promise.resolve()) },
      storage: { local: storage },
    });
    const connect = (name: string) => {
      const port = { name, postMessage: () => undefined, disconnect: () => undefined, onMessage: fakeEvent<(message: unknown) => void>(), onDisconnect: fakeEvent<() => void>() };
      onConnect.fire(port);
      return port;
    };
    return { debug, behaviours, levels, connect };
  }

  it('opens the panel from the toolbar button and closes storage to anything but the extension', () => {
    const { behaviours, levels } = setup();
    expect(behaviours).toEqual([{ openPanelOnActionClick: true }]);
    expect(levels).toEqual([{ accessLevel: 'TRUSTED_CONTEXTS' }]);
  });

  it('detaches the debugger from the tabs a panel was attached to when that panel goes away', () => {
    const { debug, connect } = setup();
    const port = connect(PANEL_PORT);
    port.onMessage.fire({ type: 'attaching', tabId: 4 });
    port.onMessage.fire({ type: 'attaching', tabId: 6 });
    port.onMessage.fire({ type: 'released', tabId: 4 });
    expect(debug.calls).toEqual([]);
    port.onDisconnect.fire();
    expect(debug.calls).toEqual([{ name: 'detach', tabId: 6 }]);
    // Once.
    port.onDisconnect.fire();
    expect(debug.calls).toHaveLength(1);
  });

  it('ignores other ports and messages that are not what a panel sends', () => {
    const { debug, connect } = setup();
    const stranger = connect('something-else');
    expect(stranger.onMessage.listeners).toEqual([]);
    const port = connect(PANEL_PORT);
    for (const junk of [null, 'attaching', { type: 'attaching' }, { type: 'attaching', tabId: '4' }, { type: 'detach-all', tabId: 4 }, { type: 'attaching', tabId: 1.5 }]) port.onMessage.fire(junk);
    port.onDisconnect.fire();
    expect(debug.calls).toEqual([]);
  });
});

describe('viewportSettled', () => {
  const settings = { protocolVersion: '1.3', viewportSettleMs: 400, viewportPollMs: 50, viewportSettleTimeoutMs: 3000 };
  const session = (sizes: string[]) => {
    const asked: Record<string, unknown>[] = [];
    let at = 0;
    return {
      asked,
      cdp: {
        send(method: string, params?: Record<string, unknown>) {
          if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'F' } } });
          if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 9 });
          asked.push(params ?? {});
          return Promise.resolve({ result: { value: sizes[Math.min(at++, sizes.length - 1)] } });
        },
        on: () => undefined,
        off: () => undefined,
      },
    };
  };

  it('waits until the size has not changed for the time that is set, asking in an isolated world', async () => {
    // The bar of Chrome comes up after the third answer.
    const { cdp, asked } = session(['758x482', '758x482', '758x482', '758x426']);
    let slept = 0;
    await viewportSettled(cdp, settings, (ms) => ((slept += ms), Promise.resolve()));
    // Three polls saw the old size or the change; then eight in a row the same one.
    expect(slept).toBe(3 * 50 + 400);
    expect(asked.every((params) => params['contextId'] === 9)).toBe(true);
  });

  it('gives up on a viewport that never stops changing', async () => {
    let n = 0;
    const cdp = { send: (method: string) => Promise.resolve(method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'F' } } } : method === 'Page.createIsolatedWorld' ? { executionContextId: 1 } : { result: { value: String(n++) } }), on: () => undefined, off: () => undefined };
    let slept = 0;
    await viewportSettled(cdp, settings, (ms) => ((slept += ms), Promise.resolve()));
    expect(slept).toBe(3000);
  });
});
