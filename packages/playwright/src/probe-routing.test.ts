import { describe, expect, it } from 'vitest';
import { RoutingRefusal, addressClass, commandLineArgs, linuxDesktop, mapHost, parseHostRules, parseProxyServer, proxyFor, redactCredentials, resolveRouting, switchesOf, systemAutoDetect, systemProxy } from './probe-routing.js';
import type { ReadRouting, SystemReaders } from './probe-routing.js';

const local: ReadRouting = { commandLine: '"C:\\chrome\\chrome.exe" --headless --no-sandbox', contextProxy: null, contextIgnoresHTTPSErrors: false, systemProxy: null, launchedHere: true };
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

describe('a browser this process did not launch', () => {
  it('is not followed unless the caller says where its requests go: its proxy and its host rules, both', () => {
    const elsewhere = { ...local, launchedHere: false };
    expect(refusal(() => resolveRouting({}, elsewhere))).toContain('not launched by this process');
    expect(refusal(() => resolveRouting({ proxy: null }, elsewhere))).toContain('probeContext.hostResolverRules');
    expect(refusal(() => resolveRouting({ hostResolverRules: '' }, elsewhere))).toContain('probeContext.proxy');
    expect(resolveRouting({ proxy: null, hostResolverRules: '' }, { ...elsewhere, commandLine: '/c --headless' })).toMatchObject({ proxy: null, hostRules: [], description: 'direct' });
    expect(resolveRouting({ proxy: null, hostResolverRules: '' }, { ...elsewhere, commandLine: null })).toMatchObject({ proxy: null, hostRules: [], description: 'direct' });
  });
});

describe('host rules the caller states', () => {
  it('never replace those of a command line that is read: taken when they say the same or it has none, else nothing is sent', () => {
    const mapped = { ...local, commandLine: '/c --host-resolver-rules="MAP shop.test 127.0.0.1:4173"' };
    // The command line maps shop.test to a server of this machine: "none" would read the real shop.test with the page's cookies.
    expect(refusal(() => resolveRouting({ hostResolverRules: '' }, mapped))).toContain('not what the browser of the page has');
    expect(refusal(() => resolveRouting({ hostResolverRules: 'MAP shop.test 10.0.0.9' }, mapped))).toContain('--host-resolver-rules=MAP shop.test 127.0.0.1:4173');
    expect(refusal(() => resolveRouting({ hostResolverRules: '' }, { ...local, commandLine: '/c --host-rules=MAP shop.test 127.0.0.1' }))).toContain('--host-rules=MAP shop.test 127.0.0.1');
    // The same rules, written otherwise: taken, as the command line says them.
    expect(mapHost(resolveRouting({ hostResolverRules: ' map  shop.test   127.0.0.1:4173 ' }, mapped).hostRules, 'shop.test', 80)).toEqual({ host: '127.0.0.1', port: 4173 });
    // A command line without rules: what is stated is taken.
    expect(mapHost(resolveRouting({ hostResolverRules: 'MAP a.test 127.0.0.1' }, local).hostRules, 'a.test', 80)).toEqual({ host: '127.0.0.1', port: 80 });
    // A browser this process did not launch, whose command line is read all the same: its rules count too.
    expect(refusal(() => resolveRouting({ proxy: null, hostResolverRules: '' }, { ...mapped, launchedHere: false }))).toContain('not what the browser of the page has');
    // A command line that cannot be read: what is stated is all there is.
    expect(resolveRouting({ proxy: null, hostResolverRules: '' }, { ...local, commandLine: null }).hostRules).toEqual([]);
  });
});

describe('ports', () => {
  it('that the browser of the page lets through although Chromium restricts them are read from its command line', () => {
    expect(resolveRouting({}, { ...local, commandLine: '/c --explicitly-allowed-ports=6667,10080, 99999,x' }).allowedPorts).toEqual([6667, 10080]);
    expect(resolveRouting({}, local).allowedPorts).toBeUndefined();
  });
});

