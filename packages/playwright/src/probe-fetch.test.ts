import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as netConnect, createServer as createNetServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isProbeReadRefused, isProbeReadTooLarge } from '@a11y-vision/collector-cdp';
import { pageIsPrivate, sendRead } from './probe-fetch.js';
import type { ReadPolicy } from './probe-fetch.js';
import { parseHostRules, resolveRouting } from './probe-routing.js';
import type { ProbeRouting } from './probe-routing.js';

/** A key and certificate made for these tests only (`e2e/support/tls`): nothing trusts them. */
const TLS = {
  key: readFileSync(new URL('../../../e2e/support/tls/test-only-key.pem', import.meta.url)),
  cert: readFileSync(new URL('../../../e2e/support/tls/test-only-cert.pem', import.meta.url)),
};

const limits = { timeoutMs: 5000, maxBytes: 1 << 20, maxEncodedBytes: 1 << 20 };
const direct: ProbeRouting = { proxy: null, hostRules: [], ignoreHTTPSErrors: false, description: 'direct' };
const hits: string[] = [];
let server: Server;
let port = 0;

function handler(request: IncomingMessage, response: ServerResponse): void {
  hits.push(`${request.method} ${request.url} host=${request.headers.host}`);
  if (request.url === '/gzip') {
    response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] }).end(gzipSync('decoded'));
    return;
  }
  if (request.url === '/redirect') {
    response.writeHead(302, { location: '/elsewhere' }).end();
    return;
  }
  response.writeHead(200, { 'content-type': 'text/plain' }).end(`served ${request.url}`);
}

const listen = async <S extends Server | ReturnType<typeof createNetServer>>(made: S, host = '127.0.0.1'): Promise<{ server: S; port: number; close(): Promise<void> }> => {
  const open = new Set<Socket>();
  made.on('connection', (socket: Socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
  });
  await new Promise<void>((resolve) => made.listen(0, host, resolve));
  return {
    server: made,
    port: (made.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        made.close(() => resolve());
      }),
  };
};

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A page on the internet, by the resolver of the test: `public.example` is 93.184.216.34, `metadata.example` the address of a cloud's metadata. */
const resolve = (host: string): Promise<{ address: string; family: number }> => {
  const table: Record<string, string> = { 'public.example': '93.184.216.34', 'metadata.example': '169.254.169.254', 'router.example': '192.168.1.1', 'back.example': '127.0.0.1', 'staging.example': '127.0.0.1' };
  const address = table[host];
  return address ? Promise.resolve({ address, family: 4 }) : Promise.reject(new Error(`getaddrinfo ENOTFOUND ${host}`));
};

const policy = (extra: Partial<ReadPolicy> = {}): ReadPolicy => ({ routing: direct, pageUrl: 'http://public.example/shop', privateAllowed: false, routed: () => false, resolve, ...extra });
const read = (url: string, extra: Partial<ReadPolicy> = {}, headers: Record<string, string> = { accept: '*/*' }, bounds = limits) => sendRead({ url, method: 'GET', headers }, bounds, policy(extra));
const refused = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (isProbeReadRefused(error)) return (error as Error).message;
    throw error;
  }
  return 'sent';
};
const failure = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('the read did not fail');
};
const viaProxy = (proxyPort: number, extra: Partial<ProbeRouting> = {}): ProbeRouting => ({
  ...direct,
  ...extra,
  proxy: { http: { host: '127.0.0.1', port: proxyPort }, https: { host: '127.0.0.1', port: proxyPort }, bypass: [], proxyLoopback: true },
});

/** A listener on port 80 of this machine, where a request lands that a client sent to its default address: bound when the system lets a test do it. */
async function decoys(): Promise<{ seen: string[]; close(): Promise<void> }> {
  const seen: string[] = [];
  const bound: Server[] = [];
  for (const host of ['127.0.0.1', '::1']) {
    const decoy = createServer((request, response) => {
      seen.push(`${request.method} ${request.headers.host}${request.url} cookie=${request.headers.cookie ?? ''}`);
      response.end('the decoy');
    });
    await new Promise<void>((done) => {
      decoy.once('error', () => done());
      decoy.listen(80, host, () => {
        bound.push(decoy);
        done();
      });
    });
  }
  return { seen, close: async () => void (await Promise.all(bound.map((decoy) => new Promise<void>((done) => decoy.close(() => done()))))) };
}

