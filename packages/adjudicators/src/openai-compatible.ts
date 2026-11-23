import { MAX_TIMER_MS } from '@a11y-vision/core';
import type { AdjudicationConfig, AiProblem, Png } from '@a11y-vision/core';
import { buildPrompt, parseVerdict, PROMPT_VERSION, VERDICT_SCHEMA } from './prompt.js';
import type { Adjudicator, JudgeInput, JudgeResult } from './types.js';

/** The kind of adapter; also the provider label when none is configured. */
export const OPENAI_COMPATIBLE = 'openai-compatible';

/** Statuses after which the same request may succeed: the server was busy or failed, the request was not wrong. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface OpenAiCompatibleOptions {
  /** Validated by the caller (`createAdjudicator`): http or https, no credentials in it. */
  baseUrl: string;
  model: string;
  /** Sent as a bearer token when not empty. It is used for that header and nothing else. */
  apiKey: string;
  label: string;
  settings: Pick<
    AdjudicationConfig,
    'temperature' | 'seed' | 'timeoutMs' | 'maxOutputTokens' | 'maxTokensField' | 'responseFormat' | 'imageUrlShape' | 'maxResponseChars' | 'maxRationaleChars'
  >;
  /** What sends the request. Defaults to the global `fetch`; `createAdjudicator` gives another one for an endpoint on this machine. */
  fetch?: typeof fetch;
  /** Source of the marker around the data, for tests. Defaults to a random one for every request. */
  nonce?: () => string;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += BASE64[(triple >> 18) & 63]! + BASE64[(triple >> 12) & 63]!;
    out += b === undefined ? '=' : BASE64[(triple >> 6) & 63]!;
    out += c === undefined ? '=' : BASE64[triple & 63]!;
  }
  return out;
}

function imagePart(png: Png, shape: AdjudicationConfig['imageUrlShape']): Record<string, unknown> {
  // A data URL, never the address of the page: the endpoint is not asked to fetch anything.
  const url = `data:image/png;base64,${toBase64(png)}`;
  return { type: 'image_url', image_url: shape === 'string' ? url : { url } };
}

/** The request body of POST {baseUrl}/chat/completions. Exported for the tests that pin its shape. */
export function chatCompletionsBody(input: JudgeInput, options: Pick<OpenAiCompatibleOptions, 'model' | 'settings' | 'nonce'>): Record<string, unknown> {
  const { settings } = options;
  const prompt = options.nonce ? buildPrompt(input.question, input.context, options.nonce) : buildPrompt(input.question, input.context);
  const body: Record<string, unknown> = {
    model: options.model,
    messages: [
      { role: 'system', content: prompt.system },
      {
        role: 'user',
        content:
          input.crops.length > 0
            ? [{ type: 'text', text: prompt.user }, ...input.crops.map((crop) => imagePart(crop, settings.imageUrlShape))]
            : prompt.user,
      },
    ],
    temperature: settings.temperature,
    stream: false,
  };
  if (settings.seed !== null) body['seed'] = settings.seed;
  if (settings.maxTokensField !== 'none') body[settings.maxTokensField] = settings.maxOutputTokens;
  if (settings.responseFormat === 'json_schema') {
    body['response_format'] = { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema: VERDICT_SCHEMA } };
  } else if (settings.responseFormat === 'json_object') {
    body['response_format'] = { type: 'json_object' };
  }
  return body;
}

function failed(problem: AiProblem, retryable = false): JudgeResult {
  return { verdict: 'unsure', rationale: '', problem, ...(retryable ? { retryable } : {}) };
}

/** The text of a response, or null when it is longer than `maxChars` (the rest is not read). */
async function readText(response: Response, maxChars: number): Promise<string | null> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > maxChars) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
  }
  return text + decoder.decode();
}

/** `choices[0].message.content` as text: a string, or parts of type text. */
function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content as unknown[]) {
    if (part !== null && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}

function readCompletion(text: string, maxRationaleChars: number): JudgeResult {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return failed('invalid-output');
  }
  const choices = (envelope as { choices?: unknown } | null)?.choices;
  const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
  if (choice === null || typeof choice !== 'object') return failed('invalid-output');
  const { message, finish_reason: finishReason } = choice as { message?: unknown; finish_reason?: unknown };
  const { content, refusal } = (message !== null && typeof message === 'object' ? message : {}) as { content?: unknown; refusal?: unknown };
  if ((typeof refusal === 'string' && refusal !== '') || finishReason === 'content_filter') return failed('refusal');
  if (finishReason === 'length') return failed('truncated');
  const output = contentText(content);
  if (output === null || output.trim() === '') return failed('invalid-output');
  const parsed = parseVerdict(output, maxRationaleChars);
  return parsed ?? failed('invalid-output');
}

/**
 * Adapter for POST {baseUrl}/chat/completions, the request shape that OpenAI defines and that
 * Ollama, LM Studio, llama.cpp, vLLM and others accept. Nothing here is specific to one of them:
 * the differences that matter (how JSON is asked for, the shape of an image part, the name of
 * the token limit) are settings.
 *
 * What comes back is untrusted: an HTTP error, a body that is not JSON, an answer that is not
 * the object asked for, a refusal and a cut-off answer all become a result with a problem code.
 * No error message, no response body and no header is ever returned or thrown, so the key cannot
 * leak through one, and neither can whatever a server chose to say.
 */
export function createOpenAiCompatibleAdjudicator(options: OpenAiCompatibleOptions): Adjudicator {
  const { settings } = options;
  const send = options.fetch ?? fetch;
  // Cut to what a timer holds, also for settings that did not come through resolveAdjudication: a
  // longer delay would fire at once, and every call would be a timeout before it was sent.
  const timeoutMs = Math.max(1, Math.min(settings.timeoutMs, MAX_TIMER_MS));
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (options.apiKey !== '') headers['authorization'] = `Bearer ${options.apiKey}`;

  return {
    provider: options.label || OPENAI_COMPATIBLE,
    model: options.model,
    promptVersion: PROMPT_VERSION,
    cacheIdentity: JSON.stringify([
      OPENAI_COMPATIBLE,
      url,
      options.model,
      settings.temperature,
      settings.seed,
      settings.responseFormat,
      settings.maxOutputTokens,
      settings.maxTokensField,
    ]),
    async judge(input, call) {
      const stop = call?.signal;
      // Asked to stop before anything was sent: nothing is.
      if (stop?.aborted) return failed('stopped');
      const controller = new AbortController();
      const onStop = (): void => controller.abort();
      stop?.addEventListener('abort', onStop, { once: true });
      let timedOut = false;
      // The limit covers the whole exchange, the reading of the body included.
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const response = await send(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(chatCompletionsBody(input, options)),
          signal: controller.signal,
          // A redirect could carry page content to another host than the one that was configured.
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return failed('http', RETRYABLE_STATUS.has(response.status));
        }
        const text = await readText(response, settings.maxResponseChars);
        if (text === null) return failed('too-large');
        return readCompletion(text, settings.maxRationaleChars);
      } catch {
        // The error is dropped on purpose: its text can hold the URL, and is of no use in a report.
        // Stopped by the caller: not a failure of the endpoint, and nothing to try again.
        if (stop?.aborted) return failed('stopped');
        return timedOut ? failed('timeout') : failed('network', true);
      } finally {
        clearTimeout(timer);
        stop?.removeEventListener('abort', onStop);
      }
    },
  };
}
