import type { Finding, Status } from '@a11y-vision/core';
import type { Decision, DecisionEntry } from './decisions.js';
import type { FindingGroup, FindingItem } from './state.js';
import { statusOf } from './state.js';
import { format } from './strings.js';
import type { StringKey, Strings } from './strings.js';

/**
 * Rendering, and nothing else: views in, DOM nodes out. What the panel holds and decides is in
 * `state.ts` and `panel.ts`.
 *
 * Selectors, messages, values and rationales are text of the page under test or of a model.
 * Every node is made with `createElement` and filled through `textContent` or a property; no
 * string is ever parsed as markup (there is no `innerHTML`, `outerHTML`, `insertAdjacentHTML`
 * or `document.write` in this package, which a test checks). Pictures come from blob URLs made
 * here from the captures.
 */

interface Props {
  class?: string;
  id?: string;
  text?: string;
  attrs?: Record<string, string>;
}

/** An element with its text and attributes set the safe way, and its children appended. */
export function h<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, props: Props = {}, ...children: Node[]): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  if (props.class !== undefined) element.className = props.class;
  if (props.id !== undefined) element.id = props.id;
  if (props.text !== undefined) element.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) element.setAttribute(name, value);
  if (children.length > 0) element.append(...children);
  return element;
}

const STATUS_TITLE: Record<Status, StringKey> = { fail: 'statusFail', likely: 'statusLikely', advisory: 'statusAdvisory', info: 'statusInfo' };
const STATUS_NOTE: Record<Status, StringKey> = { fail: 'noteFail', likely: 'noteLikely', advisory: 'noteAdvisory', info: 'noteInfo' };
const CHECK_TITLE: Record<string, StringKey> = {
  'focus-indicator': 'checkFocus',
  'icon-contrast': 'checkIcons',
  headings: 'checkHeadings',
  lists: 'checkLists',
  grouping: 'checkGrouping',
};
const DECISION_TEXT: Record<Decision, StringKey> = { confirmed: 'decisionConfirmed', dismissed: 'decisionDismissed' };
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function checkTitle(check: string, strings: Strings): string {
  const key = CHECK_TITLE[check];
  return key ? strings[key] : check;
}

export function statusTitle(status: Status, strings: Strings): string {
  return strings[STATUS_TITLE[status]];
}

export function decisionText(decision: Decision | null | undefined, strings: Strings): string {
  return decision ? strings[DECISION_TEXT[decision]] : strings.decisionNone;
}

/** Only what is a string or a finite number is shown; anything else is "unknown". Nothing calls a `toString` of a value. */
function shown(value: unknown, strings: Strings): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? strings.yes : strings.no;
  return strings.unknown;
}

function cropLabel(id: string, strings: Strings): string {
  if (id.endsWith('-focused.png')) return strings.cropFocused;
  if (id.endsWith('-unfocused.png')) return strings.cropUnfocused;
  if (id.startsWith('icon-contrast/')) return strings.cropAtRest;
  if (id.startsWith('headings/') || id.startsWith('lists/') || id.startsWith('grouping/')) return strings.cropInContext;
  return strings.cropCapture;
}

/** Sets the static texts of the page: every element with `data-text` gets the string of that key. */
export function applyStaticText(doc: Document, strings: Strings): void {
  for (const element of doc.querySelectorAll<HTMLElement>('[data-text]')) {
    const key = element.dataset['text'] as StringKey | undefined;
    if (key && Object.hasOwn(strings, key)) element.textContent = strings[key];
  }
}

export interface FindingHandlers {
  onDecision(finding: Finding, decision: Decision | null): void;
  onNote(finding: Finding, note: string): void;
  onHighlight(finding: Finding, button: HTMLButtonElement): void;
}

export interface RenderContext {
  doc: Document;
  strings: Strings;
  /** Blob URL of a capture by its id, or undefined when there is none. */
  cropUrl(id: string): string | undefined;
  handlers: FindingHandlers;
  /** Largest note that is kept. */
  maxNoteChars: number;
}

