import { connectedComponents, decodePng, diffMask, fnv1a64, unionBox } from '@a11y-vision/core';
import type { Box, FocusConfig, FocusStop, FocusWalk } from '@a11y-vision/core';
import type { AgentBlurred, AgentElementInfo, AgentPrepared, AgentRect } from './agent.js';
import type { Capture, StablePage } from './page.js';

const TAB_KEY = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
const NO_BOX: Box = { x: 0, y: 0, width: 0, height: 0 };

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
 * Measurement happens later, in core, from the captures stored in the snapshot clips.
 *
 * Runs on a page prepared by `withStablePage`, which also describes what is changed on the
 * page meanwhile and what is put back. The walk leaves no element focused.
 */
export async function collectFocus(page: StablePage, config: FocusConfig): Promise<FocusWalk> {
  const { cdp, agent, capture } = page;

  /**
   * Static CSS is used for this one question only: did the author touch the focus style?
   * Yes when a non-user-agent rule that matches in the focused state declares an outline
   * property or has :focus, :focus-visible or :focus-within in its matching selector.
   */
  const authorModified = async (nodeId: number): Promise<boolean> => {
    const styles = await page.matchedStyles(nodeId);
    const declaresOutline = (properties: { name: string; disabled?: boolean }[]): boolean =>
      properties.some((property) => !property.disabled && property.name.startsWith('outline'));
    if (styles.inlineStyle && declaresOutline(styles.inlineStyle.cssProperties)) return true;
    return (styles.matchedCSSRules ?? []).some(({ rule, matchingSelectors }) => {
      if (rule.origin !== 'regular') return false;
      if (declaresOutline(rule.style.cssProperties)) return true;
      return matchingSelectors.some((index) => rule.selectorList.selectors[index]?.text.includes(':focus'));
    });
  };

  const minArea = (scale: number): number => Math.max(1, Math.round(config.minComponentAreaCssPx2 * scale * scale));
  const isUnchanged = (focused: Capture, unfocused: Capture): boolean => {
    const mask = diffMask(decodePng(focused.png), decodePng(unfocused.png), config.diffDeltaE);
    return connectedComponents(mask, minArea(focused.scale)).length === 0;
  };

  /**
   * What the 2.4.11 sampling of the agent cannot see, looked for with Chrome's own hit test:
   * content of a parent page over the iframe, a layer with pointer-events: none, a
   * pseudo-element of an ancestor. Any of them, or no answer, and the captures are no proof.
   */
  const noteCovers = async (stop: FocusStop, key: number, prepared: AgentPrepared): Promise<void> => {
    if (prepared.frameCovered) stop.possiblyCovered = true;
    else if (prepared.probes.length > 0) {
      const hits = await page.hitKinds(key, prepared.probes, 'focus');
      if (hits.includes('cover') || hits.includes('unknown')) stop.possiblyCovered = true;
    }
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
    await noteCovers(stop, info.key, prepared);
    const crops = cropIds(info);
    const focused = await capture(crops.focused, prepared.clip);
    stop.authorModified = await authorModified(await page.nodeIdOf(info.key));
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
      const viewportUnfocused = await page.screenshot(viewport);
      await agent(`refocus(${info.key})`);
      refocused = true;
      const viewportFocused = await page.screenshot(viewport);
      const mask = diffMask(decodePng(viewportFocused.png), decodePng(viewportUnfocused.png), config.diffDeltaE);
      const scale = viewportFocused.scale;
      const changed = unionBox(connectedComponents(mask, minArea(scale)));
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
    await noteCovers(stop, info.key, prepared);
    const crops = cropIds(info);
    await capture(crops.unfocused, prepared.clip);
    const nodeId = await page.nodeIdOf(info.key);
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
  /** The element the previous press left focus on, null when it left it on the document. */
  let previousKey: number | null = null;
  let sameStreak = 0;
  for (;;) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...TAB_KEY });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...TAB_KEY });
    await agent('settle()');
    const info = await agent<AgentElementInfo | null>('active()');

    if (!info) {
      previousKey = null;
      // Focus is on the document: the walk is wrapping around, or nothing takes focus.
      if (++emptyStreak >= 2) {
        stoppedBy = stops.length > 0 ? 'cycle' : 'no-focusable';
        break;
      }
      continue;
    }
    emptyStreak = 0;
    // Tab moved inside the element it was on (the day, month and year of a date input share one
    // activeElement): not a cycle, up to `maxTabsInElement` presses in a row.
    if (!info.opaqueFrame && info.key === previousKey) {
      if (++sameStreak > config.maxTabsInElement) {
        stoppedBy = 'trapped';
        break;
      }
      continue;
    }
    sameStreak = 0;
    previousKey = info.key;

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
}
