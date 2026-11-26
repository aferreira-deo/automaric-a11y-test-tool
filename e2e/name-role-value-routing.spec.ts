import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as netConnect } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Finding } from '@a11y-vision/core';
import { A11yVision } from '@a11y-vision/playwright';
import type { ProbeContextOptions } from '@a11y-vision/playwright';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

/**
 * Where the reads of the copies go, against servers and a proxy of the test's own: through the
 * proxy of the page (launch and context), over a real tunnel for HTTPS; with exactly the cookies
 * Chromium sends for the page under test, resource by resource; never for a browser this process
 * did not launch unless the caller says how it is routed; never past a route only the test's code
 * can answer; never more than a read's limits.
 */

const TLS = {
  key: readFileSync(new URL('./support/tls/test-only-key.pem', import.meta.url)),
  cert: readFileSync(new URL('./support/tls/test-only-cert.pem', import.meta.url)),
};
const survey = (findings: Finding[]) => findings.find((finding) => finding.rule === 'name-role-value/survey')!.evidence.values!;
const scan = async (page: Page, probeContext: ProbeContextOptions = {}) => survey((await new A11yVision({ page, probeContext }).withChecks(['name-role-value']).analyze()).findings);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const CONTROL = `<button id="m" type="button" onclick="const p = document.getElementById('pn'); p.hidden = !p.hidden">Menu</button><div id="pn" hidden style="width:200px;height:100px;background:#ccc">panel</div>`;

interface Hit {
  phase: string;
  scheme: string;
  host: string;
  path: string;
  tag: string;
  cookie: string;
}

/** An HTTP and an HTTPS server that record every request, with the phase of the test it came in, and answer pages the test sets. */
async function origins(pages: Map<string, (url: URL) => { body: string; headers?: Record<string, string | string[]> }>) {
  const hits: Hit[] = [];
  const state = { phase: 'setup' };
  const handler = (scheme: string) => (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', `${scheme}://${request.headers.host}`);
    hits.push({ phase: state.phase, scheme, host: String(request.headers.host), path: url.pathname + url.search, tag: url.searchParams.get('tag') ?? '', cookie: request.headers.cookie ?? '' });
    const page = pages.get(url.pathname);
    if (page) {
      const { body, headers } = page(url);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers }).end(body);
    } else if (url.pathname.startsWith('/redir')) {
      response.writeHead(302, { location: url.searchParams.get('to') ?? '/', 'cache-control': 'no-store' }).end();
    } else {
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(PNG);
    }
  };
  const servers: Server[] = [createHttpsServer(TLS, handler('https')), createServer(handler('http'))];
  const sockets = new Set<Socket>();
  for (const server of servers) {
    server.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  }
  const portOf = (server: Server) => (server.address() as AddressInfo).port;
  return {
    hits,
    state,
    https: portOf(servers[0]!),
    http: portOf(servers[1]!),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    },
  };
}

