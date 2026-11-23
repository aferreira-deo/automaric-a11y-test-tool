// Static server for fixtures/. No dependencies; used only by the browser tests.
import { Buffer } from 'node:buffer';
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

async function dynamic(pathname, request, searchParams) {
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
      return review(pathname, request, origin, searchParams);
  }
}

/**
 * Routes for the tests of what a review of M7 found (e2e/ci-hardening.spec.ts). A page under
 * `/_ci/s/<id>/` has a version: 1 until `/_ci/s/<id>/set?v=2` is asked for. Tests run side by
 * side, so each uses an id of its own.
 */
const versions = new Map();
const AUTH_USER = 'e2e-user';
const AUTH_PASSWORD = 'e2e-PASSWORD-9999';
const REVIEW_STYLE =
  '<style>body{margin:32px;font:16px/1.5 Arial,Helvetica,sans-serif;background:#fff;color:#1a1a1a}' +
  'button,input{font:inherit;padding:8px 16px;margin:8px;background:#fff;color:#1a1a1a;border:1px solid #595959}' +
  'button:focus,input:focus,a.bad:focus{outline:none}a{color:#0645ad}' +
  '.ok:focus{outline:3px solid #000 !important;outline-offset:2px}</style>';
const reviewPage = (title, body) => ({
  status: 200,
  type: types['.html'],
  body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${REVIEW_STYLE}</head><body><main><h1>${title}</h1>${body}</main></body></html>`,
});
const redirect = (location) => ({ status: 302, type: 'text/plain', body: '', headers: { location } });
const ICON_BUTTON =
  '<button aria-label="Settings" class="ok" style="border:0"><svg width="24" height="24" viewBox="0 0 24 24"><path fill="#cccccc" d="M2 2h20v20H2z"/></svg></button>';

/** A front page in the manner of a news aggregator: every id is made from the number of its item, and the order changes. */
function aggregator(items) {
  const rows = items
    .map(
      (item, index) =>
        `<tr class="athing" id="${item}"><td><span class="rank">${index + 1}.</span></td>` +
        `<td><a id="up_${item}" class="bad" href="vote?id=${item}&amp;how=up"><div title="upvote" style="width:12px;height:12px;background:#595959"></div></a></td>` +
        `<td><a class="bad" href="https://example.test/story/${item}">Story number ${item} about something</a></td></tr>` +
        `<tr><td colspan="2"></td><td><span id="score_${item}">${item % 97} points</span></td></tr>`,
    )
    .join('');
  return `<table id="hnmain"><tbody><tr><td><a class="bad" href="newest">new</a> <button name="q-go">Search</button></td></tr><tr><td><table><tbody>${rows}</tbody></table></td></tr></tbody></table>`;
}

/** Ids as component libraries generate them: another one on every render, here on every version. */
function generatedIds(v) {
  return (
    `<div id=":r${v}:"><button>React</button></div>` +
    `<button id="react-aria${7000 + v}-:r${v}:">Aria</button>` +
    `<button id="radix-:r${v}a:">Radix</button>` +
    `<button id="headlessui-menu-button-:r${v}b:">Headless</button>` +
    `<button id="mui-${v}">Mui</button>` +
    `<button id="ember${40 + v}">Ember</button>` +
    `<button id="up_${48000000 + v}">Item</button>` +
    '<button id="save">Stable</button>' +
    '<button data-testid="submit-order">Test id</button>' +
    `<button data-testid="row-${52000 + v}">Keyed test id</button>` +
    '<form><input name="email" type="text" aria-label="Email"><button name="go" type="submit">Go</button></form>' +
    '<p><input type="radio" name="size" aria-label="Small"><input type="radio" name="size" aria-label="Large"></p>' +
    `<div data-cy="panel" id="mui-${90 + v}"><button>In panel</button></div>`
  );
}

function review(pathname, request, origin, searchParams) {
  const other = origin.includes('127.0.0.1') ? origin.replace('127.0.0.1', 'localhost') : origin.replace('localhost', '127.0.0.1');
  const xml = (locs) => ({ status: 200, type: 'application/xml', body: urlset(locs) });
  const scoped = /^\/_ci\/s\/([\w-]+)\/([\w.-]+)$/.exec(pathname);
  if (scoped) {
    const [, id, name] = scoped;
    const v = versions.get(id) ?? 1;
    switch (name) {
      case 'set':
        versions.set(id, Number(searchParams.get('v')) || 1);
        return { status: 200, type: 'text/plain', body: 'ok' };
      case 'mask.html':
        // Version 2: the control that failed is fixed and moved up, and another one fails where it was.
        return reviewPage(
          'Mask',
          v === 1
            ? '<ul><li><button class="ok">Alpha</button></li><li><button>Bravo</button></li></ul>'
            : '<ul><li><button class="ok">Bravo</button></li><li><button>Charlie, another control</button></li></ul>',
        );
      case 'two.html':
        return reviewPage('Two', `<button>Bravo</button>${ICON_BUTTON}`);
      case 'app.html':
        // Version 2: the session is over, and the address sends to a sign-in page that answers 200.
        return v === 1 ? reviewPage('App', '<button>Bravo</button>') : redirect(`${origin}/_ci/sign-in.html`);
      case 'hn.html':
        return reviewPage('Aggregator', aggregator(v === 1 ? [48100001, 48100002, 48100003, 48100004] : [48100005, 48100001, 48100002, 48100003]));
      case 'ids.html':
        return reviewPage('Ids', generatedIds(v));
      default:
        return null;
    }
  }
  switch (pathname) {
    case '/_ci/sign-in.html':
      return reviewPage('Sign in', '<p>Please sign in to see this page.</p>');
    case '/_ci/secret.html':
      // Shows what the session holds, as a page of an application may: a cookie, a value kept as
      // JSON in local storage, a plain one, and an id made from a token.
      return reviewPage(
        'Secret',
        `<button>Bravo</button><div id="out"></div><script>
          const out = document.getElementById('out');
          const add = (text) => {
            const title = document.createElement('p');
            title.style.cssText = 'font:bold 28px Arial,sans-serif;margin:24px 0 4px';
            title.textContent = text;
            const body = document.createElement('p');
            body.textContent = 'Some body text that follows the bold line, so that the line reads as the title of a section of the page.';
            out.append(title, body);
          };
          add('Cookie ' + document.cookie);
          let token = '';
          try { token = JSON.parse(localStorage.getItem('auth')).session.token; } catch {}
          add('Token ' + token);
          add('Plain ' + localStorage.getItem('plain'));
          add('Encoded ' + encodeURIComponent(localStorage.getItem('spaced') ?? ''));
          const button = document.createElement('button');
          button.id = 'btn-' + token;
          button.textContent = 'Go';
          out.append(button);
        </script>`,
      );
    case '/_ci/basic-auth.html': {
      const expected = `Basic ${Buffer.from(`${AUTH_USER}:${AUTH_PASSWORD}`).toString('base64')}`;
      if (request.headers.authorization !== expected) {
        return { status: 401, type: 'text/plain', body: 'Sign in.', headers: { 'www-authenticate': 'Basic realm="e2e"' } };
      }
      return reviewPage('Behind basic authentication', '<button>Bravo</button>');
    }
    // A sitemap that is served from another origin than the one that was asked for.
    case '/_ci/sm-redirect.xml':
      return redirect(`${other}/_ci/sm-target.xml`);
    case '/_ci/sm-target.xml':
      return xml([`${origin}/noop/basic.html`, `${other}/noop/basic.html`]);
    // A sitemap with a page that sends to another origin.
    case '/_ci/sm-out.xml':
      return xml([`${origin}/noop/basic.html`, `${origin}/_ci/redir-out.html`]);
    case '/_ci/redir-out.html':
      return redirect(`${other}/focus-indicator/outline-none.html`);
    default:
      return null;
  }
}


createServer(async (request, response) => {
  const { pathname, searchParams } = new URL(request.url ?? '/', 'http://localhost');
  if (pathname.startsWith('/_ci/')) {
    const reply = await dynamic(pathname, request, searchParams).catch(() => null);
    if (!reply) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(reply.status, { 'content-type': reply.type, 'cache-control': 'no-store', ...reply.headers });
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
