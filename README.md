# a11y-vision (working name)

Automated checks for WCAG 2.2 A/AA criteria that rule engines such as axe-core do not cover.
Deterministic code finds and measures; a model, when one is configured, only judges.

Status: M5. Four checks are implemented, and all run by default. None of them needs a model. When a model is
configured it judges the heading candidates and the series of lines with bullets or numbers, and nothing else
(see "Having a model judge candidates").

- `focus-indicator`: 2.4.7, 1.4.11 for the indicator, 2.4.11.
- `icon-contrast`: 1.4.11 for the icon of controls without visible text, and for the boundary of form controls.
- `headings`: 1.3.1 for text that looks like a heading and is not exposed as one, and for heading levels that
  contradict the visual order. It never reports a `fail`.
- `lists`: 1.3.1 for content presented as a list (bullets, numbers) that is not exposed as one, for lists whose
  role was removed while their markers still show, and, as advisory, for series of blocks of one shape and for
  names and values in pairs. It never reports a `fail`.

`--checks focus-indicator`, `--checks icon-contrast`, `--checks headings` or `--checks lists` runs one of them.

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

### Having a model judge candidates

Optional, and off unless you configure it: with no provider, no model is asked, nothing is sent anywhere, and the
report is the one deterministic code gives. There is no default endpoint and no default model.

At present the model is asked two things: for each heading candidate, whether the text functions as a heading for
what follows it; and for each series of lines that open with a bullet or a number, whether it is presented as a
list. The checks find and measure; the model only answers `yes`, `no` or `unsure`.

```sh
node packages/cli/dist/bin.js scan https://example.com \
  --ai-base-url http://127.0.0.1:<port>/v1 --ai-model <model> --html report.html
```

| Option | Environment | Meaning |
|---|---|---|
| `--ai-base-url <url>` | `A11Y_VISION_AI_BASE_URL` | Base URL of an OpenAI-compatible endpoint, up to `/v1`. |
| `--ai-model <name>` | `A11Y_VISION_AI_MODEL` | Model name, passed through as it is. |
| `--ai-key-env <NAME>` | `A11Y_VISION_AI_KEY_ENV` | NAME of the environment variable that holds the API key. The key is never given on the command line or in a file. Leave it out for an endpoint that takes no key. |
| `--ai-label <text>` | | Name shown in reports for the provider (default `openai-compatible`). |
| `--ai-allow-remote` | | Allow an endpoint that is not on this machine. It has to be an `https` URL. |
| `--ai-lower-on-no` | | Lower a `likely` heading or list candidate to `info` when the model says it is not one (`headingNoStatus: "info"` and `listNoStatus: "info"`). Off by default, see "What a verdict changes". |
| `--ai-text-only` | | Send no captures, for a model without vision. |
| `--ai-cache <file>`, `--no-ai-cache` | | Where verdicts are kept (default `.a11y-vision/verdicts.json` in the working directory), or keep none. |
| `--no-ai` | | Ask no model, whatever the environment or the config file say. |
| `--config <file>` | | JSON file with any setting (`checks`, `focus`, `icon`, `headings`, `lists`, `adjudication`). Options win over the environment, which wins over the file. |

Giving a base URL and a model selects the adapter; giving one without the other is an error (exit 2), as is a key
variable that is not set. A scan is never run half configured.

The two environment variables are enough to switch the model on, with no option on the command line. That is
convenient in CI and easy to forget in a shell, so whenever a model is asked, whatever switched it on, the CLI
says so in one line on stderr, with the model, the host and where each of the two settings came from:

```
A model is asked: Text and captures of the page go to the model <model> on 127.0.0.1 (this machine). Endpoint from the environment variable A11Y_VISION_AI_BASE_URL, model from the environment variable A11Y_VISION_AI_MODEL.
```

stdout carries the JSON report and nothing else. One of the two variables set without the other (and without the
matching option) is a usage error that names the variable and the way out (`--no-ai`). A variable set to an empty
value counts as not set.

```ts
const { result, adjudication } = await new A11yVision({ page })
  .withAdjudication({ baseUrl: 'http://127.0.0.1:<port>/v1', model: '<model>' }, { cacheFile: 'verdicts.json' })
  .analyzeWithEvidence();
```

With the API nothing is cached unless `cacheFile` or `cache` is given; `adjudicator` takes an adapter of your own.

**What a verdict changes.** Only the status of a heading candidate or of a series of lines with bullets or
numbers, and only between `likely` and `info`. The table and what follows it are written for headings; lists
follow the same rules with `listNoStatus` in place of `headingNoStatus`, and their `advisory` findings, lists
with a removed role and the inventory are never sent:

| Deterministic status | `yes` | `no` | `unsure` |
|---|---|---|---|
| `likely` | `likely` | `likely`, with the verdict recorded (`headingNoStatus: "info"` or `--ai-lower-on-no` lowers it to `info`) | `likely` |
| `info`, held back for a reason that is a matter of judgement | `likely` | `info` | `info` |
| `info`, held back for what it is (a label, a price, hidden from assistive technology) | not sent | not sent | not sent |

