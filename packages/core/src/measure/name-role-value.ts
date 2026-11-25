import { connectedComponents, diffMask } from './diff.js';
import type { PixelBox, RgbImage } from './image.js';
import type { NameRoleValueConfig, NameRoleValueSurvey, NrvElement, NrvNavigation, NrvProbe, NrvRegion, NrvStep, Status, WcagRef } from '../types.js';

/**
 * What the name-role-value check reports (4.1.2), from the survey of a page and, when probing
 * ran, from what activating some of its controls did. Everything here is deterministic and pure.
 *
 * Roles, names and states are those of the accessibility tree Chrome computed; nothing is worked
 * out again from attributes. A `fail` is only ever a fact read from that tree about an element
 * whose interactivity was measured (see `provenInteractive` and `noRoleStatus`). What is inferred
 * from behaviour or from markup is `likely` or lower, unless the owner raises the measured
 * link-or-button cases (`behaviourRoleStatus`).
 */

export const NRV_SC: WcagRef = { sc: '4.1.2', level: 'A' };

export type NrvRule =
  | 'missing-name'
  | 'name-not-descriptive'
  | 'title-only-name'
  | 'placeholder-only-name'
  | 'no-role'
  | 'focusable-hidden'
  | 'nested-interactive'
  | 'required-context'
  | 'link-acts-as-button'
  | 'button-acts-as-link'
  | 'missing-state'
  | 'state-not-exposed';

/**
 * Roles of controls, as Chrome names them in its tree. `DisclosureTriangle` is a `summary`,
 * `PopUpButton` and `ToggleButton` are older names of Chrome for some buttons, `Date`,
 * `DateTime`, `InputTime` and `ColorWell` are inputs.
 */
export const CONTROL_ROLES: readonly string[] = [
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem',
  'slider', 'spinbutton', 'combobox', 'textbox', 'searchbox', 'listbox', 'scrollbar', 'DisclosureTriangle', 'PopUpButton', 'ToggleButton',
  'Date', 'DateTime', 'InputTime', 'ColorWell',
];

/**
 * Roles that are not controls but make an element something on its own, which may take focus
 * and listen to clicks without being a control without a role: composite widgets, containers a
 * script moves focus to (a dialog, a tab panel, a region that scrolls), media, frames.
 */
const OWN_ROLES: readonly string[] = [
  'tablist', 'radiogroup', 'menu', 'menubar', 'tree', 'treegrid', 'grid', 'toolbar', 'application', 'dialog', 'alertdialog', 'tabpanel',
  'region', 'document', 'feed', 'log', 'main', 'form', 'search', 'article', 'Video', 'Audio', 'Iframe', 'IframePresentational', 'Embed',
  'PluginObject', 'MenuListPopup', 'RootWebArea', 'WebArea', 'row', 'gridcell', 'columnheader', 'rowheader', 'separator', 'Canvas',
];

/** Roles whose value a field holds: a name only from `title` is reported for these. */
const FIELD_ROLES: readonly string[] = ['textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'slider', 'checkbox', 'radio', 'switch', 'Date', 'DateTime', 'InputTime', 'ColorWell'];

/** Activation by a pointer. */
const POINTER_TYPES: readonly string[] = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'auxclick', 'dblclick'];

/**
 * What handles an activation: a click (which a key press on a control also fires), or a key. A
 * press alone (`mousedown`, `pointerdown`, `touchstart` and their ends) is what dragging, drag to
 * scroll, a selection or a ripple listen to: no proof of a control.
 */
const ACTIVATION_HANDLER_TYPES: readonly string[] = ['click', 'auxclick', 'dblclick', 'keydown', 'keyup', 'keypress'];

/** Framework handlers of an activation, by the name of the prop or event (`react:onClick`, `jquery:keydown`, `ember:action`). */
function activationFramework(element: NrvElement): boolean {
  return element.framework.some((handler) => /(?:^ember:action$|:on(?:Click|DoubleClick|Key(?:Down|Up|Press))(?:Capture)?$|:(?:click|dblclick|keydown|keyup|keypress)$)/.test(handler));
}

/** Requests of these types, stopped after an activation, are what a script needs to go on: a reaction to their block is not a reaction to the activation. */
const SCRIPT_READ_TYPES: readonly string[] = ['Fetch', 'XHR', 'Script', 'EventSource', 'Other', 'WebSocket', 'Prefetch'];
export { SCRIPT_READ_TYPES as NRV_SCRIPT_READ_TYPES };

/** States compared before and after an activation. A change of any of them, or of the name, is a state that is exposed. */
const COMPARED_STATES: readonly string[] = ['expanded', 'pressed', 'checked', 'selected', 'valuenow', 'valuetext', 'disabled'];

/** Roles whose children are presentational in ARIA: a control inside them is not exposed as one (the axe rule `nested-interactive`). */
const PRESENTATIONAL_CHILDREN: readonly string[] = ['button', 'checkbox', 'img', 'menuitemcheckbox', 'menuitemradio', 'meter', 'option', 'progressbar', 'radio', 'scrollbar', 'separator', 'slider', 'switch', 'tab'];

/** What a candidate of this check is. */
export interface NrvCandidate {
  ord: number;
  rule: `name-role-value/${NrvRule}`;
  status: Status;
  flags: string[];
  values: Record<string, string | number | boolean>;
  /** The axe-core rule that reports the same thing, when there is one. */
  axeRule?: string;
  /** The probe the finding rests on, when it does. */
  probe?: NrvProbe;
}

