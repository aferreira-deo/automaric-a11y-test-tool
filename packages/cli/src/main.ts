import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AdjudicationConfigError, createAdjudicator, describeStats, isLoopbackHost, secretsOf } from '@a11y-vision/adjudicators';
import { verifyEndpoint } from '@a11y-vision/adjudicators/node';
import {
  BaselineError,
  compareWithBaseline,
  defaultConfig,
  emptyBaseline,
  parseBaseline,
  registeredChecks,
  resolveBaselineConfig,
  resolveConfig,
  serializeBaseline,
  TOOL_NAME,
  TOOL_VERSION,
} from '@a11y-vision/core';
import type { AdjudicationInput, Baseline, BaselineSummary, CheckId, ConfigInput, Png, RunConfig, ScanResult } from '@a11y-vision/core';
import { A11yVision } from '@a11y-vision/playwright';
import { countRun, toHtmlReport, toHtmlRunReport, toJsonReport, toJsonRunReport, toSarifReport } from '@a11y-vision/reporters';
import type { Run, RunCounts } from '@a11y-vision/reporters';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { checkedAddress, collectTargets, InputError } from './inputs.js';
import { cleanResult, collectSecrets, redactText } from './redaction.js';
import { publicUrl, scrubAddresses } from './urls.js';
import type { PageTarget } from './urls.js';

export const EXIT_OK = 0;
/** At least one `fail` finding that no baseline records. */
export const EXIT_FAILURES = 1;
/** Usage error, or the scan could not run, or a page of the run could not be scanned. */
export const EXIT_ERROR = 2;

/** Prefix of the environment variables the CLI reads, from the tool name: A11Y_VISION_. */
const ENV_PREFIX = `${TOOL_NAME.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_`;
export const ENV_BASE_URL = `${ENV_PREFIX}AI_BASE_URL`;
export const ENV_MODEL = `${ENV_PREFIX}AI_MODEL`;
export const ENV_KEY_ENV = `${ENV_PREFIX}AI_KEY_ENV`;
/** Where verdicts are kept between runs unless told otherwise, relative to the working directory. */
export const DEFAULT_CACHE_FILE = join(`.${TOOL_NAME}`, 'verdicts.json');
/** What every line of the summary of a run starts with on stderr, so that it can be told from the rest. */
export const SUMMARY_PREFIX = `[${TOOL_NAME}] `;

