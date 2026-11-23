import { AdjudicationConfigError, createAdjudicator, isLoopbackHost, redact } from '@a11y-vision/adjudicators';
import type { Adjudicator } from '@a11y-vision/adjudicators';
import { resolveAdjudication } from '@a11y-vision/core';
import type { AdjudicationConfig, CheckId } from '@a11y-vision/core';
import type { PermissionsApi, StorageArea } from './chrome-api.js';
import type { ExtensionConfig } from './config.js';

/** The checks the panel offers, in the order it lists them. */
export const CHECKS: readonly CheckId[] = ['focus-indicator', 'icon-contrast', 'headings', 'lists', 'grouping'];

/** The model endpoint, as the user configured it. The key is not part of it: see `SettingsStore`. */
export interface ModelSettings {
  /** Off unless the user switches it on: with it off nothing is asked and nothing is sent. */
  enabled: boolean;
  /** Base URL of an OpenAI-compatible endpoint, up to `/v1`. */
  baseUrl: string;
  model: string;
  /** Allow an endpoint that is not on this machine. It then has to be https. */
  allowRemote: boolean;
  /** False for a model without vision: no capture is sent. */
  sendImages: boolean;
}

export interface Settings {
  checks: CheckId[];
  groupBy: 'status' | 'check';
  model: ModelSettings;
}

export const SETTINGS_KEY = 'settings';
/** The key of the API key in `chrome.storage.local`. Kept apart from the settings: nothing that reads or exports settings touches it. */
export const API_KEY_STORAGE_KEY = 'secret.apiKey';
/**
 * The adjudicator layer reads the key from an environment by the NAME of a variable, so that a
 * key is never part of a configuration. Here the environment is an object made for one scan,
 * with the key under this name.
 */
const KEY_VARIABLE = 'A11Y_VISION_EXTENSION_KEY';

export function defaultSettings(extension: ExtensionConfig): Settings {
  return {
    checks: [...CHECKS],
    groupBy: 'status',
    model: { enabled: false, baseUrl: '', model: '', allowRemote: extension.openDecisions.allowRemoteByDefault, sendImages: true },
  };
}

/** What storage gave, checked field by field. Anything that is not a usable value is the default. */
export function parseSettings(value: unknown, extension: ExtensionConfig): Settings {
  const settings = defaultSettings(extension);
  if (value === null || typeof value !== 'object') return settings;
  const stored = value as { checks?: unknown; groupBy?: unknown; model?: unknown };
  if (Array.isArray(stored.checks)) {
    const checks = CHECKS.filter((check) => (stored.checks as unknown[]).includes(check));
    if (checks.length > 0) settings.checks = checks;
  }
  if (stored.groupBy === 'check') settings.groupBy = 'check';
  if (stored.model !== null && typeof stored.model === 'object') {
    const model = stored.model as Record<string, unknown>;
    const text = (name: string, max: number): string => (typeof model[name] === 'string' ? model[name].trim().slice(0, max) : '');
    settings.model = {
      enabled: model['enabled'] === true,
      baseUrl: text('baseUrl', extension.settings.maxUrlChars),
      model: text('model', extension.settings.maxModelChars),
      allowRemote: model['allowRemote'] === true,
      sendImages: model['sendImages'] !== false,
    };
  }
  return settings;
}

export type EndpointProblem =
  | 'endpointMissing'
  | 'modelMissing'
  | 'endpointInvalid'
  | 'endpointScheme'
  | 'endpointCredentials'
  | 'endpointQuery'
  | 'endpointRemoteNotAllowed'
  | 'endpointRemoteHttp'
  | 'endpointHttpLoopbackForm';

export type EndpointCheck =
  | {
      ok: true;
      /** True when the host is this machine as far as its text goes (a loopback address, `localhost`, a name under `.localhost`). */
      local: boolean;
      host: string;
      /** The match pattern of exactly this origin, to ask the host permission for. */
      pattern: string;
    }
  | { ok: false; problem: EndpointProblem };