export interface NrvReport {
  candidates: NrvCandidate[];
  /** Candidates beyond `maxCandidates`. */
  omitted: number;
  /** Candidates of rules that axe-core covers, left out by `includeAxeCovered: false`. */
  axeCoveredLeftOut: number;
  counts: {
    elements: number;
    named: number;
    controls: number;
    noRoleCandidates: number;
    probed: number;
    stateExposed: number;
    linkBehaviour: number;
    buttonBehaviour: number;
  };
}

const STATUS_ORDER: Status[] = ['fail', 'likely', 'advisory', 'info'];

function regex(source: string, flags: string): RegExp | null {
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

export function isControlRole(role: string): boolean {
  return CONTROL_ROLES.includes(role);
}

/** Native controls whose state is the browser's business: they are checked for their name only. */
function nativelyStateful(element: NrvElement): boolean {
  return ['input', 'select', 'textarea', 'summary', 'details', 'option'].includes(element.tag);
}

function pointerListeners(element: NrvElement): string[] {
  return element.listeners.filter((type) => POINTER_TYPES.includes(type));
}

/** Focusable in sequence: a `tabindex` of 0 or more, or the Tab walk reached it. */
function sequentiallyFocusable(element: NrvElement): boolean {
  return (element.tabindex !== null && element.tabindex >= 0) || element.sources.includes('tab');
}

/**
 * The strict proof that an element is interactive, for a `fail` on its name: a native control
 * that is not disabled, or a control role with something that makes it operable (Chrome says it
 * is focusable, the Tab walk reached it, or a listener or a framework handler is on it).
 */
export function provenInteractive(element: NrvElement): boolean {
  if (element.disabled || element.ax?.disabled) return false;
  if (element.sources.includes('native')) return true;
  if (!element.ax || !isControlRole(element.ax.role)) return false;
  return element.ax.focusable || element.sources.includes('tab') || element.listeners.length > 0 || element.framework.length > 0;
}

/** The axe-core rule that reports an empty name for this element, or undefined when none does. */
export function axeNameRule(element: NrvElement): string | undefined {
  const role = element.ax?.role ?? '';
  const native = element.sources.includes('native');
  if (element.tag === 'area') return 'area-alt';
  if (element.tag === 'iframe' || element.tag === 'frame') return 'frame-title';
  if (element.tag === 'summary') return 'summary-name';
  if (element.tag === 'input' && element.type === 'image') return 'input-image-alt';
  if (element.tag === 'input' && ['button', 'submit', 'reset'].includes(element.type)) return 'input-button-name';
  if (element.tag === 'select') return 'select-name';
  if (native && (element.tag === 'input' || element.tag === 'textarea')) return 'label';
  if (role === 'button' && element.tag === 'button') return 'button-name';
  if (role === 'link' && (element.tag === 'a' || element.tag === 'area') && !element.roleAttr) return 'link-name';
  if (['button', 'link', 'menuitem'].includes(role)) return 'aria-command-name';
  if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio', 'option'].includes(role)) return 'aria-toggle-field-name';
  if (['combobox', 'listbox', 'searchbox', 'slider', 'spinbutton', 'textbox'].includes(role)) return 'aria-input-field-name';
  if (role === 'treeitem') return 'aria-treeitem-name';
  return undefined;
}

/** The element is a control the name rules look at, and which ones. */
function namedControl(element: NrvElement): boolean {
  const ax = element.ax;
  if (!ax || ax.ignored) return false;
  // The options of a native select are named by their text and announced through the select.
  if (element.tag === 'option' || element.tag === 'optgroup') return false;
  return isControlRole(ax.role) && (element.sources.includes('native') || element.sources.includes('role'));
}

/** Words that are no name, files, classes, glyphs: what the name of a control says when it names nothing. */
export function nameProblem(name: string, element: NrvElement, config: NameRoleValueConfig): { flag: string; status: Status } | null {
  const text = name.trim();
  if (text === '') return null;
  const privateUse = regex(config.privateUsePattern, 'u');
  if (privateUse) {
    const global = new RegExp(privateUse.source, 'gu');
    if (privateUse.test(text) && !/[\p{L}\p{N}]/u.test(text.replace(global, ''))) return { flag: 'privateUse', status: 'likely' };
  }
  if (regex(config.genericNamePattern, 'iu')?.test(text)) {
    // A link named after what it points to is named: "button" to the page about buttons, "Toggle" to the section of that name.
    const words = element.href?.words ?? '';
    if (element.ax?.role === 'link' && words !== '' && words.includes(text.toLowerCase())) return null;
    return { flag: 'generic', status: 'likely' };
  }
  if (!/\s/.test(text) && regex(config.fileNamePattern, 'iu')?.test(text)) return { flag: 'fileName', status: 'likely' };
  if (regex(config.classLikeNamePattern, 'u')?.test(text)) return element.iconFont ? { flag: 'ligature', status: 'advisory' } : { flag: 'classLike', status: 'likely' };
  if (element.ax?.role !== 'link' && regex(config.urlNamePattern, 'iu')?.test(text)) return { flag: 'url', status: 'advisory' };
  if (!/[\p{L}\p{N}]/u.test(text)) return { flag: 'symbols', status: 'advisory' };
  return null;
}

/** What an activation did that is a navigation: to another document, another route, or a place in the page. */
export function navigatedBy(step: NrvStep): NrvNavigation[] {
  return step.navigations.filter((navigation) => {
    if (navigation.carriesFieldValue) return false;
    switch (navigation.kind) {
      case 'document':
        // The same address again is a reload (a refresh, a language switch that sets a cookie): no place.
        return (navigation.method ?? 'GET') === 'GET' && navigation.otherPath !== false;
      // A frame that loads something else is recorded and not taken for a navigation of the element:
      // on real pages it is a frame the page itself reloads (an embedded playground, an advert).
      case 'frame':
        return false;
      case 'history':
        return navigation.otherPath === true;
      case 'fragment':
        // `#` and `#!` alone go nowhere; a fragment with a target, or a route of a hash router, is a place.
        return navigation.targetFound === true || /^#[!/]./.test(navigation.url);
      default:
        return false;
    }
  });
}

/** What appeared or disappeared that counts as a change in place: not a toast or a live message, and large enough. */
function meaningfulRegions(regions: NrvRegion[], config: NameRoleValueConfig): NrvRegion[] {
  return regions.filter((region) => region.kind !== 'live' && (region.kind === 'dialog' || region.near !== false) && region.box.width * region.box.height >= config.revealMinAreaCssPx2);
}

function changedStates(before: NrvProbe['before'], step: NrvStep): string[] {
  if (!before || !step.ax) return [];
  const changed: string[] = [];
  for (const state of COMPARED_STATES) if ((before.states[state] ?? '') !== (step.ax.states[state] ?? '')) changed.push(state);
  if (before.name !== step.ax.name) changed.push('name');
  if (before.role !== step.ax.role) changed.push('role');
  return changed;
}

/** What an activation did, in a few words: the basis of every behavioural rule. */
export interface ProbeReading {
  navigated: NrvNavigation[];
  newWindow: boolean;
  submitted: boolean;
  dialog: boolean;
  revealed: NrvRegion[];
  /** Of those, the ones that were in the page before, hidden: shown, not added. */
  shownExisting: NrvRegion[];
  hidden: NrvRegion[];
  textChanged: boolean;
  own: boolean;
  states: string[];
  /** It tried to send a request of another method than GET or HEAD: it performs an action (an order, a deletion, a subscription). */
  sendsWrite: boolean;
  /** Something changed in place: a dialog, a region shown or hidden, text elsewhere, the element's own look, or one of its states. */
  inPlace: boolean;
  /** The page scrolled and nothing was shown or hidden: what a link to a place in the page does when it scrolls by script. */
  movedInPage: boolean;
  /** Reads a script asked for after the activation were stopped: what followed may be the page's reaction to that. */
  blockedReads: boolean;
  /** A script read a field of the page during the activation. */
  fieldRead: boolean;
  /** A timer the activation set had not run when it was read: something was still to happen (a navigation after a spinner, perhaps). */
  timerPending: boolean;
}

export function readProbe(probe: NrvProbe, config: NameRoleValueConfig): ProbeReading | null {
  const step = probe.after;
  if (probe.outcome !== 'done' || !step) return null;
  const revealed = meaningfulRegions(step.revealed, config);
  const hidden = meaningfulRegions(step.hidden, config);
  const dialog = step.revealed.some((region) => region.kind === 'dialog');
  // Pixels of an element that change also without an activation (an animation, a ticker) say nothing of it.
  const own = !step.selfAnimating && step.ownChange !== null && step.ownChange >= config.ownChangeMinAreaCssPx2;
  const states = changedStates(probe.before ?? null, step);
  // Text that changes because the page scrolled (a "you are reading" label) is the scroll's doing.
  const textChanged = step.textChanged > 0 && !step.scrolled;
  return {
    navigated: navigatedBy(step),
    newWindow: step.navigations.some((navigation) => navigation.kind === 'window'),
    submitted: step.navigations.some((navigation) => navigation.kind === 'submit' || ((navigation.kind === 'document' || navigation.kind === 'frame') && (navigation.method ?? 'GET') !== 'GET')),
    dialog,
    revealed,
    shownExisting: revealed.filter((region) => region.existed),
    hidden,
    textChanged,
    own,
    states,
    sendsWrite: (step.writes ?? 0) > 0,
    inPlace: dialog || revealed.length > 0 || hidden.length > 0 || textChanged || own || states.length > 0,
    // Scrolled the page to a place and showed nothing: a link to a place in the page that does its own scrolling.
    movedInPage: step.scrolled && !dialog && revealed.length === 0 && hidden.length === 0,
    blockedReads: (step.blockedReads ?? 0) > 0,
    fieldRead: step.fieldRead === true,
    timerPending: step.timerPending === true,
  };
}

/** The probe of an element, when it ran to its end. */
function probeOf(survey: NameRoleValueSurvey, ord: number): NrvProbe | undefined {
  return survey.probe.probes.find((probe) => probe.ord === ord && probe.outcome === 'done');
}

/** A candidate for a control without a role: not a control, not inside one, not holding one, not a label, not a container. */
function noRoleShape(element: NrvElement, config: NameRoleValueConfig): boolean {
  const ax = element.ax;
  if (!ax || ax.ignored || isControlRole(ax.role) || OWN_ROLES.includes(ax.role) || element.sources.includes('native')) return false;
  if (['html', 'body', 'iframe', 'frame', 'video', 'audio', 'label', 'option', 'optgroup', 'select', 'input', 'textarea', 'button', 'summary', 'details', 'dialog', 'form'].includes(element.tag)) return false;
  if (element.sources.includes('contenteditable') || ax.states['editable']) return false;
  if (element.insideControl !== '' || element.interactiveDescendants > 0 || element.isLabel) return false;
  if (element.areaShare > config.maxControlAreaShare) return false;
  // A region that scrolls takes focus so that the keyboard can scroll it (and a drag to scroll listens to presses): not a control.
  if (element.scrollable) return false;
  // What a closed shadow root holds cannot be inspected: nothing is said of its host.
  if (element.closedShadow) return false;
  return element.visible || element.sources.includes('tab');
}

/** It handles an activation by itself: a click or key listener of its own, or a framework handler of one. */
function handlesActivation(element: NrvElement): boolean {
  return element.listeners.some((type) => ACTIVATION_HANDLER_TYPES.includes(type)) || activationFramework(element);
}

/**
 * Status of a control without a role, or null when it is not reported. See the README for the
 * table. A `fail` needs an effect that the activation caused, measured: focusable in sequence, and
 * activated, it navigated, changed the page in place or tried to send a write. Listeners alone are
 * never a `fail`, and an activation that showed nothing never supports one.
 */
export function noRoleStatus(element: NrvElement, reading: ProbeReading | null, config: NameRoleValueConfig): Status | null {
  if (!noRoleShape(element, config)) return null;
  const handler = handlesActivation(element);
  // Presses only (mousedown, pointerdown, touchstart...), or a framework handler of something else.
  const pressOnly = !handler && (pointerListeners(element).length > 0 || element.framework.length > 0);
  const focusable = sequentiallyFocusable(element);
  const cursor = element.sources.includes('cursor');
  // What the activation caused. A change after a read the probe stopped may be the page's reaction to the block;
  // a write may be a tracker that listens to every click of the document, when something there listens.
  const effect = reading !== null && (reading.navigated.length > 0 || (reading.inPlace && !reading.blockedReads) || (reading.sendsWrite && !element.delegated));
  if (focusable && effect) return 'fail';
  if (effect || (focusable && handler) || (handler && cursor)) return 'likely';
  if (handler || (pressOnly && (focusable || cursor))) return 'advisory';
  return null;
}

/**
 * Which elements are activated, in which order. Probing takes them from the front, up to its
 * limits. First what static evidence leaves open: links that point nowhere (link or button?),
 * elements that may be controls without a role, triggers (`aria-expanded`, `aria-controls`,
 * `aria-haspopup`: is the state kept?), toggles (`aria-pressed`, a custom checkbox, switch or
 * radio, a tab); then the other buttons and stateful roles; links with an address and a handler
 * of their own last. Never: native fields (they keep their own state), plain links with an
 * address and no handler, what submits a form.
 */
export function nameRoleValueProbeTargets(survey: NameRoleValueSurvey, config: NameRoleValueConfig): { ord: number; reason: NrvProbe['reason'] }[] {
  const order = ['no-href', 'no-role', 'trigger', 'toggle', 'stateful', 'link-handler'] as const;
  const buckets: Record<NrvProbe['reason'], number[]> = { 'no-href': [], 'no-role': [], trigger: [], toggle: [], stateful: [], 'link-handler': [] };
  for (const element of survey.elements) {
    const ax = element.ax;
    if (!ax || ax.ignored || !element.visible || element.excluded || element.disabled || ax.disabled || element.submits) continue;
    if (['input', 'select', 'textarea', 'option', 'iframe', 'frame', 'video', 'audio', 'summary', 'details', 'label'].includes(element.tag)) continue;
    if (element.sources.includes('contenteditable') || element.insideControl !== '') continue;
    // A link that opens a new window or downloads says so in its markup, and would leave the page.
    if (element.href && (element.href.download || !['', '_self', '_top', '_parent'].includes(element.href.target.toLowerCase()))) continue;
    const evidence = element.listeners.length > 0 || element.framework.length > 0 || element.delegated;
    if (!evidence) continue;
    const pointer = pointerListeners(element).length > 0 || element.framework.length > 0;
    const has = (name: string): boolean => element.attrs[name] !== undefined;
    if (ax.role === 'link') {
      const kind = element.href?.kind;
      if (kind === undefined || kind === 'none' || kind === 'hash' || kind === 'hashbang' || kind === 'javascript') buckets['no-href'].push(element.ord);
      else if (pointer && kind !== 'empty') buckets['link-handler'].push(element.ord);
    } else if (['button', 'tab', 'switch', 'checkbox', 'radio', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'option'].includes(ax.role)) {
      if (has('aria-expanded') || has('aria-controls') || (has('aria-haspopup') && element.attrs['aria-haspopup'] !== 'false')) buckets.trigger.push(element.ord);
      else if (has('aria-pressed') || ['tab', 'switch', 'checkbox', 'radio', 'menuitemcheckbox', 'menuitemradio'].includes(ax.role)) buckets.toggle.push(element.ord);
      else buckets.stateful.push(element.ord);
    } else if (noRoleShape(element, config) && (pointer || element.sources.includes('cursor') || element.sources.includes('tabindex'))) {
      buckets['no-role'].push(element.ord);
    }
  }
  return order.flatMap((reason) => buckets[reason].map((ord) => ({ ord, reason })));
}

function axeCovered(candidate: NrvCandidate): boolean {
  return candidate.axeRule !== undefined;
}

function textValues(element: NrvElement): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = { element: element.tag + (element.type ? `:${element.type}` : '') + (element.roleAttr ? `[role=${element.roleAttr}]` : '') };
  if (element.ax) {
    values['role'] = element.ax.role;
    values['name'] = element.ax.name;
    if (element.ax.nameSource) values['nameSource'] = element.ax.nameSource;
  }
  if (element.text) values['text'] = element.text;
  if (element.sources.length > 0) values['interactiveBy'] = element.sources.join(', ');
  if (element.listeners.length > 0) values['listeners'] = element.listeners.join(', ');
  if (element.framework.length > 0) values['frameworkHandlers'] = element.framework.join(', ');
  return values;
}

