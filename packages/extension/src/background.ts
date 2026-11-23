import { pageRestore } from '@a11y-vision/collector-cdp';
import { registerBackground } from './background-core.js';
import type { ChromeApi } from './chrome-api.js';
import { extensionConfig } from './config.js';
import { WATCH_WORLD, watchStopExpression } from './interference.js';

declare const chrome: ChromeApi;

registerBackground(chrome, {
  // What the collector and the watch put into the page, each undone by its own code, in its own world.
  steps: [pageRestore, { worldName: WATCH_WORLD, expression: watchStopExpression }],
  timeoutMs: extensionConfig.panelClosed.restoreTimeoutMs,
  settle: extensionConfig.panelClosed,
});
