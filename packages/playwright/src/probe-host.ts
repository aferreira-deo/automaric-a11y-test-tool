import { existsSync, readdirSync, rmdirSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProbeRoutingError } from '@a11y-vision/collector-cdp';
import type { CdpSession, CloneSettings, ProbeBrowser, ProbeFetchRequest, ProbeFetchResponse, ProbeHost, ProbePage } from '@a11y-vision/collector-cdp';
import type { Browser, BrowserContext, BrowserContextOptions, BrowserType, CDPSession, LaunchOptions, Page } from 'playwright-core';
import { pageIsPrivate, sendRead } from './probe-fetch.js';
import { RoutingRefusal, commandLineArgs, resolveRouting, switchesOf, systemProxy } from './probe-routing.js';
import type { ProbeRouting, ReadRouting } from './probe-routing.js';

/** What the copies of a page are given beyond what the collector reads from the page itself, and how their reads are sent. */
export interface ProbeContextOptions {
  /** Sent, for the copies, with every read to `origin` (by default the origin of the page). */
  httpCredentials?: { username: string; password: string; origin?: string };
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
  _connection?: { toImpl?: (object: unknown) => { _options?: { proxy?: { server: string; bypass?: string; username?: string; password?: string } } } | undefined };
}

/**
 * The routes of the page under test (`page.route`, `context.route`, `routeFromHAR`): what matches
 * one never left the browser of the page, so it is never sent for a copy either. Null when they
 * cannot be read (another version of Playwright): nothing is then known of what the page routes.
 */
function routesOf(page: Page): ((url: string) => boolean) | null {
  const lists = [(page as unknown as Internals)._routes, (page.context() as unknown as Internals)._routes];
  if (!lists.every(Array.isArray)) return null;
  return (url) =>
    (lists as unknown[][]).some((list) =>
      list.some((route) => {
        const matches = (route as { matches?: (url: string) => boolean }).matches;
        try {
          return typeof matches === 'function' ? matches.call(route, url) : true;
        } catch {
          return true;
        }
      }),
    );
}

/** Reads, without changing anything, how the browser and the context of the page route its requests. */
async function readRouting(page: Page, stated: ProbeContextOptions): Promise<ReadRouting & { program: string }> {
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
  try {
    const impl = typeof toImpl === 'function' ? toImpl.call(internals._connection, context) : undefined;
    // No server object, or one without options: not known, which is not the same as none.
    contextProxy = impl?._options ? (impl._options.proxy ?? null) : undefined;
  } catch {
    contextProxy = undefined;
  }
  const program = commandLine !== null ? switchesOf(commandLineArgs(commandLine)).program : '';
  const routingSwitch = commandLine !== null && /(^|\s)"?--(no-proxy-server|proxy-server|proxy-pac-url|proxy-auto-detect)\b/.test(commandLine);
  // The system's proxy is read only when it is what the browser of the page uses, and that browser is on this machine.
  const system = stated.proxy !== undefined || contextProxy !== null || routingSwitch ? null : program !== '' && existsSync(program) ? await systemProxy() : undefined;
  const launch = (browser as unknown as Internals | null)?._options?.proxy;
  return {
    commandLine,
    contextProxy,
    ...(launch ? { launchProxy: launch } : {}),
    contextIgnoresHTTPSErrors: internals._options?.ignoreHTTPSErrors === true,
    systemProxy: system,
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
      const routed = routesOf(page);
      if (!routed) throw new ProbeRoutingError('the routes of the page under test (page.route, context.route) cannot be read in this version of Playwright, so what it mocks is not known');
      if (routed(pageUrl)) throw new ProbeRoutingError('the page under test routes its own address (page.route or context.route): a copy would not get what it got');
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
      // The browser of the page, when it is on this machine: a Chromium this machine runs. Otherwise Playwright's own.
      const executablePath = options.executablePath ?? (read.program !== '' && existsSync(read.program) ? read.program : undefined);
      const launchOptions: LaunchOptions = {
        headless: true,
        ...(executablePath ? { executablePath } : options.channel ? { channel: options.channel } : {}),
        // Not Playwright's `proxy` option: with PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK set it would leave
        // loopback out of the proxy, and this machine's servers within reach. The bypass list is said here.
        args: [
          `--proxy-server=http://127.0.0.1:${port}`,
          '--proxy-bypass-list=<-loopback>',
          '--disable-features=BackForwardCache',
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
      let browserSession: CDPSession;
      try {
        browserSession = await browser.newBrowserCDPSession();
      } catch (error) {
        await browser.close().catch(() => undefined);
        dead.close();
        throw error;
      }
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

      return {
        browser: cdpOf(browserSession),
        route: routing.description,
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
        fetch(request: ProbeFetchRequest, limits): Promise<ProbeFetchResponse> {
          return sendRead(request, limits, {
            routing,
            privateAllowed,
            routed,
            extraHeaders: (url) => ({ ...(options.extraHTTPHeaders ?? {}), ...(authorization && url.origin === credentialsOrigin ? { authorization } : {}) }),
          });
        },
        refusedConnections: () => refused,
        async close() {
          for (const context of contexts) await context.close().catch(() => undefined);
          await browser.close().catch(() => undefined);
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => dead.close(() => resolve()));
        },
      };
    },
  };
}
