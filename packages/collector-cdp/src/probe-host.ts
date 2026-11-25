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
  start(): Promise<ProbeBrowser>;
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
  /** As Chrome would send them, with the cookies of the copy for that address. */
  headers: Record<string, string>;
}

export interface ProbeFetchResponse {
  status: number;
  /** Header lines as received, `set-cookie` once per cookie; without the content encoding (the body is decoded). */
  headers: { name: string; value: string }[];
  body: string;
  /** Size of the body in bytes. */
  size: number;
}

export interface ProbeBrowser {
  /** A session on the browser target of the probing browser. */
  browser: CdpSession;
  /** A page in a new context of its own, empty (no cookie, no storage, no history), on `about:blank`. */
  newPage(settings: CloneSettings): Promise<ProbePage>;
  /**
   * Sends a read to a server on behalf of a copy, and returns the response, the body as base64.
   * GET and HEAD only: anything else is refused here as well as by the collector. Redirects are
   * returned, not followed. Rejects when the server cannot be reached, when the body is larger
   * than `maxBytes`, or after `timeoutMs`.
   */
  fetch(request: ProbeFetchRequest, limits: { timeoutMs: number; maxBytes: number }): Promise<ProbeFetchResponse>;
  /** Connections the probing browser opened by itself, all refused: what the interception did not see. */
  refusedConnections(): number;
  /** Closes the browser: every copy, and every request still held, goes with it. */
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
