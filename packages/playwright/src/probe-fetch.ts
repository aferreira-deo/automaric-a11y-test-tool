import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { connect as netConnect, isIP } from 'node:net';
import type { LookupFunction, Socket } from 'node:net';
import { checkServerIdentity, connect as tlsConnect } from 'node:tls';
import type { TLSSocket } from 'node:tls';
import { createBrotliDecompress, createGunzip, createInflate, createInflateRaw } from 'node:zlib';
import type { Transform } from 'node:stream';
import { ProbeReadRefused, ProbeReadTooLarge } from '@a11y-vision/collector-cdp';
import type { ProbeFetchRequest, ProbeFetchResponse, ProbeReadLimits } from '@a11y-vision/collector-cdp';
import { addressClass, loopbackName, mapHost, proxyFor } from './probe-routing.js';
import type { AddressClass, HttpProxy, ProbeRouting } from './probe-routing.js';

/**
 * Sends one read for a copy of the page, where the page under test's own request would go: through
 * its proxy, under its host rules, with its handling of certificates. A read the page routes itself
 * (`page.route`), a read of an address of this machine, of a private network or of a link when the
 * page under test is on none of those, and a plain-HTTP read the page's browser might have upgraded
 * (see `plainHttpRefusal`) are refused (`ProbeReadRefused`), never sent.
 *
 * Where the bytes go is checked, not assumed: every connection is opened here, to the address that
 * was checked (a name is resolved once: one that resolves elsewhere the next time, DNS rebinding,
 * changes nothing), its peer is verified once it is connected, and a request is written only on a
 * connection recorded as opened for that read and that peer (`exchange`): the TCP connection to
 * the address, the TLS session over it, the proxy, or the TLS session through the tunnel the proxy
 * opened for that authority. Anything else fails the read before a byte is written. Through a proxy,
 * the proxy resolves the name: only an address written in the URL, or `localhost`, can be checked.
 *
 * One deadline holds the whole read (the name, the connection, `CONNECT`, TLS, the headers, the
 * body), and every socket of a read is destroyed when it ends, whichever way, or when `signal`
 * aborts (the end of the scan). The body is decoded as it arrives and the read stops as soon as it
 * goes over `maxEncodedBytes` as sent or `maxBytes` decoded (`ProbeReadTooLarge`). GET and HEAD
 * only; redirects are returned, not followed.
 */

