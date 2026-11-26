import { defaultConfig, resolveNameRoleValue } from '@a11y-vision/core';
import { describe, expect, it } from 'vitest';
import { emptyProbeLog } from './nrv.js';
import { ProbeNetwork, siteOf } from './probe-network.js';
import { ProbeReadRefused, ProbeReadTooLarge } from './probe-host.js';
import type { ProbeBrowser, ProbeFetchRequest, ProbeFetchResponse, ProbeReadLimits } from './probe-host.js';

const emptyProbeLogFor = () => emptyProbeLog('safe');

/** A browser session that records what the network answers, and a host that records what it is asked to fetch. */
function fake(answer?: (request: ProbeFetchRequest) => Promise<ProbeFetchResponse>): { probe: ProbeBrowser; sent: { method: string; params: Record<string, unknown> }[]; fetched: ProbeFetchRequest[]; emit: (event: string, params: unknown) => void } {
  const handlers = new Map<string, ((params: unknown) => void)[]>();
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const fetched: ProbeFetchRequest[] = [];
  const probe: ProbeBrowser = {
    browser: {
      send: (method, params) => {
        sent.push({ method, params: params ?? {} });
        return Promise.resolve({});
      },
      on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
      off: () => undefined,
    },
    route: 'direct',
    newPage: () => Promise.reject(new Error('not here')),
    fetch: (request) => {
      fetched.push(request);
      if (answer) return answer(request);
      return Promise.resolve({ status: 200, headers: [{ name: 'content-type', value: 'text/plain' }, { name: 'content-encoding', value: 'gzip' }], body: new TextEncoder().encode('ok'), size: 2 });
    },
    refusedConnections: () => 0,
    close: () => Promise.resolve(),
  };
  return { probe, sent, fetched, emit: (event, params) => (handlers.get(event) ?? []).forEach((handler) => handler(params)) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const paused = (requestId: string, method: string, url: string, resourceType: string, frameId: string | null = 'MAIN', cookie = 'sid=1') => ({ requestId, request: { url, method, headers: { Accept: '*/*', ...(cookie ? { Cookie: cookie } : {}) } }, resourceType, ...(frameId ? { frameId } : {}) });

/** The cookie check, with a probing Chromium that attaches the Cookie header it would send to the check's navigation (or none). */
async function checked(net: ProbeNetwork, emit: (event: string, params: unknown) => void, gives = true): Promise<void> {
  await net.checkCookies(
    (url, name, value) => {
      emit('Fetch.requestPaused', paused('check', 'GET', url, 'Document', 'MAIN', gives ? `other=1; ${name}=${value}` : ''));
      return tick().then(() => undefined);
    },
    () => Promise.resolve(),
  );
}

async function network() {
  const parts = fake();
  const log = emptyProbeLogFor();
  const net = new ProbeNetwork(parts.probe, defaultConfig.nameRoleValue, log);
  await net.enable();
  net.setCurrent({ browserContextId: 'CTX', mainFrameId: 'MAIN', frames: new Set(['MAIN']), url: 'https://shop.example/p' });
  await checked(net, parts.emit);
  return { ...parts, log, net };
}

describe('the network of the probing browser', () => {
  it('is held at the browser target from the start, and never continues a request', async () => {
    const { sent, emit, net } = await network();
    expect(sent.map((entry) => entry.method).slice(0, 2)).toEqual(['Fetch.enable', 'Target.setDiscoverTargets']);
    net.openLoad();
    emit('Fetch.requestPaused', paused('1', 'GET', 'https://shop.example/p', 'Document'));
    emit('Fetch.requestPaused', paused('2', 'POST', 'https://shop.example/api', 'XHR'));
    net.closeLoad();
    emit('Fetch.requestPaused', paused('3', 'GET', 'https://shop.example/other', 'Document'));
    emit('Fetch.requestPaused', paused('4', 'GET', 'https://shop.example/api?id=1', 'XHR'));
    await tick();
    expect(sent.some((entry) => entry.method === 'Fetch.continueRequest')).toBe(false);
  });

  it('fetches the reads of a copy that loads, with its cookies, and gives the same later without the network', async () => {
    const { sent, fetched, emit, net, log } = await network();
    net.openLoad();
    emit('Fetch.requestPaused', paused('1', 'GET', 'https://shop.example/app.js', 'Script'));
    await tick();
    // The cookies are those Chromium attached to the request, as they are.
    expect(fetched).toEqual([{ url: 'https://shop.example/app.js', method: 'GET', headers: { accept: '*/*', cookie: 'sid=1' } }]);
    // The body is decoded: its encoding is not passed on.
    const fulfilled = sent.find((entry) => entry.method === 'Fetch.fulfillRequest')!;
    expect(fulfilled.params['responseHeaders']).toEqual([{ name: 'content-type', value: 'text/plain' }]);
    net.closeLoad();
    net.startActivation('https://shop.example/p', []);
    emit('Fetch.requestPaused', paused('2', 'GET', 'https://shop.example/app.js', 'Script'));
    await tick();
    expect(fetched).toHaveLength(1);
    expect(sent.filter((entry) => entry.method === 'Fetch.fulfillRequest')).toHaveLength(2);
    // Kept as the bytes the host gave, encoded only as it is given to a copy: both times the same body.
    expect(sent.filter((entry) => entry.method === 'Fetch.fulfillRequest').map((entry) => entry.params['body'])).toEqual(['b2s=', 'b2s=']);
    expect(log.fetched).toBe(1);
    expect(log.allowed).toBe(2);
  });

  it('stops, once loaded, every write, every navigation and every read not already fetched, and counts what a probe needs', async () => {
    const { sent, fetched, emit, net, log } = await network();
    net.startActivation('https://shop.example/p', ['shoes']);
    emit('Fetch.requestPaused', paused('1', 'POST', 'https://shop.example/cart', 'XHR'));
    emit('Fetch.requestPaused', paused('2', 'POST', 'https://analytics.example/collect', 'XHR'));
    emit('Fetch.requestPaused', paused('3', 'POST', 'https://shop.example/beacon', 'Ping'));
    emit('Fetch.requestPaused', paused('4', 'GET', 'https://shop.example/api/stock?id=1', 'Fetch'));
    emit('Fetch.requestPaused', paused('5', 'GET', 'https://shop.example/like.png', 'Image'));
    emit('Fetch.requestPaused', paused('6', 'GET', 'https://shop.example/search?q=shoes', 'Document'));
    await tick();
    expect(fetched).toEqual([]);
    const failed = sent.filter((entry) => entry.method === 'Fetch.failRequest' && entry.params['requestId'] !== 'check').map((entry) => [entry.params['requestId'], entry.params['errorReason']]);
    expect(failed).toEqual([
      ['1', 'BlockedByClient'],
      ['2', 'BlockedByClient'],
      ['3', 'BlockedByClient'],
      ['4', 'BlockedByClient'],
      ['5', 'BlockedByClient'],
      ['6', 'Aborted'],
    ]);
    const activation = net.takeActivation();
    // A write to the site of the page; not one to another site (analytics), not a beacon.
    expect(activation.writes).toBe(1);
    // A read of a script; a picture is not counted.
    expect(activation.blockedReads).toBe(1);
    expect(activation.navigations).toEqual([{ kind: 'document', url: 'https://shop.example/search', method: 'GET', otherPath: true, carriesFieldValue: true }]);
    expect(activation.requests).toBe(6);
    expect(log.unsafe).toBe(0);
  });

  it('does not fetch for what is not the current copy, even while a copy loads', async () => {
    const { fetched, emit, net } = await network();
    emit('Target.targetCreated', { targetInfo: { targetId: 'OLD-WORKER', browserContextId: 'OLD', type: 'shared_worker' } });
    net.openLoad();
    emit('Fetch.requestPaused', paused('1', 'GET', 'https://shop.example/late?x=1', 'Fetch', 'OLD-WORKER'));
    emit('Fetch.requestPaused', paused('2', 'GET', 'https://shop.example/none', 'Fetch', null));
    // The frames of a copy that is gone are never a copy's again.
    net.setCurrent({ browserContextId: 'CTX2', mainFrameId: 'MAIN2', frames: new Set(['MAIN2']), url: 'https://shop.example/p' });
    net.openLoad();
    emit('Fetch.requestPaused', paused('3', 'GET', 'https://shop.example/pagehide?x=1', 'Fetch', 'MAIN'));
    await tick();
    expect(fetched).toEqual([]);
  });

  it('sends the cookies Chromium chose for each request, as they are, and none before that is checked or when this Chromium does not give them', async () => {
    const parts = fake();
    const log = emptyProbeLogFor();
    const net = new ProbeNetwork(parts.probe, defaultConfig.nameRoleValue, log);
    await net.enable();
    net.setCurrent({ browserContextId: 'CTX', mainFrameId: 'MAIN', frames: new Set(['MAIN']), url: 'https://www.shop.example/p' });
    net.openLoad();
    // Not checked yet: no cookie at all.
    parts.emit('Fetch.requestPaused', paused('1', 'GET', 'https://cdn.other.example/a.js', 'Script', 'MAIN', 'none=2'));
    await tick();
    await checked(net, parts.emit);
    expect(log.cookies).toBe('browser');
    // The check's own navigation went nowhere.
    expect(parts.fetched.map((request) => request.url)).toEqual(['https://cdn.other.example/a.js']);
    expect(parts.sent.find((entry) => entry.params['requestId'] === 'check')).toMatchObject({ method: 'Fetch.failRequest' });
    parts.emit('Fetch.requestPaused', paused('2', 'GET', 'https://cdn.other.example/b.js', 'Script', 'MAIN', 'none=2'));
    parts.emit('Fetch.requestPaused', paused('3', 'GET', 'https://cdn.other.example/c.js', 'Script', 'MAIN', ''));
    await tick();
    expect(parts.fetched.map((request) => request.headers['cookie'])).toEqual([undefined, 'none=2', undefined]);

    const other = fake();
    const withheld = new ProbeNetwork(other.probe, defaultConfig.nameRoleValue, log);
    await withheld.enable();
    withheld.setCurrent({ browserContextId: 'CTX', mainFrameId: 'MAIN', frames: new Set(['MAIN']), url: 'https://www.shop.example/p' });
    withheld.openLoad();
    await checked(withheld, other.emit, false);
    expect(log.cookies).toBe('withheld');
    other.emit('Fetch.requestPaused', paused('4', 'GET', 'https://www.shop.example/a.js', 'Script', 'MAIN', 'sid=1'));
    await tick();
    expect(other.fetched.map((request) => request.headers['cookie'])).toEqual([undefined]);
  });

  it('has at most probeReadConcurrency reads under way, within the limits of one read, and counts one that was too large', async () => {
    let open = 0;
    let most = 0;
    const waiting: (() => void)[] = [];
    const seen: unknown[] = [];
    const parts = fake((request) => {
      open++;
      most = Math.max(most, open);
      return new Promise((resolve, reject) => {
        waiting.push(() => {
          open--;
          if (request.url.endsWith('/bomb.js')) reject(new ProbeReadTooLarge('the response is larger than allowed decoded'));
          else resolve({ status: 200, headers: [], body: new Uint8Array(0), size: 0 });
        });
      });
    });
    const probe = { ...parts.probe, fetch: (request: ProbeFetchRequest, limits: ProbeReadLimits) => (seen.push(limits), parts.probe.fetch(request, limits)) };
    const log = emptyProbeLogFor();
    const net = new ProbeNetwork(probe, resolveNameRoleValue({ probeReadConcurrency: 2 }), log);
    await net.enable();
    net.setCurrent({ browserContextId: 'CTX', mainFrameId: 'MAIN', frames: new Set(['MAIN']), url: 'https://shop.example/p' });
    net.openLoad();
    for (const name of ['a', 'b', 'c', 'bomb']) parts.emit('Fetch.requestPaused', paused(name, 'GET', `https://shop.example/${name}.js`, 'Script'));
    await tick();
    expect(open).toBe(2);
    while (waiting.length > 0 || open > 0) {
      waiting.shift()?.();
      await tick();
    }
    expect(most).toBe(2);
    expect(seen[0]).toEqual({ timeoutMs: defaultConfig.nameRoleValue.probeLoadTimeoutMs, maxBytes: 16 << 20, maxEncodedBytes: 16 << 20 });
    expect(log.tooLarge).toBe(1);
    net.disable();
    expect(log.blocked).toEqual(['GET Script https://shop.example/bomb.js (too large)']);
  });
});

describe('what is not sent', () => {
  const load = async (answer?: (request: ProbeFetchRequest) => Promise<ProbeFetchResponse>, deny: string[] = []) => {
    const parts = fake(answer);
    const log = emptyProbeLogFor();
    const net = new ProbeNetwork(parts.probe, resolveNameRoleValue({ probeLoadDeny: deny }), log);
    await net.enable();
    net.setCurrent({ browserContextId: 'CTX', mainFrameId: 'MAIN', frames: new Set(['MAIN']), url: 'https://shop.example/p' });
    net.openLoad();
    return { ...parts, log, net };
  };
  const failed = (sent: { method: string; params: Record<string, unknown> }[]) => sent.filter((entry) => entry.method === 'Fetch.failRequest').map((entry) => [entry.params['requestId'], entry.params['errorReason']]);

  it('a read of a load that probeLoadDeny lists is never fetched; the document of the copy always is', async () => {
    const { sent, fetched, emit, net, log } = await load(undefined, ['.*']);
    emit('Fetch.requestPaused', paused('1', 'GET', 'https://shop.example/p', 'Document'));
    emit('Fetch.requestPaused', paused('2', 'GET', 'https://shop.example/api/data', 'Fetch'));
    await tick();
    expect(fetched.map((request) => request.url)).toEqual(['https://shop.example/p']);
    expect(failed(sent)).toEqual([['2', 'BlockedByClient']]);
    net.disable();
    expect(log.blocked).toEqual(['GET Fetch https://shop.example/api/data (not sent: probeLoadDeny)']);
  });

  it('a read the host refuses is recorded with its reason; one that fails keeps what went wrong, for the copy that did not load', async () => {
    const { sent, emit, net, log } = await load((request) =>
      request.url.includes('/api/') ? Promise.reject(new ProbeReadRefused('the page under test routes this address itself')) : Promise.reject(new Error('socket hang up')),
    );
    emit('Fetch.requestPaused', paused('1', 'GET', 'https://shop.example/api/data?id=1', 'Fetch'));
    emit('Fetch.requestPaused', paused('2', 'GET', 'https://shop.example/p#top', 'Document'));
    await tick();
    expect(failed(sent)).toEqual([
      ['1', 'BlockedByClient'],
      ['2', 'Failed'],
    ]);
    expect(net.failureOf('https://shop.example/p')).toBe('the read of https://shop.example/p failed: socket hang up');
    expect(net.failureOf('https://shop.example/api/data?id=1')).toBeUndefined();
    net.disable();
    expect(log.blocked).toEqual(['GET Document https://shop.example/p (unreachable)', 'GET Fetch https://shop.example/api/data (not sent: the page under test routes this address itself)']);
  });
});

describe('sites', () => {
  it('are the registrable part of the host, as far as it can be told without a list', () => {
    expect(siteOf('https://www.shop.example/a')).toBe('https://shop.example');
    expect(siteOf('https://static.bbc.co.uk/x')).toBe('https://bbc.co.uk');
    expect(siteOf('https://www.service-public.gouv.fr/')).toBe('https://service-public.gouv.fr');
    expect(siteOf('https://api.ikea.fr/')).toBe('https://ikea.fr');
    expect(siteOf('https://static.bmw.de/')).toBe('https://bmw.de');
    expect(siteOf('http://127.0.0.1:4173/x')).toBe('http://127.0.0.1');
    expect(siteOf('http://localhost:4173/x')).toBe('http://localhost');
  });
});
