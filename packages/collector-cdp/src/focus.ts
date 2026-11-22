import { connectedComponents, decodePng, diffMask, fnv1a64, unionBox } from '@a11y-vision/core';
import type { Box, FocusConfig, FocusStop, FocusWalk, Png, Screenshot } from '@a11y-vision/core';
import { AGENT_GLOBAL, agentFactory } from './agent.js';
import type { AgentBlurred, AgentElementInfo, AgentOptions, AgentPrepared, AgentRect } from './agent.js';
import type { PageEnvironment, World } from './environment.js';
import type { CdpSession } from './session.js';

const TAB_KEY = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
const NO_BOX: Box = { x: 0, y: 0, width: 0, height: 0 };

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
 * While this runs the page is changed: device scale factor, reduced motion, an adopted style
 * sheet, focus, scroll positions, text selection in fields, and `tabindex` on cross-origin
 * iframes the walk had to step past. Afterwards the style sheet and the `tabindex` values are
 * removed, focus goes back to the element that had it, and the scroll positions of the window,
 * of same-origin frames and of scroll containers are put back.
 *
 * Emulation is the part that cannot be restored from here. Chrome keeps one device-metrics
 * override and one emulated media type per page, not per session, and offers no way to read
 * them: this function replaces them while it runs and clears them at the end, which is the
 * original state only if nobody else had set them. A caller that emulates through another
 * session (Playwright does) has to apply its own emulation again; the Playwright wrapper does so.
 * Media features are different: only `prefers-reduced-motion` is touched, the others keep
 * whatever value another session gave them. `cdp` itself should carry no media emulation.
 */
export async function collectFocus(
  cdp: CdpSession,
  world: World,
  original: PageEnvironment,
  config: FocusConfig,
  clips: Record<string, Screenshot>,
): Promise<FocusWalk> {
  const overrideScale = original.devicePixelRatio !== config.deviceScaleFactor;
  const overrideMotion = !original.reducedMotion;
  // Sending a media feature list also resets the media type, so the one in effect is sent along.
  const setMedia = (features: { name: string; value: string }[]): Promise<unknown> =>
    cdp.send('Emulation.setEmulatedMedia', { media: original.mediaType === 'print' ? 'print' : '', features });

  let agentReady = false;
  const agent = async <T>(call: string): Promise<T> =>
    (await world.evaluate(`${AGENT_GLOBAL}.${call}`)).result.value as T;

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
    const { result } = await world.evaluate(`${AGENT_GLOBAL}.element(${key})`, false);
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

  /** What prepare() learned about the conditions of the capture. Only set when true, to keep stops small. */
  const noteConditions = (stop: FocusStop, prepared: AgentPrepared): void => {
    if (prepared.covered) stop.coveredAtCapture = true;
    if (prepared.clipped) stop.clippedByViewport = true;
    if (!prepared.stable) stop.unstabilised = true;
  };

  const measureTabStop = async (info: AgentElementInfo): Promise<FocusStop> => {
    if (info.opaqueFrame) return baseStop(info, 'tab');
    const prepared = await agent<AgentPrepared>(`prepare(${info.key})`);
    const stop = baseStop(info, 'tab', prepared);
    if (!prepared.clip || prepared.reason) {
      if (prepared.reason) stop.notCaptured = prepared.reason;
      return stop;
    }
    noteConditions(stop, prepared);
    const crops = cropIds(info);
    const focused = await capture(crops.focused, prepared.clip);
    stop.authorModified = await authorModified(await nodeIdOf(info.key));
    const blurred = await agent<AgentBlurred>(`blur(${info.key})`);
    const unfocused = await capture(crops.unfocused, prepared.clip);
    stop.crops = crops;
    stop.geometryChanged = moved(prepared.box, blurred.box, config.geometryToleranceCssPx);
    // Checked on both sides of the capture: a script can hand the focus back at any moment.
    if (!blurred.blurred || (await agent<boolean>(`isActive(${info.key})`))) stop.unfocusedNotCaptured = true;

    let refocused = false;
    if (!stop.unfocusedNotCaptured && isUnchanged(focused, unfocused)) {
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
    noteConditions(stop, prepared);
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
    // The agent goes in first: it records focus and scroll positions before anything moves them.
    const options: AgentOptions = {
      settleFrames: config.settleFrames,
      settleTimeoutMs: config.settleTimeoutMs,
      fontsTimeoutMs: config.fontsTimeoutMs,
      clipMarginCssPx: config.clipMarginCssPx,
      obscuredGrid: config.obscuredGrid,
      opaqueCoverMinAlpha: config.opaqueCoverMinAlpha,
      invisibleCoverMaxOpacity: config.invisibleCoverMaxOpacity,
    };
    await world.evaluate(`globalThis.${AGENT_GLOBAL} = (${agentFactory.toString()})(${JSON.stringify(options)}); 1`);
    agentReady = true;

    if (overrideScale) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        ...original.viewport,
        deviceScaleFactor: config.deviceScaleFactor,
        mobile: false,
      });
    }
    if (overrideMotion) await setMedia([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    await cdp.send('DOM.getDocument', { depth: 0 });
    await agent('stabilise()');

    // The starting point of sequential navigation cannot be reset from script, so the walk
    // starts wherever the page left it and ends when it meets an element for the second time.
    const visited = new Set<number>();
    let emptyStreak = 0;
    let opaqueKey: number | undefined;
    let opaqueStreak = 0;
    const opaqueKeys: number[] = [];
    const skipped = new Set<number>();
    /** The last stop that is not a cross-origin frame: where the walk restarts from to step past one. */
    let lastOwnStop: number | null = null;
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

      if (info.opaqueFrame && skipped.has(info.key)) {
        // Taken out of the Tab order and focus is in it again: there is no getting past it.
        stoppedBy = 'opaque-frame';
        break;
      }
      if (info.opaqueFrame && info.key === opaqueKey) {
        // Still inside the same cross-origin frame; its inner stops are invisible from here.
        if (++opaqueStreak > config.maxTabsInOpaqueFrame) {
          // It has more stops than the walk will spend on it, or it traps focus. Every
          // cross-origin frame met so far is skipped, or restarting would walk into them again.
          for (const key of opaqueKeys) skipped.add(key);
          await agent(`skipFrames(${JSON.stringify(opaqueKeys)}, ${lastOwnStop})`);
          opaqueKey = undefined;
        }
        continue;
      }
      if (visited.has(info.key)) {
        stoppedBy = 'cycle';
        break;
      }
      visited.add(info.key);
      opaqueKey = info.opaqueFrame ? info.key : undefined;
      opaqueStreak = 0;
      if (info.opaqueFrame) opaqueKeys.push(info.key);
      else lastOwnStop = info.key;

      stops.push(await measureTabStop(info));
      if (stops.length >= config.maxTabStops) break;
    }

    await agent('blurActive()');
    const rest = await agent<{ total: number; items: AgentElementInfo[] }>(`unreached(${config.maxForced})`);
    for (const info of rest.items) stops.push(await measureForced(info));
    return { stops, stoppedBy, unreached: rest.total, forced: rest.items.length };
  } finally {
    if (agentReady) await agent('cleanup()').catch(() => undefined);
    await cdp.send('CSS.disable').catch(() => undefined);
    await cdp.send('DOM.disable').catch(() => undefined);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined);
    if (overrideMotion) await setMedia([]).catch(() => undefined);
    if (overrideScale) await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
  }
}
