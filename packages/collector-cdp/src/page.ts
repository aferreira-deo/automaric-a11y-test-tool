import type { Box, Config, Png, Screenshot } from '@a11y-vision/core';
import { AGENT_GLOBAL, agentFactory } from './agent.js';
import type { AgentHitKind, AgentOptions } from './agent.js';
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
  /** Execution context of the isolated world the agent lives in. */
  contextId: number;
  /** Calls a method of the in-page agent, e.g. `agent('prepare(3)')`. */
  agent: <T>(call: string) => Promise<T>;
  /** Screenshot of a region given in page coordinates, with the scale it was really taken at. */
  screenshot: (clip: Box) => Promise<Capture>;
  /** The same, stored in the snapshot clips under `id`. */
  capture: (id: string, clip: Box) => Promise<Capture>;
  /**
   * What lies on top at each point (page coordinates) in relation to the element the agent holds
   * under `key`, by Chrome's own hit test: from the top document down through frames, and
   * without skipping `pointer-events: none`. `cover` also when the top paints nothing but
   * something under it, in front of the element, does. `unknown` when Chrome gave no answer.
   */
  hitKinds: (key: number, points: [number, number][], mode: 'icon' | 'focus') => Promise<('own' | 'cover' | 'unknown')[]>;
  /** The snapshot clips `capture` writes to. */
  clips: Record<string, Screenshot>;
  /** CDP node id of an element the agent holds under `key`. */
  nodeIdOf: (key: number) => Promise<number>;
  matchedStyles: (nodeId: number) => Promise<MatchedStyles>;
}

/** Remote objects of hit-tested nodes are held under this group and released after each element. */
const HIT_OBJECT_GROUP = 'a11y-vision-hit';

export interface Capture {
  png: Png;
  /** Device pixels per CSS pixel in `png`, worked out from its size. */
  scale: number;
}

function decodeBase64(data: string): Png {
  return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
}

/** Width and height from the IHDR chunk, which always comes first in a PNG. */
function pngSize(png: Png): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The scale a capture was taken at, from its size and the size of the clip. It is never assumed:
 * the override this collector sets is per page, not per session, and whether a screenshot taken
 * through one session honours emulation set through another is Chrome's business.
 */
export function captureScale(png: Png, clip: Box, expected: number, tolerancePx: number): number {
  const { width, height } = pngSize(png);
  const fits = (scale: number): boolean =>
    Math.abs(width - clip.width * scale) <= tolerancePx && Math.abs(height - clip.height * scale) <= tolerancePx;
  if (fits(expected)) return expected;
  const real = width / clip.width;
  if (real > 0 && Number.isFinite(real) && fits(real)) return real;
  throw new Error(
    `A capture of ${clip.width} by ${clip.height} CSS px came back as ${width} by ${height} pixels, which fits no scale: nothing can be measured on it.`,
  );
}

