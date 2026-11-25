import { defaultConfig } from '@a11y-vision/core';
import { describe, expect, it } from 'vitest';
import { emptyProbeLog } from './nrv.js';
import { ProbeNetwork, siteOf } from './probe-network.js';
import type { ProbeBrowser, ProbeFetchRequest } from './probe-host.js';

const emptyProbeLogFor = () => emptyProbeLog('safe');

/** A browser session that records what the network answers, and a host that records what it is asked to fetch. */
function fake(): { probe: ProbeBrowser; sent: { method: string; params: Record<string, unknown> }[]; fetched: ProbeFetchRequest[]; emit: (event: string, params: unknown) => void } {
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
    newPage: () => Promise.reject(new Error('not here')),
    fetch: (request) => {
      fetched.push(request);
      return Promise.resolve({ status: 200, headers: [{ name: 'content-type', value: 'text/plain' }, { name: 'content-encoding', value: 'gzip' }], body: 'b2s=', size: 2 });
    },
    refusedConnections: () => 0,
    close: () => Promise.resolve(),
  };
  return { probe, sent, fetched, emit: (event, params) => (handlers.get(event) ?? []).forEach((handler) => handler(params)) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const paused = (requestId: string, method: string, url: string, resourceType: string, frameId: string | null = 'MAIN') => ({ requestId, request: { url, method, headers: { Accept: '*/*', Cookie: 'x=1' } }, resourceType, ...(frameId ? { frameId } : {}) });

async function network() {
  const parts = fake();
  const log = emptyProbeLogFor();
  const net = new ProbeNetwork(parts.probe, defaultConfig.nameRoleValue, log);
  await net.enable();
  net.setCurrent({ browserContextId: 'CTX', mainFrameId: 'MAIN', frames: new Set(['MAIN']), url: 'https://shop.example/p', cookies: () => Promise.resolve([{ name: 'sid', value: '1', domain: 'shop.example', path: '/', sameSite: 'Lax' }]) });
  return { ...parts, log, net };
}

describe('the network of the probing browser', () => {
  it('is held at the browser target from the start, and never continues a request', async () => {
    const { sent, emit, net } = await network();
    expect(sent.map((entry) => entry.method)).toEqual(['Fetch.enable', 'Target.setDiscoverTargets']);
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
    const failed = sent.filter((entry) => entry.method === 'Fetch.failRequest').map((entry) => [entry.params['requestId'], entry.params['errorReason']]);
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
    net.setCurrent({ browserContextId: 'CTX2', mainFrameId: 'MAIN2', frames: new Set(['MAIN2']), url: 'https://shop.example/p', cookies: () => Promise.resolve([]) });
    net.openLoad();
    emit('Fetch.requestPaused', paused('3', 'GET', 'https://shop.example/pagehide?x=1', 'Fetch', 'MAIN'));
    await tick();
    expect(fetched).toEqual([]);
  });

  it('sends a cookie of another site only when it says SameSite=None', async () => {
    const parts = fake();
    const net = new ProbeNetwork(parts.probe, defaultConfig.nameRoleValue, emptyProbeLogFor());
    await net.enable();
    net.setCurrent({
      browserContextId: 'CTX',
      mainFrameId: 'MAIN',
      frames: new Set(['MAIN']),
      url: 'https://www.shop.example/p',
      cookies: () =>
        Promise.resolve([
          { name: 'lax', value: '1', domain: 'cdn.other.example', path: '/' },
          { name: 'none', value: '2', domain: 'cdn.other.example', path: '/', sameSite: 'None' },
        ]),
    });
    net.openLoad();
    parts.emit('Fetch.requestPaused', paused('1', 'GET', 'https://cdn.other.example/lib.js', 'Script'));
    await tick();
    expect(parts.fetched[0]!.headers['cookie']).toBe('none=2');
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
