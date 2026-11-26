import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withoutUserInfo } from '@a11y-vision/collector-cdp';

/**
 * Where the requests of the page under test go, read from its browser, so that the reads the
 * collector sends for the copies of the page go to the same place, or nowhere.
 *
 * What Chromium follows, and what is followed here:
 * - a proxy: of the context of the page (Playwright's `newContext({ proxy })`), else of its browser
 *   (`--proxy-server`, `--proxy-bypass-list`, which Playwright's `launch({ proxy })` writes), else of
 *   the system. HTTP proxies are followed; a proxy script (`--proxy-pac-url`, auto-detection), a
 *   SOCKS or HTTPS proxy, and a proxy of the system are not: probing does not start, and says why;
 * - host rules (`--host-resolver-rules`, `--host-rules`): `MAP pattern host[:port]`, `EXCLUDE pattern`;
 * - certificate errors ignored (`ignoreHTTPSErrors` of the context, `--ignore-certificate-errors`).
 * What the host is told (`probeContext.proxy`, `hostResolverRules`, `ignoreHTTPSErrors`) comes first.
 */

export interface HttpProxy {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface ProxyRules {
  /** The proxy for addresses of each scheme; absent: direct. */
  http?: HttpProxy;
  https?: HttpProxy;
  bypass: BypassRule[];
  /** `<-loopback>`: loopback and link-local addresses go through the proxy too. */
  proxyLoopback: boolean;
}

export interface HostRule {
  kind: 'map' | 'exclude';
  pattern: RegExp;
  /** For `map`: the host to connect to instead, or null for `~NOTFOUND`. */
  host?: string | null;
  port?: number;
}

export interface ProbeRouting {
  proxy: ProxyRules | null;
  /** `--host-resolver-rules`: how a name resolves. */
  hostRules: HostRule[];
  /** `--host-rules`: where a connection to a host goes, applied before `hostRules`. */
  connectionRules?: HostRule[];
  ignoreHTTPSErrors: boolean;
  /** `--explicitly-allowed-ports` of the browser of the page: ports it does not refuse although Chromium restricts them. */
  allowedPorts?: number[];
  /**
   * The browser of the page finds its proxy by itself on the network (the system's automatic
   * detection, WPAD), which cannot be known here: only addresses of this machine by name or by
   * address, which Chromium never sends to a proxy, are read; the reason, for the others.
   */
  proxyUnknown?: string;
  /** How the reads are sent, in a few words, for the survey. */
  description: string;
}

/** Why the routing of the page cannot be followed; its message never holds credentials (`redactCredentials`). */
export class RoutingRefusal extends Error {
  constructor(message: string) {
    super(redactCredentials(message));
  }
}

/**
 * Text with the user information of every address in it removed, whatever a password holds:
 * `http://user:p=ss@host` and `user:p;ss@host` (an `http_proxy` written without a scheme) become
 * `http://host` and `host` (see `withoutUserInfo`). For free text; what says where a proxy is is
 * built from its parsed host and port (`shownProxy`).
 */
export function redactCredentials(text: string): string {
  return withoutUserInfo(text);
}

/**
 * An address of a proxy as it can be shown: its scheme, host and port, from what follows the last
 * `@` (credentials never), without a path. Null when no host and port can be read there: then
 * nothing of it is shown.
 */
export function shownProxy(text: string): string | null {
  const trimmed = text.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1]?.toLowerCase();
  const rest = trimmed.slice(trimmed.lastIndexOf('@') + 1).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '');
  const address = hostPort(rest, -1);
  if (!address) return null;
  const host = address.host.includes(':') ? `[${address.host}]` : address.host;
  return `${scheme ? `${scheme}://` : ''}${host}${address.port > 0 ? `:${address.port}` : ''}`;
}

/** Splits a command line as Chromium writes it (`SystemInfo.getInfo`): quoted on Windows, joined with spaces elsewhere. */
export function commandLineArgs(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(char) && !quoted) {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) tokens.push(current);
  if (line.includes('"')) return tokens;
  // Not quoted (POSIX): a value with spaces was split; what does not start a switch belongs to the one before.
  const joined: string[] = [];
  for (const token of tokens) {
    if (joined.length > 1 && !token.startsWith('-')) joined[joined.length - 1] += ` ${token}`;
    else joined.push(token);
  }
  return joined;
}