- **A `no` does not take a finding off the list (default; open decision of the owner).** The brief says a judged
  candidate is `likely` at most, and says nothing about a model lowering one, so the default reads it to the
  letter: the finding stays `likely`, its `ai` part and its message record the `no`, and the HTML report shows
  "Model: no" beside the status and counts such findings in its introduction, so a tester can skim or search for
  them. The trade-off:
  - Keeping it (`headingNoStatus: "likely"`, the default) costs the tester a look at candidates a model would have
    cleared, and no page text, however persuasive to a model, and no edited cache file can make a finding of
    deterministic code disappear.
  - Lowering it (`headingNoStatus: "info"`, `--ai-lower-on-no`) shortens the `likely` list, which is the point of
    asking a model, and means that whoever controls the text of the page under test (prompt injection) or can
    write to the verdict cache can move the page's own findings to `info`. The finding is still in the report,
    with `statusBefore: "likely"`.

  Which of the two is the default is for the owner to decide; until then it is the first. A `yes` raising a
  held-back `info` to `likely` is not part of the question: it only ever adds to the tester's list.
- Never `fail`, whatever is configured and whatever the model says. The exit code does not depend on a model.
- The id of a finding, its selector and its evidence are those of deterministic code. The finding gains an `ai`
  part: provider label, model as configured, prompt version, the votes, the verdict, `confidence` (`high` or
  `low`), the model's rationale, `statusBefore` (the status without the model), `inputs` (`text` or `text+image`),
  `fromCache` (true when the verdict was read from the verdict cache and no model was asked in this run) and,
  when calls failed, `problems`. The message of deterministic code is kept and one sentence is added. `fromCache`
  and that sentence are, with the timestamp, what differs between a first run and the next on an unchanged page.
- `unsure` is also what every failure becomes: a timeout, an HTTP error, an answer that is not the JSON object
  asked for, a refusal, a cut-off answer. The status then stays as it was and `problems` says why (`timeout`,
  `network`, `http`, `invalid-output`, `refusal`, `truncated`, `too-large`, and `stopped` for a candidate that
  was not asked about because adjudication of the page had been stopped, see "Limits and the cache"). One
  candidate failing never fails the scan.
- Two votes per candidate (`votes`), at temperature 0. `yes` or `no` needs both votes to agree with high
  confidence; a second vote is not asked for when the first already settles `unsure`.
- A candidate without a capture (under a banner, for instance) is judged from its text, its style and the text
  around it, and its finding says `inputs: "text"`. `judgeWithoutImage: false` leaves such candidates alone.
- The counts in `headings/survey` are those of deterministic code.

**What is sent, and where.** For each candidate: fixed instructions, the fixed question, the candidate's context as
JSON (its text, style, measurements, the text before and after it) and, unless `--ai-text-only`, the capture of
the block with a rectangle drawn around the text. That is text and pictures of the page under test. It goes to the
endpoint you configured and nowhere else; redirects are refused. An endpoint on another host than this machine
(anything but `localhost`, a name under `.localhost`, `127.0.0.0/8`, `::1`) is refused unless `--ai-allow-remote`
(`allowRemote`) is set, and then it has to be an `https` URL: a remote endpoint over plain `http` is always
refused, with or without a key, because text, captures and the key would cross the network in the clear. Whether
cloud providers should be allowed by default is an open decision of the owner; until it is taken the default is
the conservative one.

An endpoint on this machine stays on this machine, as far as this tool can make it so:

- **No proxy.** Node can be told to send its HTTP traffic through a proxy (`NODE_USE_ENV_PROXY=1` or
  `NODE_OPTIONS=--use-env-proxy` with `HTTP_PROXY`/`HTTPS_PROXY`), and that includes loopback addresses unless
  `NO_PROXY` lists them. Requests to a loopback endpoint therefore do not use the global `fetch`: they go through
  `node:http` with an agent of their own, which those settings do not reach (tested on Node 24 with both
  switches). A remote endpoint, which you allowed explicitly, does use `fetch` and with it the proxy of the
  environment, as any other outgoing request of the machine would.
- **A name is checked, not believed.** `localhost` and names under `.localhost` are accepted as this machine by
  name, and then resolved: before the scan every address the name resolves to has to be loopback (`127.0.0.0/8`,
  `::1`), or the run stops with exit 2 and a message that gives the address. Each request then resolves the name
  again inside its own connection, refuses if any address is not loopback, and connects to an address from that
  same answer, so a resolver that changes its answer between the check and the connection (DNS rebinding) gains
  nothing. What is not covered: this holds in Node, which is where the CLI and the Playwright API run; code that
  uses `@a11y-vision/adjudicators` outside Node (the extension, later) relies on the browser, which resolves
  `localhost` to loopback itself. And something listening on a loopback port of your machine is trusted to be the
  model server you meant: a local server that forwards to a cloud (see the note on Ollama below) is beyond what
  this tool can see.

