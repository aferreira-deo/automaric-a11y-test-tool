# a11y-vision (working name)

Automated checks for WCAG 2.2 A/AA criteria that rule engines such as axe-core do not cover.
Deterministic code finds and measures; a model, when one is configured, only judges.

Status: M3. Three checks are implemented, with no AI involved, and all run by default:

- `focus-indicator`: 2.4.7, 1.4.11 for the indicator, 2.4.11.
- `icon-contrast`: 1.4.11 for the icon of controls without visible text, and for the boundary of form controls.
- `headings`: 1.3.1 for text that looks like a heading and is not exposed as one, and for heading levels that
  contradict the visual order. It never reports a `fail`.

`--checks focus-indicator`, `--checks icon-contrast` or `--checks headings` runs one of them.

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

### What `headings` reports

Text that functions as a heading without being exposed as one, and heading levels that contradict the visual order
(1.3.1). No model is involved, and nothing is ever a `fail`: whether text functions as a heading is a judgement.

Candidates come from what is rendered, not from tags:

1. **Text blocks.** Visible text nodes are grouped into blocks: the text laid out together in one block container.
   A `br` splits a block only where the style changes across it (`<b>Title</b><br>text`); where it does not, the
   two lines are joined with a space. Boxes of one style that sit on one line inside one parent, no further apart
   than words are (`mergeMaxGapEm`, 0.4 of the font size), are one block: the words of a title set as inline
   blocks or as flex items. Boxes that are something of their own (a link, a button, a cell, a list item) are
   never joined. Hidden text is left out: not displayed, clipped, transparent, off screen, of no size.
2. **Body style.** The most common font size and weight by number of characters, inside `main` when it holds
   enough text: at least `baselineMinChars` (200) characters in that style and `baselineMainMinShare` (0.1) of the
   plain text of the page; otherwise on the whole page. Headings, links, buttons, labels, navigation, code and
   text under `aria-hidden` do not count, so that a wall of links does not set it. When the whole page has fewer
   than `baselineMinChars` characters in its most common style, the body style is not trusted: no candidate is
   above `info`, and candidates and the survey carry the flag `lowText`.
3. **Exposed headings.** Taken from the accessibility tree of each document (`Accessibility.getFullAXTree`), not from
   tags: an `h2` with `role="presentation"` is not one, a `div` with the role heading is.
4. **Prominence.** A block that is no heading is looked at when it is larger than body text (`minSizeRatio`, 1.3),
   bolder (`minWeightDelta`, 200; at about body size, or smaller when in capitals), or has exactly the style
   (family, size, weight, colour, transform) of a real heading of the page that itself stands out from body text
   (`matchesHeadingStyle`). It must be short (`maxWords` 20, `maxLines` 3; 12 words when it is only bolder) and of
   one style.
5. **Position, from boxes.** Alone on its line, followed by text that starts under it, and not by something set as
   a title of its size or larger. Up to `besideControlsMax` (2) buttons or links beside it on its line are passed
   over ("View all" at the end of the row of a title).

- `likely` (`headings/unmarked-heading`): prominent, in position, and nothing speaks against it.
- `info` (`headings/heading-candidate`): prominent, with a reason against it as a flag. By markup: `label`
  (also legends), `caption`, `tableHeader`, `tableCell`, `term`, `button`, `link` (all of it is a link), `quote`,
  `code`, `navigation`, `ariaHidden`, `listItem`. By content: `numeric` (mostly digits, or with a currency or
  percent sign: a price, a figure, a date), `statistic` (short and opening with a number: "15 years", but also
  "2026 roadmap"), `peersNumeric` ("Free" among prices), `quotation`, `italic` (large italics of normal weight: a
  pull quote), `sentence`, `colon`, `lineBreaks`, `repeatedText` (the same text in the same style at least
  `repeatedTextMinCount` (3) times on the page: a badge under every product), `sameColourAsBackground`. By
  position: `notFollowed`, `repeated` (a series in one style), `headsControl` (a tagline over a call to action),
  `tightAbove` (bold text of body size with less space above than below), and two for text that is only bolder
  than body text: `shortFollower` (what follows is one plain block that is no longer than it, or one line of at
  most `shortFollowerMaxWords` (15) words that is no sentence, and nothing of that style after it: a label over a
  value) and `labelSeries` (label, such a line, label again: keys and values, names in a feed).
- Numbered titles are not numbers: "1. Scope", "2) Method", and one or two digits, with or without parts after
  dots, before a capital letter ("1 Introduction", "1.2 Requirements") (`ordinalStartPattern`).
- Not reported at all: text beside other text on its line, a row of peers, and text that has a reason by markup or
  content and also heads nothing (a navigation link, a table cell).
