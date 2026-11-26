import { existsSync, readdirSync, rmdirSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProbeRoutingError } from '@a11y-vision/collector-cdp';
import type { CdpSession, CloneSettings, ProbeBrowser, ProbeFetchRequest, ProbeFetchResponse, ProbeHost, ProbePage } from '@a11y-vision/collector-cdp';
import type { Browser, BrowserContext, BrowserContextOptions, BrowserType, CDPSession, LaunchOptions, Page } from 'playwright-core';
import { pageIsLoopback, pageIsPrivate, sendRead } from './probe-fetch.js';
import { RoutingRefusal, commandLineArgs, resolveRouting, switchesOf, systemAutoDetect, systemProxy } from './probe-routing.js';
import type { ProbeRouting, ReadRouting } from './probe-routing.js';

/** What the copies of a page are given beyond what the collector reads from the page itself, and how their reads are sent. */
export interface ProbeContextOptions {
  /**
   * Sent, for the copies, to `origin` (by default the origin of the page) and nowhere else, as
   * Playwright's `httpCredentials` are: once that origin answers 401 with a Basic challenge, the read
   * is sent again with them; with `send: 'always'`, with every read to that origin.
   */
  httpCredentials?: { username: string; password: string; origin?: string; send?: 'unauthorized' | 'always' };
  /** Sent with every read the collector makes for the copies. */
  extraHTTPHeaders?: Record<string, string>;
  /**
   * The proxy the reads of the copies go through, as Playwright takes it (`server`, `bypass`,
   * credentials); `null` for none. By default, the proxy of the page's context, else of its
   * browser; a proxy of the system is not followed (probing does not start) unless it is said here.
   */
  proxy?: { server: string; bypass?: string; username?: string; password?: string } | null;
  /** Chromium host rules the reads of the copies follow (`MAP host target`, `EXCLUDE host`); `""` for none. By default, those of the page's browser. */
  hostResolverRules?: string;
  /** Certificate errors are ignored for the reads of the copies. By default, as the page's context (`ignoreHTTPSErrors`) and browser (`--ignore-certificate-errors`) do. */
  ignoreHTTPSErrors?: boolean;
  /** The Chromium to probe in. By default, the executable of the page's browser when it is on this machine; else Playwright's own. */
  executablePath?: string;
  /** A Chromium channel to probe in (`chrome`, `msedge`), when no `executablePath` is given. */
  channel?: string;
}

function cdpOf(session: CDPSession): CdpSession {
  // Playwright types `send`/`on` against its own protocol map; the collector speaks plain CDP.
  return {
    send: (method, params) => session.send(method as never, params as never),
    on: (event, handler) => void session.on(event as never, handler as never),
    off: (event, handler) => void session.off(event as never, handler as never),
  };
}

/** What Playwright keeps of an object, in this process, beyond its API: read only, and only when it is there. */
interface Internals {
  _routes?: unknown;
  _options?: { proxy?: { server: string; bypass?: string; username?: string; password?: string }; ignoreHTTPSErrors?: boolean };
  _connection?: { toImpl?: (object: unknown) => ServerContext | undefined };
}

/** Playwright's own object for a context, on its server side, in this process. */
interface ServerContext {
  _options?: { proxy?: { server: string; bypass?: string; username?: string; password?: string } };
  _browser?: { _isBrowserCollocatedWithServer?: boolean; _defaultContext?: unknown; options?: { browserProcess?: { process?: { pid?: unknown } } } };
}

/** The kind of what a route matches, as Playwright takes it: a glob, a regular expression, a URL pattern, or the test's own function. */
type RouteKind = { kind: 'all' } | { kind: 'glob'; route: object } | { kind: 'regexp'; source: string; flags: string } | { kind: 'pattern'; pattern: { test(input: string): boolean } } | { kind: 'other'; what: string };