**The key.** Read from the environment variable you name, sent as a bearer token to the endpoint, and used for
nothing else. It is not written to reports, to the cache, to stderr or to error messages; what an endpoint
answers when a call fails is not copied anywhere either, only a problem code is.

**Untrusted text.** Page text goes to the model as data: inside JSON strings, between two marker lines that carry
128 random bits made for that one request (so the author of a page cannot write the marker in advance; the
marker is not part of the cache key), under instructions that say to judge it and never to follow it, with the
task repeated after it. No prompt makes a model immune to injected text, so the damage is bounded instead: the
answer must be exactly `{"verdict", "confidence", "rationale"}` with allowed values or it counts as `unsure`; no
selector, colour or number is taken from a model; a verdict can raise one candidate from `info` to `likely`, and
by default does nothing else to a status (see above for lowering).
The rationale is the model's own words: reports show it escaped, and it should be read as a hint, not as a fact.

**Limits and the cache.** At most `maxCallsPerPage` (120) requests per page, retries included; candidates
beyond that are left as they are, and the line on stderr says how many. `concurrency` (2) requests at a time,
`timeoutMs` (120000) each, up to `maxRetries` (2) retries for network errors and HTTP 408, 425, 429, 500, 502,
503 and 504 with a doubling wait; timeouts are not retried. `timeoutMs` and the other durations are cut to
2147483647 ms, the most a timer holds.

An endpoint that hangs or is gone is not asked about every candidate: after `maxConsecutiveFailures` (3) requests
in a row without any answer (`timeout` or `network`; an HTTP error is an answer) nothing more is sent for that
page, and neither once `pageBudgetMs` (600000, ten minutes) has passed since adjudication of the page began. The
candidates not yet asked about keep their status, carry `problems: ["stopped"]`, and the line on stderr says why
it stopped and how many were left. With the defaults a hanging endpoint costs about four minutes for a page
instead of two minutes for every pair of candidates. The budget is checked before each request and does not cut
one short, so a page can take up to `pageBudgetMs` plus `timeoutMs`. `0` switches either limit off.

Verdicts are cached in a local JSON file under a
SHA-256 of the generator version, the candidate's context, a perceptual hash of its capture, the endpoint, the
model and its settings, the prompt version and the number of votes, so an unchanged page costs no calls and a
changed candidate is judged again. Failures are not cached. The file holds verdicts and rationales, which can
quote the page; it is never sent anywhere. Delete it to start over.

The cache file is input like any other: whoever can write to it can write verdicts. Every entry is validated
when the file is read and again when it is used: only `yes`, `no` or `unsure`, the verdict worked out again from
the votes, and the number of votes the settings in force ask for (a `yes` or `no` with one vote where two are
required is dropped and the model is asked). A well-formed entry written by hand under the right key cannot be
told from a real one; that is why each finding says `fromCache` (the HTML report: "read from the cache (no model
was asked in this run)"), and one of the reasons a `no` does not lower a finding by default. Saving merges with
what is in the file at that moment and replaces it atomically, under a temporary name of its own; saves of one
file within one process run one after the other, so parallel scans in a test run lose nothing. Two separate
processes that save at the same instant can still lose the verdicts one of them added (they are asked for again
next time); the file is never left half written.
All of these are settings under `adjudication` in the config file; `packages/core/src/types.ts` documents each.

#### With a local Ollama model

