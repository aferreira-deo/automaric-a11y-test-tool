import { readFile, stat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import type { RunConfig } from '@a11y-vision/core';
import { parseSitemap, SitemapError } from './sitemap.js';
import { pageTarget } from './urls.js';
import type { PageTarget } from './urls.js';

/** The list of pages cannot be made: a usage error, said before any page is opened. */
export class InputError extends Error {}

export interface Targets {
  /** Pages to scan, in the order given, each address once. */
  pages: PageTarget[];
  /** For addresses read from the list file: the line each is on (the first one, for a repeated address), by `PageTarget.url`. */
  lines: Map<string, number>;
  otherOrigin: number;
  overLimit: number;
  duplicates: number;
  /** Things the user should know, for stderr. */
  notes: string[];
}

function isHttp(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

async function readBounded(file: string, maxBytes: number, what: string): Promise<Buffer> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    throw new InputError(`Cannot read ${what} ${file}: no such file, or it cannot be opened.`);
  }
  if (size > maxBytes) throw new InputError(`${what} ${file} is larger than ${maxBytes} bytes (run.maxInputBytes).`);
  return readFile(file);
}

/**
 * A list of addresses: one per line. Blank lines and lines that start with `#` are skipped (a
 * `#` further on is part of an address). A line that is not an http(s) address is an error with
 * its line number: a list with a typo in it is not scanned in part.
 */
export function parseUrlList(text: string, file: string): { url: string; line: number }[] {
  const out: { url: string; line: number }[] = [];
  // A byte order mark is not part of the first address.
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\n|\r/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    if (!URL.canParse(line) || !isHttp(new URL(line))) throw new InputError(`${file}, line ${index + 1}: not an http(s) address.`);
    out.push({ url: new URL(line).href, line: index + 1 });
  });
  return out;
}

/** gzip, by its magic number: a `.xml.gz` served as a file is not decoded by the transport. */
function maybeGunzip(bytes: Buffer, maxBytes: number, source: string): Buffer {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  try {
    return gunzipSync(bytes, { maxOutputLength: maxBytes });
  } catch {
    throw new InputError(`The sitemap ${source} is gzip data that cannot be read, or holds more than ${maxBytes} bytes (run.maxInputBytes).`);
  }
}

/** The bytes of a sitemap, and the address they were served from: not the one asked for when the server redirected. */
async function fetchBounded(url: string, limits: RunConfig): Promise<{ bytes: Buffer; servedFrom: string }> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(limits.sitemapTimeoutMs), headers: { accept: 'application/xml, text/xml, */*' } });
  } catch (error) {
    const reason = (error as Error).name === 'TimeoutError' ? `no answer within ${limits.sitemapTimeoutMs} ms` : 'the request failed';
    throw new InputError(`Cannot fetch the sitemap ${url}: ${reason}.`);
  }
  if (!response.ok) throw new InputError(`Cannot fetch the sitemap ${url}: HTTP status ${response.status}.`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > limits.maxInputBytes) throw new InputError(`The sitemap ${url} is larger than ${limits.maxInputBytes} bytes (run.maxInputBytes).`);
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(`Cannot fetch the sitemap ${url}: the answer broke off.`);
  }
  return { bytes: Buffer.concat(chunks), servedFrom: URL.canParse(response.url) ? response.url : url };
}

function parse(bytes: Buffer, source: string, limits: RunConfig, maxLocs: number) {
  const xml = new TextDecoder('utf-8').decode(maybeGunzip(bytes, limits.maxInputBytes, source));
  try {
    return parseSitemap(xml, maxLocs, limits.sitemapMaxDepth);
  } catch (error) {
    if (error instanceof SitemapError) throw new InputError(`${source}: ${error.message}`);
    throw error;
  }
}

export interface SitemapUrls {
  urls: string[];
  otherOrigin: number;
  /** Entries that were there and not kept because `keep` was reached. */
  overLimit: number;
  notes: string[];
}

