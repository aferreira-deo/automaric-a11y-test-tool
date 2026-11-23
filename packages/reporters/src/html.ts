import { TOOL_NAME } from '@a11y-vision/core';
import type { BaselineSummary, Finding, Png, ScanResult, Status } from '@a11y-vision/core';
import { countRun, inputNote } from './run.js';
import type { Run } from './run.js';

const STATUS_ORDER: Status[] = ['fail', 'likely', 'advisory', 'info'];
const STATUS_TEXT: Record<Status, { title: string; note: string }> = {
  fail: { title: 'Fail', note: 'Measured or structurally certain.' },
  likely: { title: 'Likely', note: 'Needs confirmation by a tester.' },
  advisory: { title: 'Advisory', note: 'Best practice, not a failure.' },
  info: { title: 'Info', note: 'Inventory of what was found and measured.' },
};

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 without Node or DOM APIs, so the reporter also runs in an extension service worker. */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += ALPHABET[(triple >> 18) & 63]! + ALPHABET[(triple >> 12) & 63]!;
    out += b === undefined ? '=' : ALPHABET[(triple >> 6) & 63]!;
    out += c === undefined ? '=' : ALPHABET[triple & 63]!;
  }
  return out;
}

/**
 * Everything written into the report goes through `escape` or `num`, whatever its declared type:
 * selectors, messages and URLs come from the page under test, and a report can also be built
 * from JSON that this version of the tool did not write.
 */