Checked against Ollama's documentation ([OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility),
[structured outputs](https://docs.ollama.com/capabilities/structured-outputs), [FAQ](https://docs.ollama.com/faq),
[CLI](https://docs.ollama.com/cli)) in November 2026, not against a running server: check there if something
differs.

1. Install Ollama and pull a model that accepts images. Which models do changes often: pick one from Ollama's
   model library and use its name wherever `<model>` stands below.

   ```sh
   ollama pull <model>
   ```

2. The server listens on `127.0.0.1:11434` by default and serves the OpenAI-compatible API under `/v1`. It needs
   no key, so `--ai-key-env` is left out.

   ```sh
   node packages/cli/dist/bin.js scan https://example.com \
     --ai-base-url http://127.0.0.1:11434/v1 --ai-model <model> --html report.html
   ```

What the documentation says, and what follows from it here:

- Images are accepted as base64 data only, not as URLs. That is what is sent.
- The documented examples write an image part as `{"type": "image_url", "image_url": "data:image/png;base64,..."}`,
  where the chat completions reference of OpenAI has `"image_url": {"url": "data:..."}`. The second form is the
  default here. If the server rejects it (every call then fails with `http`), set
  `{"adjudication": {"imageUrlShape": "string"}}` in the config file.
- `response_format` is supported, and structured outputs are said to work through it. The default here is
  `json_schema`; `"responseFormat": "json_object"` asks for plain JSON mode and `"none"` relies on the
  instructions alone, which also carry the schema, as Ollama advises. The answer is validated the same way in all
  three cases.
- `temperature`, `seed` and `max_tokens` are supported; `max_tokens` is the field used by default
  (`maxTokensField`).
- The default context window is 4096 tokens. If answers come back cut off (`truncated`) or invalid with a
  capture attached, start the server with a larger one (`OLLAMA_CONTEXT_LENGTH=8192 ollama serve`).
- A model is loaded on first use, which can take longer than a later call: `timeoutMs` allows two minutes. If the
  first calls of a run time out while a large model loads, adjudication of that page stops after three of them
  (`maxConsecutiveFailures`); run it again once the model is in memory, or raise `timeoutMs`.
- Requests are handled one at a time per model unless the server is configured otherwise, so `concurrency` above
  1 only queues.
- Ollama can also serve cloud-hosted models through the same local address. With such a model, page content
  leaves the machine although the endpoint is local, and this tool cannot tell. `OLLAMA_NO_CLOUD=1` keeps the
  server local.
- A model without vision still works with `--ai-text-only`.

Other servers that speak the same API (LM Studio, llama.cpp, vLLM, hosted ones with `--ai-allow-remote`) are
configured the same way; `max_completion_tokens` is available for those that have dropped `max_tokens`.

### What `headings` reports

Text that functions as a heading without being exposed as one, and heading levels that contradict the visual order
(1.3.1). No model is needed, and nothing is ever a `fail`: whether text functions as a heading is a judgement.

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

#### How the adjudicator layer takes the candidates

`headingCandidates(snapshot.headings, config.headings)` in `@a11y-vision/core` gives the candidates as data. Each
has:

- `findingId`: the id of its finding. It is a fingerprint of the element under one constant key
  (`headings/candidate`), not of the rule name, which follows the status: the id stays the same when a candidate
  goes from `info` to `likely` or back, between two runs or after a verdict.
- `status`: `likely` or `info`, never anything else, and `adjudicate`: false where a judgement would change
  nothing (a label, a price, text hidden from assistive technology, an accessibility tree that could not be read).
  Short titles that open with a number, text in the style of prices, repeated text and what the position says are
  left to a judgement.
- `crop`: a key of the snapshot clips, **or null** (under a fixed banner or dialog, in a transformed frame,
  outside the viewport), and `cropTarget`: where the text is inside the capture, measured when it was taken. The
  model is sent a copy with a rectangle drawn there; the capture kept as evidence is not touched.
- `context`: text, style, body style, features, reasons, the text before and after (cut to
  `contextBeforeMaxChars` and `contextAfterMaxChars`), and `sameTextAndStyle`.

`context` and the captures hold text of the page under test. They leave the machine only when they are sent to a
model, which happens only when a provider is configured. Page text is untrusted data.

#### Adding a check to the adjudicator layer

What is asked and what an answer may change is decided in `core`, per check; asking is the same for all.

1. In `packages/core/src/checks/<check>-adjudication.ts`, export a function
   `(snapshot, findings, config) => Judgement[]`. A `Judgement` is a `request` (the `findingId`, a fixed
   `question` with its `questionVersion`, the `generatorVersion` of the candidate code, a `crop` with the target
   outlined or null, its `cropHash`, and a compact `context`) and an `apply(finding, ai, config)` that returns the
   finding after the verdict. `headings-adjudication.ts` is the model to copy.
2. Register it in `SOURCES` in `packages/core/src/adjudication.ts`. `lists-adjudication.ts` is the second
   entry, and shows a check of which only some findings are a model's to judge.
3. Give the candidates what `headingCandidates` gives: the id of their finding, whether a judgement could change
   anything, a capture with the place of the target in it.

`applyVerdicts` enforces the rest whatever `apply` returns: the id, selector and evidence stay, and a status that
depends on a model is never `fail`. Votes, retries, the cap on calls, the cache, the prompt frame and the
validation of answers are in `packages/adjudicators` and need no change. A new provider is one more
implementation of `Adjudicator` (`judge` sends one request and returns a verdict or a problem code, and never
throws) plus a case in `createAdjudicator`.

### What `lists` reports

Content that is presented as a list and is not exposed as one, and three neighbours of that (1.3.1). No model is
needed, and nothing is ever a `fail`: that lines which open with a bullet are the items of a list is read from what
is rendered, and a tester confirms it.

What has list semantics is taken from the accessibility tree of each document, not from tags: a `ul` with
`role="presentation"` is not a list, a `div` with the role list is, and so is a `ul` whose presentational role the
browser ignores because it also has `aria-label` or `tabindex`. Chrome exposes `ul`, `ol` and `menu` as `list`
and `dl` as `DescriptionList`, whatever `list-style` and `display` say (verified with
`Accessibility.getFullAXTree`). Only the list containers are marked in the page, at most `maxAxMarks` (3000) per
document; an item has list semantics when a marked list holds it.

The text is read as for `headings`: the same blocks of visible text, from the same walk, with the settings of
`headings` for that part. On top of it, for each line: what it opens with, and where its block sits among the
elements.

**Lines with bullets or numbers** (`lists/glyph-list`, `likely`). Two or more lines, each starting with a marker,
one under the other and starting at one edge (or centred on one axis), outside list semantics. The lines are
either separated by `br` inside one block, or sibling blocks: each the first text of its element, the elements
side by side under one parent, with nothing else between them. A marker is:

- a bullet character (`bulletPattern`: bullets, geometric shapes, arrows, dingbats, check marks, emoji, the
  Japanese middle dot and reference mark). A second symbol right after the first means the first is no bullet:
  five stars are a rating (`★★★★☆ Pretty good`), three hyphens a rule;
- a hyphen, an en dash, an asterisk, a middle dot or an angle followed by a space (`weakBulletPattern`). These
  open many lines that are not items, so they are held to a stricter test, below. The em dash and the horizontal
  bar are left out altogether: they open the lines of a dialogue and little else. A figure after the hyphen is a
  reduction, a negative amount or a temperature, not an item: text that is mostly digits, or a number and the
  sign of a unit (`figureStartPattern`: `- 20 %`, `- 3,50 €`, `- 3 °C at dawn`). A unit written in letters does not
  make a figure (`- 200 g de farine` is an ingredient);
- a number, a letter or a numeral with what closes it, in sequence: `1.` `2)` `(3)` `[4]` `1.2.` `4/` `1°`, digits
  of any script (`١.`), one letter of any script (`a)` `(b)` `C.`), roman numerals (`ii.`), Chinese and Japanese
  numerals (`一、`), enclosed numbers (`①`). The numbers have to follow each other in one notation; "i." is read as
  a roman numeral or as a letter, as the lines after it say. Letters follow each other by code point, from the
  letters in `firstLetters`; kana and hangul, whose order is another, are read from `letterSequences` (gojūon and
  iroha order in hiragana and katakana, 가나다);
- generated content of `::before`: a bullet character, a glyph of an icon font, a counter, or a small box that is
  painted (a dot, a square, an image);
- the same small image, inline SVG or empty painted element before every line, from `markerMinSizeCssPx` (3) to
  `markerMaxSizeCssPx` (24), on the line and no further from the text than `markerMaxGapEm` (2);
- a list-item marker on an element that is no `li` (`display: list-item` with a list style, in a colour that
  paints, with room for it).

A bullet or a number in a box of its own (`loneMarkerMaxChars`, 4 characters at most) before the text of each
item counts as the start of that text: in a flex row, and in a flat grid where the mark and the text are two
cells of one parent, the next mark on a later row.

**The test for hyphens, dashes, asterisks and angles.** Lines that open with one of `weakBulletPattern` are
`likely` only when all of this holds; otherwise they are `info`:

1. there are `weakMinItems` (3) of them or more;
2. they do not open with the angle that quotes a message in plain-text mail (`quotePrefixPattern`, `>`);
3. they read as items and not as sentences: no line ends as a sentence does (`sentenceEndPattern`: a full stop, a
   question mark, an exclamation mark or an ellipsis of any script, with or without a closing quotation mark), or
   every line but the last ends with the semicolon or the comma of an enumeration (`itemSeparatorEndPattern`).

The reason for 3: the lines of a dialogue, and of any prose that opens with a dash, are sentences and end as
sentences; the items of a list typed with dashes are phrases without closing punctuation ("– Farine complète"),
or the parts of one sentence ("– le nom ; – l'adresse ; – la date."). The test uses punctuation only, no word of
any language, and it is strict on purpose: one line that ends with a full stop holds the series back. A list
whose items are full sentences after hyphens is therefore `info`, where a tester or a model still sees it. The
end of each line is read from the page (`lineEndChars`, 8 characters), not from the start that is kept.

Held back as `info` (`lists/glyph-list-candidate`), with the reason as a flag:

| Flag | What it is |
|---|---|
| `fewWeakItems` | Fewer than `weakMinItems` (3) lines, each opening with a hyphen, a dash or an asterisk: asides and footnotes open that way too. |
| `weakSentences` | Three or more such lines, of which at least one ends as a sentence does: a dialogue ("– Tu viens demain ?"), prose that opens with dashes. See the test above. |
| `quotePrefix` | Lines that open with `>`, however many: a quoted reply. |
| `fewGraphicItems` | Fewer than `graphicMinItems` (3) lines with the same image or drawn shape before each: two links that share an icon. |
| `fewSymbolItems` | Fewer than `symbolMinItems` (3) lines that open with an arrow, a triangle, a pictogram, a dingbat or an emoji (`symbolBulletPattern`: arrows, U+25B2 to U+25C5, U+2600 to U+27BF, emoji): two messages with a warning sign, two links with an arrow. Dots, squares and the other bullets need two. |
| `itemsAreControls` | Lines that open with such a symbol and are each one block that is a link, or that shows the pointer of a link (`cursor: pointer`), and nothing more: calls to action, the titles of an accordion. A plain bullet before each link is a list of links and stays `likely`. |
| `colouredMarkers` | The characters the lines open with are in different colours: the swatches of a legend ("■ Sales", "■ Costs"), the dots of a status. The bullets of a list look the same. |
| `mixedGlyphs` | Lines that open with different symbols, one of them used once: symbols that label a line (a telephone, an envelope). |
| `startsMidSequence` | Numbers that follow each other and do not start at 1, a or i: dates ("12. Mai", "13. Mai"), or a list that goes on from elsewhere. |
| `fewLetterItems` | Fewer than `letterMinItems` (3) lines numbered "A.", "B.": initials of names. "a)" and "(a)" need two. |
| `initialsAndNames` | Every line reads as a capital letter, a full stop and one capitalised word, then the end or punctuation (`initialNamePattern`): "A. Martin, Lyon", "B. Nguyen, Nantes". Titles of several words ("A. Scope of the regulation") and "a." or "A)" are not held back. |
| `sameWordAfterNumber` | Every line goes on with the same word after "1.", "2.": dates ("1. Mai", "2. Mai"), ranks, floors. The items of a list seldom all open with one word; steps that do ("1. Add …", "2. Add …") are held back with them. Only for digits closed by a full stop. |
| `itemsHeadText` | Numbered lines that each have further blocks of text under them (steps, or the numbered titles of sections), and lines with any other marker that each have `headedItemMinBlocks` (3) blocks or more: the titles of panels with an icon before each. |

Not reported at all: one line alone; numbers that do not follow each other; bullets side by side on one line
(separators of a breadcrumb or of a row of links); lines that do not start at one edge; lines in different cells
of a table; headings; text in a label, a button, a term, a caption or code; text hidden from assistive technology.
Inside navigation the status is `advisory` (flag `navigation`): the brief asks no more of groups of links.

**Lists with a removed role** (`lists/presentational-list`, `likely`). A `ul`, `ol` or `menu` with
`role="presentation"` or `role="none"`, not exposed as a list, of which at least two items still show their
marker: displayed as a list item, with a list style, in a colour that paints, and, for a marker outside the item,
with `markerRoomEm` (1) of room before the item that no clipping box and no edge of the page cuts off.

**Series of blocks of one shape** (`lists/repeated-structure`, `advisory`). Three or more consecutive siblings
whose tags agree down to `shapeDepth` (3) levels (two paragraphs or three count the same), laid out in line with
even gaps: one row, one column with a shared edge or centre, or rows that start at one edge (a grid, a row that
wraps). The gaps may differ by `gapToleranceCssPx` (4) or `gapToleranceShare` (0.1). Flag `links`: each item is one
link (navigation links, a breadcrumb, a tag cloud, pagination). Flag `cards`: each item has two blocks of text or
more, or a graphic (card grids, search results, feeds). Left out: what is inside list semantics, the rows of
tables and grids, tabs, menus, toolbars, feeds with the role, anything inside a link, a button, a label or a
table cell, items with a form field (that is for the grouping check), items that are or hold a list or a table,
rows of buttons, plain blocks of text, items with more than `repeatedItemMaxChars` (300) characters (prose in
sections), blocks under each other that each have a heading of their own that is no link (the sections of a
document), links with more text between them than separators (links inside a sentence), a series inside an item
of a series that is reported, and whatever is reported for its bullets or as pairs.

**Names and values** (`lists/key-value`, `advisory`). Three or more rows that each hold a short name and a value
side by side, the names in one style at one edge and the values in another style or after a colon; or three or
more lines that each read as a name of at most `keyMaxWords` (4) words, a colon and a value. Outside `dl` and
tables. The names of one layout have to differ from each other, and the names of lines with a colon have to be
set in one style each, the same on every line (the page gives the styles of the text before the colon,
`keySeparatorChars`). That leaves out a chat ("Alice: …", "Bob: …", "Alice: …": the names come back) and a feed of
activity ("**Marsha Labat** posted a video: …": a name in bold and a verb, and more words than a name has).
Titles that are links are not names, and neither are hours ("09:30 Welcome").

**Lists without markers** (`lists/list-style-none`, `info`). A real `ul`, `ol` or `menu`, exposed as a list by
Chrome, of which no item shows a list marker or generated text or image of its own, without an explicit role and
outside navigation: the lists Safari exposes as a group and not as a list. That is the choice of a browser and no
failure of the page. The rule is the one of WebKit's source, read in November 2026
(`AccessibilityNodeObject::determineListRoleWithCleanChildren` and `AXListHelpers::childHasPseudoVisibleListItemMarkers`
in `Source/WebCore/accessibility`), not tested in Safari: a list with an ARIA role is kept when it has an item;
one without is kept when an item is rendered as a list item with a list style or a list image, or has
accessible generated content in `::before`, or when the list is inside a navigation landmark. A dot drawn by
`::before` with empty content does not count there, so such lists are in the inventory. At most
`maxUnstyledLists` (50) are listed.

`lists/survey` (`info`) gives the counts, and the flag `truncated` when something was left out: at most
`maxCandidates` (150) findings above the inventory are reported (`likely` first, then `advisory`, then `info`,
each in document order), `maxCaptures` (120) captures taken, `maxGroups` (400) series and `maxListElements` (400)
lists read, and `maxGroupParents` (5000) elements with three children or more looked at for series of siblings
(`parentsNotRead` says how many were not). A finding beyond the captures, under a fixed banner or in a place that cannot be shown carries
`notCaptured` or `covered` and keeps its status: nothing is measured on a capture here. When the accessibility
tree cannot be read, or a document has more lists than can be marked, nothing is above `info` (`axIncomplete`).

A finding names the element that holds the items and gives their number, the first of them as text, and a capture
of the series. Of two series under one parent, the second is named after its first line. Two series of lines in
one block (bullets, a line of text, then numbers, all in one `p`) are two findings on the same element: the
first has the id it would have alone, the second an id that also holds the line it starts at, so both are the
same from run to run. Should two findings still have one rule and one element (a page with the same `id`
twice), the one of the highest status is listed and the survey counts the other (`sameElementNotListed`).

Every pattern is an option and holds no word of any language.

#### Decisions left to the owner, and their defaults

- **Card grids and search results** (section 10.2 of the brief): `advisory` by default; `lists.cardListStatus:
  "likely"` reports them as `likely`. The option takes those two values only: `fail` is turned into `likely`,
  anything else into `advisory`, when the configuration is resolved and again where the status is computed. Rows
  of links stay `advisory` either way.
- **What a "no" of a model does** to a `likely` series of lines: nothing by default, as for headings
  (`adjudication.listNoStatus: "likely"`); `"info"` or `--ai-lower-on-no` lowers it.
- **Two lines are a list.** The brief says "two or more"; that holds for bullet characters, numbers, counters and
  list-item markers. Three are asked for hyphens, for arrows, pictograms and emoji, for images and shapes, and
  for letters with a full stop (see the table above): with two, real pages gave more asides, pairs of alerts,
  pairs of links with one icon and initials than lists. Each limit is an option (`minItems`, `weakMinItems`,
  `symbolMinItems`, `graphicMinItems`, `letterMinItems`); the two lines are still reported, as `info`, and a model
  can raise them.
- **Lines after a hyphen or a dash are `info` unless they read as items.** The brief asks for `likely` on lines
  that start with a bullet glyph; for the glyphs that also open dialogue, asides and quoted mail, precision
  comes first and the test above decides. `sentenceEndPattern` set to a pattern that never matches (`(?!)`) gives
  `likely` from three lines again, quoted lines apart.

#### How the adjudicator layer takes the candidates

`listCandidates(snapshot.lists, config.lists)` gives what the check reports as data: `findingId` (a fingerprint
under the constant key `lists/glyph` for series of lines, so that the id survives a change of status and of rule
name), `status` (`likely`, `advisory` or `info`), `adjudicate`, `crop` (or null) with `cropTarget`, and a compact
`context` (the kind of marker, how the lines are separated, the start of up to `contextMaxItems` (12) items, the
reasons, the text before and after).

Only series of lines with bullets or numbers are sent to a model, `likely` ones and those held back as `info`,
and not those inside navigation. The question is fixed (`LIST_QUESTION`, version `lists-1`): is the target
presented as a list of parallel items, each introduced by a bullet, a number or a small symbol. Lists with a
removed role are not sent (their role and their markers are facts), nor are series of blocks and pairs (their
status is a policy), nor the inventory.

### Known limits of the lists check

- One viewport width and one state, as for headings: the page as it is.
- A list is found by its markers. Lines without any (three short lines under each other) are not reported as
  lists, whatever they look like; blocks of plain text of one shape are left out of the series as well.
- Bullets drawn as a background image of the line, and markers inside images, canvas and SVG text, are not seen.
  `::after` is not looked at. Of generated content only `::before` of the elements a line is the first text of
  (up to `markerAncestorLevels`, 3) is read.
- Two images are the same when their source and size are; two inline SVGs when their content is. The same icon
  drawn twice with different markup is two icons. Icons cut out of one sprite are told apart by position.
- Lines that are indented differently are not one series, so a list with one nested item under each other is
  missed; items in two columns are found when each edge is shared by two lines.
- What tells a list from its lookalikes is punctuation, colour, the pointer and the first word, never the
  meaning. So: a dialogue whose lines have no closing punctuation, after hyphens, is still `likely`; a list typed
  with hyphens whose items are sentences is `info` (`weakSentences`), and so are numbered steps that all open with
  one word (`sameWordAfterNumber`) and letters before single capitalised words ("A. Scope", "B. Definitions":
  `initialsAndNames`). Two numbered sentences that happen to open with "1." and "2." ("1. Januar ist ein
  Feiertag …", "2. Weihnachtstag ebenso …") are `likely`. A legend whose swatches are images, or three alerts
  with the same sign, are not told from lists. A temperature with its unit in letters and no degree sign
  ("- 3 C") is an item.
- Sequences of letters are known for scripts whose letters follow each other in Unicode, from the letters in
  `firstLetters`, and for the sequences in `letterSequences`. Half-width kana and other orders are not known.
- Lines are cut at `br` only. Text that keeps its line breaks through `white-space: pre` or `pre-line` is one
  line to the survey, so bullets typed on such lines are not found. This is left as it is on purpose: outside
  `pre` and `code`, which are never read for lists, such text is mostly code and configuration shown in a `div`
  ("- name: build", "- name: test"), which would read as a list of three phrases.
- In a flat grid, a mark in a cell of its own is paired with the one cell after it. Items of three cells or
  more (a mark, a title, a price), and marks in the last column, are not found that way.
- Lines in the cells of a table are never items, also in a table used for layout that does not say so with
  `role="presentation"`: bullets as images in the cells of an old layout table are missed.
- A series of sibling blocks is compared by tags only. Cards that differ by one optional element are two shapes
  and may fall under three in a row; items are measured up to `maxGroupItems` (40).
- Sibling items must share a parent within `maxAncestorLevels` (6) of their text.
- A first item that is bare text of the element that holds the others (text, then one paragraph per further
  item) is not counted: the series then starts at its second item and is held back (`startsMidSequence`), as
  seen on a real page of legal text numbered a), b), c).
