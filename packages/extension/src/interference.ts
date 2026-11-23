import type { CdpSession } from '@a11y-vision/collector-cdp';
import type { TabsApi } from './chrome-api.js';
import type { ExtensionConfig } from './config.js';

/**
 * What can get in the way of a scan of a tab the user is sitting in front of. The CLI scans a
 * page nobody touches; here the user can click, scroll, type, switch tabs or leave the page
 * while captures are taken, and a measurement made across that is not a measurement.
 * - `input`: a click, a key other than Tab, the wheel, or the pointer moving in the page.
 * - `pointer-over-page`: the pointer rests over the page, so what is under it is in its hover state.
 * - `hidden`: the tab is no longer shown (another tab, a minimised window).
 * - `navigation`: the tab went to another document.
 * - `tab-closed`: the tab is gone.
 */
export type InterferenceKind = 'input' | 'pointer-over-page' | 'hidden' | 'navigation' | 'tab-closed';

const WATCH_WORLD = 'a11y-vision-watch';
const WATCH_GLOBAL = '__a11yVisionWatch';

/**
 * Runs in an isolated world of the page: the page's scripts cannot see it or set its flag.
 * It only listens. Events the collector causes are told apart by what they are: it presses Tab
 * through the debugger and nothing else, and it never moves the pointer.
 */
function installWatch(name: string, watchInput: boolean, watchHidden: boolean): boolean {
  const scope = globalThis as unknown as Record<string, { hit: string; stop: () => void } | undefined>;
  scope[name]?.stop();
  const state = { hit: '', stop: () => undefined as void };
  const note = (kind: string): void => {
    if (state.hit === '') state.hit = kind;
  };
  const onInput = (event: Event): void => {
    if (!event.isTrusted) return;
    if (event.type === 'keydown' && (event as KeyboardEvent).key === 'Tab') return;
    note('input');
  };
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') note('hidden');
  };
  const types = ['pointerdown', 'mousedown', 'pointermove', 'mousemove', 'wheel', 'touchstart', 'keydown'];
  const options = { capture: true, passive: true };
  if (watchInput) for (const type of types) window.addEventListener(type, onInput, options);
  if (watchHidden) {
    document.addEventListener('visibilitychange', onVisibility, true);
    onVisibility();
  }
  state.stop = () => {
    for (const type of types) window.removeEventListener(type, onInput, options);
    document.removeEventListener('visibilitychange', onVisibility, true);
    delete scope[name];
  };
  scope[name] = state;
  return true;
}

export interface InterferenceWatch {
  /** Stops watching and takes the listeners off the page. */
  stop(): Promise<void>;
}

interface Evaluated {
  result?: { value?: unknown };
  exceptionDetails?: unknown;
}

/**
 * Watches the tab while it is scanned and calls `onInterference` once, with the first thing
 * that got in the way. The caller stops the scan; this only reports.
 *
 * `cdp` is the session itself, not the gated one the collector works through: the watch has to
 * go on asking while the collector is busy, and after the scan was told to stop.
 */
export async function watchInterference(
  cdp: CdpSession,
  tabs: TabsApi,
  tabId: number,
  config: ExtensionConfig['interference'],
  onInterference: (kind: InterferenceKind) => void,
): Promise<InterferenceWatch> {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const report = (kind: InterferenceKind): void => {
    if (done) return;
    done = true;
    if (timer !== undefined) clearTimeout(timer);
    tabs.onActivated.removeListener(onActivated);
    tabs.onRemoved.removeListener(onRemoved);
    onInterference(kind);
  };

  const windowId = (await tabs.get(tabId).catch(() => undefined))?.windowId;
  function onActivated(info: { tabId: number; windowId: number }): void {
    if (config.stopOnHidden && info.windowId === windowId && info.tabId !== tabId) report('hidden');
  }
  function onRemoved(removed: number): void {
    if (removed === tabId) report('tab-closed');
  }
  tabs.onActivated.addListener(onActivated);
  tabs.onRemoved.addListener(onRemoved);

  const mainFrame = async (): Promise<{ id: string; loaderId: string }> => {
    const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string; loaderId: string } } };
    return frameTree.frame;
  };
  const install = async (): Promise<number> => {
    const frame = await mainFrame();
    const { executionContextId } = (await cdp.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: WATCH_WORLD })) as { executionContextId: number };
    await cdp.send('Runtime.evaluate', {
      expression: `(${installWatch.toString()})(${JSON.stringify(WATCH_GLOBAL)}, ${String(config.stopOnUserInput)}, ${String(config.stopOnHidden)})`,
      contextId: executionContextId,
      returnByValue: true,
    });
    return executionContextId;
  };

  const start = await mainFrame();
  let contextId = await install();

  const read = `(() => { const w = globalThis[${JSON.stringify(WATCH_GLOBAL)}]; if (!w) return 'gone'; if (w.hit) return w.hit; return ${String(config.stopOnPointerOverPage)} && document.documentElement.matches(':hover') ? 'pointer-over-page' : ''; })()`;
  const poll = async (): Promise<void> => {
    if (done) return;
    let value: unknown = 'gone';
    try {
      const answer = (await cdp.send('Runtime.evaluate', { expression: read, contextId, returnByValue: true })) as Evaluated;
      if (!answer.exceptionDetails) value = answer.result?.value;
    } catch {
      // The world went with its document, or the session is over: looked at below.
    }
    if (done) return;
    if (value === 'input' || value === 'hidden' || value === 'pointer-over-page') {
      report(value);
      return;
    }
    if (value === 'gone') {
      try {
        const now = await mainFrame();
        if (now.loaderId !== start.loaderId) {
          if (config.stopOnNavigation) {
            report('navigation');
            return;
          }
        }
        // Another document, and the collector goes on there; or the same one that lost the world.
        contextId = await install();
      } catch {
        // No answer at all: the session is gone, which the session itself reports.
        return;
      }
    }
    if (!done) timer = setTimeout(() => void poll(), config.pollMs);
  };
  timer = setTimeout(() => void poll(), 0);

  return {
    async stop() {
      const wasDone = done;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      if (!wasDone) {
        tabs.onActivated.removeListener(onActivated);
        tabs.onRemoved.removeListener(onRemoved);
      }
      await cdp
        .send('Runtime.evaluate', { expression: `globalThis[${JSON.stringify(WATCH_GLOBAL)}]?.stop()`, contextId, returnByValue: true })
        .catch(() => undefined);
    },
  };
}
