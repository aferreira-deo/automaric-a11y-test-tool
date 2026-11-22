import type { Box, Config, Png, Screenshot } from '@a11y-vision/core';
import { AGENT_GLOBAL, agentFactory } from './agent.js';
import type { AgentOptions } from './agent.js';
import type { PageEnvironment, World } from './environment.js';
import type { CdpSession } from './session.js';

export interface MatchedStyles {
  inlineStyle?: { cssProperties: { name: string; disabled?: boolean }[] };
  matchedCSSRules?: {
    matchingSelectors: number[];
    rule: {
      origin: string;
      selectorList: { selectors: { text: string }[] };
      style: { cssProperties: { name: string; disabled?: boolean }[] };
    };
  }[];
}

/** The stabilised page, as the collectors of the individual checks use it. */
export interface StablePage {
  cdp: CdpSession;
  /** Calls a method of the in-page agent, e.g. `agent('prepare(3)')`. */
  agent: <T>(call: string) => Promise<T>;
  /** Screenshot of a region given in page coordinates, at the capture scale. */
  screenshot: (clip: Box) => Promise<Png>;
  /** The same, stored in the snapshot clips under `id`. */
  capture: (id: string, clip: Box) => Promise<Png>;
  /** The snapshot clips `capture` writes to. */
  clips: Record<string, Screenshot>;
  /** CDP node id of an element the agent holds under `key`. */
  nodeIdOf: (key: number) => Promise<number>;
  matchedStyles: (nodeId: number) => Promise<MatchedStyles>;
}

function decodeBase64(data: string): Png {
  return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
}

/**
 * Runs `body` on a stabilised page and puts the page back afterwards.
 *
 * While `body` runs the page is changed: device scale factor, reduced motion, an adopted style
 * sheet, and whatever the collectors do (focus, scroll positions, text selection in fields,
 * `tabindex` on cross-origin iframes the focus walk had to step past). Afterwards the style
 * sheet and the `tabindex` values are removed, focus goes back to the element that had it, and
 * the scroll positions of the window, of same-origin frames and of scroll containers are put back.
 *
 * Emulation is the part that cannot be restored from here. Chrome keeps one device-metrics
 * override and one emulated media type per page, not per session, and offers no way to read
 * them: this function replaces them while it runs and clears them at the end, which is the
 * original state only if nobody else had set them. A caller that emulates through another
 * session (Playwright does) has to apply its own emulation again; the Playwright wrapper does so.
 * Media features are different: only `prefers-reduced-motion` is touched, the others keep
 * whatever value another session gave them. `cdp` itself should carry no media emulation.
 */
export async function withStablePage<T>(
  cdp: CdpSession,
  world: World,
  original: PageEnvironment,
  config: Config,
  clips: Record<string, Screenshot>,
  body: (page: StablePage) => Promise<T>,
): Promise<T> {
  const scale = config.focus.deviceScaleFactor;
  const overrideScale = original.devicePixelRatio !== scale;
  const overrideMotion = !original.reducedMotion;
  // Sending a media feature list also resets the media type, so the one in effect is sent along.
  const setMedia = (features: { name: string; value: string }[]): Promise<unknown> =>
    cdp.send('Emulation.setEmulatedMedia', { media: original.mediaType === 'print' ? 'print' : '', features });

  let agentReady = false;
  const agent = async <R>(call: string): Promise<R> => (await world.evaluate(`${AGENT_GLOBAL}.${call}`)).result.value as R;

  const screenshot = async (clip: Box): Promise<Png> => {
    const { data } = (await cdp.send('Page.captureScreenshot', {
      format: 'png',
      // Page coordinates, verified against Chrome: the clip origin is the document, not the viewport.
      clip: { ...clip, scale: 1 },
      captureBeyondViewport: false,
    })) as { data: string };
    return decodeBase64(data);
  };

  const page: StablePage = {
    cdp,
    clips,
    agent,
    screenshot,
    capture: async (id, clip) => {
      const png = await screenshot(clip);
      clips[id] = { box: clip, scale, png };
      return png;
    },
    nodeIdOf: async (key) => {
      const { result } = await world.evaluate(`${AGENT_GLOBAL}.element(${key})`, false);
      const { nodeId } = (await cdp.send('DOM.requestNode', { objectId: result.objectId })) as { nodeId: number };
      return nodeId;
    },
    matchedStyles: async (nodeId) => (await cdp.send('CSS.getMatchedStylesForNode', { nodeId })) as MatchedStyles,
  };

  try {
    // The agent goes in first: it records focus and scroll positions before anything moves them.
    const options: AgentOptions = {
      settleFrames: config.focus.settleFrames,
      settleTimeoutMs: config.focus.settleTimeoutMs,
      fontsTimeoutMs: config.focus.fontsTimeoutMs,
      clipMarginCssPx: config.focus.clipMarginCssPx,
      obscuredGrid: config.focus.obscuredGrid,
      opaqueCoverMinAlpha: config.focus.opaqueCoverMinAlpha,
      invisibleCoverMaxOpacity: config.focus.invisibleCoverMaxOpacity,
      icon: {
        clipMarginCssPx: config.icon.clipMarginCssPx,
        minControlSizeCssPx: config.icon.minControlSizeCssPx,
        maxGraphicSizeCssPx: config.icon.maxGraphicSizeCssPx,
        iconFontFamilyPattern: config.icon.iconFontFamilyPattern,
        inactiveHintPattern: config.icon.inactiveHintPattern,
        logoHintPattern: config.icon.logoHintPattern,
        minVisibleTextCssPx: config.icon.minVisibleTextCssPx,
        boundaryWrapperLevels: config.icon.boundaryWrapperLevels,
        boundaryWrapperSlackCssPx: config.icon.boundaryWrapperSlackCssPx,
        coverGrid: config.icon.coverGrid,
      },
    };
    await world.evaluate(`globalThis.${AGENT_GLOBAL} = (${agentFactory.toString()})(${JSON.stringify(options)}); 1`);
    agentReady = true;

    if (overrideScale) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        ...original.viewport,
        deviceScaleFactor: scale,
        mobile: false,
      });
    }
    if (overrideMotion) await setMedia([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    await cdp.send('DOM.getDocument', { depth: 0 });
    await agent('stabilise()');
    return await body(page);
  } finally {
    if (agentReady) await agent('cleanup()').catch(() => undefined);
    await cdp.send('CSS.disable').catch(() => undefined);
    await cdp.send('DOM.disable').catch(() => undefined);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined);
    if (overrideMotion) await setMedia([]).catch(() => undefined);
    if (overrideScale) await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
  }
}
