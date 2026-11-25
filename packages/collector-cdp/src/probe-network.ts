import { NRV_SCRIPT_READ_TYPES } from '@a11y-vision/core';
import type { NameRoleValueConfig, NrvNavigation, NrvProbeLog } from '@a11y-vision/core';
import { isProbeReadRefused, isProbeReadTooLarge } from './probe-host.js';
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
 * - A read is sent where the page under test's own request would go, or not at all: the host
 *   follows the routing of the page's browser and refuses what it cannot follow
 *   (`ProbeReadRefused`), and a read that `probeLoadDeny` matches is never sent. What failed is
 *   kept (`failureOf`), so that a copy that did not load says why.
 * - The cookies of a read are never chosen here. The copy's context holds the cookies of the page
 *   under test, and Chromium itself attaches to each paused request the `Cookie` header it would
 *   send (SameSite with the frames above the request, Secure, prefixes, the public suffix list,
 *   the credentials mode, each hop of a redirect): that header is sent as it is. Partitioned
 *   cookies are not in it (Chromium adds them later, on the way out): they are not sent. Whether
 *   this Chromium attaches the header is checked once (`checkCookies`); when it does not, no
 *   cookie is sent at all. When the host says the page's browser may choose otherwise
 *   (`firstPartyCookiesOnly`), the header goes only with reads of the main frame to the page's host.
 * - At most `probeReadConcurrency` reads are under way at once, each within `probeReadMaxBytes`
 *   decoded and `probeReadMaxEncodedBytes` as sent; one that goes over is stopped and counted.
 */

interface PausedRequest {
  requestId: string;
  request: { url: string; method: string; headers?: Record<string, string> };
  resourceType: string;
  frameId?: string;
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
}

