import { withoutUserinfo } from '@a11y-vision/core';

/**
 * Addresses, as they are opened and as they are written. An address may carry a user name and a
 * password (`https://user:password@host/`) and values in its query that are secrets
 * (`?token=...`). The browser needs them; no report, baseline, SARIF file, message or directory
 * name does. So every page of a run has two forms: the one that is opened, and the one that is
 * written, and nothing but `openPage` in main.ts ever sees the first.
 */

/** What is put in the place of the value of a query parameter that is not written. */
export const REDACTED_VALUE = 'redacted';

export interface PageTarget {
  /** The address as it is written everywhere: no user name, no password, secret query values replaced. */
  url: string;
  /** The address the browser opens: as given, without the user name and password. */
  address: string;
  /** The user name and password of the address, given to the browser for this origin only. */
  credentials?: { username: string; password: string; origin: string };
  /** From a sitemap: held to its origin when `run.sameOrigin` is on. */
  fromSitemap: boolean;
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The address with the value of each named query parameter replaced. Works on the text, so that
 * nothing else of the address is written another way than it was given. Names are compared
 * without regard to case, as given and decoded.
 */
export function redactQuery(href: string, names: readonly string[]): string {
  const queryAt = href.indexOf('?');
  if (queryAt === -1 || names.length === 0) return href;
  const hashAt = href.indexOf('#');
  if (hashAt !== -1 && hashAt < queryAt) return href;
  const end = hashAt === -1 ? href.length : hashAt;
  const secret = new Set(names.map((name) => name.toLowerCase()));
  const query = href
    .slice(queryAt + 1, end)
    .split('&')
    .map((part) => {
      const equals = part.indexOf('=');
      if (equals === -1) return part;
      const name = part.slice(0, equals);
      return secret.has(name.toLowerCase()) || secret.has(decoded(name.replaceAll('+', ' ')).toLowerCase()) ? `${name}=${REDACTED_VALUE}` : part;
    })
    .join('&');
  return `${href.slice(0, queryAt + 1)}${query}${href.slice(end)}`;
}

/** The address as it may be written: see `PageTarget.url`. */
export function publicUrl(href: string, redactParams: readonly string[]): string {
  return redactQuery(withoutUserinfo(href), redactParams);
}

/** Every address in a text, as it may be written: for messages that quote an address (an error of the browser does). */
export function scrubAddresses(text: string, redactParams: readonly string[]): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (address) => publicUrl(address, redactParams));
}

/** The two forms of an address that `new URL` can parse. */
export function pageTarget(href: string, redactParams: readonly string[], fromSitemap = false): PageTarget {
  const url = new URL(href);
  const { username, password } = url;
  url.username = '';
  url.password = '';
  const address = url.href;
  return {
    url: redactQuery(address, redactParams),
    address,
    ...(username !== '' || password !== '' ? { credentials: { username: decoded(username), password: decoded(password), origin: url.origin } } : {}),
    fromSitemap,
  };
}
