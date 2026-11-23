import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAdjudication } from '@a11y-vision/core';
import type { AdjudicationConfig } from '@a11y-vision/core';
import { completion, dataOf, imageParts, startMockModel, systemText, userText, verdict } from '../../../e2e/support/mock-model.js';
import type { MockModel } from '../../../e2e/support/mock-model.js';
import { createOpenAiCompatibleAdjudicator } from './openai-compatible.js';
import { SYSTEM_PROMPT, VERDICT_SCHEMA } from './prompt.js';
import { AdjudicationConfigError, createAdjudicator, isLoopbackHost, redact, secretsOf } from './provider.js';
import type { JudgeInput } from './types.js';

const KEY = 'sk-test-0123456789-SECRET';
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 1, 2, 3);
const input: JudgeInput = { check: 'headings', question: 'Is it a heading?', crops: [PNG], context: { text: 'Opening hours', textAfter: 'We are open.' } };

let mock: MockModel;
beforeEach(async () => {
  mock = await startMockModel();
});
afterEach(async () => {
  await mock.close();
});

function adapter(over: Partial<AdjudicationConfig> = {}, apiKey = KEY) {
  return createOpenAiCompatibleAdjudicator({ baseUrl: mock.baseUrl, model: 'some-model:tag', apiKey, label: '', settings: resolveAdjudication({ timeoutMs: 2000, ...over }) });
}

describe('the request', () => {
  it('is a chat completion in the documented shape', async () => {
    const result = await adapter().judge(input);
    expect(result).toEqual({ verdict: 'yes', confidence: 'high', rationale: 'mock says yes' });
    expect(mock.requests).toHaveLength(1);
    const { method, path, headers, body } = mock.requests[0]!;
    expect(method).toBe('POST');
    expect(path).toBe('/v1/chat/completions');
    expect(headers['content-type']).toBe('application/json');
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(body).toMatchObject({
      model: 'some-model:tag',
      temperature: 0,
      stream: false,
      max_tokens: 400,
      response_format: { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema: VERDICT_SCHEMA } },
    });
    expect(body).not.toHaveProperty('seed');
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body!.messages!.map((message) => message.role)).toEqual(['system', 'user']);
    expect(systemText(body)).toBe(SYSTEM_PROMPT);
    expect(userText(body)).toContain('QUESTION: Is it a heading?');
    expect(dataOf(body)).toEqual(input.context);
    // The capture travels as a base64 data URL in an image part, after the text.
    expect(imageParts(body)).toEqual([{ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}` } }]);
  });

  it('takes the variants endpoints differ in from the settings', async () => {
    await adapter({ imageUrlShape: 'string', responseFormat: 'json_object', maxTokensField: 'max_completion_tokens', maxOutputTokens: 123, seed: 7, temperature: 0.2 }).judge(input);
    const first = mock.requests[0]!.body!;
    expect(imageParts(first)[0]!.image_url).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`);
    expect(first).toMatchObject({ response_format: { type: 'json_object' }, max_completion_tokens: 123, seed: 7, temperature: 0.2 });
    expect(first).not.toHaveProperty('max_tokens');
    await adapter({ responseFormat: 'none', maxTokensField: 'none' }).judge(input);
    const second = mock.requests[1]!.body!;
    expect(second).not.toHaveProperty('response_format');
    expect(second).not.toHaveProperty('max_tokens');
    expect(second).not.toHaveProperty('max_completion_tokens');
  });

  it('is plain text when there is no capture', async () => {
    await adapter().judge({ ...input, crops: [] });
    const user = mock.requests[0]!.body!.messages![1]!;
    expect(typeof user.content).toBe('string');
    expect(imageParts(mock.requests[0]!.body)).toEqual([]);
  });

  it('carries no authorization header without a key, and copes with a trailing slash', async () => {
    const bare = createOpenAiCompatibleAdjudicator({ baseUrl: `${mock.baseUrl}//`, model: 'm', apiKey: '', label: 'Local', settings: resolveAdjudication() });
    expect(bare.provider).toBe('Local');
    await bare.judge(input);
    expect(mock.requests[0]!.headers.authorization).toBeUndefined();
    expect(mock.requests[0]!.path).toBe('/v1/chat/completions');
    expect(adapter().provider).toBe('openai-compatible');
  });
});