/** The switches of a command line, last one wins, and the program. */
export function switchesOf(args: string[]): { program: string; switches: Map<string, string> } {
  const switches = new Map<string, string>();
  for (const arg of args.slice(1)) {
    const match = /^--?([^=]+)(?:=([\s\S]*))?$/.exec(arg);
    if (match) switches.set(match[1]!.toLowerCase(), match[2] ?? '');
  }
  return { program: args[0] ?? '', switches };
}

function glob(pattern: string): RegExp {
  const source = pattern
    .toLowerCase()
    .split('')
    .map((char) => (char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`, 'u');
}

/** A host and an optional port, `[::1]:80` and `::1` included. */
function hostPort(text: string, defaultPort: number): { host: string; port: number } | null {
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracket) return { host: bracket[1]!.toLowerCase(), port: bracket[2] ? Number(bracket[2]) : defaultPort };
  if (isIP(text) === 6) return { host: text.toLowerCase(), port: defaultPort };
  const match = /^([^:/\s]+)(?::(\d+))?$/.exec(text);
  if (!match) return null;
  if (!match[2]) return { host: match[1]!.toLowerCase(), port: defaultPort };
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: match[1]!.toLowerCase(), port };
}

/** `MAP pattern replacement[:port]`, `EXCLUDE pattern`, separated by commas, as Chromium parses them. */
export function parseHostRules(text: string): HostRule[] {
  const rules: HostRule[] = [];
  for (const raw of text.split(',')) {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const keyword = parts[0]!.toUpperCase();
    if (keyword === 'EXCLUDE' && parts.length === 2) {
      rules.push({ kind: 'exclude', pattern: glob(parts[1]!) });
    } else if (keyword === 'MAP' && parts.length === 3) {
      if (parts[2] === '~NOTFOUND') {
        rules.push({ kind: 'map', pattern: glob(parts[1]!), host: null });
        continue;
      }
      const target = hostPort(parts[2]!, -1);
      if (!target) throw new RoutingRefusal(`a host rule could not be read (${raw.trim()})`);
      rules.push({ kind: 'map', pattern: glob(parts[1]!), host: target.host, ...(target.port > 0 ? { port: target.port } : {}) });
    } else {
      throw new RoutingRefusal(`a host rule could not be read (${raw.trim()})`);
    }
  }
  return rules;
}

/** Where a connection to `host:port` goes under the host rules: another host or port, `null` when the rules say it does not exist. */
export function mapHost(rules: HostRule[], host: string, port: number): { host: string; port: number } | null {
  const name = host.toLowerCase();
  const withPort = `${name.includes(':') ? `[${name}]` : name}:${port}`;
  const matches = (rule: HostRule): boolean => rule.pattern.test(withPort) || rule.pattern.test(name);
  if (rules.some((rule) => rule.kind === 'exclude' && matches(rule))) return { host: name, port };
  for (const rule of rules) {
    if (rule.kind !== 'map' || !matches(rule)) continue;
    if (rule.host === null || rule.host === undefined) return null;
    return { host: rule.host, port: rule.port ?? port };
  }
  return { host: name, port };
}

/** One proxy of a `--proxy-server` list: only HTTP proxies are followed. */
function proxyOf(text: string, credentials?: { username?: string; password?: string }): HttpProxy | 'direct' {
  const trimmed = text.trim();
  const scheme = /^([a-z0-9]+):\/\//i.exec(trimmed)?.[1]?.toLowerCase() ?? 'http';
  if (scheme === 'direct') return 'direct';
  // What is said of a proxy is its parsed host and port, never the text it was given in.
  const shown = shownProxy(trimmed);
  if (scheme !== 'http') throw new RoutingRefusal(`the browser of the page uses a ${scheme} proxy${shown ? ` (${shown})` : ''}, which the reads of the copies cannot follow`);
  const rest = trimmed.replace(/^[a-z0-9]+:\/\//i, '');
  // The credentials end at the last `@`, whatever they hold (`:`, `/`, `?`, `@`); a path comes after the host only.
  const at = rest.lastIndexOf('@');
  const user = at >= 0 ? rest.slice(0, at) : '';
  const address = hostPort((at >= 0 ? rest.slice(at + 1) : rest).replace(/[/?#].*$/, ''), 80);
  if (!address) throw new RoutingRefusal(`the proxy of the browser of the page could not be read${shown ? ` (${shown})` : ''}`);
  const colon = user.indexOf(':');
  const name = colon >= 0 ? user.slice(0, colon) : user;
  const password = colon >= 0 ? user.slice(colon + 1) : '';
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const username = credentials?.username ?? (name ? decode(name) : undefined);
  const secret = credentials?.password ?? (colon >= 0 ? decode(password) : undefined);
  return { host: address.host, port: address.port, ...(username !== undefined ? { username } : {}), ...(secret !== undefined ? { password: secret } : {}) };
}

/**
 * `--proxy-server` as Chromium reads it: one proxy for every scheme (`host:port`, `http://host:port`),
 * or one per scheme (`http=host:port;https=host:port`, `socks=` for the others). The first of a list
 * of fallbacks is taken: when it fails, the read fails, it goes nowhere else.
 */
export function parseProxyServer(server: string, bypass: string, credentials?: { username?: string; password?: string }): ProxyRules {
  const rules: ProxyRules = { ...parseBypass(bypass) };
  const entries = server.split(';').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new RoutingRefusal('the proxy of the browser of the page is empty');
  const first = (list: string): HttpProxy | 'direct' => proxyOf(list.split(',')[0] ?? '', credentials);
  // One proxy for every scheme, or `scheme=` lists: told apart by how the entry starts, not by an `=` a password may hold.
  if (entries.length === 1 && !/^[a-z0-9-]+\s*=/i.test(entries[0]!)) {
    const proxy = first(entries[0]!);
    if (proxy !== 'direct') {
      rules.http = proxy;
      rules.https = proxy;
    }
    return rules;
  }
  let fallback: HttpProxy | 'direct' | undefined;
  for (const entry of entries) {
    const equals = /^[a-z0-9-]+\s*=/i.exec(entry);
    if (!equals) throw new RoutingRefusal(`the proxy of the browser of the page could not be read${shownProxy(entry) ? ` (${shownProxy(entry)})` : ''}`);
    const name = equals[0].replace('=', '').trim().toLowerCase();
    const list = entry.slice(equals[0].length);
    if (name === 'socks') {
      fallback = first(list.includes('://') ? list : `socks4://${list}`);
      continue;
    }
    if (name !== 'http' && name !== 'https') continue;
    const proxy = first(list);
    if (proxy !== 'direct') rules[name] = proxy;
  }
  if (fallback && fallback !== 'direct') {
    rules.http ??= fallback;
    rules.https ??= fallback;
  }
  return rules;
}

export interface BypassRule {
  scheme?: string;
  host?: RegExp;
  port?: number;
  /** An address range: an address and a prefix length. */
  range?: { address: string; bits: number };
  local?: true;
}

export function parseBypass(text: string): { bypass: BypassRule[]; proxyLoopback: boolean } {
  const bypass: BypassRule[] = [];
  let proxyLoopback = false;
  for (const raw of text.split(/[,;]/)) {
    let entry = raw.trim();
    if (entry === '') continue;
    if (entry === '<-loopback>') {
      proxyLoopback = true;
      continue;
    }
    if (entry === '<local>') {
      bypass.push({ local: true });
      continue;
    }
    const range = /^\[?([0-9a-fA-F:.]+)\]?\/(\d+)$/.exec(entry);
    if (range && isIP(range[1]!)) {
      bypass.push({ range: { address: range[1]!, bits: Number(range[2]) } });
      continue;
    }
    if (isIP(entry)) {
      bypass.push({ range: { address: entry, bits: isIP(entry) === 4 ? 32 : 128 } });
      continue;
    }
    const rule: BypassRule = {};
    const scheme = /^([a-z0-9+.-]+):\/\//i.exec(entry);
    if (scheme) {
      rule.scheme = scheme[1]!.toLowerCase();
      entry = entry.slice(scheme[0].length);
    }
    const parts = entry.startsWith('[') ? /^\[([^\]]+)\](?::(\d+))?$/.exec(entry) : /^([^:]*)(?::(\d+))?$/.exec(entry);
    if (!parts) throw new RoutingRefusal(`the proxy bypass list of the browser of the page could not be read (${raw.trim()})`);
    let host = parts[1]!;
    if (parts[2]) rule.port = Number(parts[2]);
    if (host.startsWith('.')) host = `*${host}`;
    if (isIP(host)) bypass.push({ ...rule, range: { address: host, bits: isIP(host) === 4 ? 32 : 128 } });
    else bypass.push({ ...rule, host: glob(host) });
  }
  return { bypass, proxyLoopback };
}

function ipv4Number(address: string): number {
  return address.split('.').reduce((total, part) => total * 256 + Number(part), 0);
}

/** The 16 bytes of an IPv6 address, `::ffff:127.0.0.1` included. */
function ipv6Bytes(address: string): number[] {
  let text = address.toLowerCase().replace(/%.*$/, '');
  let tail: number[] = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const n = ipv4Number(v4[1]!);
    tail = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    text = text.slice(0, -v4[1]!.length);
    if (text.endsWith(':') && !text.endsWith('::')) text = text.slice(0, -1);
  }
  const halves = text.split('::');
  const groups = (part: string | undefined): number[] => (part ? part.split(':').filter(Boolean).map((group) => parseInt(group, 16)) : []);
  const head = groups(halves[0]);
  const back = halves.length > 1 ? groups(halves[1]) : [];
  const middle = halves.length > 1 ? Math.max(0, 8 - tail.length / 2 - head.length - back.length) : 0;
  const all = [...head, ...new Array<number>(middle).fill(0), ...back];
  return [...all.flatMap((group) => [(group >> 8) & 255, group & 255]), ...tail].slice(0, 16);
}

function inRange(address: string, range: { address: string; bits: number }): boolean {
  const family = isIP(address);
  if (family === 0 || family !== isIP(range.address)) return false;
  if (family === 4) {
    const bits = Math.min(32, range.bits);
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : ~((1 << (32 - bits)) - 1) >>> 0;
    return ((ipv4Number(address) & mask) >>> 0) === ((ipv4Number(range.address) & mask) >>> 0);
  }
  const a = ipv6Bytes(address);
  const b = ipv6Bytes(range.address);
  let bits = Math.min(128, range.bits);
  for (let index = 0; index < 16 && bits > 0; index++, bits -= 8) {
    const mask = bits >= 8 ? 255 : (255 << (8 - bits)) & 255;
    if ((a[index]! & mask) !== (b[index]! & mask)) return false;
  }
  return true;
}

/** What an address is: one of the internet, or of this machine, of a private network, of a link. */
export type AddressClass = 'public' | 'loopback' | 'private' | 'link-local' | 'unspecified' | 'other';

export function addressClass(address: string): AddressClass {
  const family = isIP(address);
  if (family === 4) {
    const ranges: [string, number, AddressClass][] = [
      ['0.0.0.0', 8, 'unspecified'],
      ['127.0.0.0', 8, 'loopback'],
      ['10.0.0.0', 8, 'private'],
      ['172.16.0.0', 12, 'private'],
      ['192.168.0.0', 16, 'private'],
      ['100.64.0.0', 10, 'private'],
      ['169.254.0.0', 16, 'link-local'],
      ['192.0.0.0', 24, 'other'],
      ['198.18.0.0', 15, 'other'],
      ['224.0.0.0', 4, 'other'],
      ['240.0.0.0', 4, 'other'],
    ];
    for (const [base, bits, kind] of ranges) if (inRange(address, { address: base, bits })) return kind;
    return 'public';
  }
  if (family === 6) {
    const bytes = ipv6Bytes(address);
    const embedded = (from: number): string => bytes.slice(from, from + 4).join('.');
    // An IPv4 address written as IPv6 (`::ffff:127.0.0.1`), or through NAT64 (`64:ff9b::a9fe:a9fe`): what it holds.
    if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 255 && bytes[11] === 255) return addressClass(embedded(12));
    if (inRange(address, { address: '64:ff9b::', bits: 96 })) return addressClass(embedded(12));
    if (bytes.every((byte) => byte === 0)) return 'unspecified';
    if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return 'loopback';
    if (inRange(address, { address: 'fe80::', bits: 10 })) return 'link-local';
    if (inRange(address, { address: 'fc00::', bits: 7 })) return 'private';
    if (inRange(address, { address: 'ff00::', bits: 8 })) return 'other';
    return 'public';
  }
  return 'other';
}

