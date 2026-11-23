import { AdjudicationConfigError } from '@a11y-vision/adjudicators';
import { describe, expect, it } from 'vitest';
import { extensionConfig } from './config.js';
import { readFileSync } from 'node:fs';
import {
  adjudicationFor,
  API_KEY_STORAGE_KEY,
  applyPermissionChange,
  buildAdjudicator,
  checkEndpoint,
  connectSources,
  defaultSettings,
  endpointPermissionChange,
  hostPermissionPatterns,
  parseSettings,
  safeMessage,
  SETTINGS_KEY,
  SettingsStore,
} from './settings.js';
import type { EndpointCheck, ModelSettings } from './settings.js';
import { fakeStorage } from './test-support.js';

const check = (model: Pick<ModelSettings, 'baseUrl' | 'model' | 'allowRemote'>): EndpointCheck => checkEndpoint(model, extensionConfig.endpoint);

const KEY = 'sk-unit-0123456789-SECRET';
const local: ModelSettings = { enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'some-model', allowRemote: false, sendImages: true };

describe('settings', () => {
  it('start with every check, no model, and remote endpoints refused', () => {
    const settings = defaultSettings(extensionConfig);
    expect(settings.checks).toEqual(['focus-indicator', 'icon-contrast', 'headings', 'lists', 'grouping']);
    expect(settings.model).toEqual({ enabled: false, baseUrl: '', model: '', allowRemote: false, sendImages: true });
    expect(adjudicationFor(settings.model, false).provider).toBe('none');
  });

  it('read from storage are checked field by field', () => {
    expect(parseSettings(null, extensionConfig)).toEqual(defaultSettings(extensionConfig));
    const parsed = parseSettings(
      { checks: ['lists', 'noop', 7, 'headings'], groupBy: 'check', model: { enabled: 'yes', baseUrl: ' http://localhost:1/v1 ', model: 5, allowRemote: 1, sendImages: false, apiKey: KEY } },
      extensionConfig,
    );
    expect(parsed).toEqual({ checks: ['headings', 'lists'], groupBy: 'check', model: { enabled: false, baseUrl: 'http://localhost:1/v1', model: '', allowRemote: false, sendImages: false } });
    // No usable check: all of them, rather than a scan of nothing.
    expect(parseSettings({ checks: ['noop'] }, extensionConfig).checks).toHaveLength(5);
  });
});

describe('checkEndpoint', () => {
  it('takes an endpoint on this machine over http or https, and gives the pattern of exactly its origin', () => {
    expect(check(local)).toEqual({ ok: true, local: true, host: '127.0.0.1', pattern: 'http://127.0.0.1:11434/*' });
    expect(check({ ...local, baseUrl: 'http://localhost:1234/v1' })).toMatchObject({ ok: true, local: true, pattern: 'http://localhost:1234/*' });
    expect(check({ ...local, baseUrl: 'https://ollama.localhost/v1' })).toMatchObject({ ok: true, local: true, pattern: 'https://ollama.localhost/*' });
  });

  it('refuses another machine unless allowed, and plain http to another machine always', () => {
    expect(check({ ...local, baseUrl: 'https://api.example.test/v1' })).toEqual({ ok: false, problem: 'endpointRemoteNotAllowed' });
    expect(check({ ...local, baseUrl: 'http://192.168.1.10:11434/v1' })).toEqual({ ok: false, problem: 'endpointRemoteNotAllowed' });
    expect(check({ ...local, baseUrl: 'http://0.0.0.0:11434/v1' })).toEqual({ ok: false, problem: 'endpointRemoteNotAllowed' });
    expect(check({ ...local, baseUrl: 'http://localhost.example.test/v1' })).toEqual({ ok: false, problem: 'endpointRemoteNotAllowed' });
    expect(check({ ...local, baseUrl: 'http://api.example.test/v1', allowRemote: true })).toEqual({ ok: false, problem: 'endpointRemoteHttp' });
    expect(check({ ...local, baseUrl: 'https://api.example.test/v1', allowRemote: true })).toEqual({ ok: true, local: false, host: 'api.example.test', pattern: 'https://api.example.test/*' });
  });

  it('refuses what is not a plain base URL, and settings that are incomplete', () => {
    expect(check({ ...local, baseUrl: '' })).toEqual({ ok: false, problem: 'endpointMissing' });
    expect(check({ ...local, model: ' ' })).toEqual({ ok: false, problem: 'modelMissing' });
    expect(check({ ...local, baseUrl: 'localhost:11434' })).toEqual({ ok: false, problem: 'endpointScheme' });
    expect(check({ ...local, baseUrl: 'not a url' })).toEqual({ ok: false, problem: 'endpointInvalid' });
    expect(check({ ...local, baseUrl: 'file:///etc/passwd' })).toEqual({ ok: false, problem: 'endpointScheme' });
    expect(check({ ...local, baseUrl: `http://user:${KEY}@localhost/v1` })).toEqual({ ok: false, problem: 'endpointCredentials' });
    expect(check({ ...local, baseUrl: 'http://localhost/v1?key=1' })).toEqual({ ok: false, problem: 'endpointQuery' });
  });
});