const USAGE = `Usage: ${TOOL_NAME} scan <url>... [options]
       ${TOOL_NAME} scan --urls <file> [options]
       ${TOOL_NAME} scan --sitemap <url-or-file> [options]

Pages. One address given alone is scanned as before and reported in the
single-page shape. Several addresses, --urls or --sitemap make a run over
several pages: each page is opened in a fresh browser context, one after the
other, and a page that cannot be loaded is reported and does not stop the run.
      --urls <file>     File with one http(s) address per line; blank lines and
                        lines that start with # are skipped
      --sitemap <src>   Address or file of a sitemap.xml or a sitemap index
                        (gzip is read). Entries on another origin than the
                        sitemap are left out
      --max-urls <n>    Most pages in one run (default: ${defaultConfig.run.maxUrls}). More given by hand is
                        an error; a longer sitemap is cut, and the cut is said
      --any-origin      Keep sitemap entries on other origins, and scan a page
                        of a sitemap that ends on another origin than its own
      --allow-file-urls Also take file: addresses on the command line. Without
                        it only http(s) addresses are scanned; other schemes
                        (data:, javascript:, chrome: ...) never are
      --allow-http-errors
                        Scan a page that answers with HTTP status 400 or more
                        instead of counting it as not scanned
      --storage-state <file>
                        Playwright storage state (cookies, local storage) for
                        every page: scans a signed-in session. The file holds
                        session secrets: keep it out of the repository. Its
                        values are replaced in the texts of every report;
                        captures are images of the page and can show them

A user name and password in an address (https://user:password@host/) are given
to the browser and written nowhere. The values of query parameters that carry
a secret (token, key, code ...: run.redactQueryParams) are written as
"redacted", and such parameters are not part of the key of a page.

Reports
  -o, --output <file>   Write the JSON report to a file instead of stdout
      --html <file>     Also write a self-contained HTML evidence report
      --sarif <file>    Also write a SARIF 2.1.0 file (fail = error, likely =
                        warning, advisory = note; info left out)
      --sarif-anchor <path>
                        Attach every SARIF result to this file of the
                        repository (path from its root) instead of the address
                        of the page; with the file given to --urls, each result
                        is on the line of its page. GitHub code scanning only
                        documents results in files of the repository
      --sarif-include-info
                        Also write info findings to the SARIF file
      --crops <dir>     Also write the evidence crops as PNG files; the ids in
                        "evidence.crops" are paths relative to this directory,
                        or to one directory per page in it for several pages
  -q, --quiet           No summary and no progress on stderr

Baseline. Only "fail" findings are recorded, per page: where the element is
(its selector) and what it is (its signature, a hash).
      --baseline <file> Compare with this file: a "fail" it records is still
                        reported, marked, and does not set exit code 1
      --update-baseline Add the "fail" findings of this run to the file
                        (created when missing). Nothing is taken out: entries
                        of pages and checks that did not run are kept
      --prune-baseline  Remove the entries that no longer occur. Only entries
                        whose check ran, on a page that was scanned and did
                        not end on another address, are removed

Checks
      --checks <ids>    Comma-separated checks to run (default: ${defaultConfig.checks.join(', ')};
                        available: ${registeredChecks().join(', ')})
      --config <file>   JSON file with settings (checks, focus, icon, headings,
                        lists, grouping, nameRoleValue, reflow, adjudication,
                        baseline, run, selector); the options given here
                        win over it
      --no-probe        name-role-value: activate nothing. Without it, controls
                        are activated to see whether they act as links or
                        buttons and expose their state, in copies of the
                        page in a browser of their own without network; each
                        copy's load is a page view (GET) on the site
      --no-axe-overlap  name-role-value: leave out what axe-core also reports
                        (empty names of buttons, links and fields, required
                        states and context, focusable content under
                        aria-hidden, nested controls)
  -h, --help            Show this help
  -v, --version         Show the version

Model (optional). Without a base URL and a model, no model is asked and nothing
is sent anywhere; every check still runs. A model only judges candidates that
the checks found, and its verdict never makes a finding a "fail". The two
environment variables below are enough to switch it on; whenever a model is
asked, one line on stderr names the model and the host it is on.
      --ai-base-url <url>   Base URL of an OpenAI-compatible endpoint, up to /v1
                            (or ${ENV_BASE_URL})
      --ai-model <name>     Model name, as the endpoint knows it (or ${ENV_MODEL})
      --ai-key-env <NAME>   NAME of the environment variable that holds the API
                            key, for endpoints that need one (or ${ENV_KEY_ENV});
                            the key itself is never given on the command line
      --ai-label <text>     Name shown in reports for the provider
      --ai-allow-remote     Allow an endpoint that is not on this machine: text
                            and captures of the page are sent to it. It has to
                            be an https URL
      --ai-lower-on-disagree
                            Lower a finding to "info" when the model disagrees
                            with it: a "likely" heading, list or group candidate
                            the model says is not one, and a heading reported as
                            not reading as one that the model says does function
                            as a heading. Off by default: the finding stays
                            listed, with the verdict shown. A verdict never
                            raises a status
      --ai-lower-on-no      Deprecated name of --ai-lower-on-disagree, still read
      --ai-text-only        Send no captures (for a model without vision)
      --ai-cache <file>     Where verdicts are kept between runs
                            (default: ${DEFAULT_CACHE_FILE})
      --no-ai-cache         Keep no verdicts
      --no-ai               Ask no model, whatever the environment or the
                            config file say

Exit codes:
  0  no "fail" finding, or none that the baseline does not record
  1  at least one "fail" finding that the baseline does not record (every
     "fail" when no baseline is given)
  2  error: wrong usage, a file that cannot be used (config, baseline, list,
     sitemap, storage state), or a page that could not be scanned. A run over
     several pages still writes its reports; they list the pages not scanned
"likely", "advisory" and "info" never change the exit code. Exit code 0 is not a
statement of conformance: the tool covers a small set of checks.
`;

interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const processIo: Io = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
};