/** A host name that is this machine by its name (`localhost`, `*.localhost`), as Chromium treats it. */
export function loopbackName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return name === 'localhost' || name.endsWith('.localhost');
}

/** The proxy that a read of `url` goes through, or null for a direct connection, as Chromium decides it. */
export function proxyFor(rules: ProxyRules | null, url: URL): HttpProxy | null {
  if (!rules) return null;
  const scheme = url.protocol.replace(':', '');
  const proxy = scheme === 'https' ? rules.https : scheme === 'http' ? rules.http : undefined;
  if (!proxy) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = Number(url.port || (scheme === 'https' ? 443 : 80));
  if (!rules.proxyLoopback) {
    const literal = isIP(host) ? addressClass(host) : null;
    if (loopbackName(host) || literal === 'loopback' || literal === 'link-local') return null;
  }
  for (const rule of rules.bypass) {
    if (rule.local) {
      if (!host.includes('.') && isIP(host) === 0) return null;
      continue;
    }
    if (rule.scheme && rule.scheme !== scheme) continue;
    if (rule.port !== undefined && rule.port !== port) continue;
    if (rule.range ? isIP(host) !== 0 && inRange(host, rule.range) : rule.host?.test(host)) return null;
  }
  return proxy;
}

function describeProxy(rules: ProxyRules): string {
  const shown = (proxy: HttpProxy | undefined): string => (proxy ? `http://${proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host}:${proxy.port}` : 'direct');
  return rules.http === rules.https ? `proxy ${shown(rules.http)}` : `proxy ${shown(rules.http)} for http, ${shown(rules.https)} for https`;
}

