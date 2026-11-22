import { connectedComponents, decodePng, diffMask, fnv1a64, unionBox } from '@a11y-vision/core';
import type { Box, FocusConfig, FocusStop, FocusWalk, Png, Screenshot } from '@a11y-vision/core';
import { AGENT_GLOBAL, agentFactory } from './agent.js';
import type { AgentElementInfo, AgentOptions, AgentPrepared, AgentRect } from './agent.js';
import type { CdpSession } from './session.js';

const WORLD_NAME = 'a11y-vision';
const TAB_KEY = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
const NO_BOX: Box = { x: 0, y: 0, width: 0, height: 0 };

interface EvaluateResponse {
  result: { value?: unknown; objectId?: string };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

interface MatchedStyles {
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

interface MediaState {
  width: number;
  height: number;
  devicePixelRatio: number;
  colorScheme: string;
  reducedMotion: string;
  forcedColors: string;
}

const MEDIA_EXPRESSION = `({
  width: window.innerWidth,
  height: window.innerHeight,
  devicePixelRatio: window.devicePixelRatio,
  colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference',
  forcedColors: matchMedia('(forced-colors: active)').matches ? 'active' : 'none',
})`;

function decodeBase64(data: string): Png {
  return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
}

function moved(a: AgentRect | null, b: AgentRect | null, tolerance: number): boolean {
  if (!a || !b) return a !== b;
  return (
    Math.abs(a.x - b.x) > tolerance ||
    Math.abs(a.y - b.y) > tolerance ||
    Math.abs(a.width - b.width) > tolerance ||
    Math.abs(a.height - b.height) > tolerance
  );
}

/**
 * Walks the page with real Tab presses and captures every stop focused and unfocused.
 * Measurement happens later, in core, from the captures stored in `clips`.
 *
 * The page is modified while this runs (device scale factor, reduced motion, a stabilising
 * style sheet, focus and scroll position) and restored afterwards.
 */
export async function collectFocus(
  cdp: CdpSession,
  config: FocusConfig,
  clips: Record<string, Screenshot>,
): Promise<FocusWalk> {
  const evaluateIn = async (contextId: number | undefined, expression: string, byValue = true): Promise<EvaluateResponse> => {
    const response = (await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: byValue,
      awaitPromise: true,
      ...(contextId === undefined ? {} : { contextId }),
    })) as EvaluateResponse;
    if (response.exceptionDetails) {
      const { text, exception } = response.exceptionDetails;
      throw new Error(`Page evaluation failed: ${exception?.description ?? text}`);
    }
    return response;
  };

