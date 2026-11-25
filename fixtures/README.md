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

`headings/not-a-heading` and `headings/not-a-heading-controls` go together, for the rule
`headings/heading-not-a-heading`: the first holds heading markup on text that is no heading, the second real
headings that share one trait with it, and gives nothing but the survey. `e2e/headings.spec.ts` takes away what
holds the controls back (the pictures between card titles, the closed panels, the pointer) and expects the
findings to appear.

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
name, with nothing else `likely`. Eight of the nine sets come back; the ninth is the first of two sections with
the same names, which is reported once, with the second.

`grouping/choice-sets`, `grouping/grouped-sets` and `grouping/precision` go together: the first holds sets
under a text that nothing ties to them, the second the ways such a set is tied or needs no group, the third
whole forms as careful sites build them (login, signup, checkout, filters, settings, a cookie banner), which
must give no `likely`. `grouping/real-pages` holds the patterns that were reported wrongly or missed on real
pages while the check was built; each comment says where. `grouping/formulaire-fr` is in French: the rules use
no word of any language. `grouping/review-sets` and `grouping/review-fields` hold what a review of the check
found: sets and rows that were reported wrongly (the question in the names after a colon, captions over the parts
of a date, a note about required fields, lines of consent, log in and sign up in two regions of one form), at
the wrong status (names and sentences in Japanese, a question that is the description of the options, sections
under headings), with the wrong text (a label in two boxes on one line) or not at all (a part named by its
placeholder only). `e2e/grouping.spec.ts` has the tests that look at the page during the scan, at what a model
is asked, at the work done on a large page, and at a page with more controls than are marked from the
accessibility tree: what stands before the limit keeps its status, and the survey gives the real number of
controls.

`icon-contrast/assets/fixture-icons.ttf` is the icon font of the icon-contrast
fixtures. It is written by `icon-contrast/assets/make-font.mjs`, not downloaded,
so it carries no third-party licence.

The `reflow/*` fixtures each hold one pattern of 1.4.10 and are measured at the baseline, at 320 by 800 and at
800 by 256. True positives (`fixed-width`, `overflow-hidden-body`, `clipped-boxes`, `columns-collide`,
`sticky-40`, `sticky-after-scroll`, `cookie-banner`, `nested-scroller`, `scroll-locked`, `horizontal-by-design`,
`horizontal-locked`) stand beside the patterns that must raise nothing above `info` (`table-scroller`,
`table-widens`, `wide-media`, `overlap-at-baseline`, `overlays-by-design`, `sticky-70`, `scrollers-by-design`,
`invisible-overflow`, `offcanvas-menu`, `clean-responsive`); most are `exact`. `restore-state` has no manifest:
`e2e/reflow.spec.ts` uses it to check that the page is given back as it was, also after a stopped scan.

The `name-role-value/*` fixtures are probed (their controls are activated) unless nothing on them listens.
`names` is static and is also scanned from the extension, which never probes. `well-built` is a page made as a
React application renders it, with the patterns of the ARIA practices done right, and must give no `fail` and
no `likely` with probing on; `link-button`, `states` and `roles` hold true positives and true negatives side by
side; `formulaire-fr` is in French. `safety` holds controls that each write to the fixture server when really
clicked (`/_nrv/write/<session>/`, `/_nrv/nav/<session>/`, a WebSocket under `/_nrv/ws/<session>`, read back
from `/_nrv/log/<session>`); `e2e/name-role-value.spec.ts` checks that a real click on them writes, and that a
scan that probes them writes nothing.