describe('the hosts an endpoint may have over plain http', () => {
  const manifest = JSON.parse(readFileSync(new URL('../static/manifest.json', import.meta.url), 'utf8')) as {
    optional_host_permissions: string[];
    content_security_policy: { extension_pages: string };
  };
  const connectSrc = manifest.content_security_policy.extension_pages
    .split(';')
    .map((directive) => directive.trim().split(/\s+/))
    .find(([name]) => name === 'connect-src')!
    .slice(1);

  it('are one list: the manifest says what the configuration says, in its policy and in the permissions it may ask for', () => {
    expect(connectSrc).toEqual(connectSources(extensionConfig.endpoint));
    expect(manifest.optional_host_permissions).toEqual(hostPermissionPatterns(extensionConfig.endpoint));
    expect(connectSources({ httpHosts: ['localhost', '*.localhost', '127.0.0.1'] })).toEqual(['http://localhost:*', 'http://*.localhost:*', 'http://127.0.0.1:*', 'https:']);
    expect(hostPermissionPatterns({ httpHosts: ['localhost', '*.localhost', '127.0.0.1'] })).toEqual(['http://localhost/*', 'http://*.localhost/*', 'http://127.0.0.1/*', 'https://*/*']);
  });

  /** Whether the policy of the manifest lets a request to `url` out: a host source matches by scheme, host (exactly, or under `*.`) and port. */
  const policyAllows = (url: URL): boolean =>
    connectSrc.some((source) => {
      if (source === 'https:') return url.protocol === 'https:';
      const match = /^(https?):\/\/(\*\.)?([a-z0-9.-]+):\*$/.exec(source);
      if (!match) throw new Error(`A source the test does not know: ${source}`);
      const [, scheme, wildcard, host] = match;
      return url.protocol === `${scheme}:` && (wildcard ? url.hostname.endsWith(`.${host}`) : url.hostname === host);
    });

  it('are what the settings check takes, for every way of writing this machine: what the policy would block is refused, with the reason', () => {
    const forms = [
      'http://localhost:11434/v1',
      'http://LOCALHOST:11434/v1',
      'http://localhost/v1',
      'http://ai.localhost:8080/v1',
      'http://a.b.localhost:8080/v1',
      'http://127.0.0.1:11434/v1',
      'http://127.1:11434/v1',
      'http://localhost.:11434/v1',
      'http://ai.localhost.:11434/v1',
      'http://127.0.0.2:11434/v1',
      'http://127.255.255.254/v1',
      'http://[::1]:11434/v1',
      'http://[0:0:0:0:0:0:0:1]:11434/v1',
      'https://localhost:8443/v1',
      'https://127.0.0.2:8443/v1',
      'https://[::1]:8443/v1',
      'https://localhost.:8443/v1',
    ];
    const taken: string[] = [];
    for (const baseUrl of forms) {
      const result = check({ ...local, baseUrl });
      expect(result.ok, baseUrl).toBe(policyAllows(new URL(baseUrl)));
      if (result.ok) taken.push(baseUrl);
      else expect(result.problem, baseUrl).toBe('endpointHttpLoopbackForm');
    }
    expect(taken).toEqual([
      'http://localhost:11434/v1',
      'http://LOCALHOST:11434/v1',
      'http://localhost/v1',
      'http://ai.localhost:8080/v1',
      'http://a.b.localhost:8080/v1',
      'http://127.0.0.1:11434/v1',
      'http://127.1:11434/v1',
      'https://localhost:8443/v1',
      'https://127.0.0.2:8443/v1',
      'https://[::1]:8443/v1',
      'https://localhost.:8443/v1',
    ]);
    // Every one of them is this machine, and says so.
    for (const baseUrl of taken) expect(check({ ...local, baseUrl })).toMatchObject({ local: true });
  });
});