type HttpHosts = ExtensionConfig['endpoint'];

/** Whether `hostname` (as `URL` gives it: lower case, an IPv4 address in its usual form) is one of the hosts reachable over plain http. */
export function httpHostAllowed(hostname: string, endpoint: HttpHosts): boolean {
  return endpoint.httpHosts.some((host) => (host.startsWith('*.') ? hostname.endsWith(host.slice(1)) && hostname.length > host.length - 1 : hostname === host));
}

/** `connect-src` of the content security policy of the extension pages: the http hosts on any port, and https anywhere. */
export function connectSources(endpoint: HttpHosts): string[] {
  return [...endpoint.httpHosts.map((host) => `http://${host}:*`), 'https:'];
}

/** `optional_host_permissions` of the manifest: what a permission may be asked for. A match pattern without a port is every port. */
export function hostPermissionPatterns(endpoint: HttpHosts): string[] {
  return [...endpoint.httpHosts.map((host) => `http://${host}/*`), 'https://*/*'];
}

/**
 * Whether the endpoint may be used, by the rules of the CLI: this machine over http or https,
 * another machine only when allowed and only over https. Said here so that the panel can show a
 * sentence of its own; `createAdjudicator` enforces the same rules again when a scan starts.
 *
 * One rule more than the CLI has: over plain http the host has to be one the extension can
 * reach at all (`endpoint.httpHosts`). `[::1]`, `localhost.` and `127.0.0.2` are this machine
 * too, but the content security policy of the extension pages cannot name them, and a request
 * to them would fail as a network error that says nothing.
 */
