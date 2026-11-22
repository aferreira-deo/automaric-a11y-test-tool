import type { Config, Environment, Snapshot } from '@a11y-vision/core';
import { collectFocus } from './focus.js';
import type { CdpSession } from './session.js';

export type { CdpSession } from './session.js';

interface EvaluateResponse {
  result: { value?: unknown };
  exceptionDetails?: { text: string };
}

const ENVIRONMENT_EXPRESSION = `({
  url: location.href,
  devicePixelRatio: window.devicePixelRatio,
  viewport: { width: window.innerWidth, height: window.innerHeight },
  colorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
})`;

async function evaluate(cdp: CdpSession, expression: string): Promise<unknown> {
  const response = (await cdp.send('Runtime.evaluate', { expression, returnByValue: true })) as EvaluateResponse;
  if (response.exceptionDetails) {
    throw new Error(`Page evaluation failed: ${response.exceptionDetails.text}`);
  }
  return response.result.value;
}

/** Collects what the configured checks need, and nothing else. */
export async function collectSnapshot(cdp: CdpSession, config: Config): Promise<Snapshot> {
  const environment = (await evaluate(cdp, ENVIRONMENT_EXPRESSION)) as Environment;
  const snapshot: Snapshot = {
    environment,
    nodes: [],
    axTree: [],
    screenshots: { tiles: [], clips: {} },
  };
  if (config.checks.includes('focus-indicator')) {
    snapshot.focus = await collectFocus(cdp, config.focus, snapshot.screenshots.clips);
    // The captures were taken at this scale, whatever the page had before.
    snapshot.environment = { ...environment, devicePixelRatio: config.focus.deviceScaleFactor };
  }
  return snapshot;
}
