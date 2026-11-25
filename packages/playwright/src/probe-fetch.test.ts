import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isProbeReadRefused } from '@a11y-vision/collector-cdp';
import { pageIsPrivate, sendRead } from './probe-fetch.js';
import type { ReadPolicy } from './probe-fetch.js';
import { parseHostRules, resolveRouting } from './probe-routing.js';
import type { ProbeRouting } from './probe-routing.js';

const limits = { timeoutMs: 5000, maxBytes: 1 << 20 };
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
  const table: Record<string, string> = { 'public.example': '93.184.216.34', 'metadata.example': '169.254.169.254', 'router.example': '192.168.1.1', 'back.example': '127.0.0.1' };
  const address = table[host];
  return address ? Promise.resolve({ address, family: 4 }) : Promise.reject(new Error(`getaddrinfo ENOTFOUND ${host}`));
};

const policy = (extra: Partial<ReadPolicy> = {}): ReadPolicy => ({ routing: direct, privateAllowed: false, routed: () => false, resolve, ...extra });
const read = (url: string, extra: Partial<ReadPolicy> = {}) => sendRead({ url, method: 'GET', headers: { accept: '*/*' } }, limits, policy(extra));
const refused = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (isProbeReadRefused(error)) return (error as Error).message;
    throw error;
  }
  return 'sent';
};

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
    const response = await read('http://staging.example/page', { routing, privateAllowed: true });
    expect(Buffer.from(response.body, 'base64').toString()).toBe('served /page');
    expect(hits).toEqual(['GET /page host=staging.example']);
  });

  it('is never sent when the page under test routes its address itself', async () => {
    hits.length = 0;
    expect(await refused(read(`http://127.0.0.1:${port}/api/data`, { privateAllowed: true, routed: (url) => url.includes('/api/') }))).toContain('routes this address itself');
    expect(hits).toEqual([]);
  });

  it('goes through the proxy of the page: an http address asked of it in full, an https one through a tunnel', async () => {
    const asked: string[] = [];
    const proxy = createServer((request, response) => {
      asked.push(`${request.method} ${request.url} auth=${request.headers['proxy-authorization'] ?? ''}`);
      response.writeHead(200, { 'content-type': 'text/plain' }).end('from the proxy');
    });
    proxy.on('connect', (request, socket) => {
      asked.push(`CONNECT ${request.url}`);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
    try {
      const at = (proxy.address() as AddressInfo).port;
      const routing = resolveRouting({ proxy: { server: `http://127.0.0.1:${at}`, username: 'u', password: 'p' }, hostResolverRules: '' }, { commandLine: null, contextProxy: null, contextIgnoresHTTPSErrors: false, systemProxy: null });
      const response = await read('http://public.example/page?q=1', { routing });
      expect(Buffer.from(response.body, 'base64').toString()).toBe('from the proxy');
      await expect(read('https://public.example/secure', { routing })).rejects.toThrow('the proxy refused the tunnel (403)');
      expect(asked).toEqual([`GET http://public.example/page?q=1 auth=Basic ${Buffer.from('u:p').toString('base64')}`, 'CONNECT public.example:443']);
      // An address of this machine written in the URL is still refused for a public page: the proxy is not asked.
      expect(await refused(read('http://127.0.0.1/', { routing }))).toContain('not on one');
      expect(asked).toHaveLength(2);
    } finally {
      await new Promise<void>((done) => proxy.close(() => done()));
    }
  });

  it('says what went wrong when it fails: a certificate the page does not accept, or accepts (ignoreHTTPSErrors)', async () => {
    const dir = fileURLToPath(new URL(`../../../test-results/unit-tls-${process.pid}/`, import.meta.url));
    await mkdir(dir, { recursive: true });
    const made = await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1']).then(
      () => true,
      () => false,
    );
    if (!made) return;
    const secure = createHttpsServer({ key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) }, handler);
    await new Promise<void>((done) => secure.listen(0, '127.0.0.1', done));
    try {
      const url = `https://127.0.0.1:${(secure.address() as AddressInfo).port}/tls`;
      await expect(read(url, { privateAllowed: true })).rejects.toThrow(/self[- ]signed certificate/);
      const response = await read(url, { privateAllowed: true, routing: { ...direct, ignoreHTTPSErrors: true } });
      expect(Buffer.from(response.body, 'base64').toString()).toBe('served /tls');
    } finally {
      await new Promise<void>((done) => secure.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
