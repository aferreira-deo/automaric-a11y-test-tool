# a11y-vision (working name)

Automated checks for WCAG 2.2 A/AA criteria that rule engines such as axe-core do not cover.
Deterministic code finds and measures; a model, when one is configured, only judges.

Status: M0 (scaffold). No accessibility check is implemented yet; the only check is `noop`,
which exists to exercise the pipeline.

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
node packages/cli/dist/bin.js scan https://example.com
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
