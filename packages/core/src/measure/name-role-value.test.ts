import { describe, expect, it } from 'vitest';
import { defaultConfig, resolveConfig, resolveNameRoleValue } from '../config.js';
import { runChecks } from '../run.js';
import type { NameRoleValueSurvey, NrvAx, NrvAxState, NrvElement, NrvProbe, NrvStep, Snapshot } from '../types.js';
import { createImage, fillRect } from './image.js';
import { axeNameRule, changedPixels, nameProblem, nameRoleValueProbeTargets, nameRoleValueReport, navigatedBy, noRoleStatus, provenInteractive, readProbe } from './name-role-value.js';

const config = defaultConfig.nameRoleValue;

function ax(role: string, name = '', extra: Partial<NrvAx> = {}): NrvAx {
  return { role, name, nameSource: name ? 'contents:' : '', focusable: false, disabled: false, states: {}, context: ['main', 'RootWebArea'], ...extra };
}

let ords = 0;
function element(extra: Partial<NrvElement> = {}): NrvElement {
  return {
    ord: ords++,
    selector: `#e${ords}`,
    frame: '',
    box: { x: 0, y: 0, width: 80, height: 30 },
    visible: true,
    tag: 'div',
    type: '',
    roleAttr: '',
    ax: ax('generic'),
    sources: [],
    listeners: [],
    framework: [],
    delegated: false,
    tabindex: null,
    disabled: false,
    submits: false,
    inForm: false,
    isLabel: false,
    insideControl: '',
    interactiveDescendants: 0,
    text: 'Go',
    textChars: 2,
    areaShare: 0.01,
    iconFont: false,
    attrs: {},
    controlsHidden: false,
    excluded: false,
    container: -1,
    ...extra,
  };
}

function button(extra: Partial<NrvElement> = {}): NrvElement {
  return element({ tag: 'button', type: 'button', ax: ax('button', 'Save', { focusable: true }), sources: ['native', 'role', 'tab'], ...extra });
}

function survey(elements: NrvElement[], probes: NrvProbe[] = [], extra: Partial<NameRoleValueSurvey> = {}): NameRoleValueSurvey {
  return {
    elements: elements.map((item, index) => ({ ...item, ord: index })),
    total: elements.length,
    axComplete: true,
    walk: 'own',
    listenersRead: true,
    listenersBeyond: 0,
    captures: {},
    probe: { mode: 'safe', ran: probes.length > 0, probes, planned: probes.length, blocked: [], allowed: 0, fetched: 0, unsafe: 0, escapes: 0, popups: 0, guarded: {}, clones: 0, reused: 0 },
    ...extra,
  };
}

function step(extra: Partial<NrvStep> = {}): NrvStep {
  return { ax: null, removed: false, navigations: [], revealed: [], hidden: [], textChanged: 0, ownChange: 0, scrolled: false, focusMoved: false, dialogs: 0, writes: 0, ...extra };
}

const region = (extra: Partial<NrvStep['revealed'][number]> = {}): NrvStep['revealed'][number] => ({ box: { x: 0, y: 100, width: 300, height: 60 }, kind: '', fixed: false, controlled: false, near: true, existed: true, ...extra });

function probe(ord: number, before: NrvAxState | null, after: NrvStep, again?: NrvProbe['again']): NrvProbe {
  return { ord, selector: `#p${ord}`, frame: '', reason: 'stateful', outcome: 'done', before, after, ...(again ? { again } : {}), crops: { before: 'b.png', after: 'a.png' } };
}

const rules = (report: ReturnType<typeof nameRoleValueReport>) => report.candidates.map((candidate) => [candidate.ord, candidate.rule.replace('name-role-value/', ''), candidate.status]);