describe('a read for a copy', () => {
  it('of a public page never reaches this machine, a private network or a link, by address or by a name that resolves there', async () => {
    hits.length = 0;
    expect(await pageIsPrivate(direct, 'https://public.example/shop', resolve)).toBe(false);
    expect(await refused(read(`http://127.0.0.1:${port}/x`))).toContain('127.0.0.1 is an address of this machine');
    expect(await refused(read(`http://[::ffff:127.0.0.1]:${port}/x`))).toContain('not on one');
    expect(await refused(read('http://metadata.example/latest/meta-data/'))).toContain('169.254.169.254');
    expect(await refused(read('http://router.example/admin'))).toContain('192.168.1.1');
    expect(await refused(read(`http://back.example:${port}/x`))).toContain('127.0.0.1');
    expect(hits).toEqual([]);
  });

  it('of a page on this machine may read this machine, with what the server sent, decoded, redirects not followed', async () => {
    hits.length = 0;
    expect(await pageIsPrivate(direct, `http://127.0.0.1:${port}/`, resolve)).toBe(true);
    const response = await read(`http://127.0.0.1:${port}/gzip`, { privateAllowed: true });
    expect(Buffer.from(response.body, 'base64').toString()).toBe('decoded');
    expect(response.headers.filter((header) => header.name === 'set-cookie').map((header) => header.value)).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect((await read(`http://127.0.0.1:${port}/redirect`, { privateAllowed: true })).status).toBe(302);
    expect(hits).toEqual([`GET /gzip host=127.0.0.1:${port}`, `GET /redirect host=127.0.0.1:${port}`]);
  });

  it('follows the host rules of the page: the name is kept in Host, the connection goes where the rule says', async () => {
    hits.length = 0;
    const routing = { ...direct, hostRules: parseHostRules(`MAP staging.example 127.0.0.1:${port}`) };
    expect(await pageIsPrivate(routing, 'http://staging.example/', resolve)).toBe(true);
    const response = await read('http://staging.example/page', { routing, privateAllowed: true, pageUrl: 'http://staging.example/' });
    expect(Buffer.from(response.body, 'base64').toString()).toBe('served /page');
    expect(hits).toEqual(['GET /page host=staging.example']);
  });

  it('follows --host-rules before --host-resolver-rules, as Chromium layers them, and sends no HTTPS read that --host-rules moves', async () => {
    hits.length = 0;
    // a.example goes to b.example (connection rules), which resolves to the server (resolver rules).
    const routing = { ...direct, connectionRules: parseHostRules('MAP a.example b.example'), hostRules: parseHostRules(`MAP b.example 127.0.0.1:${port}`) };
    const response = await read('http://a.example/layered', { routing, privateAllowed: true, pageUrl: 'http://a.example/' });
    expect(Buffer.from(response.body, 'base64').toString()).toBe('served /layered');
    expect(hits).toEqual(['GET /layered host=a.example']);
    expect(await refused(read('https://a.example/secure', { routing, privateAllowed: true, pageUrl: 'https://a.example/' }))).toContain('--host-rules');
    expect(hits).toHaveLength(1);
  });

  it('is never sent when the page under test routes its address itself', async () => {
    hits.length = 0;
    expect(await refused(read(`http://127.0.0.1:${port}/api/data`, { privateAllowed: true, routed: (url) => url.includes('/api/') }))).toContain('routes this address itself');
    expect(hits).toEqual([]);
  });

  it('in plain HTTP goes only where the browser of the page cannot have upgraded it to HTTPS (HSTS, mixed content)', async () => {
    hits.length = 0;
    const routing = { ...direct, hostRules: parseHostRules(`MAP *.example 127.0.0.1:${port}`) };
    const local = { routing, privateAllowed: true };
    // An HTTPS page: no plain-HTTP read at all.
    expect(await refused(read('http://shop.example/a.js', { ...local, pageUrl: 'https://shop.example/' }))).toContain('page under test is on HTTPS');
    // A plain-HTTP page: its own host (it was loaded that way), an address, a name of this machine; not another host.
    expect(await refused(read('http://cdn.example/a.js', { ...local, pageUrl: 'http://shop.example/' }))).toContain('HSTS');
    expect((await read('http://shop.example/own.js', { ...local, pageUrl: 'http://shop.example/' })).status).toBe(200);
    expect((await read(`http://127.0.0.1:${port}/address.js`, { ...local, pageUrl: 'http://shop.example/' })).status).toBe(200);
    expect(hits).toEqual(['GET /own.js host=shop.example', `GET /address.js host=127.0.0.1:${port}`]);
  });

  it('goes through the proxy of the page: an http address asked of it in full, an https one through a tunnel', async () => {
    const asked: string[] = [];
    const proxy = createServer((request, response) => {
      asked.push(`${request.method} ${request.url} auth=${request.headers['proxy-authorization'] ?? ''}`);
      response.writeHead(200, { 'content-type': 'text/plain' }).end('from the proxy');
    });
    proxy.on('connect', (request, socket) => {
      asked.push(`CONNECT ${request.url} auth=${request.headers['proxy-authorization'] ?? ''}`);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    const at = await listen(proxy);
    try {
      const routing = resolveRouting({ proxy: { server: `http://127.0.0.1:${at.port}`, username: 'u', password: 'p' }, hostResolverRules: '' }, { commandLine: null, contextProxy: null, contextIgnoresHTTPSErrors: false, systemProxy: null, launchedHere: true });
      const response = await read('http://public.example/page?q=1', { routing, pageUrl: 'http://public.example/' });
      expect(Buffer.from(response.body, 'base64').toString()).toBe('from the proxy');
      await expect(read('https://public.example/secure', { routing })).rejects.toThrow('the proxy refused the tunnel (403)');
      const basic = `Basic ${Buffer.from('u:p').toString('base64')}`;
      expect(asked).toEqual([`GET http://public.example/page?q=1 auth=${basic}`, `CONNECT public.example:443 auth=${basic}`]);
      // An address of this machine written in the URL is still refused for a public page: the proxy is not asked.
      expect(await refused(read('http://127.0.0.1/', { routing }))).toContain('not on one');
      expect(asked).toHaveLength(2);
    } finally {
      await at.close();
    }
  });

  it('through a tunnel the proxy opened goes to the server at its end, over TLS: the request, its cookies and credentials reach that server and nothing else', async () => {
    const origin: string[] = [];
    const secure = await listen(
      createHttpsServer(TLS, (request, response) => {
        origin.push(`${request.method} ${request.url} host=${request.headers.host} cookie=${request.headers.cookie ?? ''} authorization=${request.headers.authorization ?? ''}`);
        response.writeHead(200, { 'content-type': 'text/plain' }).end('from the origin, over TLS');
      }),
    );
    const tunnels: string[] = [];
    const proxy = createServer((_request, response) => response.writeHead(500).end());
    proxy.on('connect', (request: IncomingMessage, socket: Socket) => {
      tunnels.push(String(request.url));
      socket.on('error', () => undefined);
      const upstream = netConnect(secure.port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
    });
    const at = await listen(proxy);
    const decoy = await decoys();
    try {
      const response = await read(
        'https://bank.example/account?id=1',
        { routing: viaProxy(at.port, { ignoreHTTPSErrors: true }), pageUrl: 'https://bank.example/', extraHeaders: () => ({ authorization: 'Basic c2VjcmV0' }) },
        { accept: '*/*', cookie: 'session=SECRET' },
      );
      expect(Buffer.from(response.body, 'base64').toString()).toBe('from the origin, over TLS');
      expect(tunnels).toEqual(['bank.example:443']);
      expect(origin).toEqual(['GET /account?id=1 host=bank.example cookie=session=SECRET authorization=Basic c2VjcmV0']);
      expect(decoy.seen).toEqual([]);
    } finally {
      await decoy.close();
      await at.close();
      await secure.close();
    }
  });

  it('through a tunnel checks the certificate against the name of the address, unless the page ignores certificate errors', async () => {
    const secure = await listen(createHttpsServer(TLS, (_request, response) => response.end('ok')));
    const proxy = createServer();
    proxy.on('connect', (_request: IncomingMessage, socket: Socket) => {
      socket.on('error', () => undefined);
      const upstream = netConnect(secure.port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 OK\r\n\r\n');
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
    });
    const at = await listen(proxy);
    try {
      expect((await failure(read('https://bank.example/', { routing: viaProxy(at.port), pageUrl: 'https://bank.example/' }))).message).toMatch(/self[- ]signed certificate/);
    } finally {
      await at.close();
      await secure.close();
    }
  });

  it('says what went wrong when it fails: a certificate the page does not accept, or accepts (ignoreHTTPSErrors)', async () => {
    const secure = await listen(createHttpsServer(TLS, handler));
    try {
      const url = `https://127.0.0.1:${secure.port}/tls`;
      await expect(read(url, { privateAllowed: true })).rejects.toThrow(/self[- ]signed certificate/);
      const response = await read(url, { privateAllowed: true, routing: { ...direct, ignoreHTTPSErrors: true } });
      expect(Buffer.from(response.body, 'base64').toString()).toBe('served /tls');
    } finally {
      await secure.close();
    }
  });
});

describe('a read that does not end', () => {
  /** A proxy that answers CONNECT with 200, or not at all, then says nothing; its side of every connection is watched. */
  const silentProxy = async (answer: boolean) => {
    const sockets: Socket[] = [];
    let closed = 0;
    const made = createNetServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => closed++);
      if (answer) socket.once('data', () => socket.write('HTTP/1.1 200 Connection established\r\n\r\n'));
      // Read on, so that the end of the connection is seen.
      socket.resume();
    });
    return { ...(await listen(made)), sockets, closed: () => closed };
  };

  it('fails within its one deadline when the proxy goes silent after the tunnel, or before it, and closes its connection', async () => {
    for (const answer of [true, false]) {
      const proxy = await silentProxy(answer);
      try {
        const started = Date.now();
        const settled = await Promise.race([failure(read('https://hang.example/x', { routing: viaProxy(proxy.port), pageUrl: 'https://hang.example/' }, {}, { ...limits, timeoutMs: 400 })), new Promise<Error>((done) => setTimeout(() => done(new Error('still pending after 3 s')), 3000))]);
        expect(settled.message).toBe('no answer within 400 ms');
        expect(Date.now() - started).toBeLessThan(1500);
        // The other side sees its connection closed: nothing is left open.
        await expect.poll(() => proxy.closed(), { timeout: 2000 }).toBe(proxy.sockets.length);
        expect(proxy.sockets).toHaveLength(1);
      } finally {
        await proxy.close();
      }
    }
  });

  it('fails within its deadline when the server sends its headers and then the body slowly, and closes the connection', async () => {
    const closed: boolean[] = [];
    const slow = await listen(
      createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        const drip = setInterval(() => response.write('x'), 50);
        request.socket.on('close', () => {
          clearInterval(drip);
          closed.push(true);
        });
      }),
    );
    try {
      const started = Date.now();
      expect((await failure(read(`http://127.0.0.1:${slow.port}/slow`, { privateAllowed: true }, {}, { ...limits, timeoutMs: 400 }))).message).toBe('no answer within 400 ms');
      expect(Date.now() - started).toBeLessThan(1500);
      await expect.poll(() => closed.length, { timeout: 2000 }).toBe(1);
    } finally {
      await slow.close();
    }
  });

  it('stops at once, its connections closed, when its signal aborts (the end of the scan)', async () => {
    const proxy = await silentProxy(true);
    try {
      const stop = new AbortController();
      const pending = failure(read('https://hang.example/x', { routing: viaProxy(proxy.port), pageUrl: 'https://hang.example/', signal: stop.signal }, {}, { ...limits, timeoutMs: 60000 }));
      await expect.poll(() => proxy.sockets.length).toBe(1);
      stop.abort();
      expect((await pending).message).toContain('stopped');
      await expect.poll(() => proxy.closed(), { timeout: 2000 }).toBe(proxy.sockets.length);
    } finally {
      await proxy.close();
    }
  });
});