/** The settings the in-page agent works from: the part of the configuration it needs, as plain data. */
export function agentOptions(config: Config): AgentOptions {
  return {
    settleFrames: config.focus.settleFrames,
    settleTimeoutMs: config.focus.settleTimeoutMs,
    fontsTimeoutMs: config.focus.fontsTimeoutMs,
    clipMarginCssPx: config.focus.clipMarginCssPx,
    obscuredGrid: config.focus.obscuredGrid,
    coverGrid: config.focus.coverGrid,
    opaqueCoverMinAlpha: config.focus.opaqueCoverMinAlpha,
    invisibleCoverMaxOpacity: config.focus.invisibleCoverMaxOpacity,
    icon: {
      clipMarginCssPx: config.icon.clipMarginCssPx,
      minControlSizeCssPx: config.icon.minControlSizeCssPx,
      maxGraphicSizeCssPx: config.icon.maxGraphicSizeCssPx,
      iconFontFamilyPattern: config.icon.iconFontFamilyPattern,
      inactiveHintPattern: config.icon.inactiveHintPattern,
      logoHintPattern: config.icon.logoHintPattern,
      homeLinkNamePattern: config.icon.homeLinkNamePattern,
      minPaintedSizeCssPx: config.icon.minPaintedSizeCssPx,
      boxToleranceCssPx: config.icon.boxToleranceCssPx,
      boundaryProbeInsetCssPx: config.icon.boundaryProbeInsetCssPx,
      minVisibleTextCssPx: config.icon.minVisibleTextCssPx,
      boundaryWrapperLevels: config.icon.boundaryWrapperLevels,
      boundaryWrapperSlackCssPx: config.icon.boundaryWrapperSlackCssPx,
      coverGrid: config.icon.coverGrid,
    },
    headings: {
      maxBlocks: config.headings.maxBlocks,
      maxTextChars: config.headings.maxTextChars,
      minVisibleTextCssPx: config.headings.minVisibleTextCssPx,
      minFontSizeCssPx: config.headings.minFontSizeCssPx,
      regionSelector: config.headings.regionSelector,
      clipMarginCssPx: config.headings.clipMarginCssPx,
      clipAboveCssPx: config.headings.clipAboveCssPx,
      clipBelowCssPx: config.headings.clipBelowCssPx,
      sameLineMinOverlap: config.headings.sameLineMinOverlap,
      mergeMaxGapEm: config.headings.mergeMaxGapEm,
    },
    lists: {
      lineStartChars: config.lists.lineStartChars,
      lineEndChars: config.lists.lineEndChars,
      keySeparatorChars: config.lists.keySeparatorChars,
      maxGroupParents: config.lists.maxGroupParents,
      maxAncestorLevels: config.lists.maxAncestorLevels,
      markerAncestorLevels: config.lists.markerAncestorLevels,
      maxGroups: config.lists.maxGroups,
      maxGroupItems: config.lists.maxGroupItems,
      maxListElements: config.lists.maxListElements,
      markerMinSizeCssPx: config.lists.markerMinSizeCssPx,
      markerMaxSizeCssPx: config.lists.markerMaxSizeCssPx,
      markerMaxGapEm: config.lists.markerMaxGapEm,
      markerRoomEm: config.lists.markerRoomEm,
      shapeDepth: config.lists.shapeDepth,
      minRepeatedItems: config.lists.minRepeatedItems,
      itemTextMaxChars: config.lists.itemTextMaxChars,
      clipMarginCssPx: config.lists.clipMarginCssPx,
      clipMarkerRoomCssPx: config.lists.clipMarkerRoomCssPx,
      sameRowMinOverlap: config.lists.sameRowMinOverlap,
    },
    grouping: {
      maxControls: config.grouping.maxControls,
      maxNameChars: config.grouping.maxNameChars,
      maxAncestorLevels: config.grouping.maxAncestorLevels,
      minControlSizeCssPx: config.grouping.minControlSizeCssPx,
      clipMarginCssPx: config.grouping.clipMarginCssPx,
      maxLabelTargets: config.grouping.maxLabelTargets,
    },
    selector: {
      unstableIdPattern: config.selector.unstableIdPattern,
      stableAttributes: config.selector.stableAttributes,
      signatureMaxTextChars: config.selector.signatureMaxTextChars,
      signatureAttributes: config.selector.signatureAttributes,
    },
  };
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
  /** Called when `body` is over, before anything is put back: a gate on `cdp` is opened here (see `gateSession`). */
  beforeRestore: () => void | Promise<void> = () => undefined,
): Promise<T> {
  const scale = config.focus.deviceScaleFactor;
  const overrideMotion = !original.reducedMotion;
  // Sending a media feature list also resets the media type, so the one in effect is sent along.
  const setMedia = (features: { name: string; value: string }[]): Promise<unknown> =>
    cdp.send('Emulation.setEmulatedMedia', { media: original.mediaType === 'print' ? 'print' : '', features });

  let agentReady = false;
  const agent = async <R>(call: string): Promise<R> => (await world.evaluate(`${AGENT_GLOBAL}.${call}`)).result.value as R;

  const screenshot = async (clip: Box): Promise<Capture> => {
    const { data } = (await cdp.send('Page.captureScreenshot', {
      format: 'png',
      // Page coordinates, verified against Chrome: the clip origin is the document, not the viewport.
      clip: { ...clip, scale: 1 },
      captureBeyondViewport: false,
    })) as { data: string };
    const png = decodeBase64(data);
    return { png, scale: captureScale(png, clip, scale, config.focus.captureSizeTolerancePx) };
  };

  const hitKinds: StablePage['hitKinds'] = async (key, points, mode) => {
    const kinds: ('own' | 'cover' | 'unknown')[] = [];
    // Neighbouring points mostly hit the same node.
    const known = new Map<number, AgentHitKind | 'unknown'>();
    for (const [x, y] of points) {
      let kind: AgentHitKind | 'unknown' = 'unknown';
      try {
        // Document coordinates of the top document, whole CSS pixels (verified against Chrome).
        const { backendNodeId } = (await cdp.send('DOM.getNodeForLocation', {
          x: Math.floor(x),
          y: Math.floor(y),
          includeUserAgentShadowDOM: false,
          ignorePointerEventsNone: true,
        })) as { backendNodeId: number };
        const cached = known.get(backendNodeId);
        if (cached) kind = cached;
        else {
          // A pseudo-element resolves to a CSSPseudoElement object, which names its element.
          const { object } = (await cdp.send('DOM.resolveNode', {
            backendNodeId,
            executionContextId: world.contextId,
            objectGroup: HIT_OBJECT_GROUP,
          })) as { object: { objectId?: string } };
          const { result } = (await cdp.send('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: `function () { return globalThis.${AGENT_GLOBAL}.hitKind(${key}, this, ${JSON.stringify(mode)}); }`,
            returnByValue: true,
          })) as { result: { value?: unknown } };
          if (result.value === 'own' || result.value === 'through' || result.value === 'cover') kind = result.value;
          known.set(backendNodeId, kind);
        }
        // The top paints nothing: what counts is what lies under it.
        if (kind === 'through') kind = (await agent<boolean>(`coveredBelow(${key}, ${x}, ${y}, ${JSON.stringify(mode)})`)) ? 'cover' : 'own';
      } catch {
        // No node at that point, or it could not be brought into the agent's world.
        kind = 'unknown';
      }
      kinds.push(kind);
    }
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: HIT_OBJECT_GROUP }).catch(() => undefined);
    return kinds;
  };

  const page: StablePage = {
    cdp,
    contextId: world.contextId,
    clips,
    agent,
    screenshot,
    hitKinds,
    capture: async (id, clip) => {
      const capture = await screenshot(clip);
      clips[id] = { box: clip, scale: capture.scale, png: capture.png };
      return capture;
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
    const options = agentOptions(config);
    await world.evaluate(`globalThis.${AGENT_GLOBAL} = (${agentFactory.toString()})(${JSON.stringify(options)}); 1`);
    agentReady = true;

    // Always sent, also when the page already has this device pixel ratio: a ratio that comes from
    // emulation set through another session (a Playwright context with deviceScaleFactor) is not
    // applied to screenshots taken through this one, which then come back at 1x (verified).
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      ...original.viewport,
      deviceScaleFactor: scale,
      mobile: false,
    });
    if (overrideMotion) await setMedia([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    await cdp.send('DOM.getDocument', { depth: 0 });
    await agent('stabilise()');
    return await body(page);
  } finally {
    await beforeRestore();
    if (agentReady) await agent('cleanup()').catch(() => undefined);
    await cdp.send('CSS.disable').catch(() => undefined);
    await cdp.send('DOM.disable').catch(() => undefined);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined);
    if (overrideMotion) await setMedia([]).catch(() => undefined);
    await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
  }
}
