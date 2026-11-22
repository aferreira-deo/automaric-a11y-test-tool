// Static server for fixtures/. No dependencies; used only by the browser tests.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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

createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
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