/** What the host is told, `probeContext`. */
export interface StatedRouting {
  proxy?: { server: string; bypass?: string; username?: string; password?: string } | null;
  hostResolverRules?: string;
  ignoreHTTPSErrors?: boolean;
  /** How the caller enables probing where the proxy of the system cannot be followed (the CLI names its `--proxy`); by default `DEFAULT_ADVICE`. */
  advice?: string;
}

/** How probing is enabled where the proxy of the system cannot be followed, said to a caller of the Playwright API. */
export const DEFAULT_ADVICE = 'to probe, say how the page reaches the network: probeContext.proxy (null when this machine reaches the site directly), or launch its browser with --no-proxy-server or a proxy';

/** What was read of the browser and the context of the page. */
export interface ReadRouting {
  /** The command line of the browser of the page, or null when it could not be read. */
  commandLine: string | null;
  /** The proxy of the context of the page: undefined when it cannot be read (a browser driven from another process), null when it has none. */
  contextProxy: { server: string; bypass?: string; username?: string; password?: string } | null | undefined;
  /** Credentials of the proxy the browser was launched with, which its command line does not hold. */
  launchProxy?: { server: string; username?: string; password?: string };
  contextIgnoresHTTPSErrors: boolean;
  /** The proxy of the system, when the browser runs on this machine and uses it; null: none. Undefined: not read (the browser is elsewhere). */
  systemProxy: string | null | undefined;
  /** Read with `systemProxy`: the system detects a proxy on the network (WPAD), in a few words; absent when it does not, or was not read. */
  systemAutoDetect?: string;
  /**
   * The browser of the page was launched by this process (`launch`, `launchPersistentContext`), as
   * Playwright's objects in this process show. False for a browser it connected to
   * (`connectOverCDP`, `connect`, a `launchServer`), and when that cannot be read.
   */
  launchedHere: boolean;
}