/**
 * The page addresses of a sitemap, given as an http(s) address or as a file. A sitemap index is
 * followed one level down (the protocol has no deeper one), for at most `run.maxSitemaps`
 * sitemaps, each fetched without cookies or any stored session.
 *
 * With `run.sameOrigin`, entries on another origin than the sitemap are left out and counted: a
 * sitemap is content of the site, and should not be able to send the scan elsewhere. The origin
 * of a sitemap is that of the address it was served from, which after a redirect is not the one
 * that was asked for; the origin of a sitemap read from a file is that of its first entry.
 */
export async function readSitemap(source: string, limits: RunConfig, keep: number): Promise<SitemapUrls> {
  const fromWeb = /^https?:\/\//i.test(source);
  if (fromWeb && !URL.canParse(source)) throw new InputError(`Not a valid sitemap address: ${source}`);
  const fetched = fromWeb ? await fetchBounded(source, limits) : null;
  const top = parse(fetched ? fetched.bytes : await readBounded(source, limits.maxInputBytes, 'the sitemap'), source, limits, Math.max(keep + 1, limits.maxSitemaps + 1));
  const result: SitemapUrls = { urls: [], otherOrigin: 0, overLimit: 0, notes: [] };
  let origin: string | null = fetched ? new URL(fetched.servedFrom).origin : null;
  if (fetched && origin !== new URL(source).origin) result.notes.push(`The sitemap ${source} was served from ${origin} after a redirect: that is the origin its entries are held to.`);
  let invalid = 0;

  /** The entry as an address when it is one that is kept. Sets the origin from the first entry of a file. */
  const accept = (loc: string): string | null => {
    if (!URL.canParse(loc) || !isHttp(new URL(loc))) {
      invalid += 1;
      return null;
    }
    const url = new URL(loc);
    origin ??= url.origin;
    if (limits.sameOrigin && url.origin !== origin) {
      result.otherOrigin += 1;
      return null;
    }
    return url.href;
  };
  const addPages = (parsed: { locs: string[]; total: number }): void => {
    for (const loc of parsed.locs) {
      const url = accept(loc);
      if (url === null) continue;
      if (result.urls.length < keep) result.urls.push(url);
      else result.overLimit += 1;
    }
    // Entries beyond what the tokenizer kept.
    result.overLimit += parsed.total - parsed.locs.length;
  };

  if (top.kind === 'urlset') addPages(top);
  else {
    const children = top.locs.map(accept).filter((url): url is string => url !== null);
    const read = children.slice(0, limits.maxSitemaps);
    const unread = children.length - read.length + (top.total - top.locs.length);
    if (unread > 0) result.notes.push(`The sitemap index ${source} lists more than ${limits.maxSitemaps} sitemaps (run.maxSitemaps): ${unread} of them were not read.`);
    for (const child of read) {
      if (result.urls.length >= keep) {
        result.notes.push(`The limit of pages was reached before the sitemap ${child} was read.`);
        continue;
      }
      const part = await fetchBounded(child, limits);
      // A sitemap of the index that is served from elsewhere is not read: its entries would be held to another origin.
      if (limits.sameOrigin && new URL(part.servedFrom).origin !== origin) {
        result.notes.push(`The sitemap ${child} was served from another origin (${new URL(part.servedFrom).origin}) after a redirect and was not read (--any-origin reads it).`);
        continue;
      }
      const parsed = parse(part.bytes, child, limits, keep + 1);
      if (parsed.kind !== 'urlset') throw new InputError(`${child}: a sitemap index inside a sitemap index, which the protocol does not have.`);
      addPages(parsed);
    }
  }
  if (invalid > 0) result.notes.push(`${invalid} entr(y/ies) of the sitemap ${source} are not http(s) addresses and were left out.`);
  if (result.otherOrigin > 0) result.notes.push(`${result.otherOrigin} entr(y/ies) of the sitemap ${source} are on another origin than ${origin ?? 'its first entry'} and were left out (--any-origin keeps them).`);
  return result;
}

