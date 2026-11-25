import { NRV_SCRIPT_READ_TYPES } from '@a11y-vision/core';
import type { NameRoleValueConfig, NrvNavigation, NrvProbeLog } from '@a11y-vision/core';
import type { ProbeBrowser, ProbeFetchResponse } from './probe-host.js';

/**
 * The network of the probing browser, held at its browser target: every request of every page,
 * frame and worker of that browser pauses here (`Fetch.enable` on the browser session, verified
 * for pages, frames of another origin, dedicated, shared and service workers, beacons and
 * `keepalive` requests sent as a page goes away), and gets either a response or an error. None
 * is ever continued to the network: the browser has no network of its own (its proxy refuses
 * every connection), and what a copy receives was fetched here, by the collector.
 *
 * - While a copy loads (`openLoad` to `closeLoad`), its GET and HEAD requests are fetched from
 *   the server, or given what was already fetched: that is a page view. Requests of anything that
 *   is not that copy (a page that is gone, a popup) are not.
 * - Otherwise, a GET or HEAD is given what was fetched while a copy loaded (`probeReads: cache`),
 *   or also fetched when it is a read of `probeAllowedResourceTypes` (`probeReads: network`).
 *   Everything else is stopped and recorded: every other method, every navigation, every read
 *   that was not fetched before.
 */

interface PausedRequest {
  requestId: string;
  request: { url: string; method: string; headers?: Record<string, string> };
  resourceType: string;
  frameId?: string;
}

interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  sameSite?: string;
  partitionKey?: { topLevelSite?: string } | string;
}

/** What a probe saw of the network while it ran. */
export interface ActivationNetwork {
  navigations: NrvNavigation[];
  /** Requests of another method than GET or HEAD to the site of the page (not beacons): it performs an action. */
  writes: number;
  /** Reads of a script that were stopped. */
  blockedReads: number;
  /** Every request the activation led to, served or stopped. */
  requests: number;
  url: string;
  fields: string[];
}

/** The copy being probed or loaded: what its requests are told apart by. */
export interface CurrentCopy {
  browserContextId: string;
  mainFrameId: string;
  frames: Set<string>;
  url: string;
  cookies(url: string): Promise<Cookie[]>;
}

/** Headers a request is never sent with by the collector: they are the connection's, or set again. */
const DROPPED_REQUEST_HEADERS = ['cookie', 'host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'accept-encoding', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'expect'];
/** Headers of a response that do not describe the body given to the copy (it is decoded) or the connection. */
const DROPPED_RESPONSE_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'alt-svc'];

/** Origin and path of an address: no query, no fragment, no credentials. */
export function shownUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return `${parsed.protocol}…`;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(not an address)';
  }
}

export function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/**
 * The registrable part of a host name, approximately (no public suffix list here): the last two
 * labels, or three under a short second-level label of a country (`co.uk`, `gouv.fr`, `com.au`).
 * An address of a machine is its own site.
 */
export function siteOf(url: string): string {
  let host: string;
  let scheme: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    scheme = parsed.protocol;
  } catch {
    return url;
  }
  if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return `${scheme}//${host}`;
  const labels = host.split('.');
  const last = labels[labels.length - 1] ?? '';
  const second = labels[labels.length - 2] ?? '';
  const count = labels.length >= 3 && last.length === 2 && SECOND_LEVEL.includes(second) ? 3 : 2;
  return `${scheme}//${labels.slice(-count).join('.')}`;
}

/** Second-level labels under which countries register names (`co.uk`, `gouv.fr`, `com.au`): the usual ones, not a full list. */
const SECOND_LEVEL = ['co', 'com', 'net', 'org', 'gov', 'gouv', 'ac', 'edu', 'ne', 'or', 'go', 'gob', 'mil', 'nic', 'ltd', 'plc', 'asso', 'nom', 'sch', 'nhs', 'police'];

function withoutFragment(url: string): string {
  const index = url.indexOf('#');
  return index < 0 ? url : url.slice(0, index);
}

export class ProbeNetwork {
  private readonly cache = new Map<string, ProbeFetchResponse>();
  private cacheBytes = 0;
  private loading = false;
  private current: CurrentCopy | null = null;
  private readonly contextOf = new Map<string, string>();
  private readonly destroyed = new Map<string, () => void>();
  private readonly blockedKinds = new Set<string>();
  private inFlight = 0;
  private activation: ActivationNetwork | null = null;
  private readonly handlers: { event: string; handler: (params: unknown) => void }[] = [];
  /** A test-only hook (see `CollectOptions.probeTestUnblock`): reads whose address matches are fetched while probing. */
  private readonly testUnblock: RegExp | undefined;

  constructor(
    private readonly probe: ProbeBrowser,
    private readonly config: NameRoleValueConfig,
    private readonly log: NrvProbeLog,
    testUnblock?: RegExp,
  ) {
    this.testUnblock = testUnblock;
  }