describe('the proof that an element is interactive', () => {
  it('is a native control that is not disabled, or a control role that something makes operable', () => {
    expect(provenInteractive(button())).toBe(true);
    expect(provenInteractive(button({ disabled: true }))).toBe(false);
    expect(provenInteractive(element({ roleAttr: 'button', ax: ax('button'), sources: ['role'] }))).toBe(false);
    expect(provenInteractive(element({ roleAttr: 'button', ax: ax('button', '', { focusable: true }), sources: ['role'] }))).toBe(true);
    expect(provenInteractive(element({ roleAttr: 'button', ax: ax('button'), sources: ['role', 'listener'], listeners: ['click'] }))).toBe(true);
    expect(provenInteractive(element({ ax: ax('generic'), listeners: ['click'] }))).toBe(false);
  });

  it('says which axe-core rule reports an empty name, if any', () => {
    expect(axeNameRule(button())).toBe('button-name');
    expect(axeNameRule(element({ tag: 'a', ax: ax('link'), sources: ['native', 'role'] }))).toBe('link-name');
    expect(axeNameRule(element({ roleAttr: 'checkbox', ax: ax('checkbox'), sources: ['role'] }))).toBe('aria-toggle-field-name');
    expect(axeNameRule(element({ tag: 'input', type: 'text', ax: ax('textbox'), sources: ['native', 'role'] }))).toBe('label');
    expect(axeNameRule(element({ roleAttr: 'tab', ax: ax('tab'), sources: ['role'] }))).toBeUndefined();
  });
});

describe('names that do not name', () => {
  const control = button();
  it('in English and in French, without catching names that are words', () => {
    expect(nameProblem('button', control, config)?.flag).toBe('generic');
    expect(nameProblem('Bouton', control, config)?.flag).toBe('generic');
    expect(nameProblem('lien', control, config)?.flag).toBe('generic');
    expect(nameProblem('icône', control, config)?.flag).toBe('generic');
    expect(nameProblem('Menu', control, config)).toBeNull();
    expect(nameProblem('close', control, config)).toBeNull();
    expect(nameProblem('Fermer', control, config)).toBeNull();
    expect(nameProblem('Sign-in', control, config)).toBeNull();
    expect(nameProblem('porte-monnaie', control, config)).toBeNull();
    // "Click here" is 2.4.4.
    expect(nameProblem('click here', control, config)).toBeNull();
    expect(nameProblem('cliquez ici', control, config)).toBeNull();
  });

  it('a link named after what it points to is named', () => {
    const link = (words: string) => element({ tag: 'a', href: { kind: 'url', target: '', download: false, sameDocument: false, words }, ax: ax('link', 'button') });
    expect(nameProblem('button', link('/docs/web/accessibility/aria/roles/button_role'), config)).toBeNull();
    expect(nameProblem('Toggle', link('/docs/components/modal/#toggle-between-modals'), config)).toBeNull();
    expect(nameProblem('link', link('/cart'), config)?.flag).toBe('generic');
  });

  it('files, classes, glyphs, addresses and symbols', () => {
    expect(nameProblem('logo-header.png', control, config)).toEqual({ flag: 'fileName', status: 'likely' });
    expect(nameProblem('Download report.pdf', control, config)).toBeNull();
    expect(nameProblem('btn_close', control, config)).toEqual({ flag: 'classLike', status: 'likely' });
    expect(nameProblem('fa-times', control, config)).toEqual({ flag: 'classLike', status: 'likely' });
    expect(nameProblem('arrow_forward', button({ iconFont: true }), config)).toEqual({ flag: 'ligature', status: 'advisory' });
    expect(nameProblem('', control, config)).toEqual({ flag: 'privateUse', status: 'likely' });
    expect(nameProblem(' Close', control, config)).toBeNull();
    expect(nameProblem('https://example.com/a', control, config)).toEqual({ flag: 'url', status: 'advisory' });
    expect(nameProblem('https://example.com/a', element({ tag: 'a', ax: ax('link', 'x') }), config)).toBeNull();
    expect(nameProblem('×', control, config)).toEqual({ flag: 'symbols', status: 'advisory' });
    expect(nameProblem('2', control, config)).toBeNull();
  });
});

