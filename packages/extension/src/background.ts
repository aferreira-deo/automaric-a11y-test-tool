import { registerBackground } from './background-core.js';
import type { ChromeApi } from './chrome-api.js';

declare const chrome: ChromeApi;

registerBackground(chrome);