/** Playwright adds `<-loopback>` to a proxy's bypass list, unless the list names loopback (or an environment variable says not to). */
function playwrightBypass(bypass: string | undefined): string {
  const hosts = (bypass ?? '').split(',').map((host) => host.trim());
  const named = ['localhost', '127.0.0.1', '::1', '[::]', '[::1]', '<loopback>', '<-loopback>'].some((host) => hosts.includes(host));
  const add = !named && !process.env['PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK'];
  const list = hosts.filter(Boolean).map((host) => (host.startsWith('.') ? `*${host}` : host));
  return [...list, ...(add ? ['<-loopback>'] : [])].join(';');
}

/**
 * Where the reads of the copies go: what the host was told first, then what the context and the
 * browser of the page say, then the system. Throws a `RoutingRefusal` with the reason when that
 * cannot be read or followed.
 */
export function resolveRouting(stated: StatedRouting, read: ReadRouting): ProbeRouting {
  const advice = stated.advice ?? DEFAULT_ADVICE;
  // A browser this process did not launch may be on another machine, behind another network: its command line
  // and its context say how it is set up, not where its requests go from there. Only what the caller says is followed.
  if (!read.launchedHere && (stated.proxy === undefined || stated.hostResolverRules === undefined)) {
    throw new RoutingRefusal(
      'the browser of the page was not launched by this process (connectOverCDP, connect, launchServer): where its requests go (its proxy, its host rules, its network) cannot be read from here; say it with probeContext.proxy (null for none) and probeContext.hostResolverRules ("" for none)',
    );
  }
  const switches = read.commandLine !== null ? switchesOf(commandLineArgs(read.commandLine)).switches : null;
  let proxy: ProxyRules | null;
  let proxyUnknown: string | undefined;
  if (stated.proxy !== undefined) {
    proxy = stated.proxy === null ? null : parseProxyServer(stated.proxy.server, playwrightBypass(stated.proxy.bypass), stated.proxy);
  } else if (read.contextProxy === undefined) {
    throw new RoutingRefusal('the browser of the page is driven from another process (connect, connectOverCDP): whether its context has a proxy cannot be read; say it with probeContext.proxy (null for none)');
  } else if (read.contextProxy !== null) {
    proxy = parseProxyServer(read.contextProxy.server, playwrightBypass(read.contextProxy.bypass), read.contextProxy);
  } else if (switches === null) {
    throw new RoutingRefusal('the command line of the browser of the page could not be read, so neither can its proxy; say it with probeContext.proxy (null for none)');
  } else if (switches.has('proxy-pac-url') || switches.has('proxy-auto-detect')) {
    throw new RoutingRefusal('the browser of the page takes its proxy from a script (--proxy-pac-url, --proxy-auto-detect), which the reads of the copies cannot follow; say it with probeContext.proxy');
  } else if (switches.has('no-proxy-server')) {
    proxy = null;
  } else if (switches.has('proxy-server')) {
    const launch = read.launchProxy;
    proxy = parseProxyServer(switches.get('proxy-server')!, switches.get('proxy-bypass-list') ?? '', launch && launch.server === switches.get('proxy-server') ? launch : undefined);
  } else if (read.systemProxy === undefined) {
    throw new RoutingRefusal('the browser of the page is not on this machine, so the proxy of its system cannot be read; say it with probeContext.proxy (null for none)');
  } else if (read.systemProxy !== null) {
    throw new RoutingRefusal(`the browser of the page uses the proxy of the system (${read.systemProxy}), which the reads of its copies do not follow, so no control was activated and what controls do was not examined; ${advice}`);
  } else {
    proxy = null;
    // The system's settings, with automatic detection on: on a network that offers a proxy (WPAD), the page's requests go there.
    if (read.systemAutoDetect) proxyUnknown = `the browser of the page uses the settings of the system, which detect a proxy on the network automatically (${read.systemAutoDetect}), so where the reads of its copies would go cannot be known, no control was activated and what controls do was not examined; ${advice}`;
  }
  let hostRules: HostRule[];
  let connectionRules: HostRule[] = [];
  let rulesText: string;
  const sameRules = (a: string, b: string): boolean => {
    const normal = (text: string): string => text.split(',').map((rule) => rule.trim().split(/\s+/).filter(Boolean).join(' ').toLowerCase()).filter(Boolean).join(',');
    return normal(a) === normal(b);
  };
  if (stated.hostResolverRules !== undefined && switches !== null) {
    // The command line is read: its rules are where the page's requests go, whatever the caller says. What it says is
    // taken only when it says the same, or the command line has none; otherwise nothing is sent.
    const resolver = switches.get('host-resolver-rules') ?? '';
    const connection = switches.get('host-rules') ?? '';
    const agrees = (resolver === '' && connection === '') || (connection === '' && sameRules(stated.hostResolverRules, resolver));
    if (!agrees) {
      throw new RoutingRefusal(
        `probeContext.hostResolverRules (${stated.hostResolverRules === '' ? 'none' : `"${stated.hostResolverRules}"`}) is not what the browser of the page has (${[...(connection ? [`--host-rules=${connection}`] : []), ...(resolver ? [`--host-resolver-rules=${resolver}`] : [])].join(' ')}), and its command line says where its requests go: leave the option out, or say the same rules`,
      );
    }
  }
  if (stated.hostResolverRules !== undefined && (switches === null || (switches.get('host-resolver-rules') ?? '') === '')) {
    // Said by the caller where the command line cannot be read, or has none.
    rulesText = stated.hostResolverRules;
    hostRules = parseHostRules(rulesText);
  } else if (switches !== null) {
    const resolver = switches.get('host-resolver-rules') ?? '';
    const connection = switches.get('host-rules') ?? '';
    if (connection !== '' && proxy) throw new RoutingRefusal('the browser of the page has host rules (--host-rules) and a proxy, which the reads of the copies cannot follow together');
    // Two layers, as in Chromium: `--host-rules` says where a connection goes, then `--host-resolver-rules` how that name resolves.
    hostRules = parseHostRules(resolver);
    connectionRules = parseHostRules(connection);
    rulesText = [...(connection ? [`--host-rules=${connection}`] : []), ...(resolver ? [resolver] : [])].join(', then ');
  } else {
    throw new RoutingRefusal('the command line of the browser of the page could not be read, so neither can its host rules; say them with probeContext.hostResolverRules ("" for none)');
  }
  const ignoreHTTPSErrors = stated.ignoreHTTPSErrors ?? (read.contextIgnoresHTTPSErrors || (switches?.has('ignore-certificate-errors') ?? false));
  // Ports Chromium restricts that this browser lets through (`--explicitly-allowed-ports`): the others stay refused.
  const allowedPorts = (switches?.get('explicitly-allowed-ports') ?? '')
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
  const description = [
    proxy ? describeProxy(proxy) : proxyUnknown ? 'direct to this machine only (a proxy of the system detected automatically, WPAD)' : 'direct',
    ...(rulesText ? [`host rules: ${rulesText}`] : []),
    ...(ignoreHTTPSErrors ? ['certificate errors ignored'] : []),
  ].join('; ');
  return {
    proxy,
    hostRules,
    ...(connectionRules.length > 0 ? { connectionRules } : {}),
    ignoreHTTPSErrors,
    ...(allowedPorts.length > 0 ? { allowedPorts } : {}),
    ...(proxyUnknown ? { proxyUnknown } : {}),
    description: redactCredentials(description),
  };
}

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5000, windowsHide: true, shell: false }, (error, stdout) => resolve(error ? null : String(stdout)));
  });
}

