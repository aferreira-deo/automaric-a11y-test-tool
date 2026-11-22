/**
 * The part of the adjudicator layer that needs Node (`node:http`, `node:dns`): the transport for
 * an endpoint on this machine, and the check of what its name resolves to. Imported as
 * `@a11y-vision/adjudicators/node` by code that runs in Node (the Playwright API, the CLI); the
 * main entry of the package loads it by itself, and only when it runs in Node.
 */
export { createLoopbackFetch, verifyEndpoint } from './loopback-fetch.js';
export type { LookupAll } from './loopback-fetch.js';