export function checkEndpoint(model: Pick<ModelSettings, 'baseUrl' | 'model' | 'allowRemote'>, endpoint: HttpHosts): EndpointCheck {
  if (model.baseUrl.trim() === '') return { ok: false, problem: 'endpointMissing' };
  if (model.model.trim() === '') return { ok: false, problem: 'modelMissing' };
  let url: URL;
  try {
    url = new URL(model.baseUrl.trim());
  } catch {
    return { ok: false, problem: 'endpointInvalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, problem: 'endpointScheme' };
  if (url.username !== '' || url.password !== '') return { ok: false, problem: 'endpointCredentials' };
  if (url.search !== '' || url.hash !== '') return { ok: false, problem: 'endpointQuery' };
  const local = isLoopbackHost(url.hostname);
  if (!local && !model.allowRemote) return { ok: false, problem: 'endpointRemoteNotAllowed' };
  if (!local && url.protocol !== 'https:') return { ok: false, problem: 'endpointRemoteHttp' };
  if (url.protocol === 'http:' && !httpHostAllowed(url.hostname, endpoint)) return { ok: false, problem: 'endpointHttpLoopbackForm' };
  // `url.host` carries the port when it is not the default one: the pattern is this origin and no other.
  return { ok: true, local, host: url.hostname, pattern: `${url.protocol}//${url.host}/*` };
}

/** What saving model settings does to host permissions: the pattern to ask for, and the one to give up. */
export interface PermissionChange {
  request: string | null;
  remove: string | null;
}

/**
 * The host permission is for the origin of the endpoint in use, and for nothing else: when the
 * origin changes, or the model is switched off, the one that was asked for before is given up.
 * `before` counts whether or not the model was on: an access left from an earlier save goes too.
 */
export function endpointPermissionChange(before: ModelSettings, after: ModelSettings, endpoint: HttpHosts): PermissionChange {
  const patternOf = (model: ModelSettings): string | null => {
    const checked = checkEndpoint(model, endpoint);
    return checked.ok ? checked.pattern : null;
  };
  const request = after.enabled ? patternOf(after) : null;
  const held = patternOf(before);
  return { request, remove: held !== null && held !== request ? held : null };
}

/**
 * Carries a `PermissionChange` out. To be called inside the click that saves: Chrome shows its
 * question only then. Nothing here rejects; `granted` and `removed` are null when there was
 * nothing to ask for or to give up, and false when Chrome said no or failed.
 */
export function applyPermissionChange(permissions: PermissionsApi, change: PermissionChange): { granted: Promise<boolean> | null; removed: Promise<boolean> | null } {
  const no = (): boolean => false;
  const { request, remove } = change;
  const granted = request === null ? null : permissions.contains({ origins: [request] }).then((has) => has || permissions.request({ origins: [request] })).catch(no);
  const removed = remove === null ? null : permissions.remove({ origins: [remove] }).catch(no);
  return { granted, removed };
}

/** The settings of the adjudicator layer for these settings; `provider: 'none'` when the model is off. */
export function adjudicationFor(model: ModelSettings, hasKey: boolean): AdjudicationConfig {
  if (!model.enabled) return resolveAdjudication({ provider: 'none' });
  return resolveAdjudication({
    provider: 'openai-compatible',
    baseUrl: model.baseUrl,
    model: model.model,
    allowRemote: model.allowRemote,
    sendImages: model.sendImages,
    apiKeyEnv: hasKey ? KEY_VARIABLE : '',
  });
}

/**
 * The adjudicator for these settings, or null when the model is off. Throws
 * `AdjudicationConfigError` for settings that cannot be used: a scan is not run half configured.
 *
 * `send` is the `fetch` of the context this runs in, an extension page: requests leave from the
 * extension, never from the page under test, and carry no cookies.
 */
export function buildAdjudicator(model: ModelSettings, apiKey: string, send: typeof fetch): { adjudicator: Adjudicator | null; config: AdjudicationConfig } {
  const config = adjudicationFor(model, apiKey !== '');
  const adjudicator = createAdjudicator(config, { [KEY_VARIABLE]: apiKey }, { fetch: (input, init) => send(input, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' }) });
  return { adjudicator, config };
}

/** A message that may be shown or logged: the key, should it be in there, is taken out. */
export function safeMessage(error: unknown, apiKey: string): string {
  const text = error instanceof AdjudicationConfigError || error instanceof Error ? error.message : 'Unknown error';
  return redact(text, apiKey === '' ? [] : [apiKey]);
}

/**
 * Settings and the API key in `chrome.storage.local`: on this machine, in the browser profile,
 * not synced (`storage.sync` is never used) and not encrypted by the extension. The key has an
 * item of its own and is only ever read by `readKey`, for the request header.
 */
export class SettingsStore {
  readonly #area: StorageArea;
  readonly #extension: ExtensionConfig;

  constructor(area: StorageArea, extension: ExtensionConfig) {
    this.#area = area;
    this.#extension = extension;
  }

  async load(): Promise<Settings> {
    return parseSettings((await this.#area.get(SETTINGS_KEY))[SETTINGS_KEY], this.#extension);
  }

  async save(settings: Settings): Promise<void> {
    // Written field by field: whatever else an object passed in may carry is not stored.
    const { checks, groupBy, model } = settings;
    await this.#area.set({
      [SETTINGS_KEY]: {
        checks: [...checks],
        groupBy,
        model: { enabled: model.enabled, baseUrl: model.baseUrl, model: model.model, allowRemote: model.allowRemote, sendImages: model.sendImages },
      },
    });
  }

  async hasKey(): Promise<boolean> {
    return (await this.readKey()) !== '';
  }

  async readKey(): Promise<string> {
    const value = (await this.#area.get(API_KEY_STORAGE_KEY))[API_KEY_STORAGE_KEY];
    return typeof value === 'string' ? value : '';
  }

  async setKey(key: string): Promise<void> {
    const trimmed = key.trim().slice(0, this.#extension.settings.maxKeyChars);
    if (trimmed === '') await this.clearKey();
    else await this.#area.set({ [API_KEY_STORAGE_KEY]: trimmed });
  }

  async clearKey(): Promise<void> {
    await this.#area.remove(API_KEY_STORAGE_KEY);
  }
}