describe('the host permission of the endpoint', () => {
  const remote: ModelSettings = { ...local, baseUrl: 'https://api.example.test/v1', allowRemote: true };
  const change = (before: ModelSettings, after: ModelSettings) => endpointPermissionChange(before, after, extensionConfig.endpoint);

  it('is asked for the origin in use, and given up for the one that no longer is', () => {
    const off = { ...local, enabled: false, baseUrl: '', model: '' };
    expect(change(off, local)).toEqual({ request: 'http://127.0.0.1:11434/*', remove: null });
    // Saved again unchanged, or with another model or path on the same origin: nothing is given up.
    expect(change(local, local)).toEqual({ request: 'http://127.0.0.1:11434/*', remove: null });
    expect(change(local, { ...local, model: 'another', baseUrl: 'http://127.0.0.1:11434/other/v1' })).toEqual({ request: 'http://127.0.0.1:11434/*', remove: null });
    // Another origin: a port is one.
    expect(change(local, { ...local, baseUrl: 'http://127.0.0.1:8080/v1' })).toEqual({ request: 'http://127.0.0.1:8080/*', remove: 'http://127.0.0.1:11434/*' });
    expect(change(remote, local)).toEqual({ request: 'http://127.0.0.1:11434/*', remove: 'https://api.example.test/*' });
    // The model switched off: nothing is asked, and the access goes.
    expect(change(remote, { ...remote, enabled: false })).toEqual({ request: null, remove: 'https://api.example.test/*' });
    // Off before and off now, with the address still in the form: still given up (it may be left from an earlier version).
    expect(change({ ...remote, enabled: false }, { ...remote, enabled: false })).toEqual({ request: null, remove: 'https://api.example.test/*' });
    // Nothing usable before: nothing to give up.
    expect(change({ ...local, baseUrl: 'not a url' }, local)).toEqual({ request: 'http://127.0.0.1:11434/*', remove: null });
    expect(change(off, off)).toEqual({ request: null, remove: null });
  });

  it('is removed through chrome.permissions, for that origin and no other; asking is skipped when it is held', async () => {
    const calls: [string, string[]][] = [];
    const held = new Set(['https://api.example.test/*']);
    const permissions = {
      contains: ({ origins }: { origins: string[] }) => (calls.push(['contains', origins]), Promise.resolve(origins.every((origin) => held.has(origin)))),
      request: ({ origins }: { origins: string[] }) => (calls.push(['request', origins]), Promise.resolve(true)),
      remove: ({ origins }: { origins: string[] }) => (calls.push(['remove', origins]), Promise.resolve(origins.every((origin) => held.delete(origin)))),
    };
    const moved = applyPermissionChange(permissions, change(remote, local));
    expect(await moved.granted).toBe(true);
    expect(await moved.removed).toBe(true);
    expect(calls).toEqual([
      ['contains', ['http://127.0.0.1:11434/*']],
      ['remove', ['https://api.example.test/*']],
      ['request', ['http://127.0.0.1:11434/*']],
    ]);
    expect([...held]).toEqual([]);

    calls.length = 0;
    held.add('https://api.example.test/*');
    const kept = applyPermissionChange(permissions, change(remote, remote));
    expect(await kept.granted).toBe(true);
    expect(kept.removed).toBeNull();
    expect(calls).toEqual([['contains', ['https://api.example.test/*']]]);

    // A browser that refuses is not an error of the settings.
    const failing = { contains: () => Promise.reject(new Error('no')), request: () => Promise.reject(new Error('no')), remove: () => Promise.reject(new Error('no')) };
    const failed = applyPermissionChange(failing, change(remote, local));
    expect(await failed.granted).toBe(false);
    expect(await failed.removed).toBe(false);
  });
});