- `advisory` or `likely` (`headings/level-inversion`): inside one region (landmark, `article`, `dialog`), a heading
  coded above a preceding heading that is visibly larger, or visibly larger than the heading it is coded under.
  Visual rank is font size, from a ratio of 1.15. `likely` only when the two are at least 2 levels apart and differ
  by 1.5 in size; both statuses are options (`inversionStatus`, `extremeInversionStatus`), an open decision of the
  owner. The options take `advisory` or `likely` only: `fail` is turned into `likely`, anything else into the
  default, when the configuration is resolved and again where the status is computed. One oversized heading is
  reported once, on itself; the headings after it are not reported as smaller than it. At most `maxInversions`
  (50) are reported. Skipped levels, a missing or repeated `h1`, a page without headings and repeated heading text
  are never reported.
- `info` (`headings/survey`): counts, and the body style that was used.

Every candidate comes with its text, its style and that of body text, the text that follows it, and a capture of
the block in context when one could be taken. When the accessibility tree cannot be read, nothing is above `info`
(`axIncomplete`).

The patterns that end a sentence, open a quotation or number a title are options and hold no words of any language.

#### Hand-off to the adjudicator layer (M4)

`headingCandidates(snapshot.headings, config.headings)` in `@a11y-vision/core` gives the candidates as data. Each
has:

- `findingId`: the id of its finding. It is a fingerprint of the element under one constant key
  (`headings/candidate`), not of the rule name, which follows the status: the id stays the same when a candidate
  goes from `info` to `likely` or back, between two runs or after a verdict.
- `status`: `likely` or `info`, never anything else, and `adjudicate`: false where a judgement would change
  nothing (a label, a price, text hidden from assistive technology, an accessibility tree that could not be read).
  Short titles that open with a number, text in the style of prices, repeated text and what the position says are
  left to a judgement.
- `crop`: a key of the snapshot clips, **or null**. A candidate with `adjudicate` true can have no capture: under
  a fixed banner or dialog (`covered`), in a transformed frame, outside the viewport. M4 has to handle that case:
  judge from `context` alone, or leave the candidate as it is. `box` is the part of the capture to outline.
- `context`: text, style, body style, features, reasons, the text before and after (cut to
  `contextBeforeMaxChars` and `contextAfterMaxChars`), and `sameTextAndStyle`, the number of blocks of the page
  with this text in this style: one judgement can serve them all.

`context` and the captures hold text of the page under test. They leave the machine only when they are sent to a
model, which happens only when a provider is configured; without one nothing is sent anywhere, and the candidates
are reported as they are. Page text is untrusted data.

### What `icon-contrast` reports

Everything is measured on a capture of the control at rest, at device scale factor 2. The scale of each capture is
worked out from its size in pixels, not assumed, so a page that already had that ratio is measured the same way.

**Icons.** Candidates are links, buttons, `summary`, button inputs and elements with the role `button`, `link`,
`menuitem` or `tab` that show no visible text and do show a graphic: inline SVG, `img`, an icon-font glyph, a CSS
background image, a mask image, pseudo-element content, or shapes drawn with CSS. Visually hidden text is not visible
text. A text character used as an icon in a text node (`×`) is text: its contrast is left to axe.

- The icon colour is the computed colour when one opaque colour paints the whole graphic (SVG shapes that share a
  fill or stroke, an icon-font glyph, the background colour under a mask) and the capture confirms it. Otherwise it is
  read from pixels, where opacity, filters and images have had their effect.
- The background is what surrounds the graphic inside the control, so a white icon on a blue button is measured
  against the blue.
- `fail`: one colour, on one background colour, under `likelyBandFloor` (2.7:1).
- `likely`: from 2.7:1 to 3:1; an icon of several colours with a part under 3:1; a background of several colours
  (a gradient, a picture) with one under 3:1 against the icon; strokes too thin for any pixel to show their colour;
  a control that looks inactive, may be a logotype or a colour swatch, or has visible text outside it as its label
  (see the hints below); any doubt about the capture.
- `info`: everything measured at 3:1 or more, disabled controls (`disabled`, a disabled `fieldset`, `aria-disabled`),
  pictures of many colours, and controls that could not be measured. The reason is a flag of the finding: `covered`,
  `cover-unknown`, `moving`, `detached`, `transformed-frame`, `no-box`, `outside-viewport`.

A control is measured only when Chrome's own hit test, run from the top document at a grid of points over it, finds
nothing in front of it. That hit test does not skip `pointer-events: none` and names pseudo-elements, so a backdrop of
the parent page over an iframe, a layer that lets clicks through and a veil painted by `::before` or `::after` of an
ancestor all count. Content in front that paints nothing (no background, border, shadow or text of its own, or
opacity 0) does not, and what lies under it is looked at in turn.

