import { lookup as systemLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import type { AdjudicationConfig } from '@a11y-vision/core';
import { AdjudicationConfigError, isLoopbackAddress, isLoopbackHost } from './provider.js';
import type { LookupAll } from './provider.js';

export type { LookupAll } from './provider.js';

/**
 * The Node half of "an endpoint on this machine stays on this machine". Node only: this file is
 * loaded by `createAdjudicator` when it runs in Node, and by nothing that runs elsewhere.
 *
 * Two things the global `fetch` cannot promise are done here with `node:http`:
 *
 * 1. No proxy. With NODE_USE_ENV_PROXY=1 or --use-env-proxy, Node sends `fetch` and the requests
 *    of the default agent through HTTP_PROXY / HTTPS_PROXY, loopback addresses included unless
 *    NO_PROXY lists them: page text, captures and the key would go to the proxy. `fetch` has no
 *    built-in way to opt one request out. An agent made here, without the `proxyEnv` option, is
 *    not subject to those variables (checked on Node 24.20 with both switches; the documentation
 *    of `http.Agent` describes proxy support as belonging to the global agent and to agents
 *    given `proxyEnv`).
 * 2. The address is checked when it is used. A name (`localhost`, `*.localhost`) is resolved by
 *    the lookup of the request itself; if any address it gives is not loopback the request is
 *    not made, and the connection goes to an address from that same answer. There is no second
 *    resolution between the check and the connection for a rebinding resolver to answer
 *    differently.
 */

const resolveAll: LookupAll = (hostname) => systemLookup(hostname, { all: true });

/** The host of a URL as `node:net` wants it: an IPv6 address without its brackets, a name without a trailing dot. */
function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** The addresses of `hostname`, all of them loopback, or an error that says which one is not. */
async function loopbackAddresses(hostname: string, lookup: LookupAll): Promise<{ address: string; family: number }[]> {
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname);
  } catch {
    addresses = [];
  }
  if (addresses.length === 0) throw new Error(`${hostname} could not be resolved`);
  const outside = addresses.find((entry) => !isLoopbackAddress(entry.address));
  if (outside) throw new Error(`${hostname} resolves to ${outside.address}, which is not this machine`);
  return addresses;
}

/**
 * A `fetch` for one purpose: POST a string to an http or https URL whose host is this machine,
 * and give back the response. It follows no redirect (a 3xx is an error, as with
 * `redirect: 'error'`), uses no proxy, and connects to loopback addresses only.
 */
export function createLoopbackFetch(options: { lookup?: LookupAll } = {}): typeof fetch {
  const lookup = options.lookup ?? resolveAll;
  // Agents of our own: the global ones are what the proxy switches of Node reconfigure.
  const agents = { 'http:': new http.Agent({ keepAlive: false }), 'https:': new https.Agent({ keepAlive: false }) };
  const pinned: LookupFunction = (hostname, lookupOptions, callback) => {
    loopbackAddresses(hostname, lookup).then(
      (addresses) => {
        if (lookupOptions.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (error: Error) => callback(error as NodeJS.ErrnoException, '', 0),
    );
  };

  const send = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Not an http or https URL.');
      const host = bareHost(url.hostname);
      // An address is checked here; a name is checked by the lookup of the request.
      if (isIP(host) !== 0 && !isLoopbackAddress(host)) throw new Error(`${host} is not this machine`);
      const request = (url.protocol === 'https:' ? https : http).request(
        {
          protocol: url.protocol,
          host,
          port: url.port === '' ? undefined : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: init.method ?? 'GET',
          headers: init.headers as Record<string, string>,
          agent: agents[url.protocol],
          lookup: pinned,
          ...(init.signal ? { signal: init.signal } : {}),
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status > 599 || (status >= 300 && status < 400)) {
            response.destroy();
            reject(new Error(status >= 300 && status < 400 ? 'The endpoint answered with a redirect.' : 'The endpoint answered with a status that is not one.'));
            return;
          }
          const empty = status === 204 || status === 205;
          if (empty) response.resume();
          resolve(new Response(empty ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), { status }));
        },
      );
      request.on('error', reject);
      request.end(typeof init.body === 'string' ? init.body : undefined);
    });
  return send;
}

/**
 * Checks, before a scan starts, that the endpoint of a configuration is where its name says:
 * for a host accepted as this machine by name (`localhost`, a name under `.localhost`), every
 * address it resolves to has to be loopback. Throws `AdjudicationConfigError` otherwise, with the
 * host and the address in the message (neither is a secret).
 *
 * This is the early, readable refusal. The enforcement is in the requests themselves
 * (`createLoopbackFetch`), which check the address again each time they connect.
 * Nothing is resolved for an IP address, for a remote host (those need `allowRemote` and https,
 * see `createAdjudicator`) or when no provider is configured.
 */
export async function verifyEndpoint(config: AdjudicationConfig, options: { lookup?: LookupAll } = {}): Promise<void> {
  if (config.provider === 'none' || !URL.canParse(config.baseUrl)) return;
  const host = bareHost(new URL(config.baseUrl).hostname);
  if (isIP(host) !== 0 || !isLoopbackHost(host)) return;
  try {
    await loopbackAddresses(host, options.lookup ?? resolveAll);
  } catch (error) {
    throw new AdjudicationConfigError(
      `The model endpoint is configured as ${host}, a name for this machine, but ${(error as Error).message}. Nothing is sent to it. Use an address (127.0.0.1, [::1]) or fix what the name resolves to.`,
    );
  }
}
