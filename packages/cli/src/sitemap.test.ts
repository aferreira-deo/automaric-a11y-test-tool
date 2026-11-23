import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '@a11y-vision/core';
import { collectTargets, InputError, parseUrlList, readSitemap } from './inputs.js';
import { pageDirectory, summaryLines } from './main.js';
import { parseSitemap, SitemapError } from './sitemap.js';

const NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
const urlset = (...locs: string[]): string => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset ${NS}>${locs.map((loc) => `<url><loc>${loc}</loc><lastmod>2026-01-01</lastmod></url>`).join('\n')}</urlset>\n`;

describe('parseSitemap', () => {
  it('reads the addresses of a urlset in order, with entities, CDATA, comments and white space', () => {
    const xml = `<?xml version="1.0"?><!-- a comment with <loc>https://no.test/</loc> -->
<urlset ${NS} xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url><loc> https://example.test/a?x=1&amp;y=2 </loc>
    <image:image><image:loc>https://example.test/picture.png</image:loc></image:image></url>
  <url><loc><![CDATA[https://example.test/b?x=1&y=2]]></loc></url>
  <url><loc>https://example.test/caf&#233;&#x2F;</loc><priority>0.5</priority></url>
  <url a=">" b='<loc>'><loc>https://example.test/d</loc></url>
</urlset>`;
    expect(parseSitemap(xml, 100)).toEqual({
      kind: 'urlset',
      total: 4,
      locs: ['https://example.test/a?x=1&y=2', 'https://example.test/b?x=1&y=2', 'https://example.test/café/', 'https://example.test/d'],
    });
  });

  it('reads a sitemap index, and only the loc of its sitemap entries', () => {
    const xml = `<sitemapindex ${NS}><sitemap><loc>https://example.test/s1.xml</loc></sitemap><url><loc>https://example.test/not-here</loc></url><sitemap><loc>https://example.test/s2.xml.gz</loc></sitemap></sitemapindex>`;
    expect(parseSitemap(xml, 100)).toEqual({ kind: 'sitemapindex', total: 2, locs: ['https://example.test/s1.xml', 'https://example.test/s2.xml.gz'] });
  });

  it('keeps no more than the limit and still counts', () => {
    expect(parseSitemap(urlset('https://example.test/1', 'https://example.test/2', 'https://example.test/3'), 2)).toMatchObject({ total: 3, locs: ['https://example.test/1', 'https://example.test/2'] });
  });

  it.each([
    ['a document type declaration', `<!DOCTYPE urlset [<!ENTITY x "y">]><urlset><url><loc>&x;</loc></url></urlset>`, /document type declaration/],
    ['an external entity', `<!DOCTYPE urlset [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><urlset><url><loc>&xxe;</loc></url></urlset>`, /document type declaration/],
    ['an entity that XML does not predefine', `<urlset><url><loc>https://example.test/&nbsp;</loc></url></urlset>`, /entity "&nbsp;"/],
    ['a bare ampersand', `<urlset><url><loc>https://example.test/?a=1&b=2</loc></url></urlset>`, /not a character reference|entity/],
    ['another root element', `<html><body><loc>https://example.test/</loc></body></html>`, /root element is <html>/],
    ['an element inside loc', `<urlset><url><loc>https://example.test/<b>x</b></loc></url></urlset>`, /inside <loc>/],
    ['tags that do not match', `<urlset><url><loc>https://example.test/</loc></urlset>`, /closes nothing/],
    ['a document that breaks off', `<urlset><url><loc>https://example.test/`, /not closed/],
    ['a tag that breaks off', `<urlset><url a="`, /not closed/],
    ['a second root', `<urlset></urlset><urlset></urlset>`, /second root/],
    ['an empty document', ``, /no root element/],
    ['text and no XML', `https://example.test/`, /text outside/],
    ['a character reference out of range', `<urlset><url><loc>&#x110000;</loc></url></urlset>`, /entity/],
  ])('refuses %s', (_name, xml, message) => {
    expect(() => parseSitemap(xml, 10)).toThrow(SitemapError);
    expect(() => parseSitemap(xml, 10)).toThrow(message);
  });

  it('refuses deep nesting instead of following it', () => {
    expect(() => parseSitemap(`<urlset>${'<a>'.repeat(40)}`, 10)).toThrow(/nested more than/);
  });

  it('reads a large sitemap in time that grows with its size', () => {
    const locs = Array.from({ length: 50000 }, (_, index) => `https://example.test/page/${index}`);
    const started = Date.now();
    expect(parseSitemap(urlset(...locs), 50000).locs).toHaveLength(50000);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('parseUrlList', () => {
  it('reads one address per line, with comments, blank lines, a BOM and CRLF, and keeps the line numbers', () => {
    const text = '﻿# pages\r\nhttps://example.test/a\r\n\r\n   https://example.test/b#part  \n#https://example.test/skipped\nHTTP://EXAMPLE.test';
    expect(parseUrlList(text, 'urls.txt')).toEqual([
      { url: 'https://example.test/a', line: 2 },
      { url: 'https://example.test/b#part', line: 4 },
      { url: 'http://example.test/', line: 6 },
    ]);
  });

  it('refuses the whole list for one line that is not an address, and names the line', () => {
    expect(() => parseUrlList('https://example.test/\nexample.test/b\n', 'urls.txt')).toThrow(/urls\.txt, line 2/);
    expect(() => parseUrlList('file:///etc/passwd\n', 'urls.txt')).toThrow(InputError);
  });
});

describe('sitemaps and lists from files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a11y-vision-inputs-'));
  const limits = { ...defaultConfig.run };
  const file = (name: string, content: string | Uint8Array): string => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };

  it('keeps the entries on the origin of the first one, counts the others, and reads gzip', async () => {
    const xml = urlset('https://example.test/a', 'https://other.test/b', 'ftp://example.test/c', 'https://example.test/d');
    for (const path of [file('sitemap.xml', xml), file('sitemap.xml.gz', gzipSync(xml))]) {
      const read = await readSitemap(path, limits, 10);
      expect(read.urls).toEqual(['https://example.test/a', 'https://example.test/d']);
      expect(read.otherOrigin).toBe(1);
      expect(read.notes.join('\n')).toMatch(/1 entr\(y\/ies\).*not http\(s\) addresses/);
      expect(read.notes.join('\n')).toContain('--any-origin');
    }
    expect((await readSitemap(file('sitemap.xml', xml), { ...limits, sameOrigin: false }, 10)).urls).toHaveLength(3);
  });

  it('cuts at the limit and says how many were left', async () => {
    const path = file('long.xml', urlset(...Array.from({ length: 9 }, (_, index) => `https://example.test/${index}`)));
    const targets = await collectTargets({ positionals: ['https://example.test/first'], sitemap: path }, { ...limits, maxUrls: 4 });
    expect(targets.urls).toEqual(['https://example.test/first', 'https://example.test/0', 'https://example.test/1', 'https://example.test/2']);
    expect(targets.overLimit).toBe(6);
    expect(targets.notes.join('\n')).toContain('6 were NOT scanned');
  });

  it('bounds what it reads: a file over the size limit and a gzip that inflates over it are refused', async () => {
    const xml = urlset(...Array.from({ length: 2000 }, (_, index) => `https://example.test/${index}`));
    await expect(readSitemap(file('big.xml', xml), { ...limits, maxInputBytes: 1000 }, 10)).rejects.toThrow(/larger than 1000 bytes/);
    const bomb = gzipSync(xml);
    expect(bomb.length).toBeLessThan(20000);
    await expect(readSitemap(file('bomb.xml.gz', bomb), { ...limits, maxInputBytes: 20000 }, 10)).rejects.toThrow(/gzip data that cannot be read, or holds more than 20000 bytes/);
  });

  it('gives each address once, in the order given, and refuses more by hand than the limit', async () => {
    const list = file('urls.txt', 'https://example.test/b\nhttps://example.test/a\nhttps://example.test/b\n');
    const targets = await collectTargets({ positionals: ['https://example.test/a'], urlsFile: list }, limits);
    expect(targets.urls).toEqual(['https://example.test/a', 'https://example.test/b']);
    expect(targets.duplicates).toBe(2);
    expect([...targets.lines]).toEqual([['https://example.test/b', 1], ['https://example.test/a', 2]]);
    await expect(collectTargets({ positionals: [], urlsFile: list }, { ...limits, maxUrls: 1 })).rejects.toThrow(/2 addresses were given and a run scans at most 1/);
    await expect(collectTargets({ positionals: [], urlsFile: join(dir, 'missing.txt') }, limits)).rejects.toThrow(InputError);
    await expect(collectTargets({ positionals: [], urlsFile: file('empty.txt', '# nothing\n') }, limits)).rejects.toThrow(/holds no address/);
  });
});