describe('controls without a role', () => {
  const focusableDiv = element({ tabindex: 0, listeners: ['click'], sources: ['listener', 'tabindex'] });
  const acted = () => readProbe(probe(0, ax('generic'), step({ revealed: [region()] })), config);
  const nothing = () => readProbe(probe(0, ax('generic'), step()), config);
  it('follow the table of the README: a fail needs an effect the activation caused', () => {
    expect(noRoleStatus(focusableDiv, acted(), config)).toBe('fail');
    // Listeners and focus alone, or an activation that showed nothing, are no fail.
    expect(noRoleStatus(focusableDiv, null, config)).toBe('likely');
    expect(noRoleStatus(focusableDiv, nothing(), config)).toBe('likely');
    expect(noRoleStatus(element({ tabindex: 0, listeners: ['keydown'], sources: ['listener', 'tabindex'] }), null, config)).toBe('likely');
    expect(noRoleStatus(element({ listeners: ['click'], sources: ['listener', 'cursor'] }), null, config)).toBe('likely');
    expect(noRoleStatus(element({ framework: ['react:onClick'], sources: ['framework', 'cursor'] }), null, config)).toBe('likely');
    expect(noRoleStatus(element({ listeners: ['click'], sources: ['listener'] }), null, config)).toBe('advisory');
    expect(noRoleStatus(element({ listeners: ['click'], sources: ['listener'] }), acted(), config)).toBe('likely');
    expect(noRoleStatus(element({ sources: ['cursor'] }), null, config)).toBeNull();
  });

  it('a press alone (drag, selection, ripple) is no proof of a control', () => {
    const drag = element({ tabindex: 0, listeners: ['mousedown'], sources: ['listener', 'tabindex'] });
    expect(noRoleStatus(drag, null, config)).toBe('advisory');
    expect(noRoleStatus(drag, nothing(), config)).toBe('advisory');
    expect(noRoleStatus(element({ listeners: ['pointerdown'], sources: ['listener'] }), null, config)).toBeNull();
  });

  it('a framework handler alone is not enough for a fail; seen acting, it is', () => {
    const react = element({ tabindex: 0, framework: ['react:onClick'], sources: ['framework', 'tabindex'] });
    expect(noRoleStatus(react, null, config)).toBe('likely');
    expect(noRoleStatus(react, acted(), config)).toBe('fail');
  });

  it('an effect the activation may not have caused is no effect: a reaction to a stopped read, a write where the document listens to every click', () => {
    const afterBlock = readProbe(probe(0, ax('generic'), step({ revealed: [region()], blockedReads: 1 })), config);
    expect(noRoleStatus(focusableDiv, afterBlock, config)).toBe('likely');
    const write = readProbe(probe(0, ax('generic'), step({ writes: 1 })), config);
    expect(noRoleStatus(focusableDiv, write, config)).toBe('fail');
    expect(noRoleStatus({ ...focusableDiv, delegated: true }, write, config)).toBe('likely');
  });

  it('a region that scrolls and a host of a closed shadow root are not candidates', () => {
    expect(noRoleStatus({ ...focusableDiv, scrollable: true }, acted(), config)).toBeNull();
    expect(noRoleStatus({ ...focusableDiv, tag: 'x-buy', closedShadow: true }, acted(), config)).toBeNull();
  });

  it('pixels of the element that change also without an activation are no effect', () => {
    const animated = readProbe(probe(0, ax('generic'), step({ ownChange: 500, selfAnimating: true })), config)!;
    expect(animated.own).toBe(false);
    expect(animated.inPlace).toBe(false);
    expect(noRoleStatus(focusableDiv, animated, config)).toBe('likely');
    expect(readProbe(probe(0, ax('generic'), step({ ownChange: 500 })), config)!.own).toBe(true);
  });

  it('leave out containers, labels, what is inside a control and what holds one', () => {
    expect(noRoleStatus({ ...focusableDiv, interactiveDescendants: 1 }, null, config)).toBeNull();
    expect(noRoleStatus({ ...focusableDiv, insideControl: 'a|link' }, null, config)).toBeNull();
    expect(noRoleStatus({ ...focusableDiv, isLabel: true }, null, config)).toBeNull();
    expect(noRoleStatus({ ...focusableDiv, tag: 'label' }, null, config)).toBeNull();
    expect(noRoleStatus({ ...focusableDiv, areaShare: 0.6 }, null, config)).toBeNull();
    expect(noRoleStatus({ ...focusableDiv, ax: ax('dialog') }, null, config)).toBeNull();
    expect(noRoleStatus({ ...focusableDiv, ax: ax('button') }, null, config)).toBeNull();
    expect(noRoleStatus({ ...focusableDiv, ax: { ...ax('generic'), ignored: ['ariaHiddenSubtree'] } }, null, config)).toBeNull();
  });
});

