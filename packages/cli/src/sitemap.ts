/**
 * Reads the addresses out of a sitemap or a sitemap index (sitemaps.org protocol 0.9).
 *
 * A sitemap comes from the site under test: it is untrusted input. This is a small strict
 * tokenizer and not an XML parser, on purpose:
 * - a document type declaration is refused, so there are no entity declarations, no external
 *   entities and no expansion of any kind (no XXE, no "billion laughs");
 * - the five predefined entities and numeric character references are the only references
 *   understood, and any other is an error;
 * - nothing is fetched, nothing is resolved, attributes are skipped unread;
 * - depth and the number of addresses kept are bounded, and the caller bounds the size.
 *
 * Only `<loc>` directly inside `<url>` (of a `<urlset>`) or `<sitemap>` (of a `<sitemapindex>`)
 * is read, so the `<image:loc>` and `<xhtml:link>` of the extensions are not taken for pages.
 */

export class SitemapError extends Error {}

export interface ParsedSitemap {
  kind: 'urlset' | 'sitemapindex';
  /** Text of the `<loc>` elements, in document order, at most `maxLocs` of them. */
  locs: string[];
  /** How many `<loc>` elements there were. */
  total: number;
}

const MAX_DEPTH = 16;
const PREDEFINED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(raw: string): string {
  return raw.replace(/&([^;&\s]*);?/g, (whole: string, name: string) => {
    if (!whole.endsWith(';')) throw new SitemapError('an "&" that is not a character reference');
    const predefined = PREDEFINED[name];
    if (predefined !== undefined) return predefined;
    const numeric = /^#(?:x([0-9a-fA-F]{1,6})|([0-9]{1,7}))$/.exec(name);
    const code = numeric ? Number.parseInt(numeric[1] ?? numeric[2]!, numeric[1] !== undefined ? 16 : 10) : Number.NaN;
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) throw new SitemapError(`the entity "&${name.slice(0, 20)};", which is not one of the five that XML predefines`);
    return String.fromCodePoint(code);
  });
}

/** The name without a namespace prefix. */
function local(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

export function parseSitemap(xml: string, maxLocs: number): ParsedSitemap {
  const stack: string[] = [];
  const locs: string[] = [];
  let total = 0;
  let kind: ParsedSitemap['kind'] | null = null;
  let closedRoot = false;
  /** Text of the `<loc>` being read, or null outside one. */
  let loc: string | null = null;
  let at = 0;

  const fail = (what: string): never => {
    throw new SitemapError(`Not a sitemap this tool reads: ${what}.`);
  };
  const endOf = (marker: string, from: number, what: string): number => {
    const end = xml.indexOf(marker, from);
    if (end === -1) fail(`${what} that is not closed`);
    return end;
  };

  try {
    while (at < xml.length) {
      const open = xml.indexOf('<', at);
      const textEnd = open === -1 ? xml.length : open;
      if (textEnd > at) {
        const between = xml.slice(at, textEnd);
        if (loc !== null) loc += decode(between);
        else if (stack.length === 0 && between.trim() !== '') fail('text outside the root element');
      }
      if (open === -1) break;

      if (xml.startsWith('<!--', open)) {
        at = endOf('-->', open + 4, 'a comment') + 3;
      } else if (xml.startsWith('<![CDATA[', open)) {
        if (stack.length === 0) fail('a CDATA section outside the root element');
        const end = endOf(']]>', open + 9, 'a CDATA section');
        if (loc !== null) loc += xml.slice(open + 9, end);
        at = end + 3;
      } else if (xml.startsWith('<?', open)) {
        at = endOf('?>', open + 2, 'a processing instruction') + 2;
      } else if (xml.startsWith('<!', open)) {
        // <!DOCTYPE, <!ENTITY and the like: never read.
        fail('it has a document type declaration, and those are not accepted');
      } else if (xml.startsWith('</', open)) {
        const end = endOf('>', open + 2, 'a closing tag');
        const name = xml.slice(open + 2, end).trim();
        if (stack.pop() !== name) fail(`a closing tag </${name.slice(0, 40)}> that closes nothing`);
        if (loc !== null) {
          total += 1;
          if (locs.length < maxLocs) locs.push(loc.trim());
          loc = null;
        }
        if (stack.length === 0) closedRoot = true;
        at = end + 1;
      } else {
        // A start tag. Attribute values may hold ">", so quotes are followed; nothing in them is read.
        let end = open + 1;
        let quote = '';
        while (end < xml.length) {
          const char = xml[end]!;
          if (quote !== '') {
            if (char === quote) quote = '';
          } else if (char === '"' || char === "'") quote = char;
          else if (char === '>') break;
          else if (char === '<') fail('a "<" inside a tag');
          end += 1;
        }
        if (end >= xml.length) fail('a tag that is not closed');
        const inner = xml.slice(open + 1, end);
        const selfClosing = inner.endsWith('/');
        const name = /^[^\s/]+/.exec(inner)?.[0] ?? '';
        if (!/^[A-Za-z_][\w.:-]*$/.test(name)) fail('a tag without a name');
        if (loc !== null) fail('an element inside <loc>');
        if (closedRoot) fail('a second root element');
        if (stack.length === 0) {
          const root = local(name);
          if (root !== 'urlset' && root !== 'sitemapindex') fail(`its root element is <${name.slice(0, 40)}>, not <urlset> or <sitemapindex>`);
          kind = root as ParsedSitemap['kind'];
        }
        if (!selfClosing) {
          if (stack.length >= MAX_DEPTH) fail(`elements nested more than ${MAX_DEPTH} deep`);
          // `loc` without a prefix, directly in an entry of the root: the entry is `url` or `sitemap`.
          const parent = stack.length === 2 ? local(stack[1]!) : '';
          if (name === 'loc' && stack.length === 2 && parent === (kind === 'urlset' ? 'url' : 'sitemap') && !stack[1]!.includes(':')) loc = '';
          stack.push(name);
        } else if (stack.length === 0) closedRoot = true;
        at = end + 1;
      }
    }
  } catch (error) {
    if (error instanceof SitemapError && !error.message.startsWith('Not a sitemap')) fail(error.message);
    throw error;
  }
  if (kind === null) return fail('it has no root element');
  if (stack.length > 0) fail(`<${stack.at(-1)!.slice(0, 40)}> is not closed`);
  return { kind, locs, total };
}