function detailRows(finding: Finding, strings: Strings): { term: string; value: string; swatch?: string; code?: boolean }[] {
  const rows: { term: string; value: string; swatch?: string; code?: boolean }[] = [];
  const evidence = finding.evidence ?? { crops: [], colors: {}, ratios: {}, flags: [] };
  rows.push({
    term: strings.criterionLabel,
    value: finding.wcag ? format(strings.criterionValue, { sc: shown(finding.wcag.sc, strings), level: shown(finding.wcag.level, strings) }) : strings.criterionNone,
  });
  rows.push({ term: strings.ruleLabel, value: shown(finding.rule, strings), code: true });
  for (const [role, ratio] of Object.entries(evidence.ratios ?? {})) {
    rows.push({ term: format(strings.measuredRatio, { role }), value: format(strings.ratioValue, { ratio: shown(ratio, strings) }) });
  }
  for (const [role, color] of Object.entries(evidence.colors ?? {})) {
    const text = shown(color, strings);
    // Only a plain hex colour is ever used as a colour.
    rows.push({ term: format(strings.colourLabel, { role }), value: text, code: true, ...(HEX_COLOR.test(text) ? { swatch: text } : {}) });
  }
  for (const [name, value] of Object.entries(evidence.values ?? {})) rows.push({ term: name, value: shown(value, strings) });
  const flags = Array.isArray(evidence.flags) ? evidence.flags.filter((flag) => typeof flag === 'string') : [];
  if (flags.length > 0) rows.push({ term: strings.flagsLabel, value: flags.join(', ') });
  if (finding.box) {
    const round = (value: unknown): string => (typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : strings.unknown);
    const { x, y, width, height } = finding.box;
    rows.push({ term: strings.boxLabel, value: format(strings.boxValue, { width: round(width), height: round(height), x: round(x), y: round(y) }) });
  }
  // What a model said is text from outside, like text of the page: shown, never acted on.
  const ai = finding.ai as Partial<NonNullable<Finding['ai']>> | null | undefined;
  if (ai !== undefined && ai !== null && typeof ai === 'object') {
    const list = (value: unknown): string => (Array.isArray(value) ? value.filter((item) => typeof item === 'string').join(', ') : '');
    rows.push({ term: strings.modelLabel, value: format(strings.modelValue, { model: shown(ai.model, strings), provider: shown(ai.provider, strings), prompt: shown(ai.promptVersion, strings) }) });
    rows.push({
      term: strings.modelVerdictLabel,
      value:
        format(strings.modelVerdictValue, {
          verdict: shown(ai.verdict, strings),
          confidence: shown(ai.confidence, strings),
          inputs: ai.inputs === 'text+image' ? strings.modelInputsImage : strings.modelInputsText,
        }) + (ai.fromCache === true ? strings.modelFromCache : ''),
    });
    rows.push({ term: strings.modelVotesLabel, value: list(ai.votes) });
    if (list(ai.problems) !== '') rows.push({ term: strings.modelProblemsLabel, value: list(ai.problems) });
    rows.push({ term: strings.modelRationaleLabel, value: shown(ai.rationale, strings) });
    rows.push({ term: strings.modelStatusBeforeLabel, value: shown(ai.statusBefore, strings) });
  }
  rows.push({ term: strings.findingIdLabel, value: shown(finding.id, strings), code: true });
  return rows;
}

/** Brings the decision controls of a finding in line with its entry. Used when one changes, so that the list is not built again and focus stays where it is. */
export function updateDecision(node: HTMLElement, entry: DecisionEntry | undefined, strings: Strings): void {
  const decision = entry?.decision ?? null;
  node.dataset['decision'] = decision ?? 'none';
  const state = node.querySelector<HTMLElement>('.decision-state');
  if (state) state.textContent = format(strings.decisionState, { state: decisionText(decision, strings) });
  node.querySelector('.confirm')?.setAttribute('aria-pressed', String(decision === 'confirmed'));
  node.querySelector('.dismiss')?.setAttribute('aria-pressed', String(decision === 'dismissed'));
}

let serial = 0;