**Boundaries.** Candidates are text fields, `textarea`, `select`, checkboxes, radios and switches, native or by role.
For the middle of each side, the colours from 3 CSS px outside the box to 4 CSS px inside are collected, and the
highest contrast between two of them is the result. That covers a border against the page, a border against the fill,
a fill against the page and a ring drawn with `box-shadow`, and one side is enough (an underline). For a field, the
elements wrapped tightly around it that draw a box of their own are measured too.

- `likely`: no edge reaches 3:1. Never `fail`: whether the boundary is what identifies the control is a judgement.
- `info`: an edge at 3:1 or more; a native control whose look no author rule changes (exempt, like the default focus
  ring); a low `select`, because its arrow may identify it.

The report shows, for every finding, the capture, the two colours and the ratio, and for icons where the colour came
from (`declaredColour` or `pixelColour`).

### What a scan does to the page

While it runs, the scan changes the page: device scale factor 2 (set as an override even when the page already has
that ratio, because captures do not honour a ratio emulated through another session), reduced motion, an adopted
style sheet that removes transitions, animations, the caret and the selection highlight, keyboard focus, scroll
positions, and the text selection of fields it tabs into. Focus and blur events reach page scripts, as they would for
a keyboard user. To look under a transparent layer, a second style sheet that turns `pointer-events` on everywhere is
adopted and dropped within one script task; nothing is painted with it.

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

The icon check also blurs the focused element before it looks at the controls, so that a focus ring is not measured
as part of a control. Focus is put back with everything else.

The headings check reads the accessibility tree of the page and of its same-origin iframes, and scrolls each block
it reports into view to capture it. It changes nothing else.

### Known limits of the headings check

- One viewport width and one state: the page as it is. Text that shows only at another width, on hover or after an
  interaction is not read. Text inside scroll containers is read; text clipped by `overflow: hidden` is not (the
  slides of a carousel that are off screen).
- Headings inside images, canvas and SVG are not found. Nor is text generated by CSS (`::before`, `::after`): a
  title that exists only as `content` is not seen.
- Bold text of body size, larger text of normal weight under 1.3 times the body size, and titles that are links
  are common false positives, so they are held back: the first by a word limit, a spacing rule and by what
  follows it (`shortFollower`, `labelSeries`), the second entirely, the third as `info`. Real unmarked headings of
  those kinds are missed or reported as `info`: a bold title over one short line that is no sentence, a title
  whose text is on the page three times.
- Bold text over one line that is a full sentence stays `likely`, because a title over a one-line paragraph looks
  the same: the title of a callout ("Warning"), the name of an author over one sentence, a term over its
  definition. `sentenceFollowerIsContent: false` holds those back too, and with them the titles over one-line
  paragraphs (on the mutation fixtures 22 of 34 stripped headings are then `likely`, against 31).
- On a page with little plain text (a home page of links), nothing is above `info` (`lowText`): what is there may
  be small print, and says little about what body text looks like.
- The site name in a header and a tagline above content can be `likely`: nothing measurable tells them from a
  heading.
- Two pieces of text of one style a word space apart on one line are read as one text, whatever they are: a key
  and its value set that close are one block.
- Text in the exact colour of the background behind it is held back as `info` (`sameColourAsBackground`). The
  background is the nearest opaque background colour among the ancestors; with a background image, a translucent
  colour, a text shadow or a frame on the way nothing is concluded, and the text is treated as visible.
- Whether text is a heading already is decided for the whole block: text half inside a heading is not one.
- The capture is not taken when fixed or sticky content lies over the middle of the block (`covered`); other covers
  are not looked for, and the capture is evidence of context only: nothing is measured on it. A finding of any
  status, `likely` included, can therefore come without a capture.
- Heading text that is visually hidden takes no part in the comparison of levels. Rank is font size alone: weight,
  colour and capitals are not ranked.
- Cross-origin iframes, closed shadow roots, and iframes that are scaled or rotated are not looked into. At most
  `maxBlocks` (6000) blocks are read, `maxCandidates` (150) candidates and `maxInversions` (50) contradictions
  between levels reported.
- Heading markup on text that is not a heading is not looked for yet.

### Known limits of the icon check

- One state only: the page as it is. Hover, pressed, expanded and checked-versus-unchecked states are not visited.
- A graphic larger than `maxGraphicSizeCssPx` (64) is left out as not being an icon, and at most `maxCandidates`
  (300) controls are measured. The `icon-contrast/survey` finding gives the counts.