function axStateText(state: NrvProbe['before'] | NrvStep['ax'] | undefined): string {
  if (!state) return 'not in the accessibility tree';
  const states = Object.entries(state.states)
    .filter(([name]) => COMPARED_STATES.includes(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`);
  return [`role=${state.role}`, `name="${state.name}"`, ...states].join('; ');
}

/** Evidence of a probe as values of a finding: what the tree said before and after, and what happened. */
function probeValues(probe: NrvProbe, reading: ProbeReading): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {
    axBefore: axStateText(probe.before),
    axAfter: axStateText(probe.after?.ax),
  };
  if (probe.again) values['axAfterSecondActivation'] = axStateText(probe.again.ax);
  const navigations = probe.after?.navigations ?? [];
  if (navigations.length > 0) values['navigations'] = navigations.map((navigation) => `${navigation.kind}${navigation.method ? ` ${navigation.method}` : ''} ${navigation.url}`).join(' | ');
  if (reading.revealed.length > 0) values['regionsShown'] = reading.revealed.length;
  if (reading.hidden.length > 0) values['regionsHidden'] = reading.hidden.length;
  if (reading.dialog) values['dialogOpened'] = true;
  if (probe.after?.ownChange !== null && probe.after?.ownChange !== undefined) values['ownChangeCssPx2'] = Math.round(probe.after.ownChange);
  if (reading.states.length > 0) values['statesChanged'] = reading.states.join(', ');
  if (probe.after?.blockedReads) values['readsStopped'] = probe.after.blockedReads;
  if (probe.after?.selfAnimating) values['changesWithoutActivation'] = true;
  if (probe.after?.timerPending) values['timerPending'] = true;
  if (probe.again) {
    values['secondActivationHidesWhatAppeared'] = probe.again.revealReverted;
    values['secondActivationRestoresLook'] = probe.again.ownReverted;
  }
  return values;
}

function pushCandidate(list: NrvCandidate[], seen: Set<string>, candidate: NrvCandidate): void {
  const key = `${candidate.ord}\u0000${candidate.rule}`;
  if (seen.has(key)) return;
  seen.add(key);
  list.push(candidate);
}

/** Everything the check reports, ordered: `fail` first, then by document order. */
export function nameRoleValueReport(survey: NameRoleValueSurvey, config: NameRoleValueConfig): NrvReport {
  const all: NrvCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: NrvCandidate): void => pushCandidate(all, seen, candidate);
  const counts: NrvReport['counts'] = { elements: survey.elements.length, named: 0, controls: 0, noRoleCandidates: 0, probed: 0, stateExposed: 0, linkBehaviour: 0, buttonBehaviour: 0 };
  const incomplete = !survey.axComplete;
  const status = (value: Status): Status => (incomplete && value !== 'info' ? 'info' : value);
  const flags = (...extra: string[]): string[] => (incomplete ? [...extra, 'axIncomplete'] : extra);
  // Tab sets in which no tab is exposed as selected.
  const tabSets = new Map<number, NrvElement[]>();

  for (const element of survey.elements) {
    const ax = element.ax;
    const probe = probeOf(survey, element.ord);
    const reading = probe ? readProbe(probe, config) : null;
    if (probe) counts.probed++;

    // Focusable content under aria-hidden: reached by Tab, absent from the tree.
    if (ax?.ignored && element.sources.includes('tab') && ax.ignored.some((reason) => reason.startsWith('ariaHidden'))) {
      add({ ord: element.ord, rule: 'name-role-value/focusable-hidden', status: status('fail'), flags: flags(...ax.ignored), values: textValues(element), axeRule: 'aria-hidden-focus' });
      continue;
    }
    if (!ax || ax.ignored) continue;

    // Frames: a name when what is inside is interactive.
    if ((element.tag === 'iframe' || element.tag === 'frame') && ax.name === '') {
      // A frame the agent can look into is interactive when it holds a focusable element; one it cannot, when the Tab walk went into it.
      const interactive = element.frameContent?.readable === true ? element.frameContent.focusables > 0 : element.sources.includes('tab');
      if (interactive) add({ ord: element.ord, rule: 'name-role-value/missing-name', status: status('fail'), flags: flags('frame'), values: { ...textValues(element), focusables: element.frameContent?.focusables ?? 0 }, axeRule: 'frame-title' });
      continue;
    }

    if (namedControl(element)) {
      counts.controls++;
      if (ax.name.trim() === '') {
        const proven = provenInteractive(element);
        const disabled = element.disabled || ax.disabled;
        // No box and taken out of the Tab order: a duplicate the author hid (an empty link beside the title of a card). Still announced in browse mode, so reported, as likely.
        const hiddenDuplicate = element.box === null && element.tabindex !== null && element.tabindex < 0;
        // Its only visible text comes from CSS: Chrome leaves it out of the name, other browsers may not.
        const generated = element.generatedText === true;
        const extra = [disabled ? 'disabled' : '', proven || disabled ? '' : 'notOperable', hiddenDuplicate ? 'noBoxNotInTabOrder' : '', generated ? 'cssGeneratedText' : ''].filter(Boolean);
        const axeRule = axeNameRule(element);
        const nameStatus: Status = generated ? (proven ? config.generatedTextNameStatus : 'advisory') : proven && !hiddenDuplicate ? 'fail' : 'likely';
        add({ ord: element.ord, rule: 'name-role-value/missing-name', status: status(nameStatus), flags: flags(...extra), values: textValues(element), ...(axeRule ? { axeRule } : {}) });
      } else {
        counts.named++;
        const problem = nameProblem(ax.name, element, config);
        if (problem) add({ ord: element.ord, rule: 'name-role-value/name-not-descriptive', status: status(problem.status), flags: flags(problem.flag), values: textValues(element) });
        else if (ax.nameSource === 'attribute:title' && FIELD_ROLES.includes(ax.role)) {
          add({ ord: element.ord, rule: 'name-role-value/title-only-name', status: status(config.titleOnlyStatus), flags: flags(), values: textValues(element) });
        } else if (ax.nameSource.startsWith('placeholder')) {
          add({ ord: element.ord, rule: 'name-role-value/placeholder-only-name', status: status(config.placeholderOnlyStatus), flags: flags(), values: textValues(element) });
        }
      }

      // A control inside a control whose children are presentational, or inside a link or a button.
      // A link in a summary is allowed by HTML (summary takes phrasing content), and Chrome exposes both.
      if (element.insideControl !== '' && !element.insideControl.startsWith('summary|') && ax.focusable) {
        const [, outerRole] = element.insideControl.split('|');
        const covered = PRESENTATIONAL_CHILDREN.includes(outerRole ?? '');
        add({
          ord: element.ord,
          rule: 'name-role-value/nested-interactive',
          status: status('likely'),
          flags: flags(),
          values: { ...textValues(element), insideOf: element.insideControl.replace('|', ' with the role ') },
          ...(covered ? { axeRule: 'nested-interactive' } : {}),
        });
      }

      // Required context, as the tree shows it.
      const parent = ax.context[0] ?? '';
      const within = (roles: string[]): boolean => roles.includes(parent) || (parent === 'group' && roles.includes(ax.context[1] ?? ''));
      const context =
        ax.role === 'tab' ? (within(['tablist']) ? null : 'tablist')
        : ['menuitem', 'menuitemcheckbox', 'menuitemradio'].includes(ax.role) ? (within(['menu', 'menubar']) ? null : 'menu or menubar')
        : ax.role === 'treeitem' ? (within(['tree']) ? null : 'tree')
        : ax.role === 'option' && element.tag !== 'option' ? (within(['listbox', 'MenuListPopup', 'combobox']) ? null : 'listbox')
        : null;
      if (context) add({ ord: element.ord, rule: 'name-role-value/required-context', status: status('likely'), flags: flags(), values: { ...textValues(element), requiredContext: context, context: ax.context.join(' < ') || '(none)' }, axeRule: 'aria-required-parent' });
      if (ax.role === 'radio' && element.roleAttr === 'radio' && !within(['radiogroup'])) {
        add({ ord: element.ord, rule: 'name-role-value/required-context', status: status('advisory'), flags: flags('noRadiogroup'), values: { ...textValues(element), requiredContext: 'radiogroup', context: ax.context.join(' < ') || '(none)' } });
      }

      // States that a custom control has to carry, read from the markup.
      if (!nativelyStateful(element)) {
        const has = (name: string): boolean => element.attrs[name] !== undefined && element.attrs[name] !== '';
        if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(ax.role) && element.roleAttr !== '' && !has('aria-checked')) {
          add({ ord: element.ord, rule: 'name-role-value/missing-state', status: status('likely'), flags: flags('noAriaChecked'), values: { ...textValues(element), expected: 'aria-checked', exposedAs: ax.states['checked'] ?? '(none)' }, axeRule: 'aria-required-attr' });
        } else if (ax.role === 'combobox' && element.roleAttr === 'combobox' && !has('aria-expanded')) {
          add({ ord: element.ord, rule: 'name-role-value/missing-state', status: status('likely'), flags: flags('noAriaExpanded'), values: { ...textValues(element), expected: 'aria-expanded' }, axeRule: 'aria-required-attr' });
        } else if (['slider', 'scrollbar'].includes(ax.role) && element.roleAttr !== '' && !has('aria-valuenow')) {
          add({ ord: element.ord, rule: 'name-role-value/missing-state', status: status('likely'), flags: flags('noAriaValuenow'), values: { ...textValues(element), expected: 'aria-valuenow' }, axeRule: 'aria-required-attr' });
        } else if (ax.role === 'spinbutton' && element.roleAttr !== '' && !has('aria-valuenow') && !has('aria-valuetext')) {
          add({ ord: element.ord, rule: 'name-role-value/missing-state', status: status('advisory'), flags: flags('noAriaValuenow'), values: { ...textValues(element), expected: 'aria-valuenow or aria-valuetext' } });
        } else if (ax.role === 'button' && !has('aria-expanded') && ['true', 'menu', 'listbox', 'tree', 'grid'].includes((element.attrs['aria-haspopup'] ?? '').toLowerCase())) {
          add({ ord: element.ord, rule: 'name-role-value/missing-state', status: status('advisory'), flags: flags('hasPopup'), values: { ...textValues(element), expected: 'aria-expanded', hasPopup: element.attrs['aria-haspopup'] ?? '' } });
        } else if (ax.role === 'button' && !has('aria-expanded') && element.controlsHidden) {
          add({ ord: element.ord, rule: 'name-role-value/missing-state', status: status('advisory'), flags: flags('controlsHidden'), values: { ...textValues(element), expected: 'aria-expanded', controls: element.attrs['aria-controls'] ?? '' } });
        }
        if (ax.role === 'tab' && element.container >= 0) {
          const set = tabSets.get(element.container) ?? [];
          set.push(element);
          tabSets.set(element.container, set);
        }
      }
    }

    // A control role the browser does not expose, because what it needs around it is missing (an option outside a list box).
    if (!namedControl(element) && ['option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem'].includes(element.roleAttr) && !isControlRole(ax.role)) {
      add({ ord: element.ord, rule: 'name-role-value/required-context', status: status('likely'), flags: flags('roleDropped'), values: { ...textValues(element), requiredContext: element.roleAttr === 'tab' ? 'tablist' : element.roleAttr === 'treeitem' ? 'tree' : element.roleAttr === 'option' ? 'listbox' : 'menu or menubar', context: ax.context.join(' < ') || '(none)' }, axeRule: 'aria-required-parent' });
    }

    // A control without a role.
    const noRole = noRoleStatus(element, reading, config);
    if (noRole !== null) {
      counts.noRoleCandidates++;
      const pointer = pointerListeners(element);
      const handler = handlesActivation(element);
      const extra = [
        pointer.length > 0 ? 'pointerListener' : element.listeners.length > 0 ? 'keyListener' : '',
        !handler && (pointer.length > 0 || element.framework.length > 0) ? 'pressOnly' : '',
        element.framework.length > 0 ? 'frameworkHandler' : '',
        sequentiallyFocusable(element) ? 'focusable' : 'notFocusable',
        element.sources.includes('cursor') ? 'cursorPointer' : '',
        element.tag === 'a' && element.href?.kind === 'none' ? 'anchorWithoutHref' : '',
        reading ? (reading.navigated.length > 0 ? 'navigates' : reading.inPlace ? 'changesInPlace' : reading.sendsWrite ? 'sendsRequest' : 'noEffect') : '',
      ].filter(Boolean);
      add({ ord: element.ord, rule: 'name-role-value/no-role', status: status(noRole), flags: flags(...extra), values: { ...textValues(element), ...(probe && reading ? probeValues(probe, reading) : {}), suggestedRole: reading?.navigated.length ? 'link' : 'button' } });
    }

    // Link or button, from what the element does.
    if (ax.role === 'link' || ax.role === 'button') {
      const measured = config.behaviourRoleStatus;
      // Not activated, or activated with nothing to show for it: what the markup says still stands, as advisory.
      const unseen = !reading || (!reading.inPlace && !reading.sendsWrite && !reading.submitted && !reading.newWindow && reading.navigated.length === 0);
      if (reading) {
        if (reading.navigated.length > 0) counts.linkBehaviour++;
        else if (reading.inPlace) counts.buttonBehaviour++;
      }
      if (ax.role === 'link') {
        // A link that scrolls the page to a place by script goes somewhere, as a link does.
        if (reading && reading.navigated.length === 0 && !reading.newWindow && !reading.submitted && !reading.movedInPage && (reading.inPlace || reading.sendsWrite)) {
          const what = reading.dialog ? 'opensDialog' : reading.revealed.length > 0 || reading.hidden.length > 0 ? 'showsOrHides' : reading.states.length > 0 ? 'changesState' : reading.textChanged ? 'changesText' : reading.own ? 'changesLook' : 'sendsRequest';
          // A read the probe stopped may be why it did not navigate (a script that loads, then goes): nothing is built on that.
          const held = reading.blockedReads && !reading.sendsWrite;
          // Nor on a timer of the activation that had not run yet: it may be the navigation.
          const pending = reading.timerPending;
          add({
            ord: element.ord,
            rule: 'name-role-value/link-acts-as-button',
            status: status(held || pending ? 'info' : measured),
            flags: flags('measured', what, ...(held ? ['requestBlocked'] : []), ...(pending ? ['timerPending'] : [])),
            values: { ...textValues(element), href: element.href?.kind ?? 'none', ...probeValues(probe!, reading) },
            probe: probe!,
          });
        } else if (unseen) {
          const kind = element.href?.kind;
          const noTarget = element.tag !== 'a' && element.tag !== 'area' ? !element.href : kind === 'none' || kind === 'hash' || kind === 'hashbang' || kind === 'javascript';
          const handler = pointerListeners(element).length > 0 || element.framework.length > 0;
          if (noTarget && (handler || element.tag !== 'a')) {
            add({ ord: element.ord, rule: 'name-role-value/link-acts-as-button', status: status('advisory'), flags: flags('static', 'noNavigationTarget', ...(reading ? ['activatedNoEffect'] : [])), values: { ...textValues(element), href: kind ?? 'none' } });
          }
        }
      } else if (!element.submits) {
        // A button that changed its own state or part of the page is a button, whatever the address does
        // (an accordion that keeps the open panel in the fragment). One that belongs to a form, or read a
        // field, falls under the exception for what sends a form, whatever the field holds.
        const actedInPlace = reading !== null && (reading.states.length > 0 || reading.revealed.length > 0 || reading.hidden.length > 0 || reading.dialog || reading.own);
        const sendsFields = element.inForm || (reading?.fieldRead ?? false);
        if (reading && reading.navigated.length > 0 && !reading.dialog && !reading.submitted && !reading.sendsWrite && !actedInPlace && !sendsFields) {
          const kinds = [...new Set(reading.navigated.map((navigation) => navigation.kind))];
          // A timer of the activation that had not run yet may still change something in place.
          const pending = reading.timerPending;
          add({
            ord: element.ord,
            rule: 'name-role-value/button-acts-as-link',
            status: status(pending ? 'info' : measured),
            flags: flags('measured', ...kinds.map((kind) => `navigates:${kind}`), ...(pending ? ['timerPending'] : [])),
            values: { ...textValues(element), ...probeValues(probe!, reading) },
            probe: probe!,
          });
        } else if (reading && reading.newWindow && !reading.inPlace && !reading.submitted) {
          add({ ord: element.ord, rule: 'name-role-value/button-acts-as-link', status: status('advisory'), flags: flags('measured', 'newWindow'), values: { ...textValues(element), ...probeValues(probe!, reading) }, probe: probe! });
        } else if (unseen && element.tag === 'a' && element.href?.kind === 'url') {
          add({ ord: element.ord, rule: 'name-role-value/button-acts-as-link', status: status('advisory'), flags: flags('static', 'hrefWithButtonRole', ...(reading ? ['activatedNoEffect'] : [])), values: { ...textValues(element), href: element.href.kind } });
        }
      }
    }

    // State, from what an activation changed.
    if (reading && probe && isControlRole(ax.role) && !nativelyStateful(element) && ax.role !== 'link' && reading.navigated.length === 0 && !reading.submitted && !reading.dialog && !probe.after!.removed && !probe.after!.selfHidden) {
      if (reading.states.length > 0) counts.stateExposed++;
      else {
        const expandedAttr = element.attrs['aria-expanded'] !== undefined;
        const regions = reading.shownExisting.length > 0 || reading.hidden.length > 0;
        const fixedOnly = reading.shownExisting.length > 0 && reading.shownExisting.every((region) => region.fixed);
        const again = probe.again;
        // One part shown and another hidden: a panel swapped for another (tabs, slides, steps).
        const swap = reading.shownExisting.length > 0 && reading.hidden.length > 0;
        let found: { status: Status; flag: string } | null = null;
        if (regions && expandedAttr) found = { status: 'likely', flag: 'expandedNotUpdated' };
        else if (regions && ax.role === 'tab') found = { status: 'likely', flag: 'selectionNotExposed' };
        else if (!swap && reading.shownExisting.length > 0 && again?.revealReverted && !fixedOnly) found = { status: 'likely', flag: 'disclosure' };
        else if (!regions && reading.revealed.length === 0 && reading.own && again?.ownReverted) found = { status: 'likely', flag: ['checkbox', 'switch', 'radio', 'menuitemcheckbox', 'menuitemradio'].includes(ax.role) ? 'checkedNotUpdated' : 'toggle' };
        // A swap with the control itself unchanged: the next slide of a carousel, the next step
        // of a wizard. Nothing to expose on a control that moves on.
        else if (swap && !reading.own) found = null;
        else if (regions) found = { status: 'advisory', flag: fixedOnly ? 'fixedRegion' : 'regionChanged' };
        else if (reading.own && reading.revealed.length === 0) found = { status: 'advisory', flag: 'lookChanged' };
        // The state may be set once a request comes back, and the probe stopped one: never built on the block.
        const held = reading.blockedReads || reading.sendsWrite;
        // Or once a timer of the activation runs, one that had not run yet.
        const pending = reading.timerPending;
        if (found) {
          add({
            ord: element.ord,
            rule: 'name-role-value/state-not-exposed',
            status: status(held || pending ? 'info' : found.status),
            flags: flags('measured', found.flag, ...(held ? ['requestBlocked'] : []), ...(pending ? ['timerPending'] : [])),
            values: { ...textValues(element), ...probeValues(probe, reading) },
            probe,
          });
        }
      }
    }
  }

  // Tab sets of which no tab is exposed as selected: once, on the first tab.
  for (const tabs of tabSets.values()) {
    if (tabs.some((tab) => tab.ax?.states['selected'] === 'true')) continue;
    const first = tabs[0]!;
    add({ ord: first.ord, rule: 'name-role-value/missing-state', status: status('likely'), flags: flags('noSelectedTab'), values: { ...textValues(first), expected: 'aria-selected="true" on the selected tab', tabs: tabs.length } });
  }

  const kept = config.includeAxeCovered ? all : all.filter((candidate) => !axeCovered(candidate));
  for (const candidate of kept) if (candidate.axeRule) candidate.flags.push('axeCovered');
  kept.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.ord - b.ord || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
  return {
    candidates: kept.slice(0, config.maxCandidates),
    omitted: Math.max(0, kept.length - config.maxCandidates),
    axeCoveredLeftOut: all.length - kept.length,
    counts,
  };
}

/**
 * Pixels that changed between two captures of the same region, inside `rect` (device pixels), in
 * device pixels, specks smaller than `minArea` left out. `afterRect` is where the element is in the
 * second capture when the page moved it (content added above it): of the same size, elsewhere.
 * Null when that place is not inside the second capture.
 */
export function changedPixels(before: RgbImage, after: RgbImage, rect: PixelBox, deltaE: number, minArea: number, afterRect: PixelBox = rect): number | null {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const width = Math.min(before.width, Math.ceil(rect.x + rect.width)) - x0;
  const height = Math.min(before.height, Math.ceil(rect.y + rect.height)) - y0;
  if (width <= 0 || height <= 0) return 0;
  const ax = x0 + Math.round(afterRect.x - rect.x);
  const ay = y0 + Math.round(afterRect.y - rect.y);
  if (ax < 0 || ay < 0 || ax + width > after.width || ay + height > after.height) return null;
  const cut = (image: RgbImage, left: number, top: number): RgbImage => {
    const data = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) data.set(image.data.subarray(((top + y) * image.width + left) * 3, ((top + y) * image.width + left + width) * 3), y * width * 3);
    return { width, height, data };
  };
  const mask = diffMask(cut(before, x0, y0), cut(after, ax, ay), deltaE);
  return connectedComponents(mask, Math.max(1, minArea)).reduce((sum, component) => sum + component.area, 0);
}