/**
 * An address given on the command line, as `new URL` writes it. Only http(s) is opened: a scan
 * is of a page of a site, and `data:`, `javascript:`, `view-source:`, `chrome:` and the like
 * are not one. A `file:` address reads a file of this machine, so it is opened only when that
 * was asked for with --allow-file-urls. The message never repeats a password.
 */
export function checkedAddress(raw: string, allowFileUrls: boolean): string {
  if (!URL.canParse(raw)) throw new InputError(`Not a valid URL: ${pageless(raw)}`);
  const url = new URL(raw);
  if (isHttp(url)) return url.href;
  if (url.protocol === 'file:') {
    if (allowFileUrls) return url.href;
    throw new InputError(`${pageless(raw)} is not an http(s) address. A file of this machine is only scanned with --allow-file-urls.`);
  }
  throw new InputError(`${pageless(raw)} is not an http(s) address: the scheme "${url.protocol}" is not scanned.`);
}

/** What was typed, cut short and without what stands before an "@": enough to recognise it in a message. */
function pageless(raw: string): string {
  const shown = raw.replace(/\/\/[^/?#\s]*@/, '//');
  return shown.length > 120 ? `${shown.slice(0, 120)}…` : shown;
}

/**
 * The pages of a run: the addresses given on the command line, then those of the list file,
 * then those of the sitemap, each once. More than `run.maxUrls` given by hand is an error; a
 * sitemap is cut at what is left of the limit, and the cut is said.
 */
export async function collectTargets(given: { positionals: string[]; urlsFile?: string; sitemap?: string; allowFileUrls?: boolean }, limits: RunConfig): Promise<Targets> {
  const targets: Targets = { pages: [], lines: new Map(), otherOrigin: 0, overLimit: 0, duplicates: 0, notes: [] };
  const seen = new Set<string>();
  /** Adds the page of an address, unless it was given before. The address as given is never kept: see urls.ts. */
  const add = (href: string, fromSitemap = false): PageTarget | null => {
    if (seen.has(href)) {
      targets.duplicates += 1;
      return null;
    }
    seen.add(href);
    const page = pageTarget(href, limits.redactQueryParams, fromSitemap);
    targets.pages.push(page);
    return page;
  };

  for (const raw of given.positionals) add(checkedAddress(raw, given.allowFileUrls === true));
  if (given.urlsFile !== undefined) {
    const text = new TextDecoder('utf-8').decode(await readBounded(given.urlsFile, limits.maxInputBytes, 'the list of addresses'));
    const listed = parseUrlList(text, given.urlsFile);
    if (listed.length === 0) throw new InputError(`The list of addresses ${given.urlsFile} holds no address.`);
    for (const { url, line } of listed) {
      const shown = pageTarget(url, limits.redactQueryParams).url;
      if (!targets.lines.has(shown)) targets.lines.set(shown, line);
      add(url);
    }
  }
  if (targets.pages.length > limits.maxUrls) {
    throw new InputError(`${targets.pages.length} addresses were given and a run scans at most ${limits.maxUrls} (--max-urls or run.maxUrls raises the limit).`);
  }
  if (given.sitemap !== undefined) {
    const room = limits.maxUrls - targets.pages.length;
    const fromSitemap = await readSitemap(given.sitemap, limits, room);
    let added = 0;
    for (const url of fromSitemap.urls) if (add(url, true)) added += 1;
    targets.otherOrigin = fromSitemap.otherOrigin;
    targets.overLimit = fromSitemap.overLimit;
    targets.notes.push(...fromSitemap.notes);
    if (fromSitemap.overLimit > 0) {
      targets.notes.push(`The sitemap lists more pages than the limit of ${limits.maxUrls} for a run: ${fromSitemap.overLimit} were NOT scanned (--max-urls or run.maxUrls raises the limit).`);
    }
    if (added === 0 && targets.pages.length === 0) throw new InputError(`The sitemap ${given.sitemap} gave no address to scan.`);
  }
  return targets;
}
