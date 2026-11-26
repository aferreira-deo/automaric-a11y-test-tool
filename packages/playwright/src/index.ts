import { adjudicateFindings, createAdjudicator } from '@a11y-vision/adjudicators';
import type { Adjudicator, AdjudicationStats, Env, VerdictCache } from '@a11y-vision/adjudicators';
import { verifyEndpoint } from '@a11y-vision/adjudicators/node';
import { collectSnapshot } from '@a11y-vision/collector-cdp';
import type { CdpSession } from '@a11y-vision/collector-cdp';
import { buildResult, resolveConfig } from '@a11y-vision/core';
import type { AdjudicationInput, CheckId, ConfigInput, Png, ScanResult, Snapshot } from '@a11y-vision/core';
import type { CDPSession, Page } from 'playwright-core';
import { loadVerdictCache, saveVerdictCache } from './cache-file.js';
import { playwrightProbeHost } from './probe-host.js';
import type { ProbeContextOptions } from './probe-host.js';

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
 * The CDP session each page is scanned through, kept for as long as the page lives. Chrome holds one device
 * metrics override per page, and drops the one a session set when that session detaches, which leaves the page
 * at the size of its window and a scale of 1 instead of the context's emulation. Kept attached, the session puts
 * back the metrics the page had (`emulation: 'reapply'`) and they stay.
 */
const sessions = new WeakMap<Page, CDPSession>();

async function sessionFor(page: Page): Promise<CDPSession> {
  const known = sessions.get(page);
  if (known) return known;
  const session = await page.context().newCDPSession(page);
  sessions.set(page, session);
  page.once('close', () => sessions.delete(page));
  return session;
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
  readonly #probeContext: ProbeContextOptions;
  #config: ConfigInput = {};
  #runtime: AdjudicationRuntime = {};

  /**
   * `probeContext`: what the copies of the page the name-role-value check probes in need beyond
   * what is read from the page (HTTP credentials, extra headers), as the context of the page has
   * them, and, when it cannot be read from the page's browser, where their reads go (`proxy`,
   * `hostResolverRules`, `ignoreHTTPSErrors`) and the Chromium to probe in (`executablePath`,
   * `channel`). Probing never happens in `page`: see the README, "The probing safety model".
   */
  constructor({ page, probeContext = {} }: { page: Page; probeContext?: ProbeContextOptions }) {
    this.#page = page;
    this.#probeContext = probeContext;
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
   * Has a model judge the candidates that deterministic code found (at present: heading candidates
   * and series of lines with bullets or numbers). Without this call, and without `adjudication` in
   * `options`, no model is asked and nothing is sent anywhere.
   *
   *   scanner.withAdjudication({ baseUrl: 'http://127.0.0.1:<port>/v1', model: '<model>' })
   *
   * Giving a base URL and a model selects the OpenAI-compatible adapter. An endpoint that is not
   * on this machine also needs `allowRemote: true` and an https URL. The key, if the endpoint
   * wants one, is read from the environment variable named in `apiKeyEnv`.
   */
  withAdjudication(settings: AdjudicationInput, runtime: AdjudicationRuntime = {}): this {
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
    // A name for this machine (`localhost`, `*.localhost`) has to resolve to this machine. The
    // requests check that again when they connect; this is the refusal that can be read.
    if (adjudicator && !this.#runtime.adjudicator) await verifyEndpoint(config.adjudication);
    const session = await sessionFor(this.#page);
    // Playwright types `send`/`on` against its own protocol map; the collector speaks plain CDP.
    const cdp: CdpSession = {
      send: (method, params) => session.send(method as never, params as never),
      on: (event, handler) => void session.on(event as never, handler as never),
      off: (event, handler) => void session.off(event as never, handler as never),
    };
    let snapshot: Snapshot;
    try {
      // Probing happens in a browser of its own, in copies of the page; never in this page.
      const probing = config.checks.includes('name-role-value') && config.nameRoleValue.probe === 'safe';
      snapshot = await collectSnapshot(cdp, config, { emulation: 'reapply', ...(probing ? { probeHost: playwrightProbeHost(this.#page, this.#probeContext) } : {}) });
    } finally {
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
   * Chrome keeps one device-metrics override and one emulated media type per page. The device metrics are put
   * back by the collector itself, through the session kept for the page: the size, device scale factor, mobile
   * emulation, `screen` and page scale the page had before the scan (`emulation: 'reapply'`). Calling
   * `page.setViewportSize` here would not do it: Playwright skips a size it believes it has already set, and
   * when it does send one it makes `screen` the size of the viewport. The emulated media is sent again by
   * Playwright: the collector cleared what it set for `prefers-reduced-motion`.
   */
  async #restoreEmulation(): Promise<void> {
    if (this.#page.isClosed()) return;
    await this.#page.emulateMedia({});
  }
}

export { loadVerdictCache, saveVerdictCache } from './cache-file.js';
export { playwrightProbeHost } from './probe-host.js';
export type { ProbeContextOptions } from './probe-host.js';
export type { Adjudicator, AdjudicationStats, VerdictCache } from '@a11y-vision/adjudicators';
export type { AdjudicationConfig, AdjudicationInput, CheckId, ConfigInput, Finding, ScanResult, Status } from '@a11y-vision/core';
