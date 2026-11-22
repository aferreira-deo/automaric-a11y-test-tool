/** The only place the tool name lives in code. Package scopes in the manifests are renamed separately. */
export const TOOL_NAME = 'a11y-vision';
/** Kept in sync with packages/core/package.json by core.test.ts (core cannot read files). */
export const TOOL_VERSION = '0.0.0';
/** Key under which our richer data sits inside the axe-compatible JSON report. */
export const EXTENSION_KEY = 'a11yVision';