function routeKind(route: unknown): RouteKind {
  const url = (route as { url?: unknown }).url;
  if (url === undefined || url === '') return { kind: 'all' };
  if (typeof url === 'string') return { kind: 'glob', route: route as object };
  if (typeof url === 'function') return { kind: 'other', what: 'a function (page.route(url => …)), whose answer is the test’s own code' };
  // A regular expression of the language, read by its source: a subclass, or one with its own `exec`, would run the test's code.
  if (url instanceof RegExp && Object.getPrototypeOf(url) === RegExp.prototype && Object.getOwnPropertyNames(url).every((name) => name === 'lastIndex')) return { kind: 'regexp', source: url.source, flags: url.flags.replace(/[gy]/g, '') };
  const Pattern = (globalThis as { URLPattern?: { prototype: object } }).URLPattern;
  if (Pattern && typeof url === 'object' && url !== null && Object.getPrototypeOf(url) === Pattern.prototype && Object.getOwnPropertyNames(url).length === 0) return { kind: 'pattern', pattern: url as { test(input: string): boolean } };
  return { kind: 'other', what: `a ${Object.prototype.toString.call(url).slice(8, -1)} that is not a plain glob, regular expression or URLPattern` };
}

/**
 * The routes of the page under test (`page.route`, `context.route`, `routeFromHAR`): what matches
 * one never left the browser of the page, so it is never sent for a copy either. They are read
 * again at every read (a route added during the scan counts). A glob is matched by Playwright's own
 * code, a regular expression or a URL pattern by the language's; a route that only the test's code
 * can answer (a function) is never called: `unknown` names it, and then nothing is sent. Null when
 * the routes cannot be read (another version of Playwright): nothing is then known of what the page
 * routes.
 */
function routesOf(page: Page): { routed(url: string): boolean; unknown(): string | null } | null {
  const lists = (): unknown[] | null => {
    const found = [(page as unknown as Internals)._routes, (page.context() as unknown as Internals)._routes];
    return found.every(Array.isArray) ? (found as unknown[][]).flat() : null;
  };
  if (!lists()) return null;
  const unknown = (): string | null => {
    const routes = lists();
    if (!routes) return 'the routes of the page under test can no longer be read';
    for (const route of routes) {
      const kind = routeKind(route);
      if (kind.kind === 'other') return `the page under test has a route whose address is ${kind.what}: which reads it mocks cannot be known without running the test's code, and it is never called`;
    }
    return null;
  };
  const routed = (url: string): boolean => {
    const routes = lists();
    if (!routes || unknown() !== null) return true;
    return routes.some((route) => {
      const kind = routeKind(route);
      try {
        switch (kind.kind) {
          case 'all':
            return true;
          case 'glob': {
            // Playwright's matching of its own glob, from the prototype: no code of the test runs.
            const matches = (Object.getPrototypeOf(kind.route) as { matches?: (url: string) => boolean }).matches;
            return typeof matches === 'function' ? matches.call(kind.route, url) : true;
          }
          case 'regexp':
            return new RegExp(kind.source, kind.flags).test(url);
          case 'pattern':
            return (Object.getPrototypeOf(kind.pattern) as { test(input: string): boolean }).test.call(kind.pattern, url);
          default:
            return true;
        }
      } catch {
        return true;
      }
    });
  };
  return { routed, unknown };
}

/**
 * What in a command line of Chromium can change which cookies it sends: switches about cookies, and
 * features about cookies, third parties, partitions, storage access or tracking protection, on or
 * off. Two browsers whose lists are equal choose cookies alike, profile apart.
 */
export function cookieSwitches(commandLine: string | null): string[] {
  if (commandLine === null) return ['(not read)'];
  const out: string[] = [];
  const relevant = /cookie|thirdparty|third-party|partition|samesite|storageaccess|tracking|firstpartysets|relatedwebsitesets|schemeful/i;
  for (const [name, value] of switchesOf(commandLineArgs(commandLine)).switches) {
    if (name === 'enable-features' || name === 'disable-features') {
      for (const feature of value.split(',').map((entry) => entry.trim().replace(/<.*$/, '')).filter(Boolean)) if (relevant.test(feature)) out.push(`${name}:${feature}`);
    } else if (relevant.test(name)) out.push(`${name}=${value}`);
  }
  return out.sort();
}

/** Whether Playwright in this process launched the browser of the context: it holds the process it started. Fails closed. */
function launchedHere(impl: ServerContext | undefined): boolean {
  const browser = impl?._browser;
  if (!browser || browser._isBrowserCollocatedWithServer === false) return false;
  return typeof browser.options?.browserProcess?.process?.pid === 'number';
}

