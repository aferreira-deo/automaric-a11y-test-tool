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

Chromium only.

### What a scan does to the page

While it runs, the scan changes the page: device scale factor 2, reduced motion, an adopted style sheet that
removes transitions, animations, the caret and the selection highlight, keyboard focus, scroll positions, and the
text selection of fields it tabs into. Focus and blur events reach page scripts, as they would for a keyboard user.

Put back afterwards:

- keyboard focus, on the element that had it (set from script, so `:focus-visible` may differ from before);
- scroll position of the window, of same-origin iframes and of every scroll container;
- the style sheet, and any `tabindex` the walk had to set on a cross-origin iframe (see below);
- through the Playwright API and the CLI: the emulation Playwright applies for the context and the page, that is
  viewport, `deviceScaleFactor`, `isMobile`, and everything set with `emulateMedia` or the matching context options.

Not put back:

- text selection inside fields, and anything page scripts did in response to focus and blur;
- the `screen` context option of Playwright: after a scan `screen.width` and `screen.height` equal the viewport size;
- with a bare CDP session (`collectSnapshot`): Chrome holds one device-metrics override and one emulated media type
  per page and cannot report them, so the collector clears both when it ends. A caller that had set them through
  another session must set them again.

During the scan a context created with `isMobile` is measured with mobile emulation off, in a viewport of the page's
layout size (`innerWidth` by `innerHeight`). The layout width is kept, but for a page without a viewport meta tag
that is larger than the device screen, so more of the page counts as on screen than on the device.

### Known limits of the focus check

- Content inside cross-origin iframes and closed shadow roots is not measured. The walk tabs through a cross-origin
  iframe; after `maxTabsInOpaqueFrame` presses (50) it sets `tabindex="-1"` on the iframe for the rest of the walk to
  step past it, which page scripts can observe.
- 2.4.11 is hit-tested inside the element's own document: an overlay in a parent document covering an iframe is not
  seen, nor is an overlay with `pointer-events: none`. It is a `fail` only when every sampled point is under fixed or
  sticky content with full opacity and a solid background colour. Under a translucent colour, an image or a gradient
  it is `likely`, or `info` when the focus change is visible through the cover.
- Elements the Tab walk did not reach are measured with a forced pseudo-state and never reported above `likely`.
- No `fail` is reported, only `likely` or `info`, when the evidence is incomplete: the element takes focus back on
  blur (no unfocused capture), it reaches beyond the viewport (its edges are off screen), more changed regions were
  found than `maxComponents` (the smaller ones are not measured), or an author `!important` rule keeps a transition
  or animation running (flag `unstabilised`).
- The stabilising style sheet is a constructed sheet, which a Content-Security-Policy does not block. Pseudo-elements
  and labels are not checked for author rules that outweigh it.

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
