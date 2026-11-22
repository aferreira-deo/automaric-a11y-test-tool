import { TOOL_NAME } from '@a11y-vision/core';
import type { Finding, Png, ScanResult, Status } from '@a11y-vision/core';

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
  return 'Capture';
}

function renderFinding(finding: Finding, crops: Record<string, Png>): string {
  const evidence = {
    crops: finding.evidence?.crops ?? [],
    colors: finding.evidence?.colors ?? {},
    ratios: finding.evidence?.ratios ?? {},
    flags: finding.evidence?.flags ?? [],
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
  if (evidence.flags.length > 0) rows.push(['Flags', evidence.flags.map(escape).join(', ')]);
  if (finding.box) {
    const { x, y, width, height } = finding.box;
    rows.push(['Box (CSS px)', `${num(width, true)} by ${num(height, true)} at ${num(x, true)}, ${num(y, true)}`]);
  }
  if (finding.ai) {
    rows.push(['Model', `${escape(finding.ai.model)}, prompt ${escape(finding.ai.promptVersion)}`]);
    rows.push(['Model votes', finding.ai.votes.map(escape).join(', ')]);
    rows.push(['Model rationale', escape(finding.ai.rationale)]);
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

  return `<article class="finding ${status}">
<h3><span class="status">${STATUS_TEXT[status].title}</span> <code>${escape(finding.selector)}</code></h3>
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
h1{font-size:1.6rem}h2{font-size:1.3rem;margin-top:2.5rem;border-bottom:2px solid var(--line)}h3{font-size:1.05rem;margin:0 0 .5rem}
code{font-family:ui-monospace,Consolas,monospace;font-size:.95em;overflow-wrap:anywhere}
table{border-collapse:collapse}th,td{border:1px solid var(--line);padding:.3rem .8rem;text-align:left}
.note,.help,.id{color:var(--muted)}
.finding{border:1px solid var(--line);border-left-width:.5rem;padding:1rem;margin:1rem 0}
.finding.fail{border-left-color:var(--fail)}.finding.likely{border-left-color:var(--likely)}.finding.advisory{border-left-color:var(--advisory)}.finding.info{border-left-color:var(--info)}
.status{font-weight:700;text-transform:uppercase;font-size:.85em}
.fail .status{color:var(--fail)}.likely .status{color:var(--likely)}.advisory .status{color:var(--advisory)}.info .status{color:var(--info)}
.crops{display:flex;flex-wrap:wrap;gap:1rem;margin:.75rem 0}figure{margin:0}figure img{display:block;max-width:100%;height:auto;border:1px solid var(--line);background:#fff}figcaption{font-size:.85rem;color:var(--muted)}
dl{margin:.5rem 0}dl div{display:flex;flex-wrap:wrap;gap:.5rem}dt{font-weight:600;min-width:11rem}dd{margin:0}
.swatch{display:inline-block;width:1em;height:1em;border:1px solid var(--line);vertical-align:-.15em;margin-right:.35em}
`;

/**
 * A single self-contained HTML file: findings grouped by status, each with its measured
 * values and its captures embedded as data URIs.
 */
export function toHtmlReport(result: ScanResult, crops: Record<string, Png> = {}): string {
  const byStatus = new Map<Status, Finding[]>(STATUS_ORDER.map((status) => [status, []]));
  for (const finding of result.findings) byStatus.get(statusOf(finding))!.push(finding);

  const summary = STATUS_ORDER.map(
    (status) =>
      `<tr><th scope="row">${STATUS_TEXT[status].title}</th><td>${byStatus.get(status)!.length}</td><td>${STATUS_TEXT[status].note}</td></tr>`,
  ).join('');

  const sections = STATUS_ORDER.filter((status) => byStatus.get(status)!.length > 0)
    .map(
      (status) =>
        `<section><h2>${STATUS_TEXT[status].title} (${byStatus.get(status)!.length})</h2>
<p class="note">${STATUS_TEXT[status].note}</p>
${byStatus
  .get(status)!
  .map((finding) => renderFinding(finding, crops))
  .join('\n')}</section>`,
    )
    .join('\n');

  // Optional chaining on a non-optional type: see the note on `escape`.
  const environment = result.environment as Partial<ScanResult['environment']> | undefined;
  const viewport = environment?.viewport as Partial<ScanResult['environment']['viewport']> | undefined;
  const colorScheme = environment?.colorScheme === 'dark' ? 'dark' : 'light';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(TOOL_NAME)} evidence report: ${escape(result.url)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>Evidence report</h1>
<p><code>${escape(result.url)}</code></p>
<p class="note">Scanned ${escape(result.timestamp)} with ${escape(result.tool.name)} ${escape(result.tool.version)}. Viewport ${num(viewport?.width)} by ${num(viewport?.height)} CSS px, device pixel ratio ${num(environment?.devicePixelRatio)}, ${colorScheme} colour scheme.</p>
<p>This report lists what the tool found and measured to assist a tester. It covers a small set of checks and makes no statement of conformance: a page with no findings here has not been shown to meet WCAG.</p>
<table>
<caption>Findings by status</caption>
<thead><tr><th scope="col">Status</th><th scope="col">Count</th><th scope="col">Meaning</th></tr></thead>
<tbody>${summary}</tbody>
</table>
${sections}
</main>
</body>
</html>
`;
}
