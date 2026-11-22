// Asks the endpoint given as the first argument one question, through the adapter as it is built,
// and prints the result as JSON. Run as a child process by the tests that need a Node process
// started with a particular environment (proxy variables, for instance). The key, if any, is read
// from PROBE_KEY. No test points this at anything but a mock on this machine.
import { createAdjudicator } from '@a11y-vision/adjudicators';
import { resolveAdjudication } from '@a11y-vision/core';

const [baseUrl] = process.argv.slice(2);
const settings = resolveAdjudication({
  provider: 'openai-compatible',
  baseUrl,
  model: 'm',
  apiKeyEnv: process.env['PROBE_KEY'] ? 'PROBE_KEY' : '',
  timeoutMs: 5000,
});
const adjudicator = createAdjudicator(settings, process.env);
const result = await adjudicator.judge({ check: 'headings', question: 'Q?', crops: [], context: { text: 'hello' } });
process.stdout.write(`${JSON.stringify(result)}\n`);