- Read from pixels, a colour is trusted only if some of its pixels are surrounded by the graphic. Strokes of about
  1 CSS px and less have none at this scale, so such an icon is `likely` at most unless its colour can be read from
  styles. Sprite icons referenced with `use`, images and anything under opacity or a filter are read from pixels.
- A gradient too faint to be told from a flat colour (under `clusterDeltaE`) is measured as that flat colour.
- Icon fonts are recognised by Private Use Area characters, or by a font family matching `iconFontFamilyPattern`
  for ligature fonts. A ligature font the pattern does not match makes its control look like one with visible text,
  and it is left out.
- Exemptions that cannot be measured are only hinted at. A hint turns a `fail` into a `likely` and shows as a flag:
  - `maybeInactive`: a class matching `inactiveHintPattern`, `pointer-events: none` or a not-allowed cursor.
  - `maybeLogo`: a class, id, name or file name matching `logoHintPattern`; or (with `homeLink`) the home link of the
    site, where a logotype usually is: a link to the site root, `rel="home"`, or a link inside `header` or
    `role="banner"` whose name matches `homeLinkNamePattern` or contains the site name given in `og:site_name` or
    `application-name`. A house icon that links home is downgraded with it. A brand mark used as an icon elsewhere
    (a social network link) carries no such hint and can be a `fail`.
  - `plainShape`: the graphic is one element drawn with CSS, which is as likely a colour swatch as an icon. A menu
    icon made of several such elements is not affected.
- Whether an icon is needed to understand the control is not judged: a control without visible text of its own is
  assumed to be identified by its graphic. Two cases are downgraded to `likely` because visible text next to the
  control does identify it: `visibleLabel` (a visible element named by `aria-labelledby`, or a `label`) and
  `duplicateLink` (a link with `aria-hidden="true"` and `tabindex="-1"` whose parent holds a text link to the same
  address). Visible text that is merely near the control is not recognised.
- A custom checkbox or radio built on a visually hidden native input and a styled sibling is not found: the input is
  hidden, and the sibling is not a control.
- For boundaries, text that touches the sampled edge (a value or a label with no gap) counts as a colour on that edge
  and can make a faint boundary look sufficient. An attached button or a contrasting wrapper does the same.
- Controls under other content at the sampled points (a cookie banner, a floating label outside the wrapper, a badge
  laid over an icon) are recorded as not measured, also when that content is transparent but takes pointer events
  (a stretched link). Only the sampled points are tested: a cover that lies between them is not seen.
- Looking under a layer that paints nothing relies on `elementsFromPoint`, which answers with the element for a hit on
  its pseudo-elements and cannot be told apart from the element itself there. An author `pointer-events: none
  !important` under such a layer is not seen.
- Inside an iframe that is scaled, rotated, skewed or zoomed, or nested in something that is, nothing is measured
  (`transformed-frame`): the frame's box does not say where a point of its content lands. Padding and borders of a
  frame are accounted for; a frame that is only translated is measured.
- On a page whose layout is still moving, a control is captured again up to `captureAttempts` times and then
  recorded as not measured. A control that the page removes or renders again during the scan is recorded as not
  measured (`detached`); the node that replaced it is not looked for.
- Cross-origin iframes and closed shadow roots are not looked into.

### Known limits of the focus check

- Content inside cross-origin iframes and closed shadow roots is not measured. The walk tabs through a cross-origin
  iframe; after `maxTabsInOpaqueFrame` presses (50) it sets `tabindex="-1"` on the iframe for the rest of the walk to
  step past it, which page scripts can observe.
- 2.4.11 is hit-tested inside the element's own document: an overlay in a parent document covering an iframe is not
  reported under 2.4.11, nor is an overlay with `pointer-events: none`. It is a `fail` only when every sampled point is
  under fixed or sticky content with full opacity and a solid background colour. Under a translucent colour, an image
  or a gradient it is `likely`, or `info` when the focus change is visible through the cover.
- Those overlays, and a veil painted by a pseudo-element of an ancestor, are looked for before the captures with the
  hit test described for the icon check (`coverGrid` points). When one is found, or cannot be ruled out, the finding
  carries the flag `possiblyCovered` and neither 2.4.7 nor 1.4.11 is reported above `likely`: the captures may show
  the overlay and not the indicator. This also downgrades a real failure whose element sits under such a layer.
- Inside an iframe that is scaled, rotated, skewed or zoomed, or nested in something that is, nothing is captured
  (`not-captured`). Padding and borders of a frame are accounted for.
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
| `e2e/` | Browser tests: every fixture against its manifest, the collector and the CLI. |