describe('a read that is too large', () => {
  /** A few kilobytes of brotli that decode to 64 MiB of spaces. */
  const bomb = brotliCompressSync(Buffer.alloc(64 << 20, 32), { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } });

  it('is stopped as soon as it decodes past the limit: a compression bomb costs the limit, not what it decodes to', async () => {
    expect(bomb.byteLength).toBeLessThan(64 << 10);
    const bombs = await listen(createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/javascript', 'content-encoding': 'br' }).end(bomb)));
    try {
      const before = process.memoryUsage().rss;
      const error = await failure(read(`http://127.0.0.1:${bombs.port}/bomb.js`, { privateAllowed: true }, {}, { timeoutMs: 5000, maxBytes: 1 << 20, maxEncodedBytes: 1 << 20 }));
      expect(isProbeReadTooLarge(error)).toBe(true);
      expect(error.message).toContain('decoded');
      expect(process.memoryUsage().rss - before).toBeLessThan(48 << 20);
    } finally {
      await bombs.close();
    }
  });

  it('is stopped as soon as what the server sends goes past the limit, declared or not', async () => {
    const big = Buffer.alloc(3 << 20, 120);
    const servers = await listen(
      createServer((request, response) => {
        if (request.url === '/declared') response.writeHead(200, { 'content-length': String(big.byteLength) }).end(big);
        else response.writeHead(200, { 'content-type': 'text/plain' }).end(big);
      }),
    );
    try {
      for (const path of ['/declared', '/chunked']) {
        const error = await failure(read(`http://127.0.0.1:${servers.port}${path}`, { privateAllowed: true }, {}, { timeoutMs: 5000, maxBytes: 8 << 20, maxEncodedBytes: 1 << 20 }));
        expect(isProbeReadTooLarge(error)).toBe(true);
      }
    } finally {
      await servers.close();
    }
  });
});
