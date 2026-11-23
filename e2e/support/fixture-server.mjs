// Static server for fixtures/. No dependencies; used only by the browser tests.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const port = Number(process.argv[2] ?? 4173);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/**
 * Routes that are not files, for the tests of a run over several pages (e2e/ci.spec.ts): sitemaps
 * whose entries are on this server whatever its port, a page behind a session cookie, and a page
 * that answers with an error. Everything is on this machine.
 */
const SESSION_COOKIE = 'e2e_session';
const SESSION_VALUE = 'e2e-session-0123456789-SECRET';
const NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
const urlset = (locs) => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset ${NS}>\n${locs.map((loc) => `  <url><loc>${loc}</loc></url>`).join('\n')}\n</urlset>\n`;

async function dynamic(pathname, request) {
  const origin = `http://${request.headers.host}`;
  const xml = (body, type = 'application/xml') => ({ status: 200, type, body });
  switch (pathname) {
    case '/_ci/sitemap.xml':
      // The second entry is on another origin: left out unless asked for.
      return xml(urlset([`${origin}/noop/basic.html`, 'http://other-origin.invalid/page.html', `${origin}/focus-indicator/outline-none.html?a=1&amp;b=2`]));
    case '/_ci/sitemap-2.xml.gz':
      return xml(gzipSync(urlset([`${origin}/focus-indicator/good-outline.html`, `${origin}/noop/basic.html`])), 'application/gzip');
    case '/_ci/sitemap-index.xml':
      return xml(
        `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex ${NS}>\n  <sitemap><loc>${origin}/_ci/sitemap.xml</loc></sitemap>\n  <sitemap><loc>${origin}/_ci/sitemap-2.xml.gz</loc></sitemap>\n  <sitemap><loc>http://other-origin.invalid/sitemap.xml</loc></sitemap>\n</sitemapindex>\n`,
      );
    case '/_ci/sitemap-xxe.xml':
      return xml(`<?xml version="1.0"?>\n<!DOCTYPE urlset [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>\n<urlset ${NS}><url><loc>${origin}/noop/basic.html?&xxe;</loc></url></urlset>\n`);
    case '/_ci/error.html':
      return { status: 500, type: types['.html'], body: '<!doctype html><html lang="en"><title>Error</title><h1>Internal error</h1></html>' };
    case '/_ci/private.html': {
      const cookies = (request.headers.cookie ?? '').split(';').map((part) => part.trim());
      if (!cookies.includes(`${SESSION_COOKIE}=${SESSION_VALUE}`)) {
        return { status: 401, type: types['.html'], body: '<!doctype html><html lang="en"><title>Sign in</title><h1>Sign in</h1><p>This page needs a session.</p></html>' };
      }
      // A page with two known failures, which also shows the value of the session in its text:
      // what a scan reads from a page must not carry it into a report.
      const page = await readFile(join(root, 'focus-indicator', 'outline-none.html'), 'utf8');
      const shown = `<main><div style="font-size:28px;font-weight:700;margin:24px 0 8px" id="shown">Session ${SESSION_VALUE}</div><p>Signed in. Body text under the title, long enough to be a paragraph of its own.</p></main>`;
      return { status: 200, type: types['.html'], body: page.replace('</body>', `${shown}</body>`) };
    }
    default:
      return null;
  }
}

createServer(async (request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  if (pathname.startsWith('/_ci/')) {
    const reply = await dynamic(pathname, request).catch(() => null);
    if (!reply) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(reply.status, { 'content-type': reply.type, 'cache-control': 'no-store' });
    response.end(reply.body);
    return;
  }
  const file = normalize(join(root, decodeURIComponent(pathname)));
  if (!file.startsWith(root) || file.endsWith(sep)) {
    response.writeHead(404).end();
    return;
  }
  readFile(file).then(
    (body) => {
      response.writeHead(200, {
        'content-type': types[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(body);
    },
    () => response.writeHead(404).end(),
  );
}).listen(port, '127.0.0.1', () => {
  console.log(`fixtures on http://127.0.0.1:${port}`);
});