describe('what an activation did', () => {
  it('navigations count when they go somewhere, not when they send a form', () => {
    const nav = (navigation: NrvStep['navigations'][number]) => navigatedBy(step({ navigations: [navigation] })).length;
    expect(nav({ kind: 'document', url: 'https://a/b', method: 'GET', otherPath: true })).toBe(1);
    expect(nav({ kind: 'document', url: 'https://a/b', method: 'POST', otherPath: true })).toBe(0);
    expect(nav({ kind: 'document', url: 'https://a/search', method: 'GET', carriesFieldValue: true })).toBe(0);
    // The same address again: a reload, not a place.
    expect(nav({ kind: 'document', url: 'https://a/b', method: 'GET', otherPath: false })).toBe(0);
    expect(nav({ kind: 'history', url: 'https://a/other', otherPath: true })).toBe(1);
    expect(nav({ kind: 'history', url: 'https://a/same', otherPath: false })).toBe(0);
    expect(nav({ kind: 'replace', url: 'https://a/other', otherPath: true })).toBe(0);
    expect(nav({ kind: 'fragment', url: '#section', targetFound: true })).toBe(1);
    expect(nav({ kind: 'fragment', url: '#', targetFound: false })).toBe(0);
    expect(nav({ kind: 'fragment', url: '#/route', targetFound: false })).toBe(1);
    expect(nav({ kind: 'window', url: 'https://a/b' })).toBe(0);
    expect(nav({ kind: 'frame', url: 'https://ads/b', method: 'GET', otherPath: true })).toBe(0);
  });

  it('toasts, specks and what appears far from the element do not count as a change in place; a dialog does', () => {
    const reading = readProbe(probe(0, ax('button'), step({ revealed: [region({ kind: 'live' }), region({ box: { x: 0, y: 0, width: 10, height: 10 } }), region({ near: false })] })), config)!;
    expect(reading.inPlace).toBe(false);
    expect(readProbe(probe(0, ax('button'), step({ revealed: [region({ kind: 'dialog', near: false })] })), config)!.dialog).toBe(true);
  });

  it('a link inside a summary is not a nested control; a button inside a link is', () => {
    const inside = (insideControl: string) => element({ tag: 'a', insideControl, ax: ax('link', 'Guides', { focusable: true }), sources: ['native', 'role'] });
    expect(rules(nameRoleValueReport(survey([inside('summary|button'), inside('a|link')]), config))).toEqual([[1, 'nested-interactive', 'likely']]);
  });
});