describe('automatic detection of a proxy (WPAD)', () => {
  const reg = (out: string | null): SystemReaders => ({ run: () => Promise.resolve(out), readFile: () => Promise.resolve(null), home: '' });
  const settings = (flags: string) => `HKEY_CURRENT_USER\\...\\Connections\n    DefaultConnectionSettings    REG_BINARY    4600000002000000${flags}000000000000000000000000\n`;

  it('is read from the settings of the connections on Windows, on by default', async () => {
    expect(await systemAutoDetect('win32', reg(settings('09')))).toContain('Automatically detect settings');
    expect(await systemAutoDetect('win32', reg(settings('01')))).toBeNull();
    expect(await systemAutoDetect('win32', reg(settings('0b')))).toContain('Automatically detect settings');
    expect(await systemAutoDetect('win32', reg('HKEY_CURRENT_USER\\...\\Connections\n'))).toContain('the default');
    expect(await systemAutoDetect('win32', reg(null))).toContain('could not be read');
    expect(await systemAutoDetect('linux', reg(null))).toBeNull();
  });

  it('where the browser of the page takes its proxy from the system: reads go to this machine only, and the survey says why', () => {
    const routing = resolveRouting({}, { ...local, systemAutoDetect: 'Windows: "Automatically detect settings"' });
    expect(routing.proxy).toBeNull();
    expect(routing.proxyUnknown).toContain('detect a proxy automatically');
    expect(routing.description).toContain('this machine only');
    // A proxy said, or none: followed.
    expect(resolveRouting({ proxy: null }, { ...local, systemAutoDetect: 'x' }).proxyUnknown).toBeUndefined();
    // A browser whose command line says its proxy does not use the system's.
    expect(resolveRouting({}, { ...local, commandLine: '/c --no-proxy-server', systemAutoDetect: 'x' }).proxyUnknown).toBeUndefined();
  });
});

describe('--host-rules', () => {
  it('is a layer of its own, before --host-resolver-rules, as in Chromium', () => {
    const routing = resolveRouting({}, { ...local, commandLine: '/c --host-rules=MAP a.test b.test --host-resolver-rules=MAP b.test 127.0.0.1' });
    expect(routing.connectionRules?.map((rule) => rule.host)).toEqual(['b.test']);
    expect(routing.hostRules.map((rule) => rule.host)).toEqual(['127.0.0.1']);
    expect(routing.description).toBe('direct; host rules: --host-rules=MAP a.test b.test, then MAP b.test 127.0.0.1');
  });
});

