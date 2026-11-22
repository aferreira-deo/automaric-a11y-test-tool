import { collectSnapshot } from '@a11y-vision/collector-cdp';
import type { CdpSession } from '@a11y-vision/collector-cdp';
import { buildResult, resolveConfig } from '@a11y-vision/core';
import type { CheckId, ConfigInput, ScanResult } from '@a11y-vision/core';
import type { Page } from 'playwright-core';

/**
 * Usage, as with @axe-core/playwright:
 *
 *   const result = await new A11yVision({ page }).withChecks(['noop']).analyze();
 *
 * Chromium only: collection runs over the Chrome DevTools Protocol.
 */
export class A11yVision {
  readonly #page: Page;
  #config: ConfigInput = {};

  constructor({ page }: { page: Page }) {
    this.#page = page;
  }

  withChecks(checks: CheckId[]): this {
    this.#config = { ...this.#config, checks };
    return this;
  }

  options(config: ConfigInput): this {
    this.#config = { ...this.#config, ...config };
    return this;
  }

  async analyze(): Promise<ScanResult> {
    const config = resolveConfig(this.#config);
    const session = await this.#page.context().newCDPSession(this.#page);
    // Playwright types `send`/`on` against its own protocol map; the collector speaks plain CDP.
    const cdp: CdpSession = {
      send: (method, params) => session.send(method as never, params as never),
      on: (event, handler) => void session.on(event as never, handler as never),
      off: (event, handler) => void session.off(event as never, handler as never),
    };
    try {
      const snapshot = await collectSnapshot(cdp);
      return buildResult(snapshot, config, new Date());
    } finally {
      await session.detach();
    }
  }
}

export type { CheckId, ConfigInput, Finding, ScanResult, Status } from '@a11y-vision/core';