/** One finding of the queue: what it is, the evidence, and the controls of the auditor. */
export function renderFinding(item: FindingItem, context: RenderContext, heading: 'h4' = 'h4'): HTMLElement {
  const { doc, strings, handlers } = context;
  const { finding, entry } = item;
  const status = statusOf(finding);
  const id = `finding-${++serial}`;
  const selector = shown(finding.selector, strings);

  const title = h(doc, heading, { id: `${id}-title` }, h(doc, 'span', { class: 'status', text: statusTitle(status, strings) }), doc.createTextNode(' '), h(doc, 'span', { class: 'rule', text: shown(finding.rule, strings) }));
  const verdict = (finding.ai as { verdict?: unknown } | null | undefined)?.verdict;
  if (verdict === 'yes' || verdict === 'no' || verdict === 'unsure') {
    title.append(doc.createTextNode(' '), h(doc, 'span', { class: 'verdict', text: format(strings.modelSaid, { verdict }) }));
  }

  const where = h(doc, 'p', { class: 'where' }, h(doc, 'span', { class: 'label', text: `${strings.selectorLabel}: ` }), h(doc, 'code', { text: selector }));
  if (typeof finding.frame === 'string' && finding.frame !== '') {
    where.append(doc.createTextNode(' '), h(doc, 'span', { class: 'label', text: `${strings.frameLabel}: ` }), h(doc, 'code', { text: finding.frame }));
  }

  const crops = h(doc, 'div', { class: 'crops' });
  for (const cropId of Array.isArray(finding.evidence?.crops) ? finding.evidence.crops : []) {
    const url = typeof cropId === 'string' ? context.cropUrl(cropId) : undefined;
    if (!url) continue;
    const label = cropLabel(cropId, strings);
    const image = h(doc, 'img', { attrs: { alt: format(strings.cropAlt, { label, selector }), loading: 'lazy' } });
    image.src = url;
    crops.append(h(doc, 'figure', {}, image, h(doc, 'figcaption', { text: label })));
  }

  const list = h(doc, 'dl');
  for (const row of detailRows(finding, strings)) {
    const value = h(doc, 'dd');
    if (row.swatch) {
      const swatch = h(doc, 'span', { class: 'swatch', attrs: { 'aria-hidden': 'true' } });
      swatch.style.backgroundColor = row.swatch;
      value.append(swatch);
    }
    value.append(row.code ? h(doc, 'code', { text: row.value }) : doc.createTextNode(row.value));
    list.append(h(doc, 'div', {}, h(doc, 'dt', { text: row.term }), value));
  }
  const details = h(doc, 'details', {}, h(doc, 'summary', { text: strings.detailsSummary }), list);

  const confirm = h(doc, 'button', { class: 'confirm', text: strings.confirmButton, attrs: { type: 'button', 'aria-pressed': 'false' } });
  const dismiss = h(doc, 'button', { class: 'dismiss', text: strings.dismissButton, attrs: { type: 'button', 'aria-pressed': 'false' } });
  const note = h(doc, 'textarea', { id: `${id}-note`, attrs: { rows: '2', maxlength: String(context.maxNoteChars) } });
  note.value = entry?.note ?? '';
  const highlight = h(doc, 'button', { class: 'highlight', text: strings.highlightButton, attrs: { type: 'button', 'aria-pressed': 'false' } });
  const decision = h(
    doc,
    'fieldset',
    { class: 'decision' },
    h(doc, 'legend', { text: strings.decisionLegend }),
    h(doc, 'p', { class: 'decision-state' }),
    h(doc, 'div', { class: 'buttons' }, confirm, dismiss, highlight),
    h(doc, 'label', { text: strings.noteLabel, attrs: { for: `${id}-note` } }),
    note,
  );

  const pressed = (button: HTMLElement): boolean => button.getAttribute('aria-pressed') === 'true';
  confirm.addEventListener('click', () => handlers.onDecision(finding, pressed(confirm) ? null : 'confirmed'));
  dismiss.addEventListener('click', () => handlers.onDecision(finding, pressed(dismiss) ? null : 'dismissed'));
  note.addEventListener('change', () => handlers.onNote(finding, note.value));
  highlight.addEventListener('click', () => handlers.onHighlight(finding, highlight));

  const article = h(
    doc,
    'article',
    { class: `finding status-${status}`, attrs: { 'aria-labelledby': `${id}-title`, 'data-finding-id': shown(finding.id, strings), 'data-status': status } },
    title,
    where,
    h(doc, 'p', { class: 'message', text: shown(finding.message, strings) }),
    h(doc, 'p', { class: 'help', text: shown(finding.help, strings) }),
  );
  if (crops.childNodes.length > 0) article.append(crops);
  article.append(details, decision);
  updateDecision(article, entry, strings);
  return article;
}

/** The queue: one section per group, with its count and what the status means. Replaces what `container` held. */
export function renderGroups(container: HTMLElement, groups: readonly FindingGroup[], context: RenderContext): void {
  const { doc, strings } = context;
  const sections: Node[] = [];
  for (const group of groups) {
    const status = group.by === 'status' ? (group.key as Status) : null;
    const name = status ? statusTitle(status, strings) : checkTitle(group.key, strings);
    const section = h(doc, 'section', { class: 'group', attrs: { 'data-group': group.key } }, h(doc, 'h3', { text: format(strings.groupCount, { title: name, count: group.items.length }) }));
    if (status) section.append(h(doc, 'p', { class: 'muted', text: strings[STATUS_NOTE[status]] }));
    const list = h(doc, 'ul', { class: 'findings' });
    for (const item of group.items) list.append(h(doc, 'li', {}, renderFinding(item, context)));
    section.append(list);
    sections.push(section);
  }
  if (sections.length === 0) sections.push(h(doc, 'p', { class: 'muted', text: strings.nothingShown }));
  container.replaceChildren(...sections);
}

/** The check boxes of the scan form. */
export function renderChecks(container: HTMLElement, checks: readonly string[], selected: readonly string[], doc: Document, strings: Strings): void {
  const rows = checks.map((check) => {
    const input = h(doc, 'input', { id: `check-${check}`, attrs: { type: 'checkbox', name: 'check', value: check } });
    input.checked = selected.includes(check);
    return h(doc, 'div', { class: 'check' }, input, h(doc, 'label', { text: checkTitle(check, strings), attrs: { for: `check-${check}` } }));
  });
  container.replaceChildren(...rows);
}