describe('credentials', () => {
  it('are never in what is said of a proxy: with a scheme or without, in the environment, the command line or a context', async () => {
    expect(redactCredentials('http_proxy=user:pass@proxy.corp:3128')).toBe('http_proxy=proxy.corp:3128');
    // Up to the last `@`: what came before it may have been a password.
    expect(redactCredentials('http=u:p@a.test:1;https=http://v:q@b.test:2')).toBe('http=b.test:2');
    expect(redactCredentials('socks5://u:p@ss@s.test:1080')).toBe('socks5://s.test:1080');
    // http_proxy without "//": the credentials are not left in the reason probing did not start.
    const system = await systemProxy('linux', { http_proxy: 'user:hunter2@proxy.corp:3128' });
    expect(system).toBe('http_proxy=proxy.corp:3128');
    const messages = [
      refusal(() => resolveRouting({}, { ...local, systemProxy: 'user:hunter2@proxy.corp:3128' })),
      refusal(() => resolveRouting({}, { ...local, commandLine: '/c --proxy-server=socks5://user:hunter2@s.test:1080' })),
      refusal(() => resolveRouting({}, { ...local, commandLine: '/c --proxy-server=http=user:hunter2@a.test:99999' })),
      refusal(() => parseProxyServer('http=user:hunter2@a.test:1;ftp', '')),
      refusal(() => resolveRouting({}, { ...local, contextProxy: { server: 'https://user:hunter2@secure.test:443' } })),
    ];
    for (const message of messages) {
      expect(message).not.toBe('');
      expect(message).not.toContain('hunter2');
      expect(message).not.toContain('user:');
    }
    expect(resolveRouting({ proxy: { server: 'http://user:hunter2@p.test:1' } }, local).description).not.toContain('hunter2');
  });

  // Passwords hold what an address uses to separate its parts: none of it is left in a message.
  const secrets = ['p=ss', 'p;ss', 'p,ss', 'p@ss', 'p:ss', 'p/ss', 'p?ss', 'p%40s%3Ds', 'a(b)c', 'x"y\'z', 'p[1]', 'h:u=n;t,e@r/2?'];

  it('are dropped up to the last @ of what an address holds, whatever the password holds', () => {
    for (const secret of secrets) {
      for (const text of [`http://user:${secret}@proxy.corp:3128`, `http_proxy=user:${secret}@proxy.corp:3128`, `the proxy (socks5://user:${secret}@s.test:1080), which`, `https=http://v:q@b.test:2;http=user:${secret}@proxy.corp:3128`]) {
        const shown = redactCredentials(text);
        expect(shown, text).not.toContain(secret);
        expect(shown, text).not.toContain('user');
        expect(shown, text).toMatch(/(proxy\.corp:3128|s\.test:1080)/);
      }
    }
    expect(redactCredentials('http://user:p=ss@proxy:3128')).toBe('http://proxy:3128');
    expect(redactCredentials('http_proxy=user:p;ss@proxy.corp:3128 and more')).toBe('http_proxy=proxy.corp:3128 and more');
  });

  it('are read whole from a proxy address, and never in a message built of it', () => {
    for (const secret of secrets) {
      const encoded = encodeURIComponent(secret);
      const rules = parseProxyServer(`http://user:${encoded}@proxy.corp:3128`, '');
      expect(rules.http).toMatchObject({ host: 'proxy.corp', port: 3128, username: 'user', password: secret });
      // Written as it is: `;` and `,` separate proxies in Chromium's grammar, so only the others.
      if (!/[;,]/.test(secret)) expect(parseProxyServer(`http://user:${secret}@proxy.corp:3128`, '').http).toMatchObject({ host: 'proxy.corp', port: 3128, username: 'user' });
      else expect(refusal(() => parseProxyServer(`http://user:${secret}@proxy.corp:3128`, ''))).not.toMatch(/user|ss@|ss\b/);
      for (const message of [
        refusal(() => resolveRouting({}, { ...local, commandLine: `/c --proxy-server=socks5://user:${secret}@s.test:1080` })),
        refusal(() => resolveRouting({}, { ...local, contextProxy: { server: `https://user:${secret}@secure.test:443` } })),
        refusal(() => resolveRouting({}, { ...local, commandLine: `/c --proxy-server=http://user:${secret}@a.test:99999` })),
        refusal(() => resolveRouting({}, { ...local, systemProxy: `user:${secret}@proxy.corp:3128` })),
      ]) {
        expect(message).not.toBe('');
        expect(message).not.toContain(secret);
        expect(message).not.toContain('user');
      }
    }
  });

  it('of the system are never in what is said of it, whatever the password holds', async () => {
    for (const secret of secrets) {
      const shown = await systemProxy('linux', { http_proxy: `http://user:${secret}@proxy.corp:3128` });
      expect(shown).not.toContain(secret);
      expect(shown).toContain('proxy.corp:3128');
      const windows = await systemProxy('win32', {}, { run: () => Promise.resolve(`    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    http=user:${secret}@proxy.corp:3128;https=user:${secret}@proxy.corp:3129\n`), readFile: () => Promise.resolve(null), home: '' });
      expect(windows).not.toContain(secret);
      expect(windows).not.toContain('user');
    }
  });
});

describe('the proxy of the desktop, on Linux', () => {
  const readers = (gsettings: string | null, kioslaverc: string | null = null): SystemReaders => ({
    run: (file) => Promise.resolve(file === 'gsettings' ? gsettings : null),
    readFile: () => Promise.resolve(kioslaverc),
    home: '/home/u',
  });
  it('is read as Chromium reads it there: GNOME, KDE, another desktop, or none', async () => {
    expect(linuxDesktop({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' })).toBe('gnome');
    expect(linuxDesktop({ XDG_CURRENT_DESKTOP: 'KDE' })).toBe('kde');
    expect(linuxDesktop({})).toBeNull();
    expect(await systemProxy('linux', { XDG_CURRENT_DESKTOP: 'GNOME' }, readers("'none'\n"))).toBeNull();
    expect(await systemProxy('linux', { XDG_CURRENT_DESKTOP: 'GNOME' }, readers("'manual'\n"))).toContain('GNOME, mode manual');
    // What cannot be read cannot be ruled out.
    expect(await systemProxy('linux', { XDG_CURRENT_DESKTOP: 'GNOME' }, readers(null))).toContain('could not be read');
    expect(await systemProxy('linux', { XDG_CURRENT_DESKTOP: 'KDE' }, readers(null, '[Proxy Settings]\nProxyType=1\n'))).toContain('KDE, ProxyType 1');
    expect(await systemProxy('linux', { XDG_CURRENT_DESKTOP: 'KDE' }, readers(null, '[Proxy Settings]\nProxyType=0\n'))).toBeNull();
    expect(await systemProxy('linux', { XDG_CURRENT_DESKTOP: 'XFCE' }, readers(null))).toContain('XFCE');
    expect(await systemProxy('linux', {}, readers(null))).toBeNull();
  });
});