describe('the report', () => {
  it('fails an empty name on a proven control, holds it back when disabled or not operable', () => {
    const report = nameRoleValueReport(
      survey([
        button({ ax: ax('button', '', { focusable: true }) }),
        button({ ax: ax('button', '', { disabled: true }), disabled: true }),
        element({ roleAttr: 'button', ax: ax('button'), sources: ['role'] }),
        button(),
        element({ tag: 'a', box: null, tabindex: -1, ax: ax('link', '', { focusable: true }), sources: ['native', 'role'] }),
      ]),
      config,
    );
    expect(rules(report)).toEqual([
      [0, 'missing-name', 'fail'],
      [1, 'missing-name', 'likely'],
      [2, 'missing-name', 'likely'],
      [4, 'missing-name', 'likely'],
    ]);
    expect(report.candidates[3]!.flags).toContain('noBoxNotInTabOrder');
  });

  it('reports a link that opens a dialog, and a button that navigates, at the configured status', () => {
    const link = element({ tag: 'a', href: { kind: 'hash', target: '', download: false, sameDocument: true }, ax: ax('link', 'Sign in', { focusable: true }), sources: ['native', 'role'], listeners: ['click'] });
    const nav = button();
    const probes = [
      probe(0, ax('link', 'Sign in'), step({ ax: ax('link', 'Sign in'), revealed: [region({ kind: 'dialog' })] })),
      probe(1, ax('button', 'Save'), step({ ax: ax('button', 'Save'), navigations: [{ kind: 'document', url: 'https://a/shops', method: 'GET', otherPath: true }] })),
    ];
    expect(rules(nameRoleValueReport(survey([link, nav], probes), config))).toEqual([
      [0, 'link-acts-as-button', 'likely'],
      [1, 'button-acts-as-link', 'likely'],
    ]);
    const raised = resolveNameRoleValue({ behaviourRoleStatus: 'fail' });
    expect(rules(nameRoleValueReport(survey([link, nav], probes), raised)).map((entry) => entry[2])).toEqual(['fail', 'fail']);
  });

  it('a button that writes and then navigates is a button: the exception of the owner', () => {
    const probes = [probe(0, ax('button', 'Save'), step({ ax: ax('button', 'Save'), writes: 1, navigations: [{ kind: 'history', url: 'https://a/done', otherPath: true }] }))];
    expect(rules(nameRoleValueReport(survey([button()], probes), config))).toEqual([]);
  });

  it('a button that changed its state or part of the page is a button, whatever the address does', () => {
    const fragment = { kind: 'fragment' as const, url: '#faq-1', targetFound: true };
    const probes = [
      // An accordion that keeps its open panel in the fragment.
      probe(0, ax('button', 'Shipping', { states: { expanded: 'false' } }), step({ ax: ax('button', 'Shipping', { states: { expanded: 'true' } }), revealed: [region()], navigations: [fragment] })),
      // Only the address changed: it acts as a link.
      probe(1, ax('button', 'Save'), step({ ax: ax('button', 'Save'), navigations: [fragment] })),
    ];
    expect(rules(nameRoleValueReport(survey([button(), button()], probes), config))).toEqual([[1, 'button-acts-as-link', 'likely']]);
  });

  it('a button of a form, or one that read a field, that navigates sends the form: not reported, whatever the field holds', () => {
    const search = { kind: 'document' as const, url: 'https://a/search', method: 'GET', otherPath: true, carriesFieldValue: false };
    const probes = [probe(0, ax('button', 'Search'), step({ ax: ax('button', 'Search'), navigations: [search], fieldRead: true })), probe(1, ax('button', 'Go'), step({ ax: ax('button', 'Go'), navigations: [search] }))];
    expect(rules(nameRoleValueReport(survey([button(), button({ inForm: true })], probes), config))).toEqual([]);
  });

  it('a link that scrolls to a place, with a label beside it that follows the scroll, is a link', () => {
    const link = element({ tag: 'a', href: { kind: 'fragment', target: '', download: false, sameDocument: true, words: '#part-3' }, ax: ax('link', 'Part 3', { focusable: true }), sources: ['native', 'role'], listeners: ['click'] });
    const probes = [probe(0, ax('link', 'Part 3'), step({ ax: ax('link', 'Part 3'), scrolled: true, textChanged: 1 }))];
    expect(rules(nameRoleValueReport(survey([link], probes), config))).toEqual([]);
  });

  it('nothing is built on the reaction of the page to a request the probe stopped', () => {
    const expanded = ax('button', 'Reviews', { states: { expanded: 'false' } });
    const link = element({ tag: 'a', href: { kind: 'hash', target: '', download: false, sameDocument: true }, ax: ax('link', 'More', { focusable: true }), sources: ['native', 'role'], listeners: ['click'] });
    const probes = [
      probe(0, expanded, step({ ax: expanded, revealed: [region()], blockedReads: 1 })),
      probe(1, ax('link', 'More'), step({ ax: ax('link', 'More'), textChanged: 1, blockedReads: 2 })),
    ];
    const report = nameRoleValueReport(survey([button({ attrs: { 'aria-expanded': 'false' } }), link], probes), config);
    expect(rules(report)).toEqual([
      [0, 'state-not-exposed', 'info'],
      [1, 'link-acts-as-button', 'info'],
    ]);
    for (const candidate of report.candidates) expect(candidate.flags).toContain('requestBlocked');
  });

  it('an empty name whose only visible text is generated by CSS is likely, and says so', () => {
    const backlink = element({ tag: 'a', href: { kind: 'fragment', target: '', download: false, sameDocument: true }, ax: ax('link', '', { focusable: true }), sources: ['native', 'role', 'tab'], text: '', generatedText: true });
    const report = nameRoleValueReport(survey([backlink]), config);
    expect(rules(report)).toEqual([[0, 'missing-name', 'likely']]);
    expect(report.candidates[0]!.flags).toContain('cssGeneratedText');
    expect(rules(nameRoleValueReport(survey([backlink]), resolveNameRoleValue({ generatedTextNameStatus: 'advisory' })))[0]![2]).toBe('advisory');
  });

  it('a disclosure, a toggle and a stuck aria-expanded; a swap of slides is nothing', () => {
    const same = ax('button', 'Save');
    const expanded = ax('button', 'Save', { states: { expanded: 'false' } });
    const reveal = step({ ax: same, revealed: [region()] });
    const elements = [button(), button(), button({ attrs: { 'aria-expanded': 'false' } }), button(), button({ attrs: { 'aria-expanded': 'false' } })];
    const probes = [
      probe(0, same, reveal, { ...step({ ax: same }), revealReverted: true, ownReverted: true }),
      probe(1, same, step({ ax: same, ownChange: 400 }), { ...step({ ax: same }), revealReverted: false, ownReverted: true }),
      probe(2, expanded, step({ ax: expanded, revealed: [region()] })),
      probe(3, same, step({ ax: same, revealed: [region()], hidden: [region()] }), { ...step({ ax: same }), revealReverted: true, ownReverted: true }),
      // The state changed: exposed, nothing to report.
      probe(4, expanded, step({ ax: ax('button', 'Save', { states: { expanded: 'true' } }), revealed: [region()] })),
    ];
    const report = nameRoleValueReport(survey(elements, probes), config);
    expect(report.candidates.map((candidate) => [candidate.ord, candidate.flags.find((flag) => ['disclosure', 'toggle', 'expandedNotUpdated'].includes(flag)), candidate.status])).toEqual([
      [0, 'disclosure', 'likely'],
      [1, 'toggle', 'likely'],
      [2, 'expandedNotUpdated', 'likely'],
    ]);
    expect(report.counts.stateExposed).toBe(1);
  });

  it('native controls are not tested for state', () => {
    const checkbox = element({ tag: 'input', type: 'checkbox', ax: ax('checkbox', 'Agree', { focusable: true }), sources: ['native', 'role'] });
    const probes = [probe(0, ax('checkbox', 'Agree'), step({ ax: ax('checkbox', 'Agree'), ownChange: 200 }), { ...step(), revealReverted: false, ownReverted: true })];
    expect(rules(nameRoleValueReport(survey([checkbox], probes), config))).toEqual([]);
  });

  it('nothing is above info when the tree could not be read', () => {
    const report = nameRoleValueReport(survey([button({ ax: ax('button', '', { focusable: true }) })], [], { axComplete: false }), config);
    expect(rules(report)).toEqual([[0, 'missing-name', 'info']]);
    expect(report.candidates[0]!.flags).toContain('axIncomplete');
  });

  it('includeAxeCovered: false leaves out what axe-core reports, and counts it', () => {
    const elements = [button({ ax: ax('button', '', { focusable: true }) }), element({ roleAttr: 'tab', ax: ax('tab', '', { focusable: true, context: ['tablist'] }), sources: ['role'] })];
    const without = nameRoleValueReport(survey(elements), resolveNameRoleValue({ includeAxeCovered: false }));
    expect(rules(without)).toEqual([[1, 'missing-name', 'fail']]);
    expect(without.axeCoveredLeftOut).toBe(1);
  });

  it('a tab list in which no tab is selected, once, on the first tab', () => {
    const tab = (selected: string) => element({ roleAttr: 'tab', container: 0, ax: ax('tab', 'T', { focusable: true, context: ['tablist'], states: { selected } }), sources: ['role'] });
    expect(rules(nameRoleValueReport(survey([tab('false'), tab('false')]), config))).toEqual([[0, 'missing-state', 'likely']]);
    expect(rules(nameRoleValueReport(survey([tab('true'), tab('false')]), config))).toEqual([]);
  });
});

