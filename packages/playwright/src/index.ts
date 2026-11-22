import { collectSnapshot } from '@a11y-vision/collector-cdp';
import type { CdpSession } from '@a11y-vision/collector-cdp';
import { buildResult, resolveConfig } from '@a11y-vision/core';
import type { CheckId, ConfigInput, Png, ScanResult } from '@a11y-vision/core';
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
    return (await this.analyzeWithEvidence()).result;
  }

  /** Like analyze(), plus the PNG crops the findings refer to, keyed by the ids in `evidence.crops`. */
  async analyzeWithEvidence(): Promise<{ result: ScanResult; crops: Record<string, Png> }> {
    const config = resolveConfig(this.#config);
    const session = await this.#page.context().newCDPSession(this.#page);
    // Playwright types `send`/`on` against its own protocol map; the collector speaks plain CDP.
    const cdp: CdpSession = {
      send: (method, params) => session.send(method as never, params as never),
      on: (event, handler) => void session.on(event as never, handler as never),
      off: (event, handler) => void session.off(event as never, handler as never),
    };
    try {
      const snapshot = await collectSnapshot(cdp, config);
      const result = buildResult(snapshot, config, new Date());
      const crops: Record<string, Png> = {};
      for (const id of result.findings.flatMap((finding) => finding.evidence.crops)) {
        const clip = snapshot.screenshots.clips[id];
        if (clip) crops[id] = clip.png;
      }
      return { result, crops };
    } finally {
      await session.detach();
      await this.#restoreEmulation();
    }
  }

  /**
   * Chrome keeps one device-metrics override and one emulated media type per page. The collector
   * replaces them through its own session and can only clear them, which also wipes what
   * Playwright had applied for the context (viewport, deviceScaleFactor, isMobile) and for the
   * page (emulateMedia). Both calls below make Playwright send its current state again; neither
   * changes that state.
   *
   * Not restored, because Playwright has no call that sends it again: the context's `screen`
   * option. After a scan `screen.width` and `screen.height` equal the viewport size.
   */
  async #restoreEmulation(): Promise<void> {
    if (this.#page.isClosed()) return;
    await this.#page.emulateMedia({});
    const viewport = this.#page.viewportSize();
    if (viewport) await this.#page.setViewportSize(viewport);
  }
}

export type { CheckId, ConfigInput, Finding, ScanResult, Status } from '@a11y-vision/core';