export interface ReadPolicy {
  routing: ProbeRouting;
  /** The address of the page under test: what its own requests are compared with (plain HTTP). */
  pageUrl: string;
  /** Addresses that are not of the internet may be read: the page under test is on one. */
  privateAllowed: boolean;
  /** The page under test routes this address itself (`page.route`, `context.route`): it is never sent. */
  routed(url: string): boolean;
  /** Headers added to every read (`probeContext.extraHTTPHeaders`, credentials). */
  extraHeaders?(url: URL): Record<string, string>;
  /** Resolves a name: `dns.lookup` by default (tests replace it). */
  resolve?: (host: string) => Promise<{ address: string; family: number }>;
  /** Stops the read and closes its connections (the end of the scan). */
  signal?: AbortSignal;
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

/** An address as Node reports a peer: IPv6 in its shortest form, lower case. */
function normalAddress(address: string): string {
  if (isIP(address) !== 6) return address;
  try {
    return bare(new URL(`http://[${address.replace(/%.*$/, '')}]/`).hostname);
  } catch {
    return address.toLowerCase();
  }
}

export interface Target {
  /** The host connected to, after the host rules. */
  host: string;
  address: string;
  family: number;
  port: number;
  kind: AddressClass;
  /** The connection rules (`--host-rules`) sent this host or port elsewhere. */
  connectionMapped: boolean;
}

/** What the address of a name is, through the host rules: where a direct connection would go. */
export async function resolveTarget(routing: ProbeRouting, hostname: string, port: number, resolve = resolveName): Promise<Target> {
  const name = bare(hostname).toLowerCase();
  // `--host-rules` first (where the connection goes), then `--host-resolver-rules` (how that name resolves), as Chromium layers them.
  const connection = mapHost(routing.connectionRules ?? [], name, port);
  if (!connection) throw new Error(`${name} does not resolve (host rules: ~NOTFOUND)`);
  const mapped = mapHost(routing.hostRules, connection.host, connection.port);
  if (!mapped) throw new Error(`${name} does not resolve (host rules: ~NOTFOUND)`);
  const literal = isIP(mapped.host);
  const found = literal !== 0 ? { address: mapped.host, family: literal } : await resolve(mapped.host);
  return { host: mapped.host, address: found.address, family: found.family, port: mapped.port, kind: addressClass(found.address), connectionMapped: connection.host !== name || connection.port !== port };
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

/**
 * Why a plain-HTTP read is not sent, or null. The browser of the page upgrades plain HTTP to HTTPS
 * for the hosts its profile holds as HSTS (and blocks or upgrades plain HTTP in an HTTPS page),
 * which cannot be read from here; sent in clear, such a read would put on the network what the
 * page's own request would not. So a plain-HTTP read goes only where the page's browser cannot have
 * upgraded it: the host of the page itself when the page is on plain HTTP (it was just loaded that
 * way), an address written as such (HSTS is never kept for an address), or a name of this machine
 * reached directly (nothing leaves the machine).
 */
export function plainHttpRefusal(url: URL, pageUrl: string, proxied: boolean): string | null {
  if (url.protocol !== 'http:') return null;
  const host = bare(url.hostname).toLowerCase();
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return 'a plain-HTTP address, and the address of the page under test is not known';
  }
  if (page.protocol === 'https:') return 'a plain-HTTP address, and the page under test is on HTTPS: its browser blocks or upgrades such a read (mixed content, HSTS), which cannot be known here';
  if (isIP(host) !== 0) return null;
  if (loopbackName(host) && !proxied) return null;
  if (host === bare(page.hostname).toLowerCase()) return null;
  return 'a plain-HTTP address of another host than the page under test: its browser may upgrade it to HTTPS (HSTS), which cannot be read here';
}

function proxyAuthorization(proxy: HttpProxy): string {
  if (proxy.username === undefined) return '';
  return `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}\r\n`;
}

/**
 * The connections of one read, and its one deadline. `fail` (the deadline, an abort) destroys every
 * socket it opened and rejects whatever is waiting; `close` (the end of the read) destroys them too.
 */
class Read {
  private readonly sockets = new Set<Socket>();
  private readonly waiting = new Set<(error: Error) => void>();
  private failed: Error | null = null;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onAbort = (): void => this.fail(new Error('the read was stopped (the scan ended)'));