describe('what is activated', () => {
  it('never a submit button, a field, a link to a new window, a disabled or excluded element, or one nothing listens for', () => {
    const delegated = { delegated: true };
    const targets = nameRoleValueProbeTargets(
      survey([
        button(delegated),
        button({ ...delegated, submits: true }),
        element({ tag: 'input', type: 'text', ax: ax('textbox', 'q', { focusable: true }), sources: ['native', 'role'], ...delegated }),
        element({ tag: 'a', href: { kind: 'url', target: '_blank', download: false, sameDocument: false }, ax: ax('link', 'x'), sources: ['native', 'role'], listeners: ['click'] }),
        button({ ...delegated, disabled: true }),
        button({ ...delegated, excluded: true }),
        button(),
        element({ tag: 'a', href: { kind: 'hash', target: '', download: false, sameDocument: true }, ax: ax('link', 'x'), sources: ['native', 'role'], listeners: ['click'] }),
      ]),
      config,
    );
    // Links that point nowhere first.
    expect(targets).toEqual([
      { ord: 7, reason: 'no-href' },
      { ord: 0, reason: 'stateful' },
    ]);
  });

  it('what static evidence leaves open first: links that point nowhere, controls without a role, triggers, toggles; links with an address last', () => {
    const listened = { listeners: ['click'] };
    const targets = nameRoleValueProbeTargets(
      survey([
        element({ tag: 'a', href: { kind: 'url', target: '', download: false, sameDocument: false }, ax: ax('link', 'Shop'), sources: ['native', 'role'], ...listened }),
        button(listened),
        button({ ...listened, attrs: { 'aria-pressed': 'false' } }),
        button({ ...listened, attrs: { 'aria-expanded': 'false' } }),
        element({ tabindex: 0, sources: ['listener', 'tabindex'], ...listened }),
        element({ tag: 'a', ax: ax('link', 'More'), sources: ['listener'], ...listened }),
        // A plain link with an address and nothing that listens: never.
        element({ tag: 'a', href: { kind: 'url', target: '', download: false, sameDocument: false }, ax: ax('link', 'Home'), sources: ['native', 'role'] }),
      ]),
      config,
    );
    expect(targets.map((target) => [target.ord, target.reason])).toEqual([
      [5, 'no-href'],
      [4, 'no-role'],
      [3, 'trigger'],
      [2, 'toggle'],
      [1, 'stateful'],
      [0, 'link-handler'],
    ]);
  });
});