describe('pageDirectory', () => {
  it('is the place of the page in the run and a readable, safe part of its address', () => {
    expect(pageDirectory(0, 3, 'https://Example.test/Shop/Items?id=3')).toBe('001-example.test-shop-items');
    expect(pageDirectory(11, 1200, 'http://127.0.0.1:4173/')).toBe('0012-127.0.0.1-4173');
    expect(pageDirectory(1, 2, 'https://example.test/../..%2F..%5Cx/con./')).toMatch(/^002-[a-z0-9.-]+[a-z0-9]$/);
    expect(pageDirectory(1, 2, 'https://example.test/../..%2F..%5Cx/')).not.toContain('..');
    expect(pageDirectory(0, 1, `https://example.test/${'a'.repeat(300)}`).length).toBeLessThanOrEqual(64);
  });
});

describe('summaryLines', () => {
  const counts = { pages: 3, errors: 0, fail: 5, likely: 4, advisory: 2, info: 30, newFail: 2, baselinedFail: 3 };

  it('gives counts by status, and with a baseline the new and the recorded fails', () => {
    const lines = summaryLines(counts, { new: 2, baselined: 3, stale: 1, notScanned: 4, added: 0, pruned: 0 }, 1).join('');
    expect(lines).toContain('[a11y-vision] 3 pages scanned.\n');
    expect(lines).toContain('Findings: 5 fail (2 new, 3 in the baseline), 4 likely, 2 advisory, 30 info.');
    expect(lines).toContain('1 entry no longer occurs on the scanned pages (--prune-baseline removes them); 4 entries are for pages not scanned in this run.');
    expect(lines).toContain('Exit code 1: "fail" findings that the baseline does not record.');
  });

  it('never says more than what was found', () => {
    const clean = summaryLines({ ...counts, fail: 0, newFail: 0, baselinedFail: 0 }, undefined, 0).join('');
    expect(clean).toContain('Exit code 0: no "fail" finding. These are the findings of a small set of checks, not a statement of conformance.');
    expect(clean).not.toMatch(/\bpass|conforms|compliant|accessible\b/i);
    expect(summaryLines({ ...counts, errors: 1 }, undefined, 2).join('')).toContain('3 pages scanned, 1 page NOT scanned.');
  });
});
