import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import type { CdpSession, CloneSettings, ProbeBrowser, ProbeFetchRequest, ProbeFetchResponse, ProbeHost, ProbePage } from '@a11y-vision/collector-cdp';
import type { Browser, BrowserContext, BrowserContextOptions, BrowserType, CDPSession, Page } from 'playwright-core';

/** What the copies of a page are given beyond what the collector reads from the page itself. */
export interface ProbeContextOptions {
  /** Sent, for the copies, with every read to `origin` (by default the origin of the page). */
  httpCredentials?: { username: string; password: string; origin?: string };
  /** Sent with every read the collector makes for the copies. */
  extraHTTPHeaders?: Record<string, string>;
}

function cdpOf(session: CDPSession): CdpSession {
  // Playwright types `send`/`on` against its own protocol map; the collector speaks plain CDP.
  return {
    send: (method, params) => session.send(method as never, params as never),
    on: (event, handler) => void session.on(event as never, handler as never),
    off: (event, handler) => void session.off(event as never, handler as never),
  };
}

/**
 * The browser the name-role-value check probes in: a Chromium of its own, started for one scan
 * and closed after it, never the browser of the page under test.
 *
 * Its network goes nowhere. It is started with a proxy on this machine that accepts every
 * connection and closes it at once (and counts it), for every address, this machine's included
 * (Playwright puts `<-loopback>` in the bypass list, so loopback goes through the proxy too), and
 * WebRTC is held to the proxy; so a WebSocket, a WebRTC connection, a request that something let
 * through by mistake, reach no server. What the copies receive was fetched here, in Node, by
 * `fetch`, which sends GET and HEAD and refuses anything else.
 */
export function playwrightProbeHost(page: Page, options: ProbeContextOptions = {}): ProbeHost {
  return {
    async start(): Promise<ProbeBrowser> {
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
      let browser: Browser;
      try {
        const type: BrowserType = page.context().browser()?.browserType() ?? (await import('playwright-core')).chromium;
        if (type.name() !== 'chromium') throw new Error(`probing needs Chromium, and the page is in ${type.name()}`);
        browser = await type.launch({
          headless: true,
          proxy: { server: `http://127.0.0.1:${port}` },
          args: ['--disable-features=BackForwardCache', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-background-networking', '--dns-prefetch-disable'],
        });
      } catch (error) {
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
          return new URL(page.url()).origin;
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
          // The second lock: whatever the collector asks, nothing but a read leaves here.
          if (request.method !== 'GET' && request.method !== 'HEAD') throw new Error(`Refused: ${String(request.method)} is not a read.`);
          const url = new URL(request.url);
          if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Refused: ${url.protocol} is not fetched.`);
          const headers: Record<string, string> = { ...request.headers, ...(options.extraHTTPHeaders ?? {}) };
          if (authorization && url.origin === credentialsOrigin) headers['authorization'] = authorization;
          const response = await fetch(url, { method: request.method, headers, redirect: 'manual', signal: AbortSignal.timeout(limits.timeoutMs) });
          const declared = Number(response.headers.get('content-length') ?? '0');
          if (declared > limits.maxBytes) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error('Refused: the response is larger than allowed.');
          }
          const chunks: Uint8Array[] = [];
          let size = 0;
          if (response.body) {
            const reader = response.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > limits.maxBytes) {
                await reader.cancel().catch(() => undefined);
                throw new Error('Refused: the response is larger than allowed.');
              }
              chunks.push(value);
            }
          }
          const lines: { name: string; value: string }[] = [];
          response.headers.forEach((value, name) => {
            if (name !== 'set-cookie') lines.push({ name, value });
          });
          for (const cookie of response.headers.getSetCookie()) lines.push({ name: 'set-cookie', value: cookie });
          return { status: response.status, headers: lines, body: Buffer.concat(chunks).toString('base64'), size };
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