test.describe('through the proxy of the page under test', () => {
  test.slow();
  for (const where of ['launch', 'context'] as const) {
    test(`${where}({ proxy }): an http page asked of the proxy, an https read through a tunnel to the server at its end, with the cookie the page sent and nothing to this machine's port 80`, async ({ playwright }) => {
      const pages = new Map([['/page', () => ({ body: `<!doctype html><html lang="en"><title>p</title><h1>Proxied</h1>${CONTROL}<img alt="" src="https://secure.example/img?tag=secure"></html>` })]]);
      const servers = await origins(pages);
      const asked: string[] = [];
      const tunnels = new Set<Socket>();
      const proxy = createServer((request, response) => {
        asked.push(`${servers.state.phase} ${request.method} ${request.url}`);
        const target = new URL(request.url ?? '/');
        const forward = httpRequest({ host: '127.0.0.1', port: servers.http, method: request.method, path: target.pathname + target.search, headers: request.headers }, (answer) => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
        });
        forward.on('error', () => response.destroy());
        request.pipe(forward);
      });
      proxy.on('connect', (request: IncomingMessage, socket: Socket) => {
        asked.push(`${servers.state.phase} CONNECT ${request.url}`);
        tunnels.add(socket);
        socket.on('error', () => undefined);
        const upstream = netConnect(servers.https, '127.0.0.1', () => {
          socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on('error', () => socket.destroy());
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      // Whatever a client sends to its default address lands here, when the system lets the test listen there.
      const decoy: string[] = [];
      const port80 = createServer((request, response) => {
        decoy.push(`${request.method} ${request.headers.host}${request.url} cookie=${request.headers.cookie ?? ''}`);
        response.end();
      });
      const bound = await new Promise<boolean>((resolve) => {
        port80.once('error', () => resolve(false));
        port80.listen(80, '127.0.0.1', () => resolve(true));
      });
      const server = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      const browser = await playwright.chromium.launch(where === 'launch' ? { proxy: { server } } : {});
      try {
        const context = await browser.newContext({ ignoreHTTPSErrors: true, ...(where === 'context' ? { proxy: { server } } : {}) });
        await context.addCookies([{ name: 'sess', value: 'SECRET', domain: 'secure.example', path: '/', secure: true, sameSite: 'None' }]);
        const page = await context.newPage();
        servers.state.phase = 'page';
        await page.goto('http://site.example/page');
        await expect.poll(() => servers.hits.filter((hit) => hit.phase === 'page' && hit.tag === 'secure').length).toBe(1);
        servers.state.phase = 'copy';
        const values = await scan(page);
        expect(values['probeStopped']).toBeUndefined();
        expect(Number(values['probesDone'])).toBeGreaterThan(0);
        expect(String(values['copyReadsRoute'])).toBe(`proxy ${server}; certificate errors ignored`);
        if (bound) expect(decoy).toEqual([]);
        const of = (phase: string) => servers.hits.filter((hit) => hit.phase === phase).map((hit) => `${hit.scheme} ${hit.host}${hit.path} cookie=${hit.cookie}`);
        expect(of('copy')).toEqual(of('page'));
        expect(of('copy')).toEqual(['http site.example/page cookie=', 'https secure.example/img?tag=secure cookie=sess=SECRET']);
        expect(asked.filter((entry) => entry.startsWith('copy '))).toEqual(['copy GET http://site.example/page', 'copy CONNECT secure.example:443']);
        expect(values['copyCookies']).toBe('browser');
      } finally {
        await browser.close();
        for (const socket of tunnels) socket.destroy();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        await new Promise<void>((resolve) => (bound ? port80.close(() => resolve()) : resolve()));
        await servers.close();
      }
    });
  }
});

test.describe('the cookies of the reads of the copies', () => {
  test.slow();

  /**
   * Every resource the page under test asked for, by tag, and the Cookie header it sent, against what
   * its copy sent: `same`, equal; `fewer`, the copy sent fewer, with the cookies it did not send;
   * `extra`, the copy sent a cookie the page did not (never allowed); `copyOnly`, read by the copy only.
   */
  function compare(hits: Hit[]): { same: string[]; fewer: string[]; extra: string[]; copyOnly: string[] } {
    const byTag = new Map<string, { page: string[][]; copy: string[][] }>();
    const names = (cookie: string) => cookie.split(/;\s*/).filter(Boolean).sort();
    for (const hit of hits) {
      if (!hit.tag || (hit.phase !== 'page' && hit.phase !== 'copy')) continue;
      const entry = byTag.get(hit.tag) ?? { page: [], copy: [] };
      entry[hit.phase].push(names(hit.cookie));
      byTag.set(hit.tag, entry);
    }
    const same: string[] = [];
    const fewer: string[] = [];
    const extra: string[] = [];
    const copyOnly: string[] = [];
    for (const [tag, { page, copy }] of byTag) {
      if (copy.length === 0) continue;
      if (page.length === 0) {
        copyOnly.push(`${tag}: ${copy.map((list) => list.join('; ')).join(' | ')}`);
        continue;
      }
      for (const sent of copy) {
        const closest = page.find((list) => sent.every((cookie) => list.includes(cookie)));
        if (!closest) extra.push(`${tag}: page [${page.map((list) => list.join('; ')).join(' | ')}] copy [${sent.join('; ')}]`);
        else if (closest.length === sent.length) same.push(tag);
        else fewer.push(`${tag}: ${closest.filter((cookie) => !sent.includes(cookie)).join('; ')}`);
      }
    }
    return { same: [...new Set(same)].sort(), fewer, extra, copyOnly };
  }

  test('are those Chromium sends for the page under test, resource by resource: host-only, Domain, Path, Secure, __Host-, SameSite across sites and frames (A in B in A), public suffixes, partitions, a redirect', async ({ playwright }) => {
    const pages = new Map<string, (url: URL) => { body: string; headers?: Record<string, string | string[]> }>();
    const servers = await origins(pages);
    const S = (host: string, path: string) => `https://${host}:${servers.https}${path}`;
    pages.set('/page', () => ({
      body: `<!doctype html><html lang="en"><title>p</title><h1>Cookies</h1>${CONTROL}
<img alt="" src="${S('a.test', '/img?tag=a-self')}">
<img alt="" src="${S('sub.a.test', '/img?tag=sub-a')}">
<img alt="" src="${S('b.test', '/img?tag=b-cross')}">
<img alt="" src="${S('a.test', '/private/img?tag=a-path-private')}">
<img alt="" src="${S('a.test', '/other/img?tag=a-path-other')}">
<img alt="" src="${S('x.github.io', '/img?tag=x-gh')}">
<img alt="" src="${S('b.test', `/redir?tag=b-redir&to=${encodeURIComponent(S('a.test', '/img?tag=a-after-b-redirect'))}`)}">
<iframe title="b" src="${S('b.test', '/frame?tag=b-frame')}"></iframe>
<iframe title="sub" src="${S('sub.a.test', '/frame2?tag=suba-frame')}"></iframe>
</html>`,
    }));
    // A frame of another site, which holds a picture and a frame of the top site: A in B in A.
    pages.set('/frame', () => ({ body: `<!doctype html><title>f</title><img alt="" src="${S('b.test', '/img?tag=b-in-b-frame')}"><img alt="" src="${S('a.test', '/img?tag=a-in-b-frame')}"><iframe title="aa" src="${S('a.test', '/frame2?tag=a-frame-in-b-frame')}"></iframe>` }));
    pages.set('/frame2', () => ({ body: `<!doctype html><title>f2</title><img alt="" src="${S('a.test', '/img?tag=a-in-nested-frame')}">` }));
    pages.set('/set', (url) => ({ headers: { 'set-cookie': (url.searchParams.get('c') ?? '').split('|').filter(Boolean) }, body: `<!doctype html><title>s</title>${url.searchParams.get('frame') ? `<iframe src="${url.searchParams.get('frame')}"></iframe>` : ''}` }));
    // The other side of a public suffix: y.github.io is another site than x.github.io.
    pages.set('/gh', () => ({ body: `<!doctype html><html lang="en"><title>gh</title><h1>Public suffix</h1>${CONTROL}<img alt="" src="${S('x.github.io', '/img?tag=x-from-y')}"><img alt="" src="${S('y.github.io', '/img?tag=y-self')}"></html>` }));
    const set = (host: string, cookies: string[], frame?: string) => `${S(host, '/set')}?c=${encodeURIComponent(cookies.join('|'))}${frame ? `&frame=${encodeURIComponent(frame)}` : ''}`;
    const browser: Browser = await playwright.chromium.launch({ args: ['--no-proxy-server', '--host-resolver-rules=MAP *.test 127.0.0.1, MAP *.github.io 127.0.0.1'] });
    try {
      const context: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      await page.goto(set('b.test', ['b_lax=1; Path=/; SameSite=Lax', 'b_strict=1; Path=/; SameSite=Strict', 'b_none=1; Path=/; SameSite=None; Secure', 'b_unspec=1; Path=/']));
      await page.goto(set('a.test', ['a_host_lax=1; Path=/; SameSite=Lax', 'a_dom_lax=1; Domain=a.test; Path=/; SameSite=Lax', 'a_strict=1; Path=/; SameSite=Strict', 'a_none=1; Path=/; SameSite=None; Secure', 'a_secure_lax=1; Path=/; Secure; SameSite=Lax', 'a_path=1; Path=/private; SameSite=Lax', '__Host-a=1; Path=/; Secure; SameSite=Lax', 'a_unspec=1; Path=/']));
      await page.goto(set('sub.a.test', ['suba_host=1; Path=/; SameSite=Lax']));
      await page.goto(set('x.github.io', ['xgh_lax=1; Path=/; SameSite=Lax', 'xgh_none=1; Path=/; SameSite=None; Secure']));
      await page.goto(set('y.github.io', ['ygh_lax=1; Path=/; SameSite=Lax']));
      // Partitioned cookies of b.test: one under the top-level site a.test, one under c.test.
      await page.goto(set('a.test', [], set('b.test', ['b_part_a=1; Path=/; SameSite=None; Secure; Partitioned'])));
      await page.waitForTimeout(300);
      await page.goto(set('c.test', [], set('b.test', ['b_part_c=1; Path=/; SameSite=None; Secure; Partitioned'])));
      await page.waitForTimeout(300);

      for (const [top, path] of [
        ['a.test', '/page'],
        ['y.github.io', '/gh'],
      ] as const) {
        servers.hits.length = 0;
        servers.state.phase = 'page';
        await page.goto(S(top, path));
        await page.waitForLoadState('networkidle');
        servers.state.phase = 'copy';
        const values = await scan(page);
        servers.state.phase = 'after';
        expect(values['probeStopped']).toBeUndefined();
        const { same, fewer, extra, copyOnly } = compare(servers.hits);
        // Never a cookie the page did not send.
        expect(extra).toEqual([]);
        expect(copyOnly).toEqual([]);
        expect(values['copyCookies']).toBe('browser');
        // Fewer only for partitioned cookies, which Chromium adds after the point where a request is held.
        expect(fewer.filter((entry) => !/^[\w-]+: b_part_a=1$/.test(entry))).toEqual([]);
        if (top === 'a.test') {
          // Each case was read by the copy, and sent what the page sent; to b.test, without the partitioned cookie.
          expect(fewer.map((entry) => entry.split(':')[0]).sort()).toEqual(['b-cross', 'b-frame', 'b-in-b-frame', 'b-redir']);
          expect([...same, ...fewer.map((entry) => entry.split(':')[0]!)]).toEqual(expect.arrayContaining(['a-self', 'sub-a', 'b-cross', 'a-path-private', 'a-path-other', 'x-gh', 'b-redir', 'a-after-b-redirect', 'b-frame', 'suba-frame', 'b-in-b-frame', 'a-in-b-frame', 'a-frame-in-b-frame', 'a-in-nested-frame']));
          // What the review saw sent wrongly: cookies of the top site withheld by Chrome in a frame of another site, and partitions.
          const copyOf = (tag: string) => servers.hits.find((hit) => hit.phase === 'copy' && hit.tag === tag)?.cookie ?? '';
          expect(copyOf('a-in-b-frame')).not.toContain('a_strict');
          expect(copyOf('b-cross')).not.toContain('b_part_c');
        } else {
          expect(same).toEqual(expect.arrayContaining(['x-from-y', 'y-self']));
          expect(servers.hits.find((hit) => hit.phase === 'copy' && hit.tag === 'x-from-y')?.cookie ?? '').not.toContain('xgh_lax');
        }
      }
    } finally {
      await browser.close();
      await servers.close();
    }
  });
});

test.describe('a browser this process did not launch', () => {
  test.slow();
  for (const which of ['a new context', 'the default context'] as const) {
    test(`connectOverCDP, ${which}: not probed unless the caller says how it is routed, and then probed`, async ({ playwright, baseURL }) => {
      const dir = mkdtempSync(join(tmpdir(), 'a11y-vision-cdp-'));
      const child = spawn(playwright.chromium.executablePath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
      try {
        const portFile = join(dir, 'DevToolsActivePort');
        let port = '';
        await expect.poll(async () => (port = (await readFile(portFile, 'utf8').catch(() => '')).split('\n')[0] ?? ''), { timeout: 20000 }).not.toBe('');
        const browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        try {
          const context = which === 'a new context' ? await browser.newContext() : browser.contexts()[0]!;
          const page = context.pages()[0] ?? (await context.newPage());
          await page.goto(`${baseURL}/name-role-value/link-button.html`);
          const refused = await scan(page);
          expect(refused['probeStopped']).toBe('routing');
          expect(String(refused['probeStoppedDetail'])).toContain('not launched by this process');
          expect(refused['copiesLoaded']).toBe(0);
          const told = await scan(page, { proxy: null, hostResolverRules: '' });
          expect(told['probeStopped']).toBeUndefined();
          expect(Number(told['probesDone'])).toBeGreaterThan(0);
        } finally {
          await browser.close();
        }
      } finally {
        child.kill();
        await new Promise((resolve) => setTimeout(resolve, 500));
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    });
  }
});

test.describe('routes the scanner cannot read without running the test', () => {
  test('a route whose address is a function: never called by the scan, and nothing is probed, with the reason', async ({ page, baseURL }) => {
    const calls: string[] = [];
    await page.route(
      (url) => {
        calls.push(url.href);
        return url.pathname.endsWith('/mocked.png');
      },
      (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
    );
    await page.goto(`${baseURL}/name-role-value/link-button.html`);
    const before = calls.length;
    const values = await scan(page);
    expect(values['probeStopped']).toBe('routing');
    expect(String(values['probeStoppedDetail'])).toContain('a function');
    expect(values['copiesLoaded']).toBe(0);
    expect(calls.length).toBe(before);
  });
});

test.describe('the credentials passed for the copies', () => {
  test('go to their origin only after it asks (401 with a Basic challenge), as Chromium sends the credentials of a context, and never elsewhere', async ({ browser }) => {
    const basic = `Basic ${Buffer.from('user:pass').toString('base64')}`;
    const seen: string[] = [];
    const state = { phase: 'page' };
    const handler = (name: string) => (request: IncomingMessage, response: ServerResponse) => {
      seen.push(`${state.phase} ${name} ${request.url} ${request.headers.authorization ?? 'none'}`);
      if (name === 'other') {
        response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(PNG);
      } else if (request.headers.authorization !== basic) {
        response.writeHead(401, { 'www-authenticate': 'Basic realm="r"', 'cache-control': 'no-store' }).end();
      } else {
        response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end(`<!doctype html><html lang="en"><title>p</title><h1>Signed in</h1>${CONTROL}<img alt="" src="http://127.0.0.1:${(other.address() as AddressInfo).port}/img"></html>`);
      }
    };
    const own = createServer(handler('own'));
    const other = createServer(handler('other'));
    for (const server of [own, other]) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(own.address() as AddressInfo).port}`;
    const context = await browser.newContext({ httpCredentials: { username: 'user', password: 'pass', origin } });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/page`);
      state.phase = 'copy';
      const values = await scan(page, { httpCredentials: { username: 'user', password: 'pass', origin } });
      const of = (phase: string) => seen.filter((entry) => entry.startsWith(`${phase} `)).map((entry) => entry.slice(phase.length + 1));
      expect({ stopped: values['probeStopped'], detail: values['probeStoppedDetail'], copy: of('copy') }).toEqual({ stopped: undefined, detail: undefined, copy: of('page') });
      expect(Number(values['probesDone'])).toBeGreaterThan(0);
      expect(of('copy')).toEqual(['own /page none', `own /page ${basic}`, 'other /img none']);
    } finally {
      await context.close();
      for (const server of [own, other]) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test.describe('what the browser of the page refuses after a request is held', () => {
  test.slow();

  test('every port the fetcher refuses, Chromium refuses (ERR_UNSAFE_PORT), and ports it does not are not', async ({ playwright }) => {
    const { RESTRICTED_PORTS } = (await import(new URL('../packages/playwright/dist/probe-fetch.js', import.meta.url).href)) as { RESTRICTED_PORTS: number[] };
    const browser = await playwright.chromium.launch({ args: ['--no-proxy-server'] });
    try {
      const page = await browser.newPage();
      const errors = new Map<number, string>();
      page.on('requestfailed', (request) => errors.set(Number(new URL(request.url()).port || 80), request.failure()?.errorText ?? ''));
      await page.goto('data:text/html,<title>ports</title>');
      // A name that never resolves: the port is checked before the name, and nothing is sent anywhere.
      const others = [80, 81, 8080, 4395, 6670, 10081];
      await page.evaluate((ports) => Promise.all(ports.map((port) => fetch(`http://ports.invalid:${port}/`, { mode: 'no-cors' }).catch(() => undefined))), [...RESTRICTED_PORTS, ...others]);
      await expect.poll(() => errors.size).toBe(RESTRICTED_PORTS.length + others.length);
      expect(RESTRICTED_PORTS.filter((port) => errors.get(port) !== 'net::ERR_UNSAFE_PORT')).toEqual([]);
      expect(others.filter((port) => errors.get(port) === 'net::ERR_UNSAFE_PORT')).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('a page that reads a restricted port: the page browser sends nothing there, nor does its copy; unless the browser lets that port through', async ({ playwright }) => {
    const ports = [6667, 10080];
    const seen: string[] = [];
    const state = { phase: 'page' };
    const listeners: Server[] = [];
    for (const port of ports) {
      const listener = createServer((request, response) => {
        seen.push(`${state.phase} ${port} ${request.url} cookie=${request.headers.cookie ?? ''}`);
        response.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
      });
      const bound = await new Promise<boolean>((resolve) => {
        listener.once('error', () => resolve(false));
        listener.listen(port, '127.0.0.1', () => resolve(true));
      });
      if (bound) listeners.push(listener);
    }
    test.skip(listeners.length === 0, 'the restricted ports cannot be listened on here');
    const site = createServer((_request, response) =>
      response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=SECRET; Path=/', 'cache-control': 'no-store' }).end(`<!doctype html><html lang="en"><title>p</title><h1>Ports</h1>${CONTROL}${ports.map((port) => `<img alt="" src="http://127.0.0.1:${port}/img">`).join('')}</html>`),
    );
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
    try {
      for (const allowed of [false, true]) {
        seen.length = 0;
        const browser = await playwright.chromium.launch({ args: ['--no-proxy-server', ...(allowed ? [`--explicitly-allowed-ports=${ports.join(',')}`] : [])] });
        try {
          const page = await browser.newPage();
          state.phase = 'page';
          await page.goto(url);
          await page.waitForLoadState('networkidle');
          state.phase = 'copy';
          const values = await scan(page);
          expect(Number(values['probesDone'])).toBeGreaterThan(0);
          const of = (phase: string) => seen.filter((entry) => entry.startsWith(`${phase} `)).map((entry) => entry.slice(phase.length + 1)).sort();
          if (!allowed) {
            expect(seen).toEqual([]);
            expect(String(values['blockedRequests'])).toContain('which Chromium restricts');
          } else {
            expect(of('page').length).toBeGreaterThan(0);
            expect(of('copy')).toEqual(of('page'));
          }
        } finally {
          await browser.close();
        }
      }
    } finally {
      for (const listener of listeners) await new Promise<void>((resolve) => listener.close(() => resolve()));
      await new Promise<void>((resolve) => site.close(() => resolve()));
    }
  });

  test('host rules said for the copies never replace those of the page browser: a contradiction is not probed, the same rules are', async ({ playwright, baseURL }) => {
    const port = new URL(baseURL!).port;
    const browser = await playwright.chromium.launch({ args: ['--no-proxy-server', `--host-resolver-rules=MAP shop.test 127.0.0.1:${port}`] });
    try {
      const page = await browser.newPage();
      await page.goto('http://shop.test/name-role-value/link-button.html');
      const none = await scan(page, { hostResolverRules: '' });
      expect(none['probeStopped']).toBe('routing');
      expect(String(none['probeStoppedDetail'])).toContain('not what the browser of the page has');
      expect(none['copiesLoaded']).toBe(0);
      const same = await scan(page, { hostResolverRules: `MAP shop.test 127.0.0.1:${port}` });
      expect(same['probeStopped']).toBeUndefined();
      expect(Number(same['probesDone'])).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });
});

test.describe('the limits of one read', () => {
  test('a compression bomb: a few kilobytes that decode to 32 MiB are stopped at the limit of a read, the copy gets an error, and the survey counts it', async ({ page, baseURL }) => {
    const session = `bomb-${test.info().workerIndex}-${Date.now()}`;
    await page.goto(`${baseURL}/_nrv/bomb/${session}/page.html`);
    const before = process.memoryUsage().rss;
    let peak = before;
    const watch = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20);
    try {
      const values = await scan(page);
      expect(values['readsTooLarge']).toBe(1);
      expect(String(values['blockedRequests'])).toContain(`/_nrv/bomb/${session}/bomb.js (too large)`);
      expect(Number(values['probesDone'])).toBeGreaterThan(0);
    } finally {
      clearInterval(watch);
    }
    // What it would decode to (32 MiB, and as much again as base64) is never held.
    expect(peak - before).toBeLessThan(160 << 20);
  });
});
