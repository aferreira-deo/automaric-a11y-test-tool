import type { Environment } from '@a11y-vision/core';
import type { CdpSession } from './session.js';

const WORLD_NAME = 'a11y-vision';

export interface EvaluateResponse {
  result: { value?: unknown; objectId?: string };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

/** The page as the collector found it: what goes in the report, plus what it needs to emulate on top. */
export interface PageEnvironment extends Environment {
  reducedMotion: boolean;
  /** `print` when the page is rendered for print (an emulation set by the caller), else `screen`. */
  mediaType: 'print' | 'screen';
}

/** An isolated world in the main frame, and an evaluator bound to it. */
export interface World {
  contextId: number;
  evaluate(expression: string, byValue?: boolean): Promise<EvaluateResponse>;
}

/**
 * Everything the collector evaluates runs in an isolated world: it shares the DOM with the page
 * but not its JavaScript objects, so a page that redefines `window.innerWidth`, `matchMedia`
 * or a prototype method cannot feed values to the collector or to the report.
 */
export async function createWorld(cdp: CdpSession): Promise<World> {
  const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
  const { executionContextId } = (await cdp.send('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id,
    worldName: WORLD_NAME,
  })) as { executionContextId: number };
  return {
    contextId: executionContextId,
    async evaluate(expression, byValue = true) {
      const response = (await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: byValue,
        awaitPromise: true,
        contextId: executionContextId,
      })) as EvaluateResponse;
      if (response.exceptionDetails) {
        const { text, exception } = response.exceptionDetails;
        throw new Error(`Page evaluation failed: ${exception?.description ?? text}`);
      }
      return response;
    },
  };
}

const ENVIRONMENT_EXPRESSION = `({
  url: location.href,
  devicePixelRatio: window.devicePixelRatio,
  width: window.innerWidth,
  height: window.innerHeight,
  dark: matchMedia('(prefers-color-scheme: dark)').matches,
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  print: matchMedia('print').matches,
})`;

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`The page reported no usable ${name} (${typeof value}).`);
  }
  return value;
}

/** Reads the environment in the isolated world and checks every value: nothing is passed on as it came. */
export async function readEnvironment(world: World): Promise<PageEnvironment> {
  const raw = ((await world.evaluate(ENVIRONMENT_EXPRESSION)).result.value ?? {}) as Record<string, unknown>;
  return {
    url: typeof raw['url'] === 'string' ? raw['url'] : '',
    devicePixelRatio: finite(raw['devicePixelRatio'], 'device pixel ratio'),
    viewport: { width: finite(raw['width'], 'viewport width'), height: finite(raw['height'], 'viewport height') },
    colorScheme: raw['dark'] === true ? 'dark' : 'light',
    reducedMotion: raw['reducedMotion'] === true,
    mediaType: raw['print'] === true ? 'print' : 'screen',
  };
}