- A modal dialog opened with `showModal()` makes the rest of the page inert, and Chrome takes it out of the
  accessibility tree: nothing outside the dialog is reported (it is treated as hidden from assistive technology,
  for headings as well). Inside and outside are those of the composed tree: what a component of the dialog
  renders in its shadow tree is inside it, and a dialog that lives in a shadow tree is found. The dialogs are
  looked for once per reading of the page. With two modal dialogs open, the content of both is read, although
  Chrome exposes only the one opened last (verified): the DOM does not say which one that is.
- Cross-origin iframes, closed shadow roots, and iframes that are scaled or rotated are not looked into. A series
  never spans two documents.
- The capture shows the series as far as the window does: a list taller than the window is cut. Other covers than
  fixed or sticky content over its middle are not looked for.

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

The headings and the lists checks read the accessibility tree of the page and of its same-origin iframes, and
scroll what they report into view to capture it. On a page that uses `content-visibility: auto`, they also have
the browser render what it skips, until the scan ends: Chrome leaves skipped content out of the accessibility
tree (verified: a list or a heading in such a subtree has no node in `Accessibility.getFullAXTree` while it is
off screen), so text read from the DOM there would look like text without semantics. Only the elements whose
computed `content-visibility` is `auto` are touched: each gets the attribute `data-a11y-vision-render` for the
time of the scan, and a style sheet adopted by their document or shadow root makes those `visible`. The
attribute is a change a `MutationObserver` of the page can see; it is removed with the style sheet. The page can
be taller while the scan runs, and the browser may remember the real size of what was rendered
(`contain-intrinsic-size: auto`), as it does after a reader has scrolled there. What the author hides with
`content-visibility: hidden` or with `hidden="until-found"` is left as it is: not rendered, not read, and
taking no room in a capture. They change nothing else.

