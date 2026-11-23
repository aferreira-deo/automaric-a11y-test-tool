import type { CdpSession } from '@a11y-vision/collector-cdp';

const SETTLE_WORLD = 'a11y-vision-settle';

/** How long a viewport has to keep still, how often it is asked, and when the waiting is given up. */
export interface SettleConfig {
  viewportSettleMs: number;
  viewportPollMs: number;
  viewportSettleTimeoutMs: number;
}

/**
 * Waits until the viewport of the page has kept its size and its device pixel ratio for
 * `viewportSettleMs`. Asked in an isolated world: a page cannot answer for the browser.
 *
 * Two things change the viewport of a tab the debugger is attached to, and both are waited out
 * with this:
 * - Chrome's debugging bar comes up shortly after attaching and makes the page shorter. A scan
 *   that read the size before it and one that read it after would not be scans of the same
 *   viewport.
 * - A capture. While Chrome takes one of a clip, it emulates a viewport of the size of the clip
 *   in device pixels, at a device pixel ratio of 1, and puts back what was emulated before when
 *   the capture is done. A session that is detached in the middle of that leaves the page with
 *   the viewport of the capture: twice as wide as the window for a capture of the whole
 *   viewport at a scale of 2, some 250 px for a capture of a button (seen in Chromium 153,
 *   9 times in 80 scans whose panel was closed while the page was walked, and not once in 80
 *   with this wait before the service worker detaches). That it is a capture is inferred from
 *   those widths, which are the sizes of the clips; see also `GatedSession.release` in the
 *   collector, which waits for the same thing from the side that knows what it sent.
 */
export async function viewportSettled(cdp: CdpSession, config: SettleConfig, sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<void> {
  const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
  const { executionContextId } = (await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: SETTLE_WORLD })) as { executionContextId: number };
  const size = async (): Promise<unknown> =>
    ((await cdp.send('Runtime.evaluate', { expression: "window.innerWidth + 'x' + window.innerHeight + '@' + window.devicePixelRatio", contextId: executionContextId, returnByValue: true })) as { result?: { value?: unknown } }).result?.value;
  let last = await size();
  let stableFor = 0;
  for (let waited = 0; stableFor < config.viewportSettleMs && waited < config.viewportSettleTimeoutMs; waited += config.viewportPollMs) {
    await sleep(config.viewportPollMs);
    const now = await size();
    stableFor = now === last ? stableFor + config.viewportPollMs : 0;
    last = now;
  }
}
