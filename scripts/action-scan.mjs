#!/usr/bin/env node
// The scan step of the GitHub Action (action.yml). It reads its inputs from INPUT_* environment
// variables, never from text put into a shell command, and starts the CLI without a shell: an
// input cannot become a command or an option. It can be run by hand the same way, see the README.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The name of the tool lives in one place.
import { TOOL_NAME } from '../packages/core/dist/index.js';

const bin = fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url));
const input = (name) => (process.env[`INPUT_${name}`] ?? '').trim();
const fail = (message) => {
  console.error(message);
  process.exit(2);
};

const args = ['scan'];
// Addresses are positional arguments: each has to be one, so that none can be taken for an option.
for (const url of input('URLS').split(/\s+/).filter(Boolean)) {
  if (!/^https?:\/\//i.test(url)) fail(`The "urls" input holds something that is not an http(s) address.`);
  args.push(url);
}
// A value is given as --name=value: it stays a value whatever it starts with.
const option = (flag, value) => {
  if (value !== '') args.push(`--${flag}=${value}`);
};
option('urls', input('URLS_FILE'));
option('sitemap', input('SITEMAP'));
option('max-urls', input('MAX_URLS'));
option('checks', input('CHECKS'));
option('config', input('CONFIG'));
option('storage-state', input('STORAGE_STATE'));
option('baseline', input('BASELINE'));
if (args.length === 1) fail('Give at least one of the inputs "urls", "urls-file" and "sitemap".');

const outputDir = input('OUTPUT_DIR') || `${TOOL_NAME}-report`;
const files = {
  json: join(outputDir, 'report.json'),
  html: join(outputDir, 'report.html'),
  sarif: join(outputDir, 'report.sarif'),
  crops: join(outputDir, 'crops'),
};
args.push(`--output=${files.json}`, `--html=${files.html}`, `--sarif=${files.sarif}`, `--crops=${files.crops}`);
// GitHub code scanning shows a result in a file of the repository: the list of addresses, when
// there is one in the repository, is that file unless another is named.
const urlsFile = input('URLS_FILE');
option('sarif-anchor', input('SARIF_ANCHOR') || (urlsFile !== '' && !isAbsolute(urlsFile) && !urlsFile.split(/[\\/]/).includes('..') ? urlsFile : ''));

const run = spawnSync(process.execPath, [bin, ...args], { stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
process.stderr.write(run.stderr ?? '');
const exitCode = run.status ?? 2;

const write = (file, text) => {
  if (file) appendFileSync(file, text);
};
// Paths this script made itself from one input; a line break would end the output early. A
// report that was not written (the scan stopped on an error before it) is given as nothing, so
// that no later step looks for it.
const clean = (value) => (existsSync(value) ? String(value).replace(/[\r\n]/g, '') : '');
write(
  process.env['GITHUB_OUTPUT'],
  [`exit-code=${exitCode}`, `json-file=${clean(files.json)}`, `html-file=${clean(files.html)}`, `sarif-file=${clean(files.sarif)}`, `crops-dir=${clean(files.crops)}`].join('\n') + '\n',
);
// The summary of the run, which is counts and fixed words only. Nothing read from a page goes here.
const prefix = `[${TOOL_NAME}] `;
const summary = (run.stderr ?? '')
  .split('\n')
  .filter((line) => line.startsWith(prefix))
  .map((line) => line.slice(prefix.length))
  .filter((line) => !/^Page \d+ of \d+: /.test(line));
if (summary.length > 0) write(process.env['GITHUB_STEP_SUMMARY'], `### ${TOOL_NAME}\n\n${summary.map((line) => `- ${line}`).join('\n')}\n`);

// Whether the job fails is decided by the last step of the action, after the SARIF upload.
process.exit(0);
