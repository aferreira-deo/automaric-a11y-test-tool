import type { AdjudicationConfig } from '@a11y-vision/core';
import { createOpenAiCompatibleAdjudicator } from './openai-compatible.js';
import type { Adjudicator } from './types.js';

/** A configuration that cannot be used. Its message names settings and variables, never a value of a key. */
export class AdjudicationConfigError extends Error {
  override name = 'AdjudicationConfigError';
}

/** Environment variables, as `process.env` has them. Passed in: this package reads no global state. */
export type Env = Readonly<Record<string, string | undefined>>;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether a host is this machine: `localhost`, a name under `.localhost`, 127.0.0.0/8 or ::1. A LAN address is not. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(host) || host === '[::1]' || host === '::1';
}

/** The key the configuration points at, or an empty string when it names no variable. */
function readKey(config: AdjudicationConfig, env: Env): string {
  if (config.apiKeyEnv === '') return '';
  if (!ENV_NAME.test(config.apiKeyEnv)) {
    // Not echoed: someone may have put the key itself where the name of the variable goes.
    throw new AdjudicationConfigError('apiKeyEnv has to be the NAME of an environment variable (letters, digits and underscores), not a key.');
  }
  const key = env[config.apiKeyEnv];
  if (key === undefined || key.trim() === '') {
    throw new AdjudicationConfigError(`The environment variable ${config.apiKeyEnv}, named as the holder of the API key, is not set or is empty.`);
  }
  return key.trim();
}

/**
 * The values that must never show in any output of a run: the key. Callers pass them to `redact`
 * for anything they print that they did not write themselves.
 */
export function secretsOf(config: AdjudicationConfig, env: Env): string[] {
  if (config.provider === 'none') return [];
  try {
    const key = readKey(config, env);
    return key === '' ? [] : [key];
  } catch {
    return [];
  }
}

/** `text` with every secret replaced. The last line of defence, not the first: nothing here puts a key into text. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== '') out = out.replaceAll(secret, '[redacted]');
  }
  return out;
}

/**
 * The adjudicator a configuration describes, or null when it describes none (`provider: 'none'`,
 * the default): then nothing is created, nothing is read from the environment and nothing is sent.
 *
 * Throws `AdjudicationConfigError` for a configuration that names a provider and cannot be used.
 * A scan is not started with half a provider: silently going on without the model would hide
 * that the results are not the adjudicated ones that were asked for.
 */
export function createAdjudicator(config: AdjudicationConfig, env: Env, options: { fetch?: typeof fetch } = {}): Adjudicator | null {
  if (config.provider === 'none') return null;
  if (config.baseUrl === '') throw new AdjudicationConfigError('A model provider is configured without a base URL (adjudication.baseUrl). No endpoint is assumed.');
  if (config.model === '') throw new AdjudicationConfigError('A model provider is configured without a model name (adjudication.model). No model is assumed.');
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new AdjudicationConfigError('adjudication.baseUrl is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AdjudicationConfigError('adjudication.baseUrl has to be an http or https URL.');
  if (url.username !== '' || url.password !== '') {
    throw new AdjudicationConfigError('adjudication.baseUrl must not carry credentials. Put the key in an environment variable and name that variable in apiKeyEnv.');
  }
  if (url.search !== '' || url.hash !== '') throw new AdjudicationConfigError('adjudication.baseUrl must not have a query string or a fragment.');
  if (!config.allowRemote && !isLoopbackHost(url.hostname)) {
    throw new AdjudicationConfigError(
      `The model endpoint is on ${url.hostname}, which is not this machine. Page text and captures would be sent there, so this has to be allowed explicitly (adjudication.allowRemote, --ai-allow-remote).`,
    );
  }
  const apiKey = readKey(config, env);
  return createOpenAiCompatibleAdjudicator({
    baseUrl: url.href,
    model: config.model,
    apiKey,
    label: config.providerLabel,
    settings: config,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
