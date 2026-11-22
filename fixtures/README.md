# Fixtures

Each fixture is a static page `fixtures/<check>/<name>.html` with a manifest
`<name>.expected.json` next to it. The manifest is written before the check
that has to satisfy it.

```json
{
  "description": "What the page demonstrates.",
  "checks": ["focus-indicator"],
  "expected": [
    { "selector": "#bad", "check": "focus-indicator", "status": "fail", "wcag": "2.4.7", "rule": "optional" }
  ]
}
```

How a run is compared (`e2e/support/manifest.ts`):

- Every `expected` entry must be matched by a finding with the same selector,
  check and status (and `wcag` / `rule` when given).
- Any `fail` or `likely` finding that no entry expects fails the test. A page
  meant to pass therefore lists no `fail` and no `likely`.
- Unexpected `advisory` and `info` findings are tolerated, unless the manifest
  sets `"exact": true`.
- Each fixture is analysed twice and the two sets of findings must be equal.

`icon-contrast/assets/fixture-icons.ttf` is the icon font of the icon-contrast
fixtures. It is written by `icon-contrast/assets/make-font.mjs`, not downloaded,
so it carries no third-party licence.