describe('the check', () => {
  it('only fails what the tree measured, whatever the candidate said', () => {
    const elements = [button({ ax: ax('button', '', { focusable: true }) }), element({ tabindex: 0, listeners: ['click'], sources: ['listener', 'tabindex'] })];
    const acted = [probe(1, ax('generic'), step({ revealed: [region()] }))];
    const snapshot: Snapshot = { environment: { url: 'https://example.test/', devicePixelRatio: 2, viewport: { width: 1280, height: 720 }, colorScheme: 'light' }, nameRoleValue: survey(elements, acted), nodes: [], axTree: [], screenshots: { tiles: [], clips: {} } };
    const findings = runChecks(snapshot, resolveConfig({ checks: ['name-role-value'] }));
    expect(findings.map((finding) => [finding.rule, finding.status])).toEqual([
      ['name-role-value/missing-name', 'fail'],
      ['name-role-value/no-role', 'fail'],
      ['name-role-value/survey', 'info'],
    ]);
    expect(findings[0]!.wcag).toEqual({ sc: '4.1.2', level: 'A' });
    expect(findings[0]!.evidence.values?.['axeRule']).toBe('button-name');
  });
});

describe('settings', () => {
  it('take only the values each option allows', () => {
    const resolved = resolveNameRoleValue({ probe: 'yes' as never, behaviourRoleStatus: 'advisory' as never, titleOnlyStatus: 'fail' as never, maxProbes: -3, genericNamePattern: '(', probeAllowedResourceTypes: ['Document', 'Image', 'bad type', 'XHR', 'Fetch', 'Ping', 'Other', 'EventSource'], probeReads: 'everything' as never, generatedTextNameStatus: 'fail' as never });
    expect(resolved.probeReads).toBe('cache');
    expect(resolved.generatedTextNameStatus).toBe('likely');
    expect(resolved.probe).toBe('safe');
    expect(resolved.behaviourRoleStatus).toBe('likely');
    expect(resolved.titleOnlyStatus).toBe('advisory');
    expect(resolved.maxProbes).toBe(0);
    expect(resolved.genericNamePattern).toBe(config.genericNamePattern);
    expect(resolved.probeAllowedResourceTypes).toEqual(['Image']);
    expect(resolveConfig({}).checks).toContain('name-role-value');
  });
});

describe('pixels that changed', () => {
  it('are counted inside the box of the element only', () => {
    const before = createImage(40, 40, { r: 255, g: 255, b: 255 });
    const after = createImage(40, 40, { r: 255, g: 255, b: 255 });
    fillRect(after, { x: 2, y: 2, width: 6, height: 6 }, { r: 0, g: 0, b: 0 });
    fillRect(after, { x: 30, y: 30, width: 6, height: 6 }, { r: 0, g: 0, b: 0 });
    expect(changedPixels(before, after, { x: 0, y: 0, width: 20, height: 20 }, 2, 1)).toBe(36);
    expect(changedPixels(before, before, { x: 0, y: 0, width: 40, height: 40 }, 2, 1)).toBe(0);
  });
});