  constructor(
    timeoutMs: number,
    private readonly signal?: AbortSignal,
  ) {
    this.timer = setTimeout(() => this.fail(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
    if (signal?.aborted) this.onAbort();
    else signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  fail(error: Error): void {
    if (this.failed) return;
    this.failed = error;
    for (const socket of this.sockets) socket.destroy();
    for (const reject of this.waiting) reject(error);
    this.waiting.clear();
  }

  /** Settles as `promise` does, or rejects as soon as the read fails (its deadline, an abort). */
  race<T>(promise: Promise<T>): Promise<T> {
    if (this.failed) {
      promise.catch(() => undefined);
      return Promise.reject(this.failed);
    }
    return new Promise<T>((resolve, reject) => {
      this.waiting.add(reject);
      promise.then(
        (value) => {
          this.waiting.delete(reject);
          resolve(value);
        },
        (error: unknown) => {
          this.waiting.delete(reject);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  track<S extends Socket>(socket: S): S {
    socket.on('error', () => undefined);
    if (this.failed) {
      socket.destroy();
      throw this.failed;
    }
    this.sockets.add(socket);
    return socket;
  }

  close(): void {
    clearTimeout(this.timer);
    this.signal?.removeEventListener('abort', this.onAbort);
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }
}

/** The peer each socket of a read was opened and verified for: a request is written only on a socket recorded here for the peer it is meant for. */
const verified = new WeakMap<Socket, string>();

const noLookup: LookupFunction = (hostname, _options, callback) => {
  (callback as (error: Error) => void)(new Error(`${hostname} is not resolved again`));
};

interface Peer {
  address: string;
  family: number;
  port: number;
}

const peerLabel = (peer: Peer): string => `${normalAddress(peer.address)}:${peer.port}`;

/** A TCP connection to the address that was checked, and to nothing else: its peer is verified once connected. */
async function connectTcp(read: Read, peer: Peer, label: string): Promise<Socket> {
  const socket = read.track(netConnect({ host: peer.address, port: peer.port, family: peer.family, lookup: noLookup }));
  await read.race(
    new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    }),
  );
  if (normalAddress(socket.remoteAddress ?? '') !== normalAddress(peer.address) || socket.remotePort !== peer.port) {
    socket.destroy();
    throw new Error(`Refused: the connection went to ${String(socket.remoteAddress)}:${String(socket.remotePort)}, not to ${peerLabel(peer)}.`);
  }
  verified.set(socket, label);
  return socket;
}

/** TLS over a verified connection, the certificate checked against `name` unless errors are ignored. */
async function tlsOver(read: Read, socket: Socket, name: string, rejectUnauthorized: boolean, label: string): Promise<TLSSocket> {
  if (!verified.has(socket)) throw new Error('Refused: TLS over a connection that was not checked.');
  const secure = read.track(
    tlsConnect({
      socket,
      ...(isIP(name) === 0 ? { servername: name } : {}),
      rejectUnauthorized,
      checkServerIdentity: (_host, certificate) => checkServerIdentity(name, certificate),
      ALPNProtocols: ['http/1.1'],
    }),
  );
  await read.race(
    new Promise<void>((resolve, reject) => {
      secure.once('secureConnect', resolve);
      secure.once('error', reject);
    }),
  );
  if (secure.alpnProtocol && secure.alpnProtocol !== 'http/1.1') throw new Error(`the server chose ${String(secure.alpnProtocol)}, not HTTP/1.1`);
  verified.set(secure, label);
  return secure;
}

/** The status line and headers of the proxy's answer to `CONNECT`, read from the socket and no further. */
function connectAnswer(socket: Socket): Promise<{ status: number; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffered.byteLength > 16384) done(new Error('the answer of the proxy to CONNECT is too long'));
        return;
      }
      socket.pause();
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buffered.subarray(0, end).toString('latin1'))?.[1] ?? 0);
      done(null, { status, rest: buffered.subarray(end + 4) });
    };
    const onClose = (): void => done(new Error('the proxy closed the connection before it answered CONNECT'));
    const onError = (error: Error): void => done(error);
    const done = (error: Error | null, answer?: { status: number; rest: Buffer }): void => {
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onError);
      if (error) reject(error);
      else resolve(answer!);
    };
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

/** A tunnel through an HTTP proxy to `authority`, then TLS over it, checked against `host`. */
async function tunnel(read: Read, proxy: Peer, proxyCredentials: string, host: string, authority: string, rejectUnauthorized: boolean): Promise<{ socket: TLSSocket; label: string }> {
  const proxyLabel = `proxy ${peerLabel(proxy)}`;
  const socket = await connectTcp(read, proxy, proxyLabel);
  const answer = connectAnswer(socket);
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${proxyCredentials}\r\n`);
  const { status, rest } = await read.race(answer);
  if (status !== 200) throw new Error(`the proxy refused the tunnel (${status})`);
  if (rest.byteLength > 0) throw new Error('the proxy sent data before the TLS handshake');
  const label = `tunnel ${peerLabel(proxy)} to ${authority}`;
  return { socket: await tlsOver(read, socket, host, rejectUnauthorized, label), label };
}

function deflateDecoder(first: Buffer): Transform {
  // A zlib stream (RFC 1950) starts with a header whose first two bytes are a multiple of 31; a raw one (RFC 1951) does not.
  const zlib = first.byteLength >= 2 && (first[0]! & 0x0f) === 8 && ((first[0]! << 8) | first[1]!) % 31 === 0;
  return zlib ? createInflate() : createInflateRaw();
}

/** Reads a response to its end and decodes it as it arrives, within the limits. */
function readResponse(response: IncomingMessage, method: string, limits: ProbeReadLimits): Promise<ProbeFetchResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let decoder: Transform | null = null;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      decoder?.destroy();
      response.destroy();
      reject(error);
    };
    const declared = Number(response.headers['content-length'] ?? NaN);
    if (declared > limits.maxEncodedBytes) {
      fail(new ProbeReadTooLarge(`the response is larger than allowed (${declared} bytes declared, ${limits.maxEncodedBytes} at most)`));
      return;
    }
    const encoding = method === 'HEAD' ? '' : String(response.headers['content-encoding'] ?? '').trim().toLowerCase();
    if (!['', 'identity', 'gzip', 'x-gzip', 'deflate', 'br'].includes(encoding)) {
      fail(new Error(`the response is encoded as ${encoding}, which is not decoded here`));
      return;
    }
    const chunks: Buffer[] = [];
    let encoded = 0;
    let decoded = 0;
    const take = (chunk: Buffer): void => {
      if (settled) return;
      decoded += chunk.byteLength;
      if (decoded > limits.maxBytes) {
        fail(new ProbeReadTooLarge(`the response is larger than allowed decoded (more than ${limits.maxBytes} bytes)`));
        return;
      }
      chunks.push(chunk);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      const body = Buffer.concat(chunks);
      const lines: { name: string; value: string }[] = [];
      for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) lines.push({ name: response.rawHeaders[index]!.toLowerCase(), value: response.rawHeaders[index + 1]! });
      resolve({ status: response.statusCode ?? 0, headers: lines, body: body.toString('base64'), size: body.byteLength });
    };
    const startDecoder = (first: Buffer): Transform => {
      const made = encoding === 'br' ? createBrotliDecompress() : encoding === 'deflate' ? deflateDecoder(first) : createGunzip();
      made.on('data', take);
      made.on('end', finish);
      made.on('error', (error: Error) => fail(error));
      return made;
    };
    response.on('data', (chunk: Buffer) => {
      if (settled) return;
      encoded += chunk.byteLength;
      if (encoded > limits.maxEncodedBytes) {
        fail(new ProbeReadTooLarge(`the response is larger than allowed as sent (more than ${limits.maxEncodedBytes} bytes)`));
        return;
      }
      if (encoding === '' || encoding === 'identity') {
        take(chunk);
        return;
      }
      decoder ??= startDecoder(chunk);
      decoder.write(chunk);
    });
    response.on('end', () => {
      if (decoder) decoder.end();
      else finish();
    });
    response.on('error', (error) => fail(error));
    response.on('close', () => {
      if (!response.complete) fail(new Error('the connection closed before the end of the response'));
    });
  });
}

/** Writes the request on `socket`, which must be the connection verified for `label`, and nothing else; reads the response. */
function exchange(read: Read, socket: Socket, label: string, method: string, path: string, headers: Record<string, string>, limits: ProbeReadLimits): Promise<ProbeFetchResponse> {
  if (socket.destroyed || verified.get(socket) !== label) return Promise.reject(new Error(`Refused: the connection is not the one checked for this read (${label}).`));
  return read.race(
    new Promise<ProbeFetchResponse>((resolve, reject) => {
      // No agent: the request goes on this socket, and an agent would open its own.
      const request = httpRequest({ createConnection: () => socket, method, path, headers, setHost: false });
      request.once('socket', (used: Socket) => {
        if (used !== socket) {
          used.destroy();
          request.destroy(new Error('Refused: the request was given another connection than the one checked.'));
        }
      });
      request.on('response', (response) => void readResponse(response, method, limits).then(resolve, reject));
      request.on('error', reject);
      request.end();
    }),
  );
}

export async function sendRead(request: ProbeFetchRequest, limits: ProbeReadLimits, policy: ReadPolicy): Promise<ProbeFetchResponse> {
  // The second lock: whatever the collector asks, nothing but a read leaves here.
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new Error(`Refused: ${String(request.method)} is not a read.`);
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ProbeReadRefused(`${url.protocol} is not fetched`);
  if (policy.routed(url.href)) throw new ProbeReadRefused('the page under test routes this address itself (page.route, context.route)');
  const routing = policy.routing;
  const proxy = proxyFor(routing.proxy, url);
  const secure = url.protocol === 'https:';
  const port = Number(url.port || (secure ? 443 : 80));
  const hostname = bare(url.hostname);
  const path = `${url.pathname}${url.search}`;
  const headers: Record<string, string> = { ...request.headers, ...(policy.extraHeaders?.(url) ?? {}), host: url.host, 'accept-encoding': 'gzip, deflate, br' };
  const rejectUnauthorized = !routing.ignoreHTTPSErrors;
  const resolver = policy.resolve ?? resolveName;

  const read = new Read(limits.timeoutMs, policy.signal);
  try {
    const resolve = (host: string): Promise<{ address: string; family: number }> => read.race(resolver(host));
    if (proxy) {
      // The proxy resolves the name: what can be checked here is an address in the URL, or localhost.
      const literal = isIP(hostname) !== 0 ? addressClass(hostname) : loopbackName(hostname) ? 'loopback' : 'public';
      if (literal !== 'public' && !policy.privateAllowed) throw new ProbeReadRefused(`${hostname} is ${PUBLIC_ONLY}`);
      const plain = plainHttpRefusal(url, policy.pageUrl, true);
      if (plain) throw new ProbeReadRefused(plain);
      const through = await resolveTarget(routing, proxy.host, proxy.port, resolve);
      const credentials = proxyAuthorization(proxy);
      if (!secure) {
        const label = `proxy ${peerLabel(through)}`;
        const socket = await connectTcp(read, through, label);
        const auth = credentials ? { 'proxy-authorization': credentials.slice('Proxy-Authorization: '.length, -2) } : {};
        return await exchange(read, socket, label, request.method, `${url.origin}${path}`, { ...headers, ...auth }, limits);
      }
      const authority = `${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`;
      const { socket, label } = await tunnel(read, through, credentials, hostname, authority, rejectUnauthorized);
      return await exchange(read, socket, label, request.method, path, headers, limits);
    }

    const target = await resolveTarget(routing, hostname, port, resolve);
    if (target.kind !== 'public' && !policy.privateAllowed) throw new ProbeReadRefused(`${hostname} is ${PUBLIC_ONLY} (${target.address})`);
    const plain = plainHttpRefusal(url, policy.pageUrl, false);
    if (plain) throw new ProbeReadRefused(plain);
    // Under `--host-rules` Chromium checks the certificate against the host it was sent to, which is not followed here.
    if (secure && target.connectionMapped) throw new ProbeReadRefused('an HTTPS address that the host rules of the browser of the page (--host-rules) send elsewhere: the name its certificate is checked against is not known here');
    // The address that was checked, not the name: it is not resolved again.
    const label = `tcp ${peerLabel(target)}`;
    const socket = await connectTcp(read, target, label);
    if (!secure) return await exchange(read, socket, label, request.method, path, headers, limits);
    // The certificate is checked against the name of the URL, not the address connected to.
    const tlsLabel = `tls ${peerLabel(target)} for ${hostname}`;
    const secured = await tlsOver(read, socket, hostname, rejectUnauthorized, tlsLabel);
    return await exchange(read, secured, tlsLabel, request.method, path, headers, limits);
  } finally {
    read.close();
  }
}
