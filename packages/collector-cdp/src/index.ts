import type { Environment, Snapshot } from '@a11y-vision/core';

/**
 * The slice of a CDP client the collector needs.
 * Playwright's CDPSession and a thin wrapper over chrome.debugger both satisfy it.
 */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (params: unknown) => void): void;
  off(event: string, handler: (params: unknown) => void): void;
}

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

/** M0: environment only. Nodes, accessibility tree and screenshots arrive with the checks that need them. */
export async function collectSnapshot(cdp: CdpSession): Promise<Snapshot> {
  const environment = (await evaluate(cdp, ENVIRONMENT_EXPRESSION)) as Environment;
  return {
    environment,
    nodes: [],
    axTree: [],
    screenshots: { tiles: [], clips: {} },
  };
}