/** Headers a request is never sent with by the collector: they are the connection's, or set again. `cookie` is Chrome's, taken apart (see `fetchAndGive`). */
const DROPPED_REQUEST_HEADERS = ['cookie', 'host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'accept-encoding', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'expect'];

/** The name of the cookie that shows whether the probing Chromium gives its own `Cookie` header with a paused request (`checkCookies`). */
export const COOKIE_CHECK_NAME = 'a11y-vision-cookie-check';
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

/** A header of a paused request, whatever its case. */
function headerOf(headers: Record<string, string> | undefined, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers ?? {})) if (key.toLowerCase() === name) return value;
  return undefined;
}

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
    this.deny = config.probeLoadDeny.map((source) => new RegExp(source, 'u'));
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
    this.loadGiven.clear();
  }

  /** What the current copy was given while it loaded, by key. */
  private readonly loadGiven = new Set<string>();

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
    // The navigation of the cookie check: what Chromium attached is read, and it goes nowhere.
    if (this.cookieCheck && withoutFragment(url) === this.cookieCheck.url) {
      this.cookieCheck.seen = headerOf(event.request.headers, 'cookie') ?? '';
      await this.fail(event, 'Aborted');
      return;
    }
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
      if (cached) return this.give(event, cached, key);
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

  /** Gives a response; one a copy asks for again while it loads (`loadKey`: a picture its browser did not keep) is counted once. */
  private async give(event: PausedRequest, response: ProbeFetchResponse, loadKey?: string): Promise<void> {
    if (loadKey === undefined || !this.loadGiven.has(loadKey)) this.log.allowed++;
    if (loadKey !== undefined) this.loadGiven.add(loadKey);
    await this.probe.browser.send('Fetch.fulfillRequest', {
      requestId: event.requestId,
      responseCode: response.status,
      responseHeaders: response.headers.length > 0 ? response.headers : [{ name: 'content-type', value: 'application/octet-stream' }],
      body: response.body,
    });
  }

  /** Whether the probing Chromium gives the `Cookie` header it would send with each paused request: undefined until checked. */
  private browserCookies: boolean | undefined;
  private cookieCheck: { url: string; seen: string | null } | null = null;

  /**
   * Checks, once, that this Chromium gives the `Cookie` header with a paused request. `prepare`
   * sets a cookie for `url` in a context of the probing browser and sends a navigation there
   * (never fetched: it is stopped here, as it pauses); `forget` removes the cookie. Without the
   * header, no read carries a cookie: fewer cookies than the page sends, never more.
   */
  async checkCookies(prepare: (url: string, name: string, value: string) => Promise<void>, forget: (url: string, name: string) => Promise<void>): Promise<void> {
    if (this.browserCookies !== undefined) return;
    const value = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const url = `http://c${value}.cookie-check.a11y-vision.invalid/`;
    this.cookieCheck = { url, seen: null };
    try {
      await prepare(url, COOKIE_CHECK_NAME, value);
    } finally {
      const seen = this.cookieCheck.seen ?? '';
      this.cookieCheck = null;
      this.browserCookies = seen.split(/;\s*/).includes(`${COOKIE_CHECK_NAME}=${value}`);
      this.log.cookies = !this.browserCookies ? 'withheld' : this.probe.firstPartyCookiesOnly !== undefined ? 'firstParty' : 'browser';
      if (this.browserCookies && this.probe.firstPartyCookiesOnly !== undefined) this.log.cookiesDetail = this.probe.firstPartyCookiesOnly;
      await forget(url, COOKIE_CHECK_NAME).catch(() => undefined);
    }
  }

  /** What went wrong when the collector read this address for a copy, in a few words; undefined when nothing did. */
  failureOf(url: string): string | undefined {
    return this.failures.get(withoutFragment(url));
  }

  private readonly failures = new Map<string, string>();

  /** A read of a copy's load that `probeLoadDeny` keeps from the server; never the document of the copy. */
  private denied(event: PausedRequest): boolean {
    if (this.deny.length === 0) return false;
    if (event.resourceType === 'Document' && event.frameId === this.current?.mainFrameId) return false;
    return this.deny.some((pattern) => pattern.test(event.request.url));
  }

  private readonly deny: RegExp[];

  private reading = 0;
  private readonly queued: (() => void)[] = [];

  /** A place among the reads under way (`probeReadConcurrency` at most); call what it returns when the read is over. */
  private async slot(): Promise<() => void> {
    if (this.reading >= Math.max(1, this.config.probeReadConcurrency)) await new Promise<void>((resolve) => this.queued.push(resolve));
    this.reading++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reading--;
      this.queued.shift()?.();
    };
  }

  /** Not sent, and why: recorded with the requests that were stopped. */
  private async refuse(event: PausedRequest, method: string, why: string): Promise<void> {
    this.blockedKinds.add(`${method} ${event.resourceType} ${shownUrl(event.request.url)} (not sent: ${why})`);
    await this.fail(event, event.resourceType === 'Document' ? 'Aborted' : 'BlockedByClient');
  }

  private async fetchAndGive(event: PausedRequest, key: string, method: 'GET' | 'HEAD'): Promise<void> {
    if (this.denied(event)) return this.refuse(event, method, 'probeLoadDeny');
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(event.request.headers ?? {})) {
      const lower = name.toLowerCase();
      if (lower.startsWith(':') || DROPPED_REQUEST_HEADERS.includes(lower)) continue;
      headers[lower] = value;
    }
    // Chromium's own choice of cookies for this request, once it is known to give it; otherwise none. When the browser
    // of the page may choose otherwise (its profile, its switches), only for the main frame, to the page's own host.
    const firstParty = (): boolean => {
      if (!this.current || event.frameId !== this.current.mainFrameId) return false;
      try {
        return new URL(event.request.url).host === new URL(this.current.url).host;
      } catch {
        return false;
      }
    };
    const cookie = this.browserCookies === true && (this.probe.firstPartyCookiesOnly === undefined || firstParty()) ? headerOf(event.request.headers, 'cookie') : undefined;
    if (cookie !== undefined && cookie !== '') headers['cookie'] = cookie;
    // The collector sends GET and HEAD and nothing else; the host refuses anything else too.
    if (method !== 'GET' && method !== 'HEAD') {
      this.log.unsafe++;
      await this.fail(event, 'BlockedByClient');
      return;
    }
    let response: ProbeFetchResponse;
    const release = await this.slot();
    try {
      response = await this.probe.fetch(
        { url: event.request.url, method, headers },
        { timeoutMs: this.config.probeLoadTimeoutMs, maxBytes: this.config.probeReadMaxBytes, maxEncodedBytes: this.config.probeReadMaxEncodedBytes },
      );
    } catch (error) {
      const message = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
      if (isProbeReadRefused(error)) return this.refuse(event, method, message);
      const tooLarge = isProbeReadTooLarge(error);
      if (tooLarge) this.log.tooLarge = (this.log.tooLarge ?? 0) + 1;
      this.failures.set(withoutFragment(event.request.url), `the read of ${shownUrl(event.request.url)} failed: ${message}`);
      this.blockedKinds.add(`${method} ${event.resourceType} ${shownUrl(event.request.url)} (${tooLarge ? 'too large' : 'unreachable'})`);
      await this.fail(event, 'Failed');
      return;
    } finally {
      release();
    }
    this.log.fetched++;
    const kept = { ...response, headers: response.headers.filter((header) => !DROPPED_RESPONSE_HEADERS.includes(header.name.toLowerCase())) };
    if (this.cacheBytes + kept.size <= this.config.probeCacheMaxBytes) {
      this.cache.set(key, kept);
      this.cacheBytes += kept.size;
    }
    await this.give(event, kept, this.loading ? key : undefined);
  }

  /** The address without its fragment equals the copy's: only the fragment changed. */
  static sameDocument(a: string, b: string): boolean {
    return withoutFragment(a) === withoutFragment(b);
  }
}
