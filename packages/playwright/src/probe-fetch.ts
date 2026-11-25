import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Socket } from 'node:net';
import { checkServerIdentity, connect as tlsConnect } from 'node:tls';
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import { ProbeReadRefused } from '@a11y-vision/collector-cdp';
import type { ProbeFetchRequest, ProbeFetchResponse } from '@a11y-vision/collector-cdp';
import { addressClass, loopbackName, mapHost, proxyFor } from './probe-routing.js';
import type { AddressClass, HttpProxy, ProbeRouting } from './probe-routing.js';

/**
 * Sends one read for a copy of the page, where the page under test's own request would go: through
 * its proxy, under its host rules, with its handling of certificates. A read the page routes itself
 * (`page.route`), and a read of an address of this machine, of a private network or of a link when
 * the page under test is on none of those, is refused (`ProbeReadRefused`), never sent.
 *
 * A name is resolved once, here, and the connection goes to the address that was checked: a name
 * that resolves to another address the next time (DNS rebinding) changes nothing. Through a proxy,
 * the proxy resolves the name: only an address written in the URL, or `localhost`, can be checked.
 * GET and HEAD only; redirects are returned, not followed. `CONNECT` opens the tunnel to an HTTPS
 * address through a proxy, as the browser does.
 */

export interface ReadPolicy {
  routing: ProbeRouting;
  /** Addresses that are not of the internet may be read: the page under test is on one. */
  privateAllowed: boolean;
  /** The page under test routes this address itself (`page.route`, `context.route`): it is never sent. */
  routed(url: string): boolean;
  /** Headers added to every read (`probeContext.extraHTTPHeaders`, credentials). */
  extraHeaders?(url: URL): Record<string, string>;
  /** Resolves a name: `dns.lookup` by default (tests replace it). */
  resolve?: (host: string) => Promise<{ address: string; family: number }>;
}

const resolveName = async (host: string): Promise<{ address: string; family: number }> => {
  const [first] = await dnsLookup(host, { all: true, verbatim: true });
  if (!first) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
  return first;
};

const PUBLIC_ONLY = 'an address of this machine, of a private network or of a link, and the page under test is not on one';

function bare(host: string): string {
  return host.replace(/^\[|\]$/g, '');
}

/** What the address of a name is, through the host rules: where a direct connection would go. */
export async function resolveTarget(routing: ProbeRouting, hostname: string, port: number, resolve = resolveName): Promise<{ host: string; address: string; family: number; port: number; kind: AddressClass }> {
  const mapped = mapHost(routing.hostRules, bare(hostname), port);
  if (!mapped) throw new Error(`${bare(hostname)} does not resolve (host rules: ~NOTFOUND)`);
  const literal = isIP(mapped.host);
  const found = literal !== 0 ? { address: mapped.host, family: literal } : await resolve(mapped.host);
  return { host: mapped.host, address: found.address, family: found.family, port: mapped.port, kind: addressClass(found.address) };
}

/** Whether the page under test is on an address that is not of the internet: its copies may then read such addresses. */
export async function pageIsPrivate(routing: ProbeRouting, pageUrl: string, resolve = resolveName): Promise<boolean> {
  const url = new URL(pageUrl);
  const host = bare(url.hostname);
  if (proxyFor(routing.proxy, url)) return loopbackName(host) || (isIP(host) !== 0 && addressClass(host) !== 'public');
  try {
    const target = await resolveTarget(routing, host, Number(url.port || (url.protocol === 'https:' ? 443 : 80)), resolve);
    return target.kind !== 'public' || loopbackName(target.host);
  } catch {
    return false;
  }
}

function proxyAuthorization(proxy: HttpProxy): Record<string, string> {
  if (proxy.username === undefined) return {};
  return { 'proxy-authorization': `Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}` };
}

function decode(body: Buffer, encoding: string, maxBytes: number): Buffer {
  const options = { maxOutputLength: Math.max(1, maxBytes) };
  switch (encoding.trim().toLowerCase()) {
    case '':
    case 'identity':
      return body;
    case 'gzip':
    case 'x-gzip':
      return gunzipSync(body, options);
    case 'deflate':
      try {
        return inflateSync(body, options);
      } catch {
        return inflateRawSync(body, options);
      }
    case 'br':
      return brotliDecompressSync(body, options);
    default:
      throw new Error(`the response is encoded as ${encoding}, which is not decoded here`);
  }
}