describe('the marker around the data', () => {
  const markerOf = (index: number): string =>
    userText(mock.requests[index]!.body)
      .split('\n')
      .find((line) => line.startsWith('BEGIN DATA '))!
      .slice('BEGIN DATA '.length);

  it('is random for every request, and no part of what tells one endpoint from another', async () => {
    const one = adapter();
    await one.judge(input);
    await one.judge(input);
    await adapter().judge(input);
    const markers = [0, 1, 2].map(markerOf);
    expect(new Set(markers).size).toBe(3);
    for (const marker of markers) expect(marker).toMatch(/^[0-9a-f]{32}$/);
    // The cache key is made from this and from the candidate: the same for every request.
    expect(adapter().cacheIdentity).toBe(one.cacheIdentity);
    for (const marker of markers) expect(one.cacheIdentity).not.toContain(marker);
  });

  it('comes from the source that is given, for a test that needs the request to be the same twice', async () => {
    const pinned = createOpenAiCompatibleAdjudicator({ baseUrl: mock.baseUrl, model: 'm', apiKey: '', label: '', settings: resolveAdjudication(), nonce: () => 'pinned' });
    await pinned.judge(input);
    await pinned.judge(input);
    expect(markerOf(0)).toBe('pinned');
    expect(mock.requests[1]!.raw).toBe(mock.requests[0]!.raw);
  });
});

describe('the answer', () => {
  it.each([
    ['yes', 'high'],
    ['no', 'high'],
    ['unsure', 'low'],
  ] as const)('reads %s (%s)', async (value, confidence) => {
    mock.respond(() => verdict(value, confidence, 'why'));
    expect(await adapter().judge(input)).toEqual({ verdict: value, confidence, rationale: 'why' });
  });

  it('reads content given as parts', async () => {
    mock.respond(() => ({ body: completion([{ type: 'text', text: '{"verdict":"no","confidence":"high",' }, { type: 'text', text: '"rationale":"a label"}' }]) }));
    expect(await adapter().judge(input)).toEqual({ verdict: 'no', confidence: 'high', rationale: 'a label' });
  });

  it.each([
    ['prose in place of JSON', { body: completion('Yes, that is clearly a heading.') }, 'invalid-output'],
    ['a verdict that is not one of the three', { body: completion('{"verdict":"fail","confidence":"high","rationale":"x"}') }, 'invalid-output'],
    ['an object with a field that was not asked for', { body: completion('{"verdict":"yes","confidence":"high","rationale":"x","status":"fail"}') }, 'invalid-output'],
    ['empty content', { body: completion('') }, 'invalid-output'],
    ['null content', { body: completion(null) }, 'invalid-output'],
    ['a body that is not JSON', { body: '<html>Bad gateway</html>' }, 'invalid-output'],
    ['a body without choices', { body: { error: 'nope' } }, 'invalid-output'],
    ['choices that are not a list', { body: { choices: 'yes' } }, 'invalid-output'],
    ['a refusal', { body: completion(null, { message: { role: 'assistant', content: null, refusal: 'I cannot help with that.' } }) }, 'refusal'],
    ['a content filter', { body: completion('{"verdict":"yes","confidence":"high","rationale":"x"}', { finish_reason: 'content_filter' }) }, 'refusal'],
    ['an answer cut at the token limit', { body: completion('{"verdict":"yes","confid', { finish_reason: 'length' }) }, 'truncated'],
  ])('turns %s into unsure', async (_name, reply, problem) => {
    mock.respond(() => reply);
    expect(await adapter().judge(input)).toEqual({ verdict: 'unsure', rationale: '', problem });
  });

  it('does not read an answer that is too long', async () => {
    mock.respond(() => ({ body: completion(JSON.stringify({ verdict: 'yes', confidence: 'high', rationale: 'x'.repeat(5000) })) }));
    expect(await adapter({ maxResponseChars: 1000 }).judge(input)).toEqual({ verdict: 'unsure', rationale: '', problem: 'too-large' });
  });

  it('cuts a long rationale', async () => {
    mock.respond(() => verdict('yes', 'high', 'y'.repeat(900)));
    const result = await adapter({ maxRationaleChars: 20 }).judge(input);
    expect(result.rationale).toHaveLength(21);
  });
});