  const original = (await evaluateIn(undefined, MEDIA_EXPRESSION)).result.value as MediaState;
  const overrideScale = original.devicePixelRatio !== config.deviceScaleFactor;
  const setMetrics = (deviceScaleFactor: number): Promise<unknown> =>
    cdp.send('Emulation.setDeviceMetricsOverride', {
      width: original.width,
      height: original.height,
      deviceScaleFactor,
      mobile: false,
    });
  // setEmulatedMedia replaces the whole set, so the features already in effect are sent back with it.
  const setMedia = (reducedMotion: string): Promise<unknown> =>
    cdp.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: original.colorScheme },
        { name: 'forced-colors', value: original.forcedColors },
        { name: 'prefers-reduced-motion', value: reducedMotion },
      ],
    });

  let contextId: number | undefined;
  const agent = async <T>(call: string): Promise<T> =>
    (await evaluateIn(contextId, `${AGENT_GLOBAL}.${call}`)).result.value as T;

  const capture = async (id: string, clip: Box): Promise<Png> => {
    const { data } = (await cdp.send('Page.captureScreenshot', {
      format: 'png',
      // Page coordinates, verified against Chrome: the clip origin is the document, not the viewport.
      clip: { ...clip, scale: 1 },
      captureBeyondViewport: false,
    })) as { data: string };
    const png = decodeBase64(data);
    clips[id] = { box: clip, scale: config.deviceScaleFactor, png };
    return png;
  };

  const nodeIdOf = async (key: number): Promise<number> => {
    const { result } = await evaluateIn(contextId, `${AGENT_GLOBAL}.element(${key})`, false);
    const { nodeId } = (await cdp.send('DOM.requestNode', { objectId: result.objectId })) as { nodeId: number };
    return nodeId;
  };

  /**
   * Static CSS is used for this one question only: did the author touch the focus style?
   * Yes when a non-user-agent rule that matches in the focused state declares an outline
   * property or has :focus, :focus-visible or :focus-within in its matching selector.
   */
  const authorModified = async (nodeId: number): Promise<boolean> => {
    const styles = (await cdp.send('CSS.getMatchedStylesForNode', { nodeId })) as MatchedStyles;
    const declaresOutline = (properties: { name: string; disabled?: boolean }[]): boolean =>
      properties.some((property) => !property.disabled && property.name.startsWith('outline'));
    if (styles.inlineStyle && declaresOutline(styles.inlineStyle.cssProperties)) return true;
    return (styles.matchedCSSRules ?? []).some(({ rule, matchingSelectors }) => {
      if (rule.origin !== 'regular') return false;
      if (declaresOutline(rule.style.cssProperties)) return true;
      return matchingSelectors.some((index) => rule.selectorList.selectors[index]?.text.includes(':focus'));
    });
  };

  const isUnchanged = (focused: Png, unfocused: Png): boolean => {
    const mask = diffMask(decodePng(focused), decodePng(unfocused), config.diffDeltaE);
    const minArea = Math.max(1, Math.round(config.minComponentAreaCssPx2 * config.deviceScaleFactor ** 2));
    return connectedComponents(mask, minArea).length === 0;
  };

  const stops: FocusStop[] = [];
  // Named after the element, not after its position in the walk: the walk can start anywhere.
  const cropIds = (info: AgentElementInfo): { focused: string; unfocused: string } => {
    const name = fnv1a64(JSON.stringify([info.frame, info.selector]));
    return { focused: `focus-indicator/${name}-focused.png`, unfocused: `focus-indicator/${name}-unfocused.png` };
  };
  const baseStop = (info: AgentElementInfo, reachedBy: FocusStop['reachedBy'], prepared?: AgentPrepared): FocusStop => ({
    selector: info.selector,
    frame: info.frame,
    box: prepared?.box ?? NO_BOX,
    reachedBy,
    textEntry: info.textEntry,
    authorModified: false,
    opaqueFrame: info.opaqueFrame,
    obscured: info.obscured,
    geometryChanged: false,
    crops: null,
  });

  const measureTabStop = async (info: AgentElementInfo): Promise<FocusStop> => {
    if (info.opaqueFrame) return baseStop(info, 'tab');
    const prepared = await agent<AgentPrepared>(`prepare(${info.key})`);
    const stop = baseStop(info, 'tab', prepared);
    if (!prepared.clip || prepared.reason) {
      if (prepared.reason) stop.notCaptured = prepared.reason;
      return stop;
    }
    const crops = cropIds(info);
    const focused = await capture(crops.focused, prepared.clip);
    stop.authorModified = await authorModified(await nodeIdOf(info.key));
    const unfocusedBox = await agent<AgentRect | null>(`blur(${info.key})`);
    const unfocused = await capture(crops.unfocused, prepared.clip);
    stop.crops = crops;
    stop.geometryChanged = moved(prepared.box, unfocusedBox, config.geometryToleranceCssPx);

    let refocused = false;
    if (isUnchanged(focused, unfocused)) {
      // Nothing changed near the element. Before that becomes a failure, look at the whole viewport.
      const viewport = await agent<AgentRect>('viewport()');
      const shot = async (): Promise<Png> => {
        const { data } = (await cdp.send('Page.captureScreenshot', {
          format: 'png',
          clip: { ...viewport, scale: 1 },
          captureBeyondViewport: false,
        })) as { data: string };
        return decodeBase64(data);
      };
      const viewportUnfocused = await shot();
      await agent(`refocus(${info.key})`);
      refocused = true;
      const viewportFocused = await shot();
      const mask = diffMask(decodePng(viewportFocused), decodePng(viewportUnfocused), config.diffDeltaE);
      const scale = config.deviceScaleFactor;
      const changed = unionBox(connectedComponents(mask, Math.max(1, Math.round(config.minComponentAreaCssPx2 * scale * scale))));
      stop.outsideChange = changed
        ? {
            x: viewport.x + changed.x / scale,
            y: viewport.y + changed.y / scale,
            width: changed.width / scale,
            height: changed.height / scale,
          }
        : null;
    }
    // Chrome would continue sequential navigation from the blurred element, but page scripts that
    // manage focus (a focus trap) need the next Tab keydown to be dispatched on the element itself.
    if (!refocused) await agent(`refocus(${info.key})`);
    return stop;
  };

  const measureForced = async (info: AgentElementInfo): Promise<FocusStop> => {
    const prepared = await agent<AgentPrepared>(`prepare(${info.key})`);
    const stop = baseStop(info, 'forced', prepared);
    if (!prepared.clip || prepared.reason) {
      if (prepared.reason) stop.notCaptured = prepared.reason;
      return stop;
    }
    const crops = cropIds(info);
    await capture(crops.unfocused, prepared.clip);
    const nodeId = await nodeIdOf(info.key);
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] });
    try {
      await agent('settle()');
      const focusedBox = await agent<AgentRect | null>(`box(${info.key})`);
      await capture(crops.focused, prepared.clip);
      stop.authorModified = await authorModified(nodeId);
      stop.geometryChanged = moved(focusedBox, prepared.box, config.geometryToleranceCssPx);
      if (focusedBox) stop.box = focusedBox;
    } finally {
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    }
    stop.crops = crops;
    return stop;
  };

  let stoppedBy: FocusWalk['stoppedBy'] = 'limit';

  try {
    if (overrideScale) await setMetrics(config.deviceScaleFactor);
    await setMedia('reduce');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    await cdp.send('DOM.getDocument', { depth: 0 });

    const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
    const world = (await cdp.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName: WORLD_NAME,
    })) as { executionContextId: number };
    contextId = world.executionContextId;

    const options: AgentOptions = {
      settleFrames: config.settleFrames,
      settleTimeoutMs: config.settleTimeoutMs,
      fontsTimeoutMs: config.fontsTimeoutMs,
      clipMarginCssPx: config.clipMarginCssPx,
      obscuredGrid: config.obscuredGrid,
    };
    await evaluateIn(
      contextId,
      `globalThis.${AGENT_GLOBAL} = (${agentFactory.toString()})(${JSON.stringify(options)}); 1`,
    );
    await agent('stabilise()');

    // The starting point of sequential navigation cannot be reset from script, so the walk
    // starts wherever the page left it and ends when it meets an element for the second time.
    const visited = new Set<number>();
    let emptyStreak = 0;
    let opaqueKey: number | undefined;
    let opaqueStreak = 0;
    for (;;) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...TAB_KEY });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...TAB_KEY });
      await agent('settle()');
      const info = await agent<AgentElementInfo | null>('active()');

      if (!info) {
        // Focus is on the document: the walk is wrapping around, or nothing takes focus.
        if (++emptyStreak >= 2) {
          stoppedBy = stops.length > 0 ? 'cycle' : 'no-focusable';
          break;
        }
        continue;
      }
      emptyStreak = 0;

      if (info.opaqueFrame && info.key === opaqueKey) {
        // Still inside the same cross-origin frame; its inner stops are invisible from here.
        if (++opaqueStreak > config.maxTabsInOpaqueFrame) break;
        continue;
      }
      if (visited.has(info.key)) {
        stoppedBy = 'cycle';
        break;
      }
      visited.add(info.key);
      opaqueKey = info.opaqueFrame ? info.key : undefined;
      opaqueStreak = 0;

      stops.push(await measureTabStop(info));
      if (stops.length >= config.maxTabStops) break;
    }

    await agent('blurActive()');
    const rest = await agent<{ total: number; items: AgentElementInfo[] }>(`unreached(${config.maxForced})`);
    for (const info of rest.items) stops.push(await measureForced(info));
    return { stops, stoppedBy, unreached: rest.total, forced: rest.items.length };
  } finally {
    if (contextId !== undefined) await agent('cleanup()').catch(() => undefined);
    await cdp.send('CSS.disable').catch(() => undefined);
    await cdp.send('DOM.disable').catch(() => undefined);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined);
    await setMedia(original.reducedMotion).catch(() => undefined);
    if (overrideScale) await setMetrics(original.devicePixelRatio).catch(() => undefined);
  }
}