/** Reads a response to its end, `maxBytes` at most, and decodes it. */
function readResponse(response: IncomingMessage, method: string, maxBytes: number): Promise<ProbeFetchResponse> {
  return new Promise((resolve, reject) => {
    const declared = Number(response.headers['content-length'] ?? '0');
    if (declared > maxBytes) {
      response.destroy();
      reject(new Error('Refused: the response is larger than allowed.'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        response.destroy();
        reject(new Error('Refused: the response is larger than allowed.'));
        return;
      }
      chunks.push(chunk);
    });
    response.on('error', reject);
    response.on('end', () => {
      try {
        const raw = Buffer.concat(chunks);
        const body = method === 'HEAD' ? raw : decode(raw, String(response.headers['content-encoding'] ?? ''), maxBytes);
        if (body.byteLength > maxBytes) throw new Error('Refused: the response is larger than allowed.');
        const lines: { name: string; value: string }[] = [];
        for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) lines.push({ name: response.rawHeaders[index]!.toLowerCase(), value: response.rawHeaders[index + 1]! });
        resolve({ status: response.statusCode ?? 0, headers: lines, body: body.toString('base64'), size: body.byteLength });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function send(make: () => ClientRequest, method: string, limits: { timeoutMs: number; maxBytes: number }): Promise<ProbeFetchResponse> {
  return new Promise((resolve, reject) => {
    let request: ClientRequest;
    try {
      request = make();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const timer = setTimeout(() => request.destroy(new Error(`no answer within ${limits.timeoutMs} ms`)), limits.timeoutMs);
    request.on('response', (response) => {
      readResponse(response, method, limits.maxBytes).then(resolve, reject).finally(() => clearTimeout(timer));
    });
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

/** Opens a tunnel through an HTTP proxy to `host:port`, then TLS over it. */
function tunnel(proxy: { address: string; family: number; port: number }, auth: Record<string, string>, host: string, port: number, tls: { rejectUnauthorized: boolean }, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const authority = `${host.includes(':') ? `[${host}]` : host}:${port}`;
    const connect = httpRequest({ host: proxy.address, family: proxy.family, port: proxy.port, method: 'CONNECT', path: authority, headers: { host: authority, ...auth }, agent: false });
    const timer = setTimeout(() => connect.destroy(new Error(`the proxy did not answer within ${timeoutMs} ms`)), timeoutMs);
    connect.on('connect', (response, socket) => {
      clearTimeout(timer);
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`the proxy refused the tunnel (${response.statusCode})`));
        return;
      }
      const secure = tlsConnect({ socket, ...(isIP(host) === 0 ? { servername: host } : {}), rejectUnauthorized: tls.rejectUnauthorized, ALPNProtocols: ['http/1.1'] });
      secure.once('secureConnect', () => resolve(secure));
      secure.once('error', reject);
    });
    connect.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    connect.end();
  });
}

export async function sendRead(request: ProbeFetchRequest, limits: { timeoutMs: number; maxBytes: number }, policy: ReadPolicy): Promise<ProbeFetchResponse> {
  // The second lock: whatever the collector asks, nothing but a read leaves here.
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new Error(`Refused: ${String(request.method)} is not a read.`);
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ProbeReadRefused(`${url.protocol} is not fetched`);
  if (policy.routed(url.href)) throw new ProbeReadRefused('the page under test routes this address itself (page.route, context.route)');
  const resolver = policy.resolve ?? resolveName;
  // A name that does not resolve in time is a read that fails, held to the same bound as the rest.
  const resolve = (host: string): Promise<{ address: string; family: number }> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${host} did not resolve within ${limits.timeoutMs} ms`)), limits.timeoutMs);
    });
    return Promise.race([resolver(host), late]).finally(() => clearTimeout(timer));
  };
  const routing = policy.routing;
  const secure = url.protocol === 'https:';
  const port = Number(url.port || (secure ? 443 : 80));
  const hostname = bare(url.hostname);
  const path = `${url.pathname}${url.search}`;
  const headers: Record<string, string> = { ...request.headers, ...(policy.extraHeaders?.(url) ?? {}), host: url.host, 'accept-encoding': 'gzip, deflate, br' };
  const rejectUnauthorized = !routing.ignoreHTTPSErrors;
  const proxy = proxyFor(routing.proxy, url);

  if (proxy) {
    // The proxy resolves the name: what can be checked here is an address in the URL, or localhost.
    const literal = isIP(hostname) !== 0 ? addressClass(hostname) : loopbackName(hostname) ? 'loopback' : 'public';
    if (literal !== 'public' && !policy.privateAllowed) throw new ProbeReadRefused(`${hostname} is ${PUBLIC_ONLY}`);
    const through = await resolveTarget(routing, proxy.host, proxy.port, resolve);
    const auth = proxyAuthorization(proxy);
    if (!secure) {
      return send(() => httpRequest({ host: through.address, family: through.family, port: through.port, method: request.method, path: `${url.origin}${path}`, headers: { ...headers, ...auth }, agent: false }), request.method, limits);
    }
    const socket = await tunnel(through, auth, hostname, port, { rejectUnauthorized }, limits.timeoutMs);
    return send(() => httpRequest({ createConnection: () => socket, method: request.method, path, headers, agent: false } as RequestOptions), request.method, limits);
  }

  const target = await resolveTarget(routing, hostname, port, resolve);
  if (target.kind !== 'public' && !policy.privateAllowed) throw new ProbeReadRefused(`${hostname} is ${PUBLIC_ONLY} (${target.address})`);
  const options: RequestOptions & { servername?: string; rejectUnauthorized?: boolean; checkServerIdentity?: typeof checkServerIdentity } = {
    // The address that was checked, not the name: it is not resolved again.
    host: target.address,
    family: target.family,
    port: target.port,
    method: request.method,
    path,
    headers,
    agent: false,
  };
  if (secure) {
    if (isIP(hostname) === 0) options.servername = hostname;
    options.rejectUnauthorized = rejectUnauthorized;
    // The certificate is checked against the name of the URL, not the address connected to.
    options.checkServerIdentity = (_host, certificate) => checkServerIdentity(hostname, certificate);
  }
  return send(() => (secure ? httpsRequest(options) : httpRequest(options)), request.method, limits);
}
