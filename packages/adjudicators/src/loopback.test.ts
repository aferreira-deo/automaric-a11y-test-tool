import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAdjudication } from '@a11y-vision/core';
import type { AdjudicationConfig } from '@a11y-vision/core';
import { startMockModel } from '../../../e2e/support/mock-model.js';
import type { MockModel } from '../../../e2e/support/mock-model.js';
import { createLoopbackFetch, verifyEndpoint } from './loopback-fetch.js';
import type { LookupAll } from './loopback-fetch.js';
import { AdjudicationConfigError, createAdjudicator, isLoopbackAddress, isLoopbackHost } from './provider.js';
import type { JudgeInput } from './types.js';

const run = promisify(execFile);
const KEY = 'sk-test-0123456789-SECRET';
const input: JudgeInput = { check: 'headings', question: 'Is it a heading?', crops: [], context: { text: 'Opening hours' } };
const settings = (over: Partial<AdjudicationConfig>): AdjudicationConfig => resolveAdjudication({ provider: 'openai-compatible', model: 'm', timeoutMs: 3000, ...over });

/** A resolver that answers from a table and records what it was asked. */
function resolver(table: Record<string, string[]>): LookupAll & { asked: string[] } {
  const asked: string[] = [];
  const lookup = ((hostname: string) => {
    asked.push(hostname);
    const addresses = table[hostname];
    if (!addresses) return Promise.reject(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
    return Promise.resolve(addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  }) as LookupAll & { asked: string[] };
  lookup.asked = asked;
  return lookup;
}

let mock: MockModel;
beforeEach(async () => {
  mock = await startMockModel();
});
afterEach(async () => {
  await mock.close();
});

describe('what counts as this machine', () => {
  it('tells loopback addresses from every other address', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '127.255.255.254', '::1', '0:0:0:0:0:0:0:1', '[::1]']) expect(isLoopbackAddress(address)).toBe(true);
    for (const address of ['10.0.0.1', '192.168.1.10', '0.0.0.0', '128.0.0.1', '1.127.0.0', '::', '::2', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1', '127.0.0.1.example.com', 'localhost', '', '127.0.0', '127.0.0.256']) {
      expect(isLoopbackAddress(address)).toBe(false);
    }
  });

  it('takes a name for this machine only as far as the name goes: the address is checked when it is used', () => {
    // By name these may be this machine; whether they are is for the resolver to say.
    for (const host of ['localhost', 'LOCALHOST', 'localhost.', 'ai.localhost']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['localhost.example.com', 'notlocalhost', 'example.com', '10.0.0.1']) expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('verifyEndpoint', () => {
  it('accepts a name every address of which is this machine', async () => {
    const lookup = resolver({ localhost: ['::1', '127.0.0.1'], 'ai.localhost': ['127.0.0.1'] });
    await verifyEndpoint(settings({ baseUrl: 'http://localhost:11434/v1' }), { lookup });
    await verifyEndpoint(settings({ baseUrl: 'http://ai.localhost:11434/v1' }), { lookup });
    expect(lookup.asked).toEqual(['localhost', 'ai.localhost']);
  });

  it('refuses a name under .localhost, or localhost itself, that leads anywhere else, and says where', async () => {
    const lookup = resolver({ 'evil.localhost': ['203.0.113.7'], 'mixed.localhost': ['127.0.0.1', '10.1.2.3'], localhost: ['192.168.1.50'], 'none.localhost': [] });
    for (const [host, address] of [
      ['evil.localhost', '203.0.113.7'],
      ['mixed.localhost', '10.1.2.3'],
      ['localhost', '192.168.1.50'],
    ]) {
      const refused = verifyEndpoint(settings({ baseUrl: `http://${host}:11434/v1` }), { lookup });
      await expect(refused).rejects.toBeInstanceOf(AdjudicationConfigError);
      await expect(refused).rejects.toThrow(`${host} resolves to ${address}, which is not this machine`);
    }
    await expect(verifyEndpoint(settings({ baseUrl: 'http://gone.localhost/v1' }), { lookup })).rejects.toThrow(/gone\.localhost could not be resolved/);
    await expect(verifyEndpoint(settings({ baseUrl: 'http://none.localhost/v1' }), { lookup })).rejects.toThrow(/none\.localhost could not be resolved/);
    // Allowing remote endpoints does not turn a name that claims to be local into a remote one that is fine over http.
    await expect(verifyEndpoint(settings({ baseUrl: 'http://evil.localhost/v1', allowRemote: true }), { lookup })).rejects.toThrow(/not this machine/);
  });

  it('asks no resolver about an address, about a remote host that was allowed, or when no provider is configured', async () => {
    const lookup = resolver({});
    await verifyEndpoint(settings({ baseUrl: 'http://127.0.0.1:1/v1' }), { lookup });
    await verifyEndpoint(settings({ baseUrl: 'http://[::1]:1/v1' }), { lookup });
    await verifyEndpoint(settings({ baseUrl: 'https://api.example.com/v1', allowRemote: true }), { lookup });
    await verifyEndpoint(resolveAdjudication({ baseUrl: 'http://evil.localhost/v1', model: 'm' }), { lookup });
    expect(lookup.asked).toEqual([]);
  });
});

describe('requests to an endpoint on this machine', () => {
  it('go to the address that was checked, under the name that was configured', async () => {
    const lookup = resolver({ 'ai.localhost': ['127.0.0.1'] });
    const adjudicator = createAdjudicator(settings({ baseUrl: `http://ai.localhost:${mock.port}/v1`, apiKeyEnv: 'K' }), { K: KEY }, { lookup })!;
    expect(await adjudicator.judge(input)).toMatchObject({ verdict: 'yes', confidence: 'high' });
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]!.headers.host).toBe(`ai.localhost:${mock.port}`);
    expect(mock.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(lookup.asked).toEqual(['ai.localhost']);
  });

  it('are not sent when the name turns out to lead elsewhere, even if it led here a moment ago', async () => {
    // The answer changes between the check and the request, as a rebinding resolver would do it.
    let calls = 0;
    const rebinding: LookupAll = () => Promise.resolve([{ address: calls++ === 0 ? '127.0.0.1' : '203.0.113.7', family: 4 }]);
    const config = settings({ baseUrl: `http://rebind.localhost:${mock.port}/v1`, apiKeyEnv: 'K', maxRetries: 0 });
    await verifyEndpoint(config, { lookup: rebinding });
    const adjudicator = createAdjudicator(config, { K: KEY }, { lookup: rebinding })!;
    const result = await adjudicator.judge(input);
    expect(result).toEqual({ verdict: 'unsure', rationale: '', problem: 'network', retryable: true });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(mock.requests).toHaveLength(0);

    // One address of several being elsewhere is enough.
    const mixed = createAdjudicator(config, { K: KEY }, { lookup: resolver({ 'rebind.localhost': ['127.0.0.1', '10.1.2.3'] }) })!;
    expect((await mixed.judge(input)).problem).toBe('network');
    expect(mock.requests).toHaveLength(0);
  });

  it('refuse an address that is not this machine, whatever made the request', async () => {
    const send = createLoopbackFetch();
    await expect(send('http://192.0.2.1:9/v1/chat/completions', { method: 'POST', body: '{}' })).rejects.toThrow(/not this machine/);
    await expect(send('ftp://127.0.0.1/x', { method: 'POST', body: '{}' })).rejects.toThrow();
  });

  it('reach localhost through the resolver of the system', async () => {
    const adjudicator = createAdjudicator(settings({ baseUrl: `http://localhost:${mock.port}/v1` }), {})!;
    await verifyEndpoint(settings({ baseUrl: `http://localhost:${mock.port}/v1` }));
    expect(await adjudicator.judge(input)).toMatchObject({ verdict: 'yes' });
    expect(mock.requests).toHaveLength(1);
  });
});

describe('a proxy configured in the environment', () => {
  const probe = fileURLToPath(new URL('../../../e2e/support/judge-once.mjs', import.meta.url));
  let proxy: Server;
  let proxied: string[];
  let proxyUrl: string;

  beforeEach(async () => {
    proxied = [];
    // A forward proxy that records what reaches it, and answers like a model would.
    proxy = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        proxied.push(`${request.method} ${request.url} auth=${request.headers.authorization ?? '-'} bytes=${Buffer.concat(chunks).length}`);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: '{"verdict":"no","confidence":"high","rationale":"from the proxy"}' }, finish_reason: 'stop' }] }));
      });
    });
    proxy.on('connect', (request, socket) => {
      proxied.push(`CONNECT ${request.url}`);
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  });

  /** A Node process with the proxy variables set and nothing that exempts this machine from them. */
  async function judgeInChild(baseUrl: string, extra: Record<string, string>): Promise<{ verdict: string; problem?: string; rationale: string }> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of Object.keys(env)) {
      if (/^(no_proxy|http_proxy|https_proxy|all_proxy|node_use_env_proxy|node_options)$/i.test(name)) delete env[name];
    }
    Object.assign(env, { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, PROBE_KEY: KEY }, extra);
    const { stdout, stderr } = await run(process.execPath, [probe, baseUrl], { env });
    expect(stdout + stderr).not.toContain(KEY);
    return JSON.parse(stdout) as { verdict: string; problem?: string; rationale: string };
  }

  it.each([
    ['NODE_USE_ENV_PROXY=1', { NODE_USE_ENV_PROXY: '1' }, '127.0.0.1'],
    ['NODE_OPTIONS=--use-env-proxy', { NODE_OPTIONS: '--use-env-proxy' }, '127.0.0.1'],
    ['NODE_USE_ENV_PROXY=1 and a name', { NODE_USE_ENV_PROXY: '1' }, 'localhost'],
  ])('is not used for an endpoint on this machine (%s)', async (_name, extra, host) => {
    const result = await judgeInChild(`http://${host}:${mock.port}/v1`, extra);
    // Page text, the capture and the key went to the endpoint and to nothing else.
    expect(proxied).toEqual([]);
    expect(result).toMatchObject({ verdict: 'yes', rationale: 'mock says yes' });
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  }, 20000);
});
