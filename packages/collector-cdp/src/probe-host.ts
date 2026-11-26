import type { CdpSession } from './session.js';

/**
 * What a host of a collection offers so that controls can be activated without touching the page
 * under test: a browser of its own, started for probing and closed afterwards, whose network goes
 * nowhere (every connection it opens by itself is refused), and in which the collector loads
 * copies of the page. The collector holds every request of that browser at the browser target
 * (`Fetch.enable` on `browser`, which covers its pages, frames of every origin and workers of
 * every kind), and gives each one either a response it fetched itself through `fetch` (GET or
 * HEAD, while a copy loads, or what it already fetched) or an error. So nothing a copy does can
 * reach a server except reads the collector sent, and nothing the copy stores, opens or
 * changes exists anywhere once the browser is closed.
 *
 * The Playwright API and the CLI provide one (`@a11y-vision/playwright`). A collection without a
 * host (a bare CDP session, the extension) does not probe.
 */
export interface ProbeHost {
  /**
   * Starts the probing browser. Rejects with a `ProbeRoutingError` when the reads of the copies
   * cannot be sent where the page under test's own requests go (its routing cannot be read, or
   * cannot be followed): nothing is then loaded. Any other rejection is a browser that did not start.
   */
  start(): Promise<ProbeBrowser>;
}

/**
 * The reads of the copies cannot be sent where the page under test's own requests go, so none is
 * sent: a proxy the host cannot follow, routing it cannot read, a page that is not on http or https.
 * Told apart by its name, so that a host built against another copy of this package is understood.
 */
export class ProbeRoutingError extends Error {
  override readonly name = 'ProbeRoutingError';
}

export function isProbeRoutingError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ProbeRoutingError';
}

/**
 * A read the host refused to send (an address the page under test routes itself, a private address
 * for a public page): the copy gets an error, and the reason is recorded. Told apart by its name.
 */
export class ProbeReadRefused extends Error {
  override readonly name = 'ProbeReadRefused';
}

export function isProbeReadRefused(error: unknown): boolean {
  return error instanceof Error && error.name === 'ProbeReadRefused';
}

/**
 * A read whose response was larger than allowed, as sent (`maxEncodedBytes`) or decoded
 * (`maxBytes`): stopped as soon as it went over, the copy gets an error, and it is counted.
 * Told apart by its name.
 */
export class ProbeReadTooLarge extends Error {
  override readonly name = 'ProbeReadTooLarge';
}

export function isProbeReadTooLarge(error: unknown): boolean {
  return error instanceof Error && error.name === 'ProbeReadTooLarge';
}

/** The bounds of one read: one deadline for all of it (name, connection, proxy, TLS, headers, body), and its size. */
export interface ProbeReadLimits {
  timeoutMs: number;
  /** The body, decoded, at most. */
  maxBytes: number;
  /** The body as the server sent it (compressed), at most. */
  maxEncodedBytes: number;
}

/** What a copy is set up with, read from the page under test. */
export interface CloneSettings {
  url: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  userAgent: string;
  /** `navigator.language` of the page under test: the copy's locale and `Accept-Language`. */
  locale: string;
  colorScheme: 'light' | 'dark';
  /** Empty when it could not be read. */
  timezoneId: string;
}

export interface ProbeFetchRequest {
  url: string;
  method: 'GET' | 'HEAD';
  /**
   * As the probing Chromium would send them, its `Cookie` header included: the cookies are those
   * Chrome itself chose for this request of the copy (`Fetch.requestPaused`), never chosen here.
   */
  headers: Record<string, string>;
}

export interface ProbeFetchResponse {
  status: number;
  /** Header lines as received, `set-cookie` once per cookie; without the content encoding (the body is decoded). */
  headers: { name: string; value: string }[];
  /** The body, decoded, as bytes: kept so, and encoded only as it is given to a copy (base64 would hold a third more, for every read kept). */
  body: Uint8Array;
  /** Size of the body in bytes. */
  size: number;
}

/**
 * Text with the user information of every address in it removed, whatever a password holds
 * (`= ; , ( [ " : / ? @`, escapes): in each run of text without spaces that holds an `@`,
 * everything up to its last `@` goes, but for what is known to hold no credentials before it (a
 * bracket or quote, a `name=` of a variable, a `scheme://`). `http://user:p=ss@proxy:3128` becomes
 * `http://proxy:3128`, `http_proxy=user:p@ss@proxy:3128` becomes `http_proxy=proxy:3128`. It may
 * take more than the credentials (an `@` in a path): never less. Messages that say where a proxy is
 * are built from its parsed host and port; this is for free text.
 */
export function withoutUserInfo(text: string): string {
  return text.replace(/\S+/g, (run) => {
    const at = run.lastIndexOf('@');
    if (at < 0) return run;
    const kept = /^[("'<[]*(?:[A-Za-z_][A-Za-z0-9_]*=)?(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?/.exec(run)?.[0] ?? '';
    return `${kept}${run.slice(at + 1)}`;
  });
}

/** Bytes as base64, here and in a browser alike. */
export function base64Of(bytes: Uint8Array): string {
  const buffer = (globalThis as { Buffer?: { from(data: ArrayBufferLike, offset: number, length: number): { toString(encoding: string): string } } }).Buffer;
  if (buffer) return buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let binary = '';
  for (let index = 0; index < bytes.byteLength; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export interface ProbeBrowser {
  /** A session on the browser target of the probing browser. */
  browser: CdpSession;
  /** A page in a new context of its own, empty (no cookie, no storage, no history), on `about:blank`. */
  newPage(settings: CloneSettings): Promise<ProbePage>;
  /** How the reads are sent, in a few words (`direct`, `proxy http://…`, host rules): for the survey. */
  route: string;
  /**
   * Set when the browser of the page may choose cookies otherwise than the probing one (a profile
   * of its own, with its settings: third-party cookies blocked, exceptions by site; switches that
   * change cookies), with the reason: the cookies Chromium attaches are then sent only with reads of
   * the main frame of a copy to the host of the page itself, where no such setting withholds them.
   */
  firstPartyCookiesOnly?: string;
  /**
   * Sends a read to a server on behalf of a copy, and returns the response, the body as bytes.
   * GET and HEAD only: anything else is refused here as well as by the collector. Redirects are
   * returned, not followed. The read goes where the page under test's own request would go (its
   * proxy, its host rules), or nowhere: a read the page routes itself, or one to a private address
   * when the page is public, is refused (`ProbeReadRefused`). Rejects when the server cannot be
   * reached, when the body is larger than allowed (`ProbeReadTooLarge`), or after `timeoutMs`, with
   * what went wrong; every connection of a read is closed when it ends, whichever way.
   */
  fetch(request: ProbeFetchRequest, limits: ProbeReadLimits): Promise<ProbeFetchResponse>;
  /** Connections the probing browser opened by itself, all refused: what the interception did not see. */
  refusedConnections(): number;
  /** Settles when the probing browser is gone (closed, crashed, killed): nothing it would report is waited for after that. */
  ended?: Promise<void>;
  /** Closes the browser: every copy, and every request still held, goes with it; every read still under way is stopped and its connections closed. */
  close(): Promise<void>;
}

export interface ProbePage {
  /** A session on the page. */
  cdp: CdpSession;
  targetId: string;
  browserContextId: string;
  /** Closes the page and destroys its context, without `beforeunload`. */
  close(): Promise<void>;
}
