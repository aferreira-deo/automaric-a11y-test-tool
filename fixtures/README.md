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
- The fixtures of the checks that take captures are also run once each in
  contexts with `deviceScaleFactor` 1.5 and 2 (`e2e/fixtures-scale.spec.ts`),
  against the same manifests: results must not depend on the device pixel
  ratio the page comes with.

The `headings/source-*` fixtures are well-marked pages: as they are, they must give no `fail` and no `likely`.
`e2e/headings-mutation.spec.ts` replaces each of their headings with a `div` that keeps its attributes (their
styles are set by class) and expects at least 90% of them back as candidates, and at least 90% as `likely`, with
nothing else `likely`.

The `lists/source-*` fixtures are well-marked pages as well. `e2e/lists-mutation.spec.ts` replaces every `ul`,
`ol` and `li` by a `div` that keeps its attributes and expects every list back as `likely`, with nothing else
`likely`.

`lists/lookalikes` and `lists/more-lists` go together: the first holds lines that open like items and are not
(dialogue, a quoted reply, ratings, alerts, calls to action, accordion titles, a legend, temperatures, dates,
initials, a chat, a feed) and must give no `likely`; the second holds the lists that the same rules must still
let through. A rule that is tightened for one has to keep the other green.

`lists/modal-shadow`, `lists/modal-in-shadow` and `lists/content-hidden` open a dialog or depend on what the
browser renders: `e2e/lists.spec.ts` has the tests that look at boxes, at the page during the scan and at the
work done on a large page.

The `grouping/source-*` fixtures are well-marked forms. `e2e/grouping-mutation.spec.ts` replaces every
`fieldset` and `legend` by a `div` that keeps its attributes, removes the group roles and their names, and
expects each set back at the status its `data-expect` attribute says: `likely` for sets of radios or checkboxes
and for a section whose field names are those of another, `advisory` for the parts of a date that each have a
name, with nothing else `likely`.

`grouping/choice-sets`, `grouping/grouped-sets` and `grouping/precision` go together: the first holds sets
under a text that nothing ties to them, the second the ways such a set is tied or needs no group, the third
whole forms as careful sites build them (login, signup, checkout, filters, settings, a cookie banner), which
must give no `likely`. `grouping/real-pages` holds the patterns that were reported wrongly or missed on real
pages while the check was built; each comment says where. `grouping/formulaire-fr` is in French: the rules use
no word of any language. `e2e/grouping.spec.ts` has the tests that look at the page during the scan, at what a
model is asked, and at the work done on a large page.

`icon-contrast/assets/fixture-icons.ttf` is the icon font of the icon-contrast
fixtures. It is written by `icon-contrast/assets/make-font.mjs`, not downloaded,
so it carries no third-party licence.