  /** Holds every request of the browser from here on. Called before any copy exists. */
  async enable(): Promise<void> {
    const on = (event: string, handler: (params: unknown) => void): void => {
      this.probe.browser.on(event, handler);
      this.handlers.push({ event, handler });
    };
    on('Fetch.requestPaused', (params) => void this.paused(params as PausedRequest));
    const known = (params: unknown): void => {
      const info = (params as { targetInfo: { targetId: string; browserContextId?: string; openerId?: string; type: string } }).targetInfo;
      if (info.browserContextId) this.contextOf.set(info.targetId, info.browserContextId);
    };
    on('Target.targetCreated', (params) => {
      known(params);
      const info = (params as { targetInfo: { targetId: string; openerId?: string; type: string } }).targetInfo;
      // A window a copy opened all the same (the guard stops window.open and links to a new window): closed at once.
      const context = (params as { targetInfo: { browserContextId?: string } }).targetInfo.browserContextId;
      if (this.current && info.type === 'page' && info.targetId !== this.current.mainFrameId && (info.openerId === this.current.mainFrameId || (context !== undefined && context === this.current.browserContextId))) {
        this.log.popups++;
        this.activation?.navigations.push({ kind: 'window', url: '' });
        this.probe.browser.send('Target.closeTarget', { targetId: info.targetId }).catch(() => undefined);
      }
    });
    on('Target.targetInfoChanged', known);
    on('Target.targetDestroyed', (params) => {
      const { targetId } = params as { targetId: string };
      this.destroyed.get(targetId)?.();
      this.destroyed.delete(targetId);
    });
    await this.probe.browser.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }], handleAuthRequests: false });
    await this.probe.browser.send('Target.setDiscoverTargets', { discover: true });
  }

  disable(): void {
    // The browser is closed with every request still held: nothing is ever let go.
    for (const { event, handler } of this.handlers) this.probe.browser.off(event, handler);
    this.log.blocked = [...this.blockedKinds].sort();
  }

  /** A promise that settles when the target is destroyed, `timeoutMs` at most. */
  destroyedOf(targetId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.destroyed.set(targetId, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  setCurrent(copy: CurrentCopy | null): void {
    // The frames of a copy that goes are never a copy's again.
    if (this.current) {
      this.retired.add(this.current.mainFrameId);
      for (const frame of this.current.frames) this.retired.add(frame);
      for (const [target, context] of this.contextOf) if (context === this.current.browserContextId) this.retired.add(target);
    }
    this.current = copy;
  }

  /** From here, the requests of the current copy are a load: fetched from the server. */
  openLoad(): void {
    this.loading = true;
  }

  closeLoad(): void {
    this.loading = false;
  }

  /** Requests being answered. */
  busy(): number {
    return this.inFlight;
  }

  startActivation(url: string, fields: string[]): void {
    this.activation = { navigations: [], writes: 0, blockedReads: 0, requests: 0, url, fields };
  }

  takeActivation(): ActivationNetwork {
    const taken = this.activation ?? { navigations: [], writes: 0, blockedReads: 0, requests: 0, url: '', fields: [] };
    this.activation = { ...taken, navigations: [], writes: 0, blockedReads: 0, requests: 0 };
    return taken;
  }

  endActivation(): void {
    this.activation = null;
  }

  /**
   * The request is the current copy's: from its frames, or from a target of its context. A frame
   * or a target the browser reports only after its first request (events of two sessions do not
   * come in order) is the current copy's too, unless it belonged to a copy that was destroyed.
   */
  private belongs(frameId: string | undefined): boolean {
    const copy = this.current;
    if (!copy || !frameId) return false;
    if (frameId === copy.mainFrameId || copy.frames.has(frameId)) return true;
    const context = this.contextOf.get(frameId);
    if (context !== undefined) return context === copy.browserContextId;
    return !this.retired.has(frameId);
  }

  private readonly retired = new Set<string>();

  private fieldValueIn(url: string): boolean {
    const fields = this.activation?.fields ?? [];
    try {
      const query = decodeURIComponent(new URL(url).search.replace(/\+/g, ' ')).toLowerCase();
      return fields.some((value) => query.includes(value.toLowerCase()));
    } catch {
      return false;
    }
  }

  private async paused(event: PausedRequest): Promise<void> {
    this.inFlight++;
    try {
      await this.answer(event);
    } catch {
      await this.probe.browser.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' }).catch(() => undefined);
    } finally {
      this.inFlight--;
    }
  }

  private fail(event: PausedRequest, reason: string): Promise<unknown> {
    return this.probe.browser.send('Fetch.failRequest', { requestId: event.requestId, errorReason: reason }).catch(() => undefined);
  }

  private async answer(event: PausedRequest): Promise<void> {
    const method = event.request.method.toUpperCase();
    const url = event.request.url;
    const type = event.resourceType;
    const read = method === 'GET' || method === 'HEAD';
    const ours = this.belongs(event.frameId);
    const activation = this.activation;
    if (activation && ours) activation.requests++;
    const key = `${method} ${url} ${event.request.headers?.['Range'] ?? event.request.headers?.['range'] ?? ''}`;
    const cached = read ? this.cache.get(key) : undefined;

    const stop = async (): Promise<void> => {
      this.blockedKinds.add(`${method} ${type} ${shownUrl(url)}`);
      if (activation && ours) {
        if (!read && type !== 'Ping' && type !== 'CSPViolationReport' && this.current && siteOf(url) === siteOf(this.current.url)) activation.writes++;
        if (read && NRV_SCRIPT_READ_TYPES.includes(type)) activation.blockedReads++;
        if (type === 'Document') {
          activation.navigations.push({
            kind: event.frameId === this.current?.mainFrameId ? 'document' : 'frame',
            url: shownUrl(url),
            method,
            otherPath: pathOf(url) !== pathOf(activation.url),
            carriesFieldValue: this.fieldValueIn(url),
          });
        }
      }
      // Aborted, not BlockedByClient, for a navigation: the frame then stays on its document instead of an error page.
      await this.fail(event, type === 'Document' ? 'Aborted' : 'BlockedByClient');
    };

    if (!read) return stop();
    // A copy that loads: its own reads are fetched (a page view), or given what was fetched before.
    if (this.loading && ours) {
      if (cached) return this.give(event, cached);
      return this.fetchAndGive(event, key, method);
    }
    // Probing: a navigation is the evidence that an element navigates, and is never followed.
    if (type === 'Document') return stop();
    if (cached) return this.give(event, cached);
    const query = (() => {
      try {
        return new URL(url).search !== '';
      } catch {
        return true;
      }
    })();
    const fetchable =
      ours &&
      this.config.probeReads === 'network' &&
      this.config.probeAllowedResourceTypes.includes(type) &&
      (this.config.probeAllowQueryStrings || !query);
    if (fetchable || (ours && this.testUnblock?.test(url))) return this.fetchAndGive(event, key, method);
    return stop();
  }

  private async give(event: PausedRequest, response: ProbeFetchResponse): Promise<void> {
    this.log.allowed++;
    await this.probe.browser.send('Fetch.fulfillRequest', {
      requestId: event.requestId,
      responseCode: response.status,
      responseHeaders: response.headers.length > 0 ? response.headers : [{ name: 'content-type', value: 'application/octet-stream' }],
      body: response.body,
    });
  }

  private async cookieHeader(url: string): Promise<string> {
    const copy = this.current;
    if (!copy) return '';
    const cookies = await copy.cookies(url).catch(() => [] as Cookie[]);
    const top = siteOf(copy.url);
    const sameSite = siteOf(url) === top;
    const kept = cookies.filter((cookie) => {
      if (cookie.partitionKey) {
        const partition = typeof cookie.partitionKey === 'string' ? cookie.partitionKey : (cookie.partitionKey.topLevelSite ?? '');
        if (siteOf(partition) !== top) return false;
      }
      // A cookie of another site goes along only when it says so (SameSite=None), as Chrome does.
      return sameSite || (cookie.sameSite ?? '').toLowerCase() === 'none';
    });
    return kept.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  private async fetchAndGive(event: PausedRequest, key: string, method: 'GET' | 'HEAD'): Promise<void> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(event.request.headers ?? {})) {
      const lower = name.toLowerCase();
      if (lower.startsWith(':') || DROPPED_REQUEST_HEADERS.includes(lower)) continue;
      headers[lower] = value;
    }
    const cookie = await this.cookieHeader(event.request.url);
    if (cookie !== '') headers['cookie'] = cookie;
    // The collector sends GET and HEAD and nothing else; the host refuses anything else too.
    if (method !== 'GET' && method !== 'HEAD') {
      this.log.unsafe++;
      await this.fail(event, 'BlockedByClient');
      return;
    }
    let response: ProbeFetchResponse;
    try {
      response = await this.probe.fetch({ url: event.request.url, method, headers }, { timeoutMs: this.config.probeLoadTimeoutMs, maxBytes: this.config.probeCacheMaxBytes });
    } catch {
      this.blockedKinds.add(`${method} ${event.resourceType} ${shownUrl(event.request.url)} (unreachable)`);
      await this.fail(event, 'Failed');
      return;
    }
    this.log.fetched++;
    const kept = { ...response, headers: response.headers.filter((header) => !DROPPED_RESPONSE_HEADERS.includes(header.name.toLowerCase())) };
    if (this.cacheBytes + kept.size <= this.config.probeCacheMaxBytes) {
      this.cache.set(key, kept);
      this.cacheBytes += kept.size;
    }
    await this.give(event, kept);
  }

  /** The address without its fragment equals the copy's: only the fragment changed. */
  static sameDocument(a: string, b: string): boolean {
    return withoutFragment(a) === withoutFragment(b);
  }
}