function escape(value: unknown): string {
  // String() is not used: it would call a toString supplied by the value.
  const text = typeof value === 'string' ? value : typeof value === 'number' ? num(value) : '';
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function num(value: unknown, round = false): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown';
  return String(round ? Math.round(value) : value);
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function statusOf(finding: Finding): Status {
  // An unknown status is shown as inventory, never as a failure.
  return STATUS_ORDER.includes(finding.status) ? finding.status : 'info';
}

function cropLabel(id: string): string {
  if (id.endsWith('-focused.png')) return 'Focused';
  if (id.endsWith('-unfocused.png')) return 'Not focused';
  if (id.startsWith('icon-contrast/')) return 'At rest';
  if (id.startsWith('headings/') || id.startsWith('lists/') || id.startsWith('grouping/')) return 'In context';
  return 'Capture';
}

/** The verdict of a model on a finding when it is one of the three words a verdict can be; otherwise nothing. */
function modelVerdict(finding: Finding): 'yes' | 'no' | 'unsure' | null {
  const ai = finding.ai as { verdict?: unknown } | null | undefined;
  const verdict = ai !== null && typeof ai === 'object' ? ai.verdict : undefined;
  return verdict === 'yes' || verdict === 'no' || verdict === 'unsure' ? verdict : null;
}

function renderFinding(finding: Finding, crops: Record<string, Png>, heading: 'h3' | 'h5' = 'h3'): string {
  const evidence = {
    crops: finding.evidence?.crops ?? [],
    colors: finding.evidence?.colors ?? {},
    ratios: finding.evidence?.ratios ?? {},
    flags: finding.evidence?.flags ?? [],
    values: finding.evidence?.values ?? {},
  };
  const status = statusOf(finding);
  const rows: [string, string][] = [
    ['Success criterion', finding.wcag ? `${escape(finding.wcag.sc)} (Level ${escape(finding.wcag.level)})` : 'None'],
    ['Rule', `<code>${escape(finding.rule)}</code>`],
    ['Selector', `<code>${escape(finding.selector)}</code>`],
  ];
  if (finding.frame) rows.push(['Frame', `<code>${escape(finding.frame)}</code>`]);
  for (const [role, ratio] of Object.entries(evidence.ratios)) {
    rows.push([`Measured ${escape(role)}`, `${num(ratio)}:1`]);
  }
  for (const [role, color] of Object.entries(evidence.colors)) {
    // Only a plain hex colour goes into a style attribute: anything else could carry a url().
    const swatch = HEX_COLOR.test(color) ? `<span class="swatch" style="background:${escape(color)}"></span>` : '';
    rows.push([`Colour: ${escape(role)}`, `${swatch}<code>${escape(color)}</code>`]);
  }
  for (const [name, value] of Object.entries(evidence.values)) {
    // Text read from the page is among these values: escaped like everything else.
    rows.push([escape(name), typeof value === 'boolean' ? (value ? 'yes' : 'no') : escape(value)]);
  }
  if (evidence.flags.length > 0) rows.push(['Flags', evidence.flags.map(escape).join(', ')]);
  if (finding.box) {
    const { x, y, width, height } = finding.box;
    rows.push(['Box (CSS px)', `${num(width, true)} by ${num(height, true)} at ${num(x, true)}, ${num(y, true)}`]);
  }
  // What a model said is text from outside, like text of the page: every part is escaped, and
  // none of it is used for anything but display. A report can also be built from JSON written by
  // something else, so no field is assumed to be there or to have its type.
  const ai = finding.ai as Partial<NonNullable<Finding['ai']>> | undefined;
  if (ai !== undefined && ai !== null && typeof ai === 'object') {
    const votes = Array.isArray(ai.votes) ? ai.votes : [];
    const problems = Array.isArray(ai.problems) ? ai.problems : [];
    rows.push(['Model', `${escape(ai.model)} (${escape(ai.provider)}), prompt ${escape(ai.promptVersion)}`]);
    rows.push([
      'Model verdict',
      `${escape(ai.verdict)}, ${escape(ai.confidence)} confidence, from ${ai.inputs === 'text+image' ? 'the text and the capture' : 'the text alone'}` +
        // A cache is a local file: a verdict read from it was not given by a model in this run.
        (ai.fromCache === true ? ', read from the cache (no model was asked in this run)' : ''),
    ]);
    rows.push(['Model votes', votes.map(escape).join(', ')]);
    if (problems.length > 0) rows.push(['Model calls failed', problems.map(escape).join(', ')]);
    rows.push(['Model rationale', escape(ai.rationale)]);
    rows.push(['Status without the model', escape(ai.statusBefore)]);
  }

  const figures = evidence.crops
    .filter((id) => typeof id === 'string')
    .map((id) => {
      const png = crops[id];
      if (!png) return '';
      const label = cropLabel(id);
      return `<figure><img src="data:image/png;base64,${toBase64(png)}" alt="${label} capture of ${escape(finding.selector)}"><figcaption>${label}</figcaption></figure>`;
    })
    .join('');

  // The verdict beside the status, so that a tester can skim a list for what a model said. One of
  // three fixed words, or nothing.
  const said = modelVerdict(finding);
  const verdict = said ? ` <span class="verdict">Model: ${said}</span>` : '';
  // Only a fail carries this, and only when a baseline file was used. Two fixed texts.
  const mark = status !== 'fail' ? '' : finding.baseline === 'baselined' ? ' <span class="verdict">In the baseline</span>' : finding.baseline === 'new' ? ' <span class="verdict">New</span>' : '';
  return `<article class="finding ${status}">
<${heading}><span class="status">${STATUS_TEXT[status].title}</span>${verdict}${mark} <code>${escape(finding.selector)}</code></${heading}>
<p>${escape(finding.message)}</p>
<p class="help">${escape(finding.help)}</p>
${figures ? `<div class="crops">${figures}</div>` : ''}
<dl>${rows.map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`).join('')}</dl>
<p class="id">Finding id <code>${escape(finding.id)}</code></p>
</article>`;
}

const CSS = `
:root{color-scheme:light dark;--fg:#1a1a1a;--bg:#fff;--muted:#555;--line:#c4c4c4;--fail:#b00020;--likely:#8a4b00;--advisory:#00539b;--info:#4a4a4a}
@media (prefers-color-scheme:dark){:root{--fg:#f1f1f1;--bg:#151515;--muted:#b5b5b5;--line:#555;--fail:#ff8a9a;--likely:#ffc46b;--advisory:#8cc8ff;--info:#c4c4c4}}
body{margin:0 auto;max-width:72rem;padding:1.5rem;font:1rem/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
h1{font-size:1.6rem}h2{font-size:1.3rem;margin-top:2.5rem;border-bottom:2px solid var(--line)}h3{font-size:1.05rem;margin:0 0 .5rem}h4{font-size:1.1rem;margin:1.5rem 0 .5rem}h5{font-size:1rem;margin:0 0 .5rem}.page>h3{font-size:1.15rem;margin:1.5rem 0 .5rem}.page{border-top:4px solid var(--line);margin-top:3rem}ul.errors li{margin:.25rem 0}
code{font-family:ui-monospace,Consolas,monospace;font-size:.95em;overflow-wrap:anywhere}
table{border-collapse:collapse}th,td{border:1px solid var(--line);padding:.3rem .8rem;text-align:left}
.note,.help,.id{color:var(--muted)}
.finding{border:1px solid var(--line);border-left-width:.5rem;padding:1rem;margin:1rem 0}
.finding.fail{border-left-color:var(--fail)}.finding.likely{border-left-color:var(--likely)}.finding.advisory{border-left-color:var(--advisory)}.finding.info{border-left-color:var(--info)}
.status{font-weight:700;text-transform:uppercase;font-size:.85em}
.verdict{font-weight:600;font-size:.85em;border:1px solid var(--line);border-radius:.25rem;padding:0 .35em}
.fail .status{color:var(--fail)}.likely .status{color:var(--likely)}.advisory .status{color:var(--advisory)}.info .status{color:var(--info)}
.crops{display:flex;flex-wrap:wrap;gap:1rem;margin:.75rem 0}figure{margin:0}figure img{display:block;max-width:100%;height:auto;border:1px solid var(--line);background:#fff}figcaption{font-size:.85rem;color:var(--muted)}
dl{margin:.5rem 0}dl div{display:flex;flex-wrap:wrap;gap:.5rem}dt{font-weight:600;min-width:11rem}dd{margin:0}
.swatch{display:inline-block;width:1em;height:1em;border:1px solid var(--line);vertical-align:-.15em;margin-right:.35em}
`;

function modelNote(findings: Finding[]): string {
  return findings.some((finding) => finding.ai)
    ? `<p>A model was asked to judge some of the candidates. Its verdict is shown beside the status of each such finding (&quot;Model: yes&quot;, &quot;Model: no&quot;, &quot;Model: unsure&quot;) and never makes one a Fail. A yes can raise a candidate from Info to Likely. A no does not take a finding off the Likely list unless the scan was set to lower it: ${
        findings.filter((finding) => statusOf(finding) === 'likely' && modelVerdict(finding) === 'no').length
      } finding(s) under Likely carry &quot;Model: no&quot;. Each such finding shows the verdict, whether it was read from the cache instead of asked for in this run, the model’s own words and the status it had without the model; the measurements are those of the tool, not of the model.</p>\n`
    : '';
}

const SCOPE_NOTE =
  '<p>This report lists what the tool found and measured to assist a tester. It covers a small set of checks and makes no statement of conformance: a page with no findings here has not been shown to meet WCAG.</p>';

/** What a baseline file changed, in words. A recorded failure is still a failure, and the text says so. */
function baselineNote(summary: BaselineSummary | undefined): string {
  if (!summary) return '';
  const stale = summary.stale > 0 ? ` ${num(summary.stale)} entr(y/ies) of the baseline no longer occur on the pages that were scanned.` : '';
  const unknown = summary.notScanned > 0 ? ` ${num(summary.notScanned)} entr(y/ies) are for pages that were not scanned in this run.` : '';
  // Optional on purpose: a summary made by an earlier version has no such count.
  const unverified = (summary.unverified as number | undefined) ?? 0;
  const notLooked = unverified > 0 ? ` ${num(unverified)} entr(y/ies) were not looked for: their check did not run, or their page ended on another address than the one that was asked for.` : '';
  return `<p>A baseline file was used. ${num(summary.new)} Fail finding(s) are new: they are not in the baseline. ${num(summary.baselined)} Fail finding(s) are in the baseline: they were recorded earlier and do not break a build, and they are still failures, listed with the others and marked &quot;In the baseline&quot;.${stale}${unknown}${notLooked}</p>\n`;
}

function environmentNote(result: ScanResult): string {
  // Optional chaining on a non-optional type: see the note on `escape`.
  const environment = result.environment as Partial<ScanResult['environment']> | undefined;
  const viewport = environment?.viewport as Partial<ScanResult['environment']['viewport']> | undefined;
  const colorScheme = environment?.colorScheme === 'dark' ? 'dark' : 'light';
  return `Viewport ${num(viewport?.width)} by ${num(viewport?.height)} CSS px, device pixel ratio ${num(environment?.devicePixelRatio)}, ${colorScheme} colour scheme.`;
}

/**
 * The table of counts and the findings of one page, by status. `level` is the heading level of
 * a status: 2 in the report of one page, with findings at 3; 4 in a report of several, with
 * findings at 5.
 */
function renderPage(result: ScanResult, crops: Record<string, Png>, level: 2 | 4, caption: string): { table: string; sections: string } {
  const byStatus = new Map<Status, Finding[]>(STATUS_ORDER.map((status) => [status, []]));
  for (const finding of result.findings) byStatus.get(statusOf(finding))!.push(finding);

  const summary = STATUS_ORDER.map(
    (status) =>
      `<tr><th scope="row">${STATUS_TEXT[status].title}</th><td>${byStatus.get(status)!.length}</td><td>${STATUS_TEXT[status].note}</td></tr>`,
  ).join('');
  const heading = level === 2 ? 'h2' : 'h4';
  const sections = STATUS_ORDER.filter((status) => byStatus.get(status)!.length > 0)
    .map(
      (status) =>
        `<section><${heading}>${STATUS_TEXT[status].title} (${byStatus.get(status)!.length})</${heading}>
<p class="note">${STATUS_TEXT[status].note}</p>
${byStatus
  .get(status)!
  .map((finding) => renderFinding(finding, crops, level === 2 ? 'h3' : 'h5'))
  .join('\n')}</section>`,
    )
    .join('\n');
  const table = `<table>
<caption>${caption}</caption>
<thead><tr><th scope="col">Status</th><th scope="col">Count</th><th scope="col">Meaning</th></tr></thead>
<tbody>${summary}</tbody>
</table>`;
  return { table, sections };
}

function documentOf(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

/**
 * A single self-contained HTML file: findings grouped by status, each with its measured
 * values and its captures embedded as data URIs.
 */
export function toHtmlReport(result: ScanResult, crops: Record<string, Png> = {}, extra: { baseline?: BaselineSummary } = {}): string {
  const { table, sections } = renderPage(result, crops, 2, 'Findings by status');
  return documentOf(
    `${escape(TOOL_NAME)} evidence report: ${escape(result.url)}`,
    `<h1>Evidence report</h1>
<p><code>${escape(result.url)}</code></p>
<p class="note">Scanned ${escape(result.timestamp)} with ${escape(result.tool.name)} ${escape(result.tool.version)}. ${environmentNote(result)}</p>
${modelNote(result.findings)}${baselineNote(extra.baseline)}${SCOPE_NOTE}
${table}
${sections}`,
  );
}

/**
 * The report of a run over several pages, in one self-contained file: what could not be scanned
 * first, then the counts per page, then each page as `toHtmlReport` shows one. `crops` holds the
 * captures of each page, in the order of `run.pages`.
 */
export function toHtmlRunReport(run: Run, crops: Record<string, Png>[] = []): string {
  const counts = countRun(run);
  const errors =
    run.errors.length === 0
      ? ''
      : `<section><h2>Not scanned (${run.errors.length})</h2>
<p class="note">These pages could not be read. Nothing is known about them: they are not among the pages below, and the absence of findings for them means nothing.</p>
<ul class="errors">${run.errors.map((error) => `<li><code>${escape(error.url)}</code>: ${escape(error.message)}</li>`).join('')}</ul></section>\n`;
  const rows = run.pages
    .map((page, index) => {
      const of = (status: Status): number => page.result.findings.filter((finding) => statusOf(finding) === status).length;
      return `<tr><th scope="row"><a href="#page-${index + 1}"><code>${escape(page.requestedUrl)}</code></a></th><td>${of('fail')}</td><td>${of('likely')}</td><td>${of('advisory')}</td><td>${of('info')}</td></tr>`;
    })
    .join('');
  const pages = run.pages
    .map((page, index) => {
      const { table, sections } = renderPage(page.result, crops[index] ?? {}, 4, `Findings by status on page ${index + 1}`);
      const moved = page.result.url !== page.requestedUrl ? ` The document that was read is <code>${escape(page.result.url)}</code>.` : '';
      return `<section class="page" id="page-${index + 1}"><h3>Page ${index + 1}: <code>${escape(page.requestedUrl)}</code></h3>
<p class="note">Scanned ${escape(page.result.timestamp)}. ${environmentNote(page.result)}${moved}</p>
${table}
${sections}</section>`;
    })
    .join('\n');
  const all = run.pages.flatMap((page) => page.result.findings);
  const cut = inputNote(run.input);
  return documentOf(
    `${escape(TOOL_NAME)} evidence report: ${counts.pages} page(s)`,
    `<h1>Evidence report</h1>
<p class="note">Run of ${escape(run.timestamp)} with ${escape(run.tool.name)} ${escape(run.tool.version)}: ${counts.pages} page(s) scanned, ${counts.errors} not scanned.</p>
${modelNote(all)}${baselineNote(run.baseline)}${cut === '' ? '' : `<p><strong>${escape(cut)}</strong></p>\n`}${SCOPE_NOTE}
${errors}<section><h2>Pages</h2>
<table>
<caption>Findings by page and status</caption>
<thead><tr><th scope="col">Page</th><th scope="col">Fail</th><th scope="col">Likely</th><th scope="col">Advisory</th><th scope="col">Info</th></tr></thead>
<tbody>${rows}</tbody>
</table>
${pages}</section>`,
  );
}
