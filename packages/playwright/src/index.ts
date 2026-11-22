import { adjudicateFindings, createAdjudicator } from '@a11y-vision/adjudicators';
import type { Adjudicator, AdjudicationStats, Env, VerdictCache } from '@a11y-vision/adjudicators';
import { collectSnapshot } from '@a11y-vision/collector-cdp';
import type { CdpSession } from '@a11y-vision/collector-cdp';
import { buildResult, resolveConfig } from '@a11y-vision/core';
import type { AdjudicationConfig, CheckId, ConfigInput, Png, ScanResult, Snapshot } from '@a11y-vision/core';
import type { Page } from 'playwright-core';
import { loadVerdictCache, saveVerdictCache } from './cache-file.js';

/** How the adjudicator layer is run from here. All optional. */
export interface AdjudicationRuntime {
  /** Where the API key is looked up, under the name given in `apiKeyEnv`. Defaults to `process.env`. */
  env?: Env;
  /** A JSON file that keeps verdicts between runs. Without it, and without `cache`, nothing is kept. */
  cacheFile?: string;
  /** A cache of your own, in place of `cacheFile`. */
  cache?: VerdictCache;
  /** An adapter of your own, in place of the one the settings describe. */
  adjudicator?: Adjudicator;
}

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
  #runtime: AdjudicationRuntime = {};

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

  /**
   * Has a model judge the candidates that deterministic code found (at present: heading
   * candidates). Without this call, and without `adjudication` in `options`, no model is asked
   * and nothing is sent anywhere.
   *
   *   scanner.withAdjudication({ baseUrl: 'http://127.0.0.1:<port>/v1', model: '<model>' })
   *
   * Giving a base URL and a model selects the OpenAI-compatible adapter. An endpoint that is not
   * on this machine also needs `allowRemote: true`. The key, if the endpoint wants one, is read
   * from the environment variable named in `apiKeyEnv`.
   */
  withAdjudication(settings: Partial<AdjudicationConfig>, runtime: AdjudicationRuntime = {}): this {
    const adjudication = { ...this.#config.adjudication, ...settings };
    // Asked for by this call: a provider is selected unless the settings name one themselves.
    if (adjudication.provider === undefined) adjudication.provider = 'openai-compatible';
    this.#config = { ...this.#config, adjudication };
    this.#runtime = { ...this.#runtime, ...runtime };
    return this;
  }

  async analyze(): Promise<ScanResult> {
    return (await this.analyzeWithEvidence()).result;
  }

  /**
   * Like analyze(), plus the PNG crops the findings refer to, keyed by the ids in `evidence.crops`,
   * and, when a model was asked, what the adjudicator layer did (counts; not part of the result).
   */
  async analyzeWithEvidence(): Promise<{ result: ScanResult; crops: Record<string, Png>; adjudication?: AdjudicationStats }> {
    const config = resolveConfig(this.#config);
    // Before anything is done to the page: a provider that cannot be used stops the scan here.
    const adjudicator = this.#runtime.adjudicator ?? createAdjudicator(config.adjudication, this.#runtime.env ?? process.env);
    const session = await this.#page.context().newCDPSession(this.#page);
    // Playwright types `send`/`on` against its own protocol map; the collector speaks plain CDP.
    const cdp: CdpSession = {
      send: (method, params) => session.send(method as never, params as never),
      on: (event, handler) => void session.on(event as never, handler as never),
      off: (event, handler) => void session.off(event as never, handler as never),
    };
    let snapshot: Snapshot;
    try {
      snapshot = await collectSnapshot(cdp, config);
    } finally {
      await session.detach();
      await this.#restoreEmulation();
    }
    const result = buildResult(snapshot, config, new Date());
    // The model is asked once the page has been given back: it works from the snapshot alone,
    // and can take long.
    let adjudication: AdjudicationStats | undefined;
    if (adjudicator) {
      const { cacheFile } = this.#runtime;
      const fileCache = !this.#runtime.cache && cacheFile ? await loadVerdictCache(cacheFile, config.adjudication) : undefined;
      const cache = this.#runtime.cache ?? fileCache;
      const judged = await adjudicateFindings({ snapshot, findings: result.findings, config, adjudicator, ...(cache ? { cache } : {}) });
      result.findings = judged.findings;
      adjudication = judged.stats;
      // A cache that cannot be written costs calls next time, not this scan.
      if (fileCache && cacheFile) await saveVerdictCache(cacheFile, fileCache).catch(() => undefined);
    }
    const crops: Record<string, Png> = {};
    for (const id of result.findings.flatMap((finding) => finding.evidence.crops)) {
      const clip = snapshot.screenshots.clips[id];
      if (clip) crops[id] = clip.png;
    }
    return { result, crops, ...(adjudication ? { adjudication } : {}) };
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

export { loadVerdictCache, saveVerdictCache } from './cache-file.js';
export type { Adjudicator, AdjudicationStats, VerdictCache } from '@a11y-vision/adjudicators';
export type { AdjudicationConfig, CheckId, ConfigInput, Finding, ScanResult, Status } from '@a11y-vision/core';