describe('failures of the endpoint', () => {
  it.each([
    [500, true],
    [502, true],
    [503, true],
    [429, true],
    [408, true],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
  ])('reports HTTP %i, retryable: %s, and nothing of the body', async (status, retryable) => {
    mock.respond(() => ({ status, body: { error: { message: `Incorrect API key provided: ${KEY}` } } }));
    const result = await adapter().judge(input);
    expect(result).toEqual({ verdict: 'unsure', rationale: '', problem: 'http', ...(retryable ? { retryable: true } : {}) });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('gives up after the timeout, and says so', async () => {
    mock.respond(() => ({ hang: true }));
    const started = Date.now();
    expect(await adapter({ timeoutMs: 150 }).judge(input)).toEqual({ verdict: 'unsure', rationale: '', problem: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('gives up on an answer that comes after the timeout', async () => {
    mock.respond(() => ({ ...verdict('yes'), delayMs: 600 }));
    expect((await adapter({ timeoutMs: 150 }).judge(input)).problem).toBe('timeout');
  });

  it('is aborted by the signal of the caller, and says that it was stopped, not that it failed', async () => {
    mock.respond(() => ({ hang: true }));
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => stop.abort(), 100);
    expect(await adapter({ timeoutMs: 5000 }).judge(input, { signal: stop.signal })).toEqual({ verdict: 'unsure', rationale: '', problem: 'stopped' });
    expect(Date.now() - started).toBeLessThan(2000);
    // And is not sent at all once the signal has fired.
    const sent = mock.requests.length;
    expect(await adapter().judge(input, { signal: stop.signal })).toEqual({ verdict: 'unsure', rationale: '', problem: 'stopped' });
    expect(mock.requests.length).toBe(sent);
  });

  it('reports a dropped connection and a closed port as network problems worth retrying', async () => {
    mock.respond(() => ({ drop: true }));
    expect(await adapter().judge(input)).toEqual({ verdict: 'unsure', rationale: '', problem: 'network', retryable: true });
    const closed = await startMockModel();
    await closed.close();
    const gone = createOpenAiCompatibleAdjudicator({ baseUrl: closed.baseUrl, model: 'm', apiKey: KEY, label: '', settings: resolveAdjudication() });
    expect(await gone.judge(input)).toEqual({ verdict: 'unsure', rationale: '', problem: 'network', retryable: true });
  });

  it('does not follow a redirect to another address', async () => {
    const other = await startMockModel();
    try {
      mock.respond(() => ({ status: 307, headers: { location: `${other.baseUrl}/chat/completions` } }));
      expect((await adapter().judge(input)).problem).toBe('network');
      expect(other.requests).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it('waits as long as it is told to, however long that is', async () => {
    // A delay beyond what a timer holds used to fire at once: the call was a timeout before it was sent.
    for (const timeoutMs of [2 ** 31, 1e13, Number.MAX_SAFE_INTEGER]) {
      mock.respond(() => ({ ...verdict('yes'), delayMs: 30 }));
      expect(await adapter({ timeoutMs }).judge(input)).toMatchObject({ verdict: 'yes' });
    }
  });

  it('never throws, whatever fetch does', async () => {
    const broken = createOpenAiCompatibleAdjudicator({
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'm',
      apiKey: KEY,
      label: '',
      settings: resolveAdjudication(),
      fetch: () => Promise.reject(new Error(`connect failed with header Bearer ${KEY}`)),
    });
    const result = await broken.judge(input);
    expect(result).toEqual({ verdict: 'unsure', rationale: '', problem: 'network', retryable: true });
  });
});

describe('createAdjudicator', () => {
  const settings = (over: Partial<AdjudicationConfig>): AdjudicationConfig => resolveAdjudication({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'm', ...over });

  it('makes nothing, and reads nothing, when no provider is configured', () => {
    const env = new Proxy(
      {},
      {
        get: () => {
          throw new Error('the environment was read');
        },
      },
    );
    expect(createAdjudicator(resolveAdjudication(), env)).toBeNull();
    // A base URL and a model alone select nothing: the provider has to be named.
    expect(createAdjudicator(resolveAdjudication({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKeyEnv: 'SOME_KEY' }), env)).toBeNull();
    expect(secretsOf(resolveAdjudication({ apiKeyEnv: 'SOME_KEY' }), env)).toEqual([]);
  });

  it('has no default endpoint and no default model', () => {
    expect(resolveAdjudication()).toMatchObject({ provider: 'none', baseUrl: '', model: '', apiKeyEnv: '', allowRemote: false });
    expect(() => createAdjudicator(settings({ baseUrl: '' }), {})).toThrow(/without a base URL/);
    expect(() => createAdjudicator(settings({ model: '' }), {})).toThrow(/without a model name/);
  });

  it('refuses an endpoint that is not on this machine unless that is allowed', () => {
    for (const baseUrl of ['https://api.example.com/v1', 'https://192.168.1.20:11434/v1', 'https://10.0.0.5/v1', 'https://localhost.example.com/v1', 'https://[2001:db8::1]/v1']) {
      expect(() => createAdjudicator(settings({ baseUrl }), {})).toThrow(/not this machine/);
      expect(createAdjudicator(settings({ baseUrl, allowRemote: true }), {})).not.toBeNull();
    }
    for (const baseUrl of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://127.1.2.3/v1', 'http://[::1]:8080/v1', 'http://ai.localhost/v1']) {
      expect(createAdjudicator(settings({ baseUrl }), {})).not.toBeNull();
    }
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('127.0.0.1.example.com')).toBe(false);
  });

  it('never talks plain http to another machine, allowed or not, with a key or without', async () => {
    let sent = 0;
    const spy = (() => {
      sent++;
      return Promise.resolve(new Response('{}'));
    }) as unknown as typeof fetch;
    for (const baseUrl of ['http://api.example.com/v1', 'http://192.168.1.20:11434/v1', 'http://10.0.0.5/v1', 'http://localhost.example.com/v1', 'http://[2001:db8::1]/v1', 'http://0.0.0.0:1/v1']) {
      for (const over of [{ allowRemote: true }, { allowRemote: true, apiKeyEnv: 'MY_MODEL_KEY' }]) {
        let message = '';
        try {
          createAdjudicator(settings({ baseUrl, ...over }), { MY_MODEL_KEY: KEY }, { fetch: spy });
        } catch (error) {
          expect(error).toBeInstanceOf(AdjudicationConfigError);
          message = (error as Error).message;
        }
        expect(message).toMatch(/https/);
        expect(message).toMatch(/would travel unencrypted/);
        expect(message).not.toContain(KEY);
      }
      // Without allowRemote the first thing said is that the host is another machine.
      expect(() => createAdjudicator(settings({ baseUrl }), {})).toThrow(/not this machine/);
    }
    expect(sent).toBe(0);
    // Plain http stays fine for this machine, and https for another one that was allowed.
    const local = createAdjudicator(settings({ baseUrl: mock.baseUrl, apiKeyEnv: 'MY_MODEL_KEY' }), { MY_MODEL_KEY: KEY })!;
    expect((await local.judge(input)).verdict).toBe('yes');
    const remote = createAdjudicator(settings({ baseUrl: 'https://api.example.com/v1', allowRemote: true, apiKeyEnv: 'MY_MODEL_KEY' }), { MY_MODEL_KEY: KEY }, { fetch: spy })!;
    await remote.judge(input);
    expect(sent).toBe(1);
  });

  it('refuses a base URL it cannot use, without echoing credentials', () => {
    expect(() => createAdjudicator(settings({ baseUrl: 'not a url' }), {})).toThrow(/not a valid URL/);
    expect(() => createAdjudicator(settings({ baseUrl: 'file:///etc/passwd' }), {})).toThrow(/http or https/);
    expect(() => createAdjudicator(settings({ baseUrl: 'http://127.0.0.1/v1?key=abc' }), {})).toThrow(/query string/);
    let message = '';
    try {
      createAdjudicator(settings({ baseUrl: `http://user:${KEY}@127.0.0.1/v1` }), {});
    } catch (error) {
      expect(error).toBeInstanceOf(AdjudicationConfigError);
      message = (error as Error).message;
    }
    expect(message).toMatch(/must not carry credentials/);
    expect(message).not.toContain(KEY);
  });

  it('reads the key from the variable that is named, and only its name is ever said', async () => {
    await createAdjudicator(settings({ baseUrl: mock.baseUrl, apiKeyEnv: 'MY_MODEL_KEY' }), { MY_MODEL_KEY: ` ${KEY} `, OTHER: 'x' })!.judge(input);
    expect(mock.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(() => createAdjudicator(settings({ apiKeyEnv: 'MY_MODEL_KEY' }), {})).toThrow(/MY_MODEL_KEY.*not set/);
    expect(() => createAdjudicator(settings({ apiKeyEnv: 'MY_MODEL_KEY' }), { MY_MODEL_KEY: '  ' })).toThrow(/not set or is empty/);
    // The key itself where the name should be: refused, and not repeated.
    let message = '';
    try {
      createAdjudicator(settings({ apiKeyEnv: KEY }), {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/NAME of an environment variable/);
    expect(message).not.toContain(KEY);
    expect(secretsOf(settings({ apiKeyEnv: 'MY_MODEL_KEY' }), { MY_MODEL_KEY: KEY })).toEqual([KEY]);
    expect(secretsOf(settings({ apiKeyEnv: 'MY_MODEL_KEY' }), {})).toEqual([]);
  });

  it('redacts', () => {
    expect(redact(`401 for Bearer ${KEY}, again ${KEY}`, [KEY])).toBe('401 for Bearer [redacted], again [redacted]');
    expect(redact('nothing to hide', [KEY, ''])).toBe('nothing to hide');
  });
});