async function writeTo(file: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

/**
 * Writes a file so that it is either the old one or the new one, never half of one: the content
 * goes to a file beside it, which then takes its place. A run that is stopped while it writes a
 * baseline leaves the baseline as it was. When the content cannot be moved into place, the file
 * beside it is removed and the error is passed on.
 */
export async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const beside = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(beside, content, { flag: 'wx' });
    await rename(beside, file);
  } catch (error) {
    await rm(beside, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readConfigFile(file: string): Promise<ConfigInput> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read the config file ${file}: ${(error as Error).message}`, { cause: error });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`The config file ${file} has to hold a JSON object.`);
  const input = value as Record<string, unknown>;
  for (const section of ['focus', 'icon', 'headings', 'lists', 'grouping', 'nameRoleValue', 'reflow', 'adjudication', 'baseline', 'run', 'selector']) {
    const part = input[section];
    if (part !== undefined && (part === null || typeof part !== 'object' || Array.isArray(part))) {
      throw new Error(`"${section}" in the config file ${file} has to be an object.`);
    }
  }
  if (input['checks'] !== undefined && !(Array.isArray(input['checks']) && input['checks'].every((id) => typeof id === 'string'))) {
    throw new Error(`"checks" in the config file ${file} has to be a list of check ids.`);
  }
  return input;
}

/** A file given on the command line cannot be used. The message never holds anything read from the file. */
class FileError extends Error {}

/**
 * The baseline a file holds, or null when the file is not there. Anything else that is wrong
 * with it is an error: a baseline that cannot be read is never taken for an empty or a full one.
 */
async function readBaselineFile(file: string): Promise<Baseline | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new FileError(`The baseline file ${file} cannot be opened.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FileError(`The baseline file ${file} cannot be used: it is not valid JSON. Nothing was scanned. Restore the file, or move it away and write a new one with --update-baseline.`);
  }
  try {
    return parseBaseline(value);
  } catch (error) {
    if (!(error instanceof BaselineError)) throw error;
    throw new FileError(`The baseline file ${file} cannot be used: ${error.message}. Nothing was scanned.`);
  }
}

/**
 * Checks a Playwright storage state before a browser is started, and gives back the values in it
 * that have to stay out of everything this program writes. What the file holds is never part of
 * a message: a JSON parser quotes what it could not read, so its message is not passed on.
 */