/** What `systemProxy` reads the system with: replaced in tests. */
export interface SystemReaders {
  /** Runs a program with arguments (never a shell); null when it fails or is not there. */
  run(file: string, args: string[]): Promise<string | null>;
  /** Reads a file; null when it cannot be read. */
  readFile(path: string): Promise<string | null>;
  home: string;
}

const nativeReaders: SystemReaders = {
  run,
  readFile: (path) => readFile(path, 'utf8').catch(() => null),
  home: homedir(),
};

/**
 * The desktop whose proxy settings Chromium follows on Linux, as it tells them apart (from
 * `XDG_CURRENT_DESKTOP`, `DESKTOP_SESSION`, `KDE_FULL_SESSION`, `GNOME_DESKTOP_SESSION_ID`); null
 * for none, where Chromium follows the environment variables only.
 */
export function linuxDesktop(env: NodeJS.ProcessEnv): 'gnome' | 'kde' | 'other' | null {
  const current = (env['XDG_CURRENT_DESKTOP'] ?? '').toLowerCase().split(':').filter(Boolean);
  const session = (env['DESKTOP_SESSION'] ?? '').toLowerCase();
  const names = [...current, session];
  if (names.some((name) => ['gnome', 'unity', 'cinnamon', 'pantheon', 'budgie', 'mate', 'x-cinnamon', 'ubuntu', 'gnome-classic', 'gnome-flashback'].includes(name)) || env['GNOME_DESKTOP_SESSION_ID']) return 'gnome';
  if (names.some((name) => name === 'kde' || name.startsWith('kde-') || name === 'plasma') || env['KDE_FULL_SESSION']) return 'kde';
  if (names.some((name) => name !== '')) return 'other';
  return null;
}