describe('buildAdjudicator', () => {
  const noFetch: typeof fetch = () => Promise.reject(new Error('not expected'));

  it('gives none when the model is off, whatever else is filled in, and reads no key', () => {
    expect(buildAdjudicator({ ...local, enabled: false }, KEY, noFetch).adjudicator).toBeNull();
  });

  it('enforces the rules of the CLI again, whatever the form let through', () => {
    expect(() => buildAdjudicator({ ...local, baseUrl: 'https://api.example.test/v1' }, '', noFetch)).toThrow(AdjudicationConfigError);
    expect(() => buildAdjudicator({ ...local, baseUrl: 'http://api.example.test/v1', allowRemote: true }, '', noFetch)).toThrow(/https/);
    expect(() => buildAdjudicator({ ...local, model: '' }, '', noFetch)).toThrow(AdjudicationConfigError);
  });

  it('sends from the fetch it is given, with the key as a bearer token and no cookies, and the key is in no part of the adjudicator that is shown', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const send: typeof fetch = (input, init) => {
      seen.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init });
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"yes","confidence":"high","rationale":"r"}' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    };
    const { adjudicator, config } = buildAdjudicator(local, KEY, send);
    expect(adjudicator).not.toBeNull();
    const result = await adjudicator!.judge({ check: 'headings', question: 'Is it?', crops: [], context: { text: 'Title' } });
    expect(result.verdict).toBe('yes');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(new Headers(seen[0]!.init?.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.init?.credentials).toBe('omit');
    expect(seen[0]!.init?.referrerPolicy).toBe('no-referrer');
    expect(seen[0]!.init?.redirect).toBe('error');
    // The configuration names a variable, never the key; neither does anything shown in a finding.
    expect(JSON.stringify(config)).not.toContain(KEY);
    expect(JSON.stringify([adjudicator!.provider, adjudicator!.model, adjudicator!.promptVersion])).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('sends no authorization header when there is no key', async () => {
    let headers: Headers | undefined;
    const send: typeof fetch = (_input, init) => {
      headers = new Headers(init?.headers);
      return Promise.reject(new Error('down'));
    };
    const result = await buildAdjudicator(local, '', send).adjudicator!.judge({ check: 'headings', question: 'Is it?', crops: [], context: {} });
    expect(headers?.has('authorization')).toBe(false);
    expect(result.verdict).toBe('unsure');
  });

  it('a message that is shown never carries the key', () => {
    expect(safeMessage(new Error(`401 for key ${KEY} at endpoint`), KEY)).toBe('401 for key [redacted] at endpoint');
    expect(safeMessage(new Error('plain'), '')).toBe('plain');
    expect(safeMessage('not an error', KEY)).toBe('Unknown error');
  });
});

describe('SettingsStore', () => {
  it('keeps the key in an item of its own in the area it is given, and the settings without it', async () => {
    const area = fakeStorage();
    const store = new SettingsStore(area, extensionConfig);
    expect(await store.hasKey()).toBe(false);
    await store.setKey(`  ${KEY}  `);
    await store.save({ checks: ['headings'], groupBy: 'status', model: local });
    expect(area.items[API_KEY_STORAGE_KEY]).toBe(KEY);
    expect(JSON.stringify(area.items[SETTINGS_KEY])).not.toContain(KEY);
    expect(await store.hasKey()).toBe(true);
    expect(await store.readKey()).toBe(KEY);
    expect(JSON.stringify(await store.load())).not.toContain(KEY);
    expect(await store.load()).toEqual({ checks: ['headings'], groupBy: 'status', model: local });
  });

  it('does not store a key that came in as part of the settings', async () => {
    const area = fakeStorage();
    const store = new SettingsStore(area, extensionConfig);
    await store.save({ checks: ['headings'], groupBy: 'status', model: { ...local, apiKey: KEY } as ModelSettings, apiKey: KEY } as never);
    expect(JSON.stringify(area.items)).not.toContain(KEY);
  });

  it('removes the key, also when an empty one is set', async () => {
    const area = fakeStorage({ [API_KEY_STORAGE_KEY]: KEY });
    const store = new SettingsStore(area, extensionConfig);
    await store.setKey('   ');
    expect(Object.hasOwn(area.items, API_KEY_STORAGE_KEY)).toBe(false);
    await store.setKey(KEY);
    await store.clearKey();
    expect(area.items).toEqual({});
    expect(await store.readKey()).toBe('');
  });

  it('reads a key that is not a string as none', async () => {
    const store = new SettingsStore(fakeStorage({ [API_KEY_STORAGE_KEY]: { a: 1 } }), extensionConfig);
    expect(await store.readKey()).toBe('');
  });
});
