import { describe, expect, it } from 'vitest';
import { RoutingRefusal, addressClass, commandLineArgs, mapHost, parseHostRules, proxyFor, resolveRouting, switchesOf, systemProxy } from './probe-routing.js';
import type { ReadRouting } from './probe-routing.js';

const local: ReadRouting = { commandLine: '"C:\\chrome\\chrome.exe" --headless --no-sandbox', contextProxy: null, contextIgnoresHTTPSErrors: false, systemProxy: null };
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof RoutingRefusal) return error.message;
    throw error;
  }
  return '';
};

describe('the command line of the browser of the page', () => {
  it('is split as Chromium writes it: quoted on Windows, joined with spaces elsewhere', () => {
    const windows = '"C:\\Program Files\\chrome.exe" --proxy-server=http://127.0.0.1:9 --host-resolver-rules="MAP fake.test 127.0.0.1" --user-data-dir="C:\\Temp\\p x"';
    const { program, switches } = switchesOf(commandLineArgs(windows));
    expect(program).toBe('C:\\Program Files\\chrome.exe');
    expect(switches.get('host-resolver-rules')).toBe('MAP fake.test 127.0.0.1');
    expect(switches.get('user-data-dir')).toBe('C:\\Temp\\p x');
    const posix = switchesOf(commandLineArgs('/opt/chrome --headless --host-resolver-rules=MAP fake.test 127.0.0.1, EXCLUDE x.test --no-sandbox')).switches;
    expect(posix.get('host-resolver-rules')).toBe('MAP fake.test 127.0.0.1, EXCLUDE x.test');
    expect(posix.has('no-sandbox')).toBe(true);
  });
});

describe('where the reads of the copies go', () => {
  it('direct when nothing routes the browser of the page', () => {
    expect(resolveRouting({}, local)).toMatchObject({ proxy: null, hostRules: [], ignoreHTTPSErrors: false, description: 'direct' });
  });

  it('through the proxy of the browser (launch({ proxy }) writes --proxy-server), loopback included when it says <-loopback>', () => {
    const routing = resolveRouting({}, { ...local, commandLine: '/c --proxy-server=http://10.0.0.5:3128 --proxy-bypass-list=*.corp;<-loopback>', launchProxy: { server: 'http://10.0.0.5:3128', username: 'u', password: 'p' } });
    expect(routing.description).toBe('proxy http://10.0.0.5:3128');
    expect(proxyFor(routing.proxy, new URL('https://example.com/'))).toEqual({ host: '10.0.0.5', port: 3128, username: 'u', password: 'p' });
    expect(proxyFor(routing.proxy, new URL('http://intranet.corp/'))).toBeNull();
    expect(proxyFor(routing.proxy, new URL('http://127.0.0.1:4173/'))).not.toBeNull();
    // Without <-loopback>, Chromium connects to this machine directly.
    const implicit = resolveRouting({}, { ...local, commandLine: '/c --proxy-server=proxy.test:8080' });
    expect(proxyFor(implicit.proxy, new URL('http://localhost:3000/'))).toBeNull();
    expect(proxyFor(implicit.proxy, new URL('http://169.254.169.254/'))).toBeNull();
    expect(proxyFor(implicit.proxy, new URL('http://example.com/'))).toMatchObject({ host: 'proxy.test', port: 8080 });
  });

  it('through the proxy of the context first, and what the host is told before anything', () => {
    const read = { ...local, commandLine: '/c --proxy-server=http://browser.test:1', contextProxy: { server: 'http://context.test:2', bypass: '.internal' } };
    const routing = resolveRouting({}, read);
    expect(proxyFor(routing.proxy, new URL('http://example.com/'))).toMatchObject({ host: 'context.test', port: 2 });
    expect(proxyFor(routing.proxy, new URL('http://a.internal/'))).toBeNull();
    expect(resolveRouting({ proxy: null }, read).proxy).toBeNull();
    expect(proxyFor(resolveRouting({ proxy: { server: 'stated.test:3' } }, read).proxy, new URL('http://example.com/'))).toMatchObject({ host: 'stated.test', port: 3 });
  });

  it('per scheme, and a list of fallbacks takes the first', () => {
    const routing = resolveRouting({}, { ...local, commandLine: '/c --proxy-server=http=a.test:1,b.test:2;https=c.test:3' });
    expect(proxyFor(routing.proxy, new URL('http://example.com/'))).toMatchObject({ host: 'a.test', port: 1 });
    expect(proxyFor(routing.proxy, new URL('https://example.com/'))).toMatchObject({ host: 'c.test', port: 3 });
    const httpOnly = resolveRouting({}, { ...local, commandLine: '/c --proxy-server=http=a.test:1' });
    expect(proxyFor(httpOnly.proxy, new URL('https://example.com/'))).toBeNull();
  });

  it('nowhere, with the reason, when it cannot be read or followed', () => {
    expect(refusal(() => resolveRouting({}, { ...local, commandLine: '/c --proxy-pac-url=http://wpad/proxy.pac' }))).toContain('script');
    expect(refusal(() => resolveRouting({}, { ...local, commandLine: '/c --proxy-auto-detect' }))).toContain('script');
    expect(refusal(() => resolveRouting({}, { ...local, commandLine: '/c --proxy-server=socks5://127.0.0.1:1080' }))).toContain('socks5 proxy');
    expect(refusal(() => resolveRouting({}, { ...local, contextProxy: { server: 'https://secure.test:443' } }))).toContain('https proxy');
    expect(refusal(() => resolveRouting({}, { ...local, systemProxy: 'proxy.corp:8080' }))).toContain('proxy of the system');
    expect(refusal(() => resolveRouting({}, { ...local, systemProxy: undefined }))).toContain('not on this machine');
    expect(refusal(() => resolveRouting({}, { ...local, contextProxy: undefined }))).toContain('another process');
    expect(refusal(() => resolveRouting({}, { ...local, commandLine: null }))).toContain('command line');
    expect(refusal(() => resolveRouting({}, { ...local, commandLine: '/c --host-resolver-rules=MAP' }))).toContain('host rule');
    expect(refusal(() => resolveRouting({}, { ...local, commandLine: '/c --proxy-server=p.test:1 --host-rules=MAP a b' }))).toContain('--host-rules');
    // Told, it is followed.
    expect(resolveRouting({ proxy: null, hostResolverRules: '' }, { ...local, commandLine: null, contextProxy: undefined }).description).toBe('direct');
    expect(resolveRouting({ proxy: null }, { ...local, systemProxy: 'proxy.corp:8080' }).proxy).toBeNull();
  });

  it('certificate errors are ignored as the context or the browser of the page ignores them', () => {
    expect(resolveRouting({}, { ...local, contextIgnoresHTTPSErrors: true }).ignoreHTTPSErrors).toBe(true);
    expect(resolveRouting({}, { ...local, commandLine: '/c --ignore-certificate-errors' }).ignoreHTTPSErrors).toBe(true);
    expect(resolveRouting({ ignoreHTTPSErrors: false }, { ...local, contextIgnoresHTTPSErrors: true }).ignoreHTTPSErrors).toBe(false);
  });
});

