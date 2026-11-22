import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { AdjudicationConfigError, createAdjudicator, describeStats, isLoopbackHost, redact, secretsOf } from '@a11y-vision/adjudicators';
import { verifyEndpoint } from '@a11y-vision/adjudicators/node';
import { defaultConfig, hasFailures, registeredChecks, resolveConfig, TOOL_NAME, TOOL_VERSION } from '@a11y-vision/core';
import type { AdjudicationConfig, CheckId, ConfigInput } from '@a11y-vision/core';
import { A11yVision } from '@a11y-vision/playwright';
import { toHtmlReport, toJsonReport } from '@a11y-vision/reporters';
import { chromium } from 'playwright';

export const EXIT_OK = 0;
/** At least one `fail` finding. */
export const EXIT_FAILURES = 1;
/** Usage error or the scan itself could not run. */
export const EXIT_ERROR = 2;

/** Prefix of the environment variables the CLI reads, from the tool name: A11Y_VISION_. */
const ENV_PREFIX = `${TOOL_NAME.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_`;
export const ENV_BASE_URL = `${ENV_PREFIX}AI_BASE_URL`;
export const ENV_MODEL = `${ENV_PREFIX}AI_MODEL`;
export const ENV_KEY_ENV = `${ENV_PREFIX}AI_KEY_ENV`;
/** Where verdicts are kept between runs unless told otherwise, relative to the working directory. */
export const DEFAULT_CACHE_FILE = join(`.${TOOL_NAME}`, 'verdicts.json');

const USAGE = `Usage: ${TOOL_NAME} scan <url> [options]

Options:
  -o, --output <file>   Write the JSON report to a file instead of stdout
      --html <file>     Also write a self-contained HTML evidence report
      --crops <dir>     Also write the evidence crops as PNG files; the ids in
                        "evidence.crops" are paths relative to this directory
      --checks <ids>    Comma-separated checks to run (default: ${defaultConfig.checks.join(', ')};
                        available: ${registeredChecks().join(', ')})
      --config <file>   JSON file with settings (checks, focus, icon, headings,
                        adjudication); the options given here win over it
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
      --ai-lower-on-no      Lower a "likely" heading candidate to "info" when the
                            model says it is not a heading. Off by default: the
                            finding stays listed, with the verdict shown
      --ai-text-only        Send no captures (for a model without vision)
      --ai-cache <file>     Where verdicts are kept between runs
                            (default: ${DEFAULT_CACHE_FILE})
      --no-ai-cache         Keep no verdicts
      --no-ai               Ask no model, whatever the environment or the
                            config file say

Exit codes: 0 no "fail" finding, 1 at least one "fail" finding, 2 error.
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

async function readConfigFile(file: string): Promise<ConfigInput> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read the config file ${file}: ${(error as Error).message}`, { cause: error });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`The config file ${file} has to hold a JSON object.`);
  const input = value as Record<string, unknown>;
  for (const section of ['focus', 'icon', 'headings', 'adjudication']) {
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

export async function main(argv: string[], io: Io = processIo, env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        output: { type: 'string', short: 'o' },
        html: { type: 'string' },
        crops: { type: 'string' },
        checks: { type: 'string' },
        config: { type: 'string' },
        'ai-base-url': { type: 'string' },
        'ai-model': { type: 'string' },
        'ai-key-env': { type: 'string' },
        'ai-label': { type: 'string' },
        'ai-allow-remote': { type: 'boolean' },
        'ai-lower-on-no': { type: 'boolean' },
        'ai-text-only': { type: 'boolean' },
        'ai-cache': { type: 'string' },
        'no-ai-cache': { type: 'boolean' },
        'no-ai': { type: 'boolean' },
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

  const [command, url, ...rest] = positionals;
  if (command !== 'scan' || !url || rest.length > 0) {
    io.stderr(USAGE);
    return EXIT_ERROR;
  }
  if (!URL.canParse(url)) {
    io.stderr(`Not a valid URL: ${url}\n`);
    return EXIT_ERROR;
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
  const adjudication: Partial<AdjudicationConfig> = { ...fromFile.adjudication };
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
  if (values['ai-lower-on-no']) adjudication.headingNoStatus = 'info';
  if (values['no-ai']) adjudication.provider = 'none';
  // Asked for here or in the environment: that selects the adapter, whatever the file says. From
  // the file alone, an endpoint or a model selects it unless the file names a provider itself.
  else if (baseUrl !== undefined || model !== undefined) adjudication.provider = 'openai-compatible';
  else if (adjudication.provider === undefined && (adjudication.baseUrl || adjudication.model)) adjudication.provider = 'openai-compatible';

  const input: ConfigInput = { ...fromFile, adjudication, ...(checks ? { checks: checks as CheckId[] } : {}) };
  const settings = resolveConfig(input).adjudication;
  // Whatever is printed below that this program did not write itself goes through this.
  const secrets = secretsOf(settings, env);
  const safe = (text: string): string => redact(text, secrets);
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

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load' });
    const scanner = new A11yVision({ page }).options(input);
    if (withModel) {
      scanner.withAdjudication({}, { env, ...(values['no-ai-cache'] ? {} : { cacheFile: values['ai-cache'] ?? DEFAULT_CACHE_FILE }) });
    }
    const { result, crops, adjudication: stats } = await scanner.analyzeWithEvidence();
    if (stats) io.stderr(`${safe(describeStats(stats))}\n`);

    const json = `${JSON.stringify(toJsonReport(result), null, 2)}\n`;
    if (values.output) await writeTo(values.output, json);
    else io.stdout(json);
    if (values.html) await writeTo(values.html, toHtmlReport(result, crops));
    if (values.crops) {
      for (const [id, png] of Object.entries(crops)) await writeTo(join(values.crops, id), png);
    }
    return hasFailures(result) ? EXIT_FAILURES : EXIT_OK;
  } catch (error) {
    io.stderr(`Scan failed: ${safe((error as Error).message)}\n`);
    return EXIT_ERROR;
  } finally {
    await browser.close();
  }
}