A page that goes to another document while it is being read (a redirect by script or by `meta refresh` that
fires after `load`, as on a site that has moved to another domain) is read again from the start on the document
it went to, once. The result then carries the address the scan started on (`environment.navigatedFrom`; `url` is
the address the findings are about), and the CLI says so on stderr. Before that, such a scan stopped with
"Cannot find context with specified id" or "Could not find node with given id". A page that navigates again
during the second reading is an error that names the three addresses. A document that is still being parsed
when the scan starts is waited for first (`focus.navigationTimeoutMs`, 15 s at most, for both waits).

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
- Outside a modal dialog opened with `showModal()`, the page is inert and absent from the accessibility tree: text
  there is treated as hidden from assistive technology (`ariaHidden`), so a candidate there is `info` at most.

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
| `packages/adjudicators` | The adjudicator layer: the OpenAI-compatible adapter, the prompt and the validation of answers, votes, retries, limits and the verdict cache. The only package that calls a model: through `node:http` without a proxy for an endpoint on this machine (`./node`, loaded only in Node), through the global `fetch` for a remote one. |
| `packages/reporters` | JSON report in the axe result shape; our data sits under `a11yVision`. |
| `packages/playwright` | `new A11yVision({ page }).analyze()` |
| `packages/cli` | `scan <url>` |
| `packages/extension` | Placeholder until M8. |
| `fixtures/` | Test pages with expected-findings manifests, see `fixtures/README.md`. |
| `e2e/` | Browser tests: every fixture against its manifest, the mutation tests of headings and lists, the collector, the CLI, and the adjudicator layer against a mocked endpoint (`e2e/support/mock-model.ts`). No test calls a real model. |