describe('host rules', () => {
  it('map a name, with or without its port, to another host and port; exclusions first; ~NOTFOUND', () => {
    const rules = parseHostRules('EXCLUDE keep.test, MAP *.test 127.0.0.1:4173, MAP localhost:9000 10.0.0.2, MAP gone.example ~NOTFOUND');
    expect(mapHost(rules, 'site.test', 80)).toEqual({ host: '127.0.0.1', port: 4173 });
    expect(mapHost(rules, 'keep.test', 80)).toEqual({ host: 'keep.test', port: 80 });
    expect(mapHost(rules, 'localhost', 9000)).toEqual({ host: '10.0.0.2', port: 9000 });
    expect(mapHost(rules, 'localhost', 9001)).toEqual({ host: 'localhost', port: 9001 });
    expect(mapHost(rules, 'gone.example', 443)).toBeNull();
    expect(mapHost(parseHostRules('MAP * [::1]:8080'), 'any.example', 80)).toEqual({ host: '::1', port: 8080 });
  });
});

describe('what an address is', () => {
  it('tells the internet from this machine, private networks and links, written as IPv6 too', () => {
    expect(addressClass('93.184.216.34')).toBe('public');
    expect(addressClass('127.0.0.1')).toBe('loopback');
    expect(addressClass('::1')).toBe('loopback');
    expect(addressClass('10.1.2.3')).toBe('private');
    expect(addressClass('172.20.0.1')).toBe('private');
    expect(addressClass('192.168.1.1')).toBe('private');
    expect(addressClass('169.254.169.254')).toBe('link-local');
    expect(addressClass('0.0.0.0')).toBe('unspecified');
    expect(addressClass('::ffff:127.0.0.1')).toBe('loopback');
    expect(addressClass('::ffff:a9fe:a9fe')).toBe('link-local');
    expect(addressClass('64:ff9b::a9fe:a9fe')).toBe('link-local');
    expect(addressClass('fe80::1')).toBe('link-local');
    expect(addressClass('fd00::1')).toBe('private');
    expect(addressClass('2606:4700::1111')).toBe('public');
  });
});

describe('the proxy of the system', () => {
  it('is read from the environment where Chromium reads it there', async () => {
    expect(await systemProxy('linux', { HTTPS_PROXY: 'http://user:secret@proxy.corp:8080' })).toBe('https_proxy=http://proxy.corp:8080');
    expect(await systemProxy('linux', {})).toBeNull();
  });
});