/** Reads, without changing anything, how the browser and the context of the page route its requests. */
async function readRouting(page: Page, stated: ProbeContextOptions): Promise<ReadRouting & { program: string; persistent: boolean }> {
  const context = page.context();
  const browser = context.browser();
  let commandLine: string | null = null;
  if (browser) {
    const session = await browser.newBrowserCDPSession().catch(() => null);
    if (session) {
      commandLine = await session
        .send('SystemInfo.getInfo' as never)
        .then((info) => (info as { commandLine?: string }).commandLine || null)
        .catch(() => null);
      await session.detach().catch(() => undefined);
    }
  }
  const internals = context as unknown as Internals;
  const toImpl = internals._connection?.toImpl;
  // In this process, Playwright's server side holds the options of the context, its proxy included.
  let contextProxy: ReadRouting['contextProxy'];
  let launched: boolean;
  let persistent: boolean;
  try {
    const impl = typeof toImpl === 'function' ? toImpl.call(internals._connection, context) : undefined;
    // No server object, or one without options: not known, which is not the same as none. What the context was
    // created with on this side (its options as the test gave them) counts too: a proxy either side names is followed.
    contextProxy = impl?._options ? (impl._options.proxy ?? internals._options?.proxy ?? null) : undefined;
    launched = launchedHere(impl);
    // The default context of a browser launched with a profile (launchPersistentContext): its settings are not read.
    // Not a profile only when Playwright's browser has that field and it holds no context: a field renamed, or
    // anything else in it, counts as a profile.
    const owner = impl?._browser as Record<string, unknown> | undefined;
    persistent = !(owner !== undefined && Object.prototype.hasOwnProperty.call(owner, '_defaultContext') && owner['_defaultContext'] === null);
  } catch {
    contextProxy = undefined;
    launched = false;
    // Not known: as if it were a profile, whose settings are not read.
    persistent = true;
  }
  const program = commandLine !== null ? switchesOf(commandLineArgs(commandLine)).program : '';
  const routingSwitch = commandLine !== null && /(^|\s)"?--(no-proxy-server|proxy-server|proxy-pac-url|proxy-auto-detect)\b/.test(commandLine);
  // The system's proxy is read only when it is what the browser of the page uses, and that browser is on this machine.
  const usesSystem = !(stated.proxy !== undefined || contextProxy !== null || routingSwitch);
  const system = !usesSystem ? null : program !== '' && existsSync(program) ? await systemProxy() : undefined;
  // Automatic detection matters only where the browser of the page takes its proxy from the system.
  const autoDetect = usesSystem && system === null ? await systemAutoDetect() : null;
  const launch = (browser as unknown as Internals | null)?._options?.proxy;
  return {
    commandLine,
    contextProxy,
    ...(launch ? { launchProxy: launch } : {}),
    contextIgnoresHTTPSErrors: internals._options?.ignoreHTTPSErrors === true,
    systemProxy: system,
    ...(autoDetect ? { systemAutoDetect: autoDetect } : {}),
    launchedHere: launched,
    persistent,
    program,
  };
}

const PROFILE_PREFIX = 'playwright_chromiumdev_profile-';

function profiles(): Set<string> {
  try {
    return new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(PROFILE_PREFIX)));
  } catch {
    return new Set();
  }
}

/**
 * A launch that failed can leave the empty profile folder Playwright made for it. Those that
 * appeared during the launch and are empty are removed; a folder that holds anything (another
 * browser's) is never touched: removing a folder that is not empty fails.
 */
function removeEmptyProfiles(before: Set<string>): void {
  for (const name of profiles()) {
    if (before.has(name)) continue;
    try {
      rmdirSync(join(tmpdir(), name));
    } catch {
      // Not empty, or gone: not ours to remove.
    }
  }
}

/**
 * The browser the name-role-value check probes in: a Chromium of its own, started for one scan
 * and closed after it, never the browser of the page under test.
 *
 * Its network goes nowhere. It is started with a proxy on this machine that accepts every
 * connection and closes it at once (and counts it), for every address, this machine's included
 * (`--proxy-bypass-list=<-loopback>` is passed here, whatever Playwright's environment says), and
 * WebRTC is held to the proxy; so a WebSocket, a WebRTC connection, a request that something let
 * through by mistake, reach no server. What the copies receive was fetched here, in Node
 * (`sendRead`), GET and HEAD only, where the page under test's own requests go: through its proxy,
 * under its host rules, never what the page routes itself (`page.route`), never an address of a
 * private network for a public page. When that routing cannot be read or followed, `start`
 * rejects with a `ProbeRoutingError` and nothing is loaded.
 */