/**
 * The proxy the system gives browsers, when there is one, in a few words, without credentials;
 * null when there is none. Windows: the settings of the user (`Internet Settings`: a proxy server, a
 * script). macOS: `scutil --proxy`. Linux, as Chromium reads it there: on a GNOME-like desktop the
 * `org.gnome.system.proxy` mode (`gsettings get`, run without a shell); on KDE the `ProxyType` of
 * `~/.config/kioslaverc`; on another desktop it cannot be ruled out; without a desktop, and on the
 * other systems, the environment (`http_proxy`, `https_proxy`, `all_proxy`, `auto_proxy`). What
 * cannot be read counts as a proxy: probing then does not start unless `probeContext.proxy` says
 * it. Automatic detection (WPAD) is read apart (`systemAutoDetect`).
 */
let systemReaders: SystemReaders = nativeReaders;
let systemEnv: NodeJS.ProcessEnv | null = null;

/** Tests only: what the system is read with, in place of the system itself (`null`: the system again), and the environment then read. */
export function setSystemReaders(readers: SystemReaders | null, env: NodeJS.ProcessEnv = {}): void {
  systemReaders = readers ?? nativeReaders;
  systemEnv = readers ? env : null;
}

export async function systemProxy(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = systemEnv ?? process.env, readers: SystemReaders = systemReaders): Promise<string | null> {
  if (platform === 'win32') {
    const out = (await readers.run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'])) ?? '';
    const value = (name: string): string | undefined => new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, 'im').exec(out)?.[1]?.trim();
    const script = value('AutoConfigURL');
    if (script) return `a proxy script${shownProxy(script.replace(/[?#].*$/, '')) ? `, ${shownProxy(script.replace(/[?#].*$/, ''))}` : ''}`;
    const server = value('ProxyServer');
    // Several proxies (`http=host:port;https=…`) whose credentials may hold anything: only what follows the last `@` is shown.
    if (/^0x0*1$/i.test(value('ProxyEnable') ?? '') && server) {
      const last = shownProxy((server.slice(server.lastIndexOf('@') + 1).split(';')[0] ?? '').replace(/^[a-z]+=/i, ''));
      return `the proxy server of Windows' Internet Settings${last ? ` (${last})` : ''}`;
    }
    return null;
  }
  if (platform === 'darwin') {
    const out = (await readers.run('scutil', ['--proxy'])) ?? '';
    const on = (name: string): boolean => new RegExp(`\\b${name}\\s*:\\s*1\\b`).test(out);
    if (on('ProxyAutoConfigEnable') || on('ProxyAutoDiscoveryEnable')) return 'a proxy script';
    for (const kind of ['HTTP', 'HTTPS', 'SOCKS']) if (on(`${kind}Enable`)) return redactCredentials(`${kind} ${/\bHTTPProxy\s*:\s*(\S+)/.exec(out)?.[1] ?? ''}`.trim());
    return null;
  }
  if (platform === 'linux') {
    const desktop = linuxDesktop(env);
    if (desktop === 'gnome') {
      const mode = await readers.run('gsettings', ['get', 'org.gnome.system.proxy', 'mode']);
      if (mode === null) return 'the proxy settings of the desktop (GNOME), which could not be read';
      const value = mode.trim().replace(/^'|'$/g, '');
      if (value !== 'none') return `the proxy settings of the desktop (GNOME, mode ${value})`;
    } else if (desktop === 'kde') {
      const config = env['XDG_CONFIG_HOME'] || join(readers.home, '.config');
      const text = await readers.readFile(join(config, 'kioslaverc'));
      const type = text === null ? '0' : (/^\s*ProxyType\s*=\s*(\d+)/m.exec(text)?.[1] ?? '0');
      if (type !== '0') return `the proxy settings of the desktop (KDE, ProxyType ${type})`;
    } else if (desktop === 'other') {
      return `the proxy settings of the desktop (${env['XDG_CURRENT_DESKTOP'] || env['DESKTOP_SESSION']}), which are not read here`;
    }
  }
  for (const name of ['http_proxy', 'https_proxy', 'all_proxy', 'auto_proxy']) {
    const value = env[name] ?? env[name.toUpperCase()];
    if (value) return `${name}=${shownProxy(value) ?? '(not shown)'}`;
  }
  return null;
}

/**
 * Whether the system has browsers detect a proxy on the network by themselves (WPAD), in a few
 * words; null when it does not. Windows: the flag of automatic detection in the settings of the
 * user's connections (`Connections\DefaultConnectionSettings`, "Automatically detect settings", on
 * by default), as Chromium reads them there. What cannot be read there counts as on. Elsewhere,
 * `systemProxy` covers it (macOS: auto-discovery is a proxy script there) or the system has none.
 */
export async function systemAutoDetect(platform: NodeJS.Platform = process.platform, readers: SystemReaders = systemReaders): Promise<string | null> {
  if (platform !== 'win32') return null;
  const out = await readers.run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections', '/v', 'DefaultConnectionSettings']);
  if (out === null) return 'Windows: the settings of the connections could not be read';
  const hex = /DefaultConnectionSettings\s+REG_BINARY\s+([0-9a-f]*)/i.exec(out)?.[1];
  // No settings saved yet: Windows' default, detection on.
  if (!hex || hex.length < 18) return 'Windows: "Automatically detect settings", the default';
  // The ninth byte holds the flags: 0x08, detect automatically.
  const flags = parseInt(hex.slice(16, 18), 16);
  return (flags & 0x08) !== 0 ? 'Windows: "Automatically detect settings"' : null;
}
