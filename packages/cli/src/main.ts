import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { hasFailures, registeredChecks, TOOL_NAME, TOOL_VERSION } from '@a11y-vision/core';
import type { CheckId } from '@a11y-vision/core';
import { A11yVision } from '@a11y-vision/playwright';
import { toJsonReport } from '@a11y-vision/reporters';
import { chromium } from 'playwright';

export const EXIT_OK = 0;
/** At least one `fail` finding. */
export const EXIT_FAILURES = 1;
/** Usage error or the scan itself could not run. */
export const EXIT_ERROR = 2;

const USAGE = `Usage: ${TOOL_NAME} scan <url> [options]

Options:
  -o, --output <file>   Write the JSON report to a file instead of stdout
      --checks <ids>    Comma-separated checks to run (available: ${registeredChecks().join(', ')})
  -h, --help            Show this help
  -v, --version         Show the version

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

export async function main(argv: string[], io: Io = processIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        output: { type: 'string', short: 'o' },
        checks: { type: 'string' },
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

  const known = new Set<string>(registeredChecks());
  const checks = values.checks
    ?.split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const unknown = checks?.filter((id) => !known.has(id)) ?? [];
  if (unknown.length > 0) {
    io.stderr(`Unknown check(s): ${unknown.join(', ')}. Available: ${[...known].join(', ')}\n`);
    return EXIT_ERROR;
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load' });
    const scanner = new A11yVision({ page });
    if (checks) scanner.withChecks(checks as CheckId[]);
    const result = await scanner.analyze();
    const json = `${JSON.stringify(toJsonReport(result), null, 2)}\n`;
    if (values.output) {
      await writeFile(values.output, json);
    } else {
      io.stdout(json);
    }
    return hasFailures(result) ? EXIT_FAILURES : EXIT_OK;
  } catch (error) {
    io.stderr(`Scan failed: ${(error as Error).message}\n`);
    return EXIT_ERROR;
  } finally {
    await browser.close();
  }
}