export function playwrightProbeHost(page: Page, options: ProbeContextOptions = {}): ProbeHost {
  return {
    async start(): Promise<ProbeBrowser> {
      const pageUrl = page.url();
      const protocol = (() => {
        try {
          return new URL(pageUrl).protocol;
        } catch {
          return '';
        }
      })();
      if (protocol !== 'http:' && protocol !== 'https:') throw new ProbeRoutingError(`the page under test is at a ${protocol || 'non'} address: only pages on http or https are probed, since the reads of their copies are fetched by the collector`);
      const routes = routesOf(page);
      if (!routes) throw new ProbeRoutingError('the routes of the page under test (page.route, context.route) cannot be read in this version of Playwright, so what it mocks is not known');
      const unknownRoute = routes.unknown();
      if (unknownRoute) throw new ProbeRoutingError(unknownRoute);
      if (routes.routed(pageUrl)) throw new ProbeRoutingError('the page under test routes its own address (page.route or context.route): a copy would not get what it got');
      const type: BrowserType = page.context().browser()?.browserType() ?? (await import('playwright-core')).chromium;
      if (type.name() !== 'chromium') throw new Error(`probing needs Chromium, and the page is in ${type.name()}`);
      const read = await readRouting(page, options);
      let routing: ProbeRouting;
      try {
        routing = resolveRouting({ ...(options.proxy !== undefined ? { proxy: options.proxy } : {}), ...(options.hostResolverRules !== undefined ? { hostResolverRules: options.hostResolverRules } : {}), ...(options.ignoreHTTPSErrors !== undefined ? { ignoreHTTPSErrors: options.ignoreHTTPSErrors } : {}) }, read);
      } catch (error) {
        if (error instanceof RoutingRefusal) throw new ProbeRoutingError(error.message);
        throw error;
      }
      const privateAllowed = await pageIsPrivate(routing, pageUrl);
      const loopbackAllowed = await pageIsLoopback(routing, pageUrl);

      let refused = 0;
      const sockets = new Set<Socket>();
      const dead: Server = createServer((socket) => {
        refused++;
        sockets.add(socket);
        socket.on('error', () => undefined);
        socket.on('close', () => sockets.delete(socket));
        socket.destroy();
      });
      await new Promise<void>((resolve, reject) => {
        dead.once('error', reject);
        dead.listen(0, '127.0.0.1', () => resolve());
      });
      const address = dead.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      // The browser of the page, when this process launched it: a Chromium this machine runs. Otherwise Playwright's own.
      const executablePath = options.executablePath ?? (read.launchedHere && read.program !== '' && existsSync(read.program) ? read.program : undefined);
      // Chromium takes one --disable-features and one --enable-features, the last: Playwright's own lists (they change
      // how cookies are partitioned) would be lost under ours. The page's browser's lists are kept, ours added.
      const pageLine = read.commandLine !== null ? switchesOf(commandLineArgs(read.commandLine)).switches : new Map<string, string>();
      const featureList = (name: string, add: string[]): string[] => [...new Set([...(pageLine.get(name) ?? '').split(',').map((entry) => entry.trim()).filter(Boolean), ...add])];
      const enabled = featureList('enable-features', []);
      const launchOptions: LaunchOptions = {
        headless: true,
        ...(executablePath ? { executablePath } : options.channel ? { channel: options.channel } : {}),
        // Not Playwright's `proxy` option: with PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK set it would leave
        // loopback out of the proxy, and this machine's servers within reach. The bypass list is said here.
        args: [
          `--proxy-server=http://127.0.0.1:${port}`,
          '--proxy-bypass-list=<-loopback>',
          `--disable-features=${featureList('disable-features', ['BackForwardCache']).join(',')}`,
          ...(enabled.length > 0 ? [`--enable-features=${enabled.join(',')}`] : []),
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          '--disable-background-networking',
          '--dns-prefetch-disable',
        ],
      };
      let browser: Browser;
      const before = profiles();
      try {
        browser = await type.launch(launchOptions);
      } catch (error) {
        removeEmptyProfiles(before);
        dead.close();
        throw error;
      }
      const ended = new Promise<void>((resolve) => {
        if (!browser.isConnected()) resolve();
        else browser.once('disconnected', () => resolve());
      });
      let browserSession: CDPSession;
      let probeLine: string | null;
      try {
        browserSession = await browser.newBrowserCDPSession();
        probeLine = await browserSession
          .send('SystemInfo.getInfo' as never)
          .then((info) => (info as { commandLine?: string }).commandLine || null)
          .catch(() => null);
      } catch (error) {
        await browser.close().catch(() => undefined);
        dead.close();
        throw error;
      }
      // Where the two browsers may choose cookies otherwise, the copies send them only where nothing withholds them.
      const pageSwitches = cookieSwitches(read.commandLine);
      const probeSwitches = cookieSwitches(probeLine);
      const differ = pageSwitches.join(' ') !== probeSwitches.join(' ');
      const firstPartyCookiesOnly = !read.launchedHere
        ? 'the browser of the page was not launched by this process: its cookie settings are not read'
        : read.persistent
          ? 'the page is in a browser profile (launchPersistentContext), whose cookie settings are not read'
          : differ
          ? `the browser of the page and the probing one differ in what changes cookies (${[...pageSwitches.filter((entry) => !probeSwitches.includes(entry)), ...probeSwitches.filter((entry) => !pageSwitches.includes(entry)).map((entry) => `not ${entry}`)].join(', ').slice(0, 300)})`
          : undefined;
      const contexts = new Set<BrowserContext>();
      const pageOrigin = (() => {
        try {
          return new URL(pageUrl).origin;
        } catch {
          return '';
        }
      })();
      const authorization = options.httpCredentials
        ? `Basic ${Buffer.from(`${options.httpCredentials.username}:${options.httpCredentials.password}`).toString('base64')}`
        : '';
      const credentialsOrigin = options.httpCredentials?.origin ?? pageOrigin;
      const preemptive = options.httpCredentials?.send === 'always';
      // Every read under way stops, and its connections close, when the probing browser does.
      const reads = new AbortController();
      const policy = {
        routing,
        pageUrl,
        privateAllowed,
        loopbackAllowed,
        routed: (url: string) => routes.routed(url),
        signal: reads.signal,
      };
      const withHeaders = (extra: (url: URL) => Record<string, string>) => ({ ...policy, extraHeaders: (url: URL) => ({ ...(options.extraHTTPHeaders ?? {}), ...extra(url) }) });

      return {
        browser: cdpOf(browserSession),
        route: routing.description,
        ...(firstPartyCookiesOnly !== undefined ? { firstPartyCookiesOnly } : {}),
        async newPage(settings: CloneSettings): Promise<ProbePage> {
          const contextOptions: BrowserContextOptions = {
            viewport: settings.viewport,
            deviceScaleFactor: settings.deviceScaleFactor,
            colorScheme: settings.colorScheme,
            reducedMotion: 'reduce',
            serviceWorkers: 'block',
            acceptDownloads: false,
            ...(settings.userAgent ? { userAgent: settings.userAgent } : {}),
            ...(settings.locale ? { locale: settings.locale } : {}),
            ...(settings.timezoneId ? { timezoneId: settings.timezoneId } : {}),
          };
          const context = await browser.newContext(contextOptions);
          contexts.add(context);
          try {
            const copy = await context.newPage();
            const session = await context.newCDPSession(copy);
            const { targetInfo } = (await session.send('Target.getTargetInfo')) as { targetInfo: { targetId: string; browserContextId?: string } };
            return {
              cdp: cdpOf(session),
              targetId: targetInfo.targetId,
              browserContextId: targetInfo.browserContextId ?? '',
              async close() {
                contexts.delete(context);
                await context.close();
              },
            };
          } catch (error) {
            contexts.delete(context);
            await context.close().catch(() => undefined);
            throw error;
          }
        },
        async fetch(request: ProbeFetchRequest, limits): Promise<ProbeFetchResponse> {
          const ours = (url: URL): boolean => authorization !== '' && url.origin === credentialsOrigin;
          // As Chromium does with the credentials of a context (Playwright's `httpCredentials`): sent to their origin
          // only, and only once that origin asked for them (401 with a Basic challenge), unless `send: 'always'`.
          const first = await sendRead(request, limits, withHeaders((url) => (preemptive && ours(url) ? { authorization } : {})));
          const challenged = first.status === 401 && first.headers.some((header) => header.name === 'www-authenticate' && /^\s*basic\b/i.test(header.value));
          if (preemptive || !challenged || !ours(new URL(request.url))) return first;
          return sendRead(request, limits, withHeaders((url) => (ours(url) ? { authorization } : {})));
        },
        refusedConnections: () => refused,
        ended,
        async close() {
          reads.abort();
          for (const context of contexts) await context.close().catch(() => undefined);
          await browser.close().catch(() => undefined);
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => dead.close(() => resolve()));
        },
      };
    },
  };
}
