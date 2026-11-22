# a11y-vision (working name)

Automated checks for WCAG 2.2 A/AA criteria that rule engines such as axe-core do not cover.
Deterministic code finds and measures; a model, when one is configured, only judges.

Status: M1. One check is implemented, `focus-indicator` (2.4.7, 1.4.11 for the indicator, 2.4.11), with no AI involved.

## Use

```sh
node packages/cli/dist/bin.js scan https://example.com --html report.html --crops crops -o report.json
```

Exit code 1 means at least one `fail`. `likely`, `advisory` and `info` never fail a run.

```ts
import { A11yVision } from '@a11y-vision/playwright';

const result = await new A11yVision({ page }).analyze();
```

Chromium only. While it runs, the scan changes the page (device scale factor 2, reduced motion, a style sheet that
removes transitions and the caret, focus and scroll position) and restores it afterwards. Focus and blur events do
reach page scripts.

Known limits of the focus check: content inside cross-origin iframes and closed shadow roots is not measured; an
overlay in a parent document covering an iframe is not seen by the 2.4.11 test; elements outside the Tab order are
measured with a forced pseudo-state and never reported above `likely`.

## Development

Requires Node 22.12+ (CI uses 24). pnpm is pinned in `package.json` and run through corepack.

```sh
corepack pnpm install
corepack pnpm exec playwright install chromium
corepack pnpm check        # lint, build, typecheck, unit tests, browser tests
```

Individual steps: `lint`, `build`, `typecheck`, `test` (vitest), `test:browser` (Playwright).
`typecheck` and `test:browser` read the packages through their built output, so run `build` first.

```sh
node e2e/support/fixture-server.mjs 4173 &   # then, to print findings next to manifests:
node e2e/support/dump.mjs focus-indicator/gradient
```

## Layout

| Path | Role |
|---|---|
| `packages/core` | Types, result schema, pure checks and measurers. No Node or DOM APIs: its tsconfig loads neither. |
| `packages/collector-cdp` | Builds a `Snapshot` over a minimal CDP session interface. |
| `packages/adjudicators` | Model adapters (interface only until M4). |
| `packages/reporters` | JSON report in the axe result shape; our data sits under `a11yVision`. |
| `packages/playwright` | `new A11yVision({ page }).analyze()` |
| `packages/cli` | `scan <url>` |
| `packages/extension` | Placeholder until M8. |
| `fixtures/` | Test pages with expected-findings manifests, see `fixtures/README.md`. |
| `e2e/` | Browser tests: every fixture against its manifest, and the CLI. |