async function readStorageState(file: string, minSecretChars: number): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new FileError(`The storage state file ${file} cannot be opened.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FileError(`The storage state file ${file} is not valid JSON.`);
  }
  const state = value as { cookies?: unknown; origins?: unknown } | null;
  if (state === null || typeof state !== 'object' || (state.cookies !== undefined && !Array.isArray(state.cookies)) || (state.origins !== undefined && !Array.isArray(state.origins))) {
    throw new FileError(`The storage state file ${file} is not a Playwright storage state (an object with "cookies" and "origins").`);
  }
  return collectSecrets(state, minSecretChars);
}

/** A directory name for the captures of one page: its place in the run, then what can be read of its address. */
export function pageDirectory(index: number, total: number, url: string): string {
  const number = String(index + 1).padStart(Math.max(3, String(total).length), '0');
  let slug = 'page';
  if (URL.canParse(url)) {
    const { host, pathname } = new URL(url);
    slug =
      `${host}${pathname}`
        .toLowerCase()
        .replace(/[^a-z0-9.]+/g, '-')
        .replace(/\.{2,}/g, '.')
        .slice(0, 60)
        .replace(/^[-.]+|[-.]+$/g, '') || 'page';
  }
  return `${number}-${slug}`;
}

/** The first line of an error of Playwright: the rest is its log of calls. */
function firstLine(message: string): string {
  return message.split('\n', 1)[0]!.trim();
}

/** The path given for --sarif-anchor as a URI reference relative to the root of a repository, or null when it cannot be one. */
function anchorUri(path: string): string | null {
  const forward = path.replaceAll('\\', '/').replace(/^\.\//, '');
  if (forward === '' || isAbsolute(path) || /^[A-Za-z]:/.test(forward) || forward.split('/').includes('..')) return null;
  return encodeURI(forward);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The summary of a run for a person, in counts. It never says more than what was found. */
export function summaryLines(counts: RunCounts, baseline: BaselineSummary | undefined, exitCode: number): string[] {
  const lines: string[] = [];
  const notScanned = counts.errors > 0 ? `, ${plural(counts.errors, 'page', 'pages')} NOT scanned` : '';
  lines.push(`${plural(counts.pages, 'page', 'pages')} scanned${notScanned}.`);
  const fails = baseline ? `${counts.fail} fail (${counts.newFail} new, ${counts.baselinedFail} in the baseline)` : `${counts.fail} fail`;
  lines.push(`Findings: ${fails}, ${counts.likely} likely, ${counts.advisory} advisory, ${counts.info} info.`);
  if (baseline) {
    const parts: string[] = [];
    if (baseline.added > 0) parts.push(`${plural(baseline.added, 'entry', 'entries')} added`);
    if (baseline.pruned > 0) parts.push(`${plural(baseline.pruned, 'entry', 'entries')} removed`);
    if (baseline.stale - baseline.pruned > 0) parts.push(`${plural(baseline.stale - baseline.pruned, 'entry no longer occurs', 'entries no longer occur')} on the scanned pages (--prune-baseline removes them)`);
    if (baseline.notScanned > 0) parts.push(`${plural(baseline.notScanned, 'entry is', 'entries are')} for pages not scanned in this run`);
    if (baseline.unverified > 0) {
      parts.push(`${plural(baseline.unverified, 'entry was', 'entries were')} not looked for (the check did not run, or the page ended on another address) and ${baseline.unverified === 1 ? 'is' : 'are'} kept`);
    }
    if (parts.length > 0) lines.push(`Baseline: ${parts.join('; ')}.`);
  }
  const why =
    exitCode === EXIT_ERROR
      ? 'the run is not complete'
      : exitCode === EXIT_FAILURES
        ? baseline
          ? '"fail" findings that the baseline does not record'
          : '"fail" findings'
        : baseline
          ? 'no "fail" finding that the baseline does not record'
          : 'no "fail" finding';
  lines.push(`Exit code ${exitCode}: ${why}. These are the findings of a small set of checks, not a statement of conformance.`);
  return lines.map((line) => `${SUMMARY_PREFIX}${line}\n`);
}

export async function main(argv: string[], io: Io = processIo, env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        output: { type: 'string', short: 'o' },
        html: { type: 'string' },
        sarif: { type: 'string' },
        'sarif-anchor': { type: 'string' },
        'sarif-include-info': { type: 'boolean' },
        crops: { type: 'string' },
        urls: { type: 'string' },
        sitemap: { type: 'string' },
        'max-urls': { type: 'string' },
        'any-origin': { type: 'boolean' },
        'allow-file-urls': { type: 'boolean' },
        'allow-http-errors': { type: 'boolean' },
        'storage-state': { type: 'string' },
        baseline: { type: 'string' },
        'update-baseline': { type: 'boolean' },
        'prune-baseline': { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        checks: { type: 'string' },
        config: { type: 'string' },
        'ai-base-url': { type: 'string' },
        'ai-model': { type: 'string' },
        'ai-key-env': { type: 'string' },
        'ai-label': { type: 'string' },
        'ai-allow-remote': { type: 'boolean' },
        'ai-lower-on-disagree': { type: 'boolean' },
        // Deprecated name of the option above.
        'ai-lower-on-no': { type: 'boolean' },
        'ai-text-only': { type: 'boolean' },
        'ai-cache': { type: 'string' },
        'no-ai-cache': { type: 'boolean' },
        'no-ai': { type: 'boolean' },
        'no-probe': { type: 'boolean' },
        'no-axe-overlap': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${USAGE}`);
    return EXIT_ERROR;
  }
  const { values, positionals } = parsed;

  if (values.help) {
    io.stdout(USAGE);
    return EXIT_OK;
  }
  if (values.version) {
    io.stdout(`${TOOL_VERSION}\n`);
    return EXIT_OK;
  }

  const [command, ...given] = positionals;
  if (command !== 'scan' || (given.length === 0 && values.urls === undefined && values.sitemap === undefined)) {
    io.stderr(USAGE);
    return EXIT_ERROR;
  }
  // What is not an address that is scanned stops here, before anything is read or opened.
  try {
    for (const url of given) checkedAddress(url, values['allow-file-urls'] === true);
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    io.stderr(`${error.message}\n`);
    return EXIT_ERROR;
  }
  // One address given alone: the report of one page, as it always was. Anything else is a run.
  const single = given.length === 1 && values.urls === undefined && values.sitemap === undefined;
  if ((values['update-baseline'] || values['prune-baseline']) && values.baseline === undefined) {
    io.stderr('--update-baseline and --prune-baseline need --baseline <file>.\n');
    return EXIT_ERROR;
  }
  if ((values['sarif-anchor'] !== undefined || values['sarif-include-info']) && values.sarif === undefined) {
    io.stderr('--sarif-anchor and --sarif-include-info need --sarif <file>.\n');
    return EXIT_ERROR;
  }
  let anchor: string | null = null;
  if (values['sarif-anchor'] !== undefined) {
    anchor = anchorUri(values['sarif-anchor']);
    if (anchor === null) {
      io.stderr(`--sarif-anchor takes the path of a file from the root of the repository, without "..": ${values['sarif-anchor']}\n`);
      return EXIT_ERROR;
    }
  }
  let maxUrls: number | undefined;
  if (values['max-urls'] !== undefined) {
    maxUrls = Number(values['max-urls']);
    if (!Number.isInteger(maxUrls) || maxUrls < 1) {
      io.stderr(`--max-urls takes a whole number of at least 1: ${values['max-urls']}\n`);
      return EXIT_ERROR;
    }
  }

  let fromFile: ConfigInput = {};
  if (values.config) {
    try {
      fromFile = await readConfigFile(values.config);
    } catch (error) {
      io.stderr(`${(error as Error).message}\n`);
      return EXIT_ERROR;
    }
  }

  const known = new Set<string>(registeredChecks());
  const checks =
    values.checks
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean) ?? fromFile.checks;
  const unknown = checks?.filter((id) => !known.has(id)) ?? [];
  if (unknown.length > 0) {
    io.stderr(`Unknown check(s): ${unknown.join(', ')}. Available: ${[...known].join(', ')}\n`);
    return EXIT_ERROR;
  }

  // The model: the config file, then the environment, then the options. Nothing here has a default
  // endpoint or model, so with none of the three no provider is configured.
  const adjudication: AdjudicationInput = { ...fromFile.adjudication };
  // A variable that is set to nothing is not set.
  const fromEnv = (name: string): string | undefined => (env[name]?.trim() ? env[name] : undefined);
  const baseUrl = values['ai-base-url'] ?? fromEnv(ENV_BASE_URL);
  const model = values['ai-model'] ?? fromEnv(ENV_MODEL);
  const keyEnv = values['ai-key-env'] ?? fromEnv(ENV_KEY_ENV);
  if (baseUrl !== undefined) adjudication.baseUrl = baseUrl;
  if (model !== undefined) adjudication.model = model;
  if (keyEnv !== undefined) adjudication.apiKeyEnv = keyEnv;
  if (values['ai-label'] !== undefined) adjudication.providerLabel = values['ai-label'];
  if (values['ai-allow-remote']) adjudication.allowRemote = true;
  if (values['ai-text-only']) adjudication.sendImages = false;
  if (values['ai-lower-on-disagree'] || values['ai-lower-on-no']) {
    adjudication.headingDisagreeStatus = 'info';
    adjudication.listDisagreeStatus = 'info';
    adjudication.groupDisagreeStatus = 'info';
  }
  if (values['no-ai']) adjudication.provider = 'none';
  // Asked for here or in the environment: that selects the adapter, whatever the file says. From
  // the file alone, an endpoint or a model selects it unless the file names a provider itself.
  else if (baseUrl !== undefined || model !== undefined) adjudication.provider = 'openai-compatible';
  else if (adjudication.provider === undefined && (adjudication.baseUrl || adjudication.model)) adjudication.provider = 'openai-compatible';

  const run: Partial<RunConfig> = { ...fromFile.run };
  if (maxUrls !== undefined) run.maxUrls = maxUrls;
  if (values['any-origin']) run.sameOrigin = false;
  if (values['allow-http-errors']) run.httpErrorIsFailure = false;

  const nameRoleValue = { ...fromFile.nameRoleValue };
  if (values['no-probe']) nameRoleValue.probe = 'off';
  if (values['no-axe-overlap']) nameRoleValue.includeAxeCovered = false;

  const input: ConfigInput = { ...fromFile, adjudication, run, nameRoleValue, ...(checks ? { checks: checks as CheckId[] } : {}) };
  const config = resolveConfig(input);
  const settings = config.adjudication;
  const limits = config.run;

  // The files a run depends on are read before anything is scanned: a baseline that cannot be
  // used, or a storage state that is not one, stops here and not after minutes of scanning.
  let baseline: Baseline | null = null;
  let storageSecrets: string[] = [];
  try {
    if (values.baseline !== undefined) {
      baseline = await readBaselineFile(values.baseline);
      if (baseline === null) {
        if (!values['update-baseline']) throw new FileError(`The baseline file ${values.baseline} does not exist. Nothing was scanned. Write it with --baseline ${values.baseline} --update-baseline.`);
        baseline = emptyBaseline(config.baseline);
      } else if (fromFile.baseline !== undefined && JSON.stringify(resolveBaselineConfig(fromFile.baseline)) !== JSON.stringify(resolveBaselineConfig(baseline.urlKey))) {
        io.stderr(`The baseline file ${values.baseline} was written with other "baseline" settings than the config file gives: those of the baseline file are used, so that its entries keep their pages.\n`);
      }
    }
    if (values['storage-state'] !== undefined) storageSecrets = await readStorageState(values['storage-state'], limits.minSecretChars);
  } catch (error) {
    if (!(error instanceof FileError)) throw error;
    io.stderr(`${error.message}\n`);
    return EXIT_ERROR;
  }

  // Whatever is printed or written below that this program did not write itself goes through
  // this: addresses lose their credentials and secret query values, and the values of the model
  // key and of the stored session are replaced. It is applied to texts, before a report is made
  // of them, and never to a serialised report.
  const secrets = [...secretsOf(settings, env), ...storageSecrets];
  const shown = (url: string): string => publicUrl(url, limits.redactQueryParams);
  const safe = (text: string): string => redactText(scrubAddresses(text, limits.redactQueryParams), secrets);
  const withModel = settings.provider !== 'none';
  /** Where a setting of the model came from, for the messages below. */
  const origin = (option: 'ai-base-url' | 'ai-model', variable: string): string =>
    values[option] !== undefined ? `--${option}` : fromEnv(variable) !== undefined ? `the environment variable ${variable}` : 'the config file';
  if (withModel) {
    // Half a model from the environment: a variable left over from another session should give a
    // message that names it, not one about a setting the user never typed.
    const off = 'or pass --no-ai to scan without a model';
    if (settings.baseUrl === '' && settings.model !== '' && values['ai-model'] === undefined && fromEnv(ENV_MODEL) !== undefined) {
      io.stderr(`${ENV_MODEL} is set in the environment, which asks for a model, but no endpoint is given. Set ${ENV_BASE_URL} or pass --ai-base-url <url> as well, ${off}.\n`);
      return EXIT_ERROR;
    }
    if (settings.model === '' && settings.baseUrl !== '' && values['ai-base-url'] === undefined && fromEnv(ENV_BASE_URL) !== undefined) {
      io.stderr(`${ENV_BASE_URL} is set in the environment, which asks for a model, but no model is named. Set ${ENV_MODEL} or pass --ai-model <name> as well, ${off}.\n`);
      return EXIT_ERROR;
    }
  }
  try {
    createAdjudicator(settings, env);
    await verifyEndpoint(settings);
  } catch (error) {
    if (!(error instanceof AdjudicationConfigError)) throw error;
    io.stderr(`${safe(error.message)}\n`);
    return EXIT_ERROR;
  }

  // The pages of the run. A sitemap is fetched here, from the site under test, without the
  // stored session: the only request of a scan that is not made by the browser or to the model.
  let targets;
  try {
    targets = await collectTargets(
      {
        positionals: given,
        allowFileUrls: values['allow-file-urls'] === true,
        ...(values.urls !== undefined ? { urlsFile: values.urls } : {}),
        ...(values.sitemap !== undefined ? { sitemap: values.sitemap } : {}),
      },
      limits,
    );
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    io.stderr(`${safe(error.message)}\n`);
    return EXIT_ERROR;
  }
  for (const note of targets.notes) io.stderr(`${safe(note)}\n`);

  if (withModel) {
    // Said every time a model is asked, on stderr, whether flags, a file or the environment
    // alone switched it on: where page content goes is not something to find out later.
    const { hostname } = new URL(settings.baseUrl);
    const where = isLoopbackHost(hostname) ? 'this machine' : 'not this machine';
    const what = settings.sendImages ? 'Text and captures' : 'Text';
    io.stderr(
      safe(
        `A model is asked: ${what} of the page go to the model ${settings.model} on ${hostname} (${where}). ` +
          `Endpoint from ${origin('ai-base-url', ENV_BASE_URL)}, model from ${origin('ai-model', ENV_MODEL)}.\n`,
      ),
    );
  }

  /** One page, in a browser context of its own: nothing a page stores reaches the next one. */
  const scanPage = async (browser: Browser, target: PageTarget): Promise<{ result: ScanResult; crops: Record<string, Png> }> => {
    // A user name and password of the address go to the browser here, for that origin, and nowhere else.
    const context = await browser.newContext({
      ...(values['storage-state'] !== undefined ? { storageState: values['storage-state'] } : {}),
      ...(target.credentials ? { httpCredentials: target.credentials } : {}),
    });
    /** A page of a sitemap is held to its origin: a redirect must not send the scan elsewhere. */
    const heldToOrigin = (address: string): void => {
      if (!target.fromSitemap || !limits.sameOrigin || !URL.canParse(address)) return;
      const { origin } = new URL(address);
      if (origin !== new URL(target.address).origin) {
        throw new Error(`The page ended on another origin (${origin}) than the one of the sitemap entry, and was not scanned there (--any-origin scans it).`);
      }
    };
    try {
      const page = await context.newPage();
      const response = await page.goto(target.address, { waitUntil: 'load', timeout: limits.navigationTimeoutMs });
      if (limits.httpErrorIsFailure && response !== null && response.status() >= 400) {
        throw new Error(`The page answered with HTTP status ${response.status()}; an error page is not scanned in place of the page (--allow-http-errors scans it).`);
      }
      heldToOrigin(page.url());
      // The copies the name-role-value check probes in get the credentials of the address too, for its origin only.
      const probeContext = target.credentials ? { httpCredentials: { ...target.credentials, origin: new URL(target.address).origin } } : {};
      const scanner = new A11yVision({ page, probeContext }).options(input);
      if (withModel) {
        scanner.withAdjudication({}, { env, ...(values['no-ai-cache'] ? {} : { cacheFile: values['ai-cache'] ?? DEFAULT_CACHE_FILE }) });
      }
      const { result: read, crops, adjudication: stats } = await scanner.analyzeWithEvidence();
      // The page may have gone on to another document while it was read.
      heldToOrigin(read.url);
      // From here on, the texts that came from the page hold no session value and no credentials.
      const result = cleanResult(read, safe, shown);
      if (stats) io.stderr(`${safe(describeStats(stats))}\n`);
      if (result.environment.navigatedFrom !== undefined) {
        io.stderr(`The page went from ${safe(result.environment.navigatedFrom)} to ${safe(result.url)} while it was being read. The findings are those of ${safe(result.url)}.\n`);
      }
      return { result, crops };
    } finally {
      await context.close();
    }
  };

  const started = new Date().toISOString();
  const report: Run = { tool: { name: TOOL_NAME, version: TOOL_VERSION }, timestamp: started, pages: [], errors: [] };
  if (!single) report.input = { otherOrigin: targets.otherOrigin, overLimit: targets.overLimit, duplicates: targets.duplicates };
  const crops: Record<string, Png>[] = [];

  const browser = await chromium.launch();
  try {
    for (const [index, target] of targets.pages.entries()) {
      // The address as it may be written: the one that is opened stays in `target`.
      const url = safe(target.url);
      if (!single && !values.quiet) io.stderr(`${SUMMARY_PREFIX}Page ${index + 1} of ${targets.pages.length}: ${url}\n`);
      try {
        const scanned = await scanPage(browser, target);
        report.pages.push({ requestedUrl: url, result: scanned.result, ...(single ? {} : { cropsDir: pageDirectory(index, targets.pages.length, url) }) });
        crops.push(scanned.crops);
      } catch (error) {
        const message = safe((error as Error).message);
        if (single) {
          io.stderr(`Scan failed: ${message}\n`);
          return EXIT_ERROR;
        }
        // Reported, and the run goes on: one page that is down should not hide the others.
        report.errors.push({ url, message: firstLine(message) });
        io.stderr(`Not scanned: ${url}: ${firstLine(message)}\n`);
      }
    }
  } finally {
    await browser.close();
  }

  try {
    let summary: BaselineSummary | undefined;
    if (baseline !== null && values.baseline !== undefined) {
      // An entry is only known to be gone when its check ran on the page that was asked for.
      const compared = compareWithBaseline(
        report.pages.map((page) => ({ url: page.requestedUrl, findings: page.result.findings, checks: config.checks, finalUrl: page.result.url })),
        baseline,
        { update: values['update-baseline'] === true, prune: values['prune-baseline'] === true, redactQueryParams: limits.redactQueryParams },
      );
      for (const moved of compared.moved) {
        io.stderr(`The page ${moved.url} ended on ${moved.finalUrl}: what the baseline records for ${moved.url} was not looked for there, and is kept as it is.\n`);
      }
      report.pages.forEach((page, index) => {
        page.result = { ...page.result, findings: compared.pages[index]!.findings };
      });
      summary = compared.summary;
      report.baseline = summary;
      if (values['update-baseline'] || values['prune-baseline']) await writeAtomic(values.baseline, serializeBaseline(compared.baseline));
    }

    const counts = countRun(report);
    const exitCode = counts.errors > 0 ? EXIT_ERROR : counts.newFail > 0 ? EXIT_FAILURES : EXIT_OK;

    // Nothing is replaced in a serialised report: the texts in it were cleaned when the page was read.
    const [first] = report.pages;
    const json = `${JSON.stringify(single ? toJsonReport(first!.result, summary ? { baseline: summary } : {}) : toJsonRunReport(report), null, 2)}\n`;
    if (values.output) await writeTo(values.output, json);
    else io.stdout(json);
    if (values.html) await writeTo(values.html, single ? toHtmlReport(first!.result, crops[0], summary ? { baseline: summary } : {}) : toHtmlRunReport(report, crops));
    if (values.sarif) {
      // The same file whichever way its separators are written.
      const forward = (path: string): string => resolve(path.replaceAll('\\', '/'));
      const sameFile = anchor !== null && values.urls !== undefined && forward(values['sarif-anchor']!) === forward(values.urls);
      const { sarif, omitted } = toSarifReport(report, {
        includeInfo: values['sarif-include-info'] === true,
        urlKey: baseline?.urlKey ?? config.baseline,
        maxResults: limits.sarifMaxResults,
        redactQueryParams: limits.redactQueryParams,
        ...(anchor !== null ? { anchor: { uri: anchor, ...(sameFile ? { lines: targets.lines } : {}) } } : {}),
      });
      await writeTo(values.sarif, `${JSON.stringify(sarif, null, 2)}\n`);
      if (omitted > 0) io.stderr(`${omitted} result(s) were left out of the SARIF file, the least severe first, to stay under ${limits.sarifMaxResults} results (run.sarifMaxResults). The JSON and HTML reports have them all.\n`);
    }
    if (values.crops) {
      for (const [index, page] of report.pages.entries()) {
        for (const [id, png] of Object.entries(crops[index] ?? {})) await writeTo(join(values.crops, page.cropsDir ?? '', id), png);
      }
    }
    if (!values.quiet) for (const line of summaryLines(counts, summary, exitCode)) io.stderr(line);
    return exitCode;
  } catch (error) {
    io.stderr(`Scan failed: ${safe((error as Error).message)}\n`);
    return EXIT_ERROR;
  }
}
