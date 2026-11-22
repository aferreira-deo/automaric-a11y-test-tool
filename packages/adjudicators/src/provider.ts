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

/** All addresses of a host name, as `dns.lookup` with `all: true` gives them. Replaceable in tests. */
export type LookupAll = (hostname: string) => Promise<{ address: string; family: number }[]>;

/** Whether an IP address is a loopback address: 127.0.0.0/8 or ::1. Not a name, not 0.0.0.0, not a LAN address. */
export function isLoopbackAddress(address: string): boolean {
  const text = address.replace(/^\[|\]$/g, '');
  const v4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) return v4.slice(1).every((part) => Number(part) <= 255);
  return text === '::1' || /^(0{1,4}:){7}0{0,3}1$/.test(text);
}

/**
 * Whether a host is this machine as far as its text goes: a loopback address, `localhost`, or a
 * name under `.localhost`. For a name this is a claim, not a fact: what the name resolves to is
 * checked where the network is used (`verifyEndpoint` before a scan and the transport at every
 * connection, both in `loopback-fetch.ts`).
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || isLoopbackAddress(host);
}

/** True in Node, false in a browser or a service worker. */
function inNode(): boolean {
  return typeof (globalThis as { process?: { versions?: { node?: unknown } } }).process?.versions?.node === 'string';
}

/**
 * What sends requests to an endpoint on this machine when the caller gave no `fetch`.
 *
 * In Node that is not the global `fetch`: Node can be told by the environment to send `fetch`
 * through a proxy (NODE_USE_ENV_PROXY, --use-env-proxy), loopback included, and `fetch` resolves
 * a name without saying to what. The transport of `loopback-fetch.ts` uses no proxy and connects
 * to loopback addresses only. It is loaded on first use, so that this module has no import that
 * only Node can satisfy.
 *
 * Outside Node (an extension service worker) the global `fetch` is all there is. Browsers resolve
 * `localhost` to loopback themselves and do not proxy it by default; that is their guarantee, not
 * one this code adds.
 */
function loopbackSender(lookup: LookupAll | undefined): typeof fetch {
  if (!inNode()) return fetch;
  let loaded: Promise<typeof fetch> | undefined;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    loaded ??= import('./loopback-fetch.js').then((module) => module.createLoopbackFetch(lookup ? { lookup } : {}));
    return (await loaded)(input, init);
  });
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
 *
 * Where requests may go:
 * - This machine (a loopback address, `localhost`, a name under `.localhost`), over http or
 *   https. In Node the requests use no proxy and connect to loopback addresses only, whatever the
 *   name resolves to (see `loopbackSender`).
 * - Another machine only with `allowRemote`, and only over https: over plain http the page text,
 *   the captures and the key would cross the network in the clear. Such requests use the global
 *   `fetch`, and so the proxy of the environment if Node was told to use one: that is the
 *   network path the user configured for remote hosts.
 *
 * `options.fetch` replaces the sender (tests), `options.lookup` the resolver of the loopback
 * transport (tests), `options.nonce` the source of the prompt marker (tests).
 */
export function createAdjudicator(
  config: AdjudicationConfig,
  env: Env,
  options: { fetch?: typeof fetch; lookup?: LookupAll; nonce?: () => string } = {},
): Adjudicator | null {
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
  const local = isLoopbackHost(url.hostname);
  if (!local && !config.allowRemote) {
    throw new AdjudicationConfigError(
      `The model endpoint is on ${url.hostname}, which is not this machine. Page text and captures would be sent there, so this has to be allowed explicitly (adjudication.allowRemote, --ai-allow-remote).`,
    );
  }
  if (!local && url.protocol !== 'https:') {
    throw new AdjudicationConfigError(
      `The model endpoint on ${url.hostname} is on another machine and its URL is plain http: page text, captures and the API key would travel unencrypted. An endpoint that is not on this machine has to be an https URL.`,
    );
  }
  const apiKey = readKey(config, env);
  const send = options.fetch ?? (local ? loopbackSender(options.lookup) : undefined);
  return createOpenAiCompatibleAdjudicator({
    baseUrl: url.href,
    model: config.model,
    apiKey,
    label: config.providerLabel,
    settings: config,
    ...(send ? { fetch: send } : {}),
    ...(options.nonce ? { nonce: options.nonce } : {}),
  });
}
