import { AdjudicationConfigError } from '@a11y-vision/adjudicators';
import { describe, expect, it } from 'vitest';
import { extensionConfig } from './config.js';
import { adjudicationFor, API_KEY_STORAGE_KEY, buildAdjudicator, checkEndpoint, defaultSettings, parseSettings, safeMessage, SETTINGS_KEY, SettingsStore } from './settings.js';
import type { ModelSettings } from './settings.js';
import { fakeStorage } from './test-support.js';

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
    expect(checkEndpoint(local)).toEqual({ ok: true, local: true, host: '127.0.0.1', pattern: 'http://127.0.0.1:11434/*' });
    expect(checkEndpoint({ ...local, baseUrl: 'http://localhost:1234/v1' })).toMatchObject({ ok: true, local: true, pattern: 'http://localhost:1234/*' });
    expect(checkEndpoint({ ...local, baseUrl: 'https://ollama.localhost/v1' })).toMatchObject({ ok: true, local: true, pattern: 'https://ollama.localhost/*' });
  });

  it('refuses another machine unless allowed, and plain http to another machine always', () => {
    expect(checkEndpoint({ ...local, baseUrl: 'https://api.example.test/v1' })).toEqual({ ok: false, problem: 'endpointRemoteNotAllowed' });
    expect(checkEndpoint({ ...local, baseUrl: 'http://192.168.1.10:11434/v1' })).toEqual({ ok: false, problem: 'endpointRemoteNotAllowed' });
    expect(checkEndpoint({ ...local, baseUrl: 'http://0.0.0.0:11434/v1' })).toEqual({ ok: false, problem: 'endpointRemoteNotAllowed' });
    expect(checkEndpoint({ ...local, baseUrl: 'http://localhost.example.test/v1' })).toEqual({ ok: false, problem: 'endpointRemoteNotAllowed' });
    expect(checkEndpoint({ ...local, baseUrl: 'http://api.example.test/v1', allowRemote: true })).toEqual({ ok: false, problem: 'endpointRemoteHttp' });
    expect(checkEndpoint({ ...local, baseUrl: 'https://api.example.test/v1', allowRemote: true })).toEqual({ ok: true, local: false, host: 'api.example.test', pattern: 'https://api.example.test/*' });
  });

  it('refuses what is not a plain base URL, and settings that are incomplete', () => {
    expect(checkEndpoint({ ...local, baseUrl: '' })).toEqual({ ok: false, problem: 'endpointMissing' });
    expect(checkEndpoint({ ...local, model: ' ' })).toEqual({ ok: false, problem: 'modelMissing' });
    expect(checkEndpoint({ ...local, baseUrl: 'localhost:11434' })).toEqual({ ok: false, problem: 'endpointScheme' });
    expect(checkEndpoint({ ...local, baseUrl: 'not a url' })).toEqual({ ok: false, problem: 'endpointInvalid' });
    expect(checkEndpoint({ ...local, baseUrl: 'file:///etc/passwd' })).toEqual({ ok: false, problem: 'endpointScheme' });
    expect(checkEndpoint({ ...local, baseUrl: `http://user:${KEY}@localhost/v1` })).toEqual({ ok: false, problem: 'endpointCredentials' });
    expect(checkEndpoint({ ...local, baseUrl: 'http://localhost/v1?key=1' })).toEqual({ ok: false, problem: 'endpointQuery' });
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
