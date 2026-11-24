import { NRV_SC, nameRoleValueReport } from '../measure/name-role-value.js';
import type { NrvCandidate } from '../measure/name-role-value.js';
import type { Check, Evidence, FindingDraft, NameRoleValueSurvey, NrvElement, Status } from '../types.js';

const HELP = {
  name: 'Every user interface component needs an accessible name that assistive technology can announce (4.1.2 Name, Role, Value). The name is the one the browser computed, read from its accessibility tree. Native elements take it from their content, a label, alt text or a title; others from aria-label or aria-labelledby.',
  nameWords: 'An accessible name has to say what the control is or does (4.1.2 Name, Role, Value). A name that repeats the role, is the file name of a picture, a class name, a glyph of an icon font or only symbols is announced, and says nothing. Whether such a name is understood in its context is for a tester to confirm.',
  titleOnly: 'The field is named only by its title attribute. Chrome uses the title as the accessible name when nothing else names a field, so the name is there; but a title shows only on hover, never on touch screens nor to keyboard users, and some assistive technologies announce it as a description. A visible label tied to the field is the robust name. Advisory.',
  placeholder: 'The field is named only by its placeholder. Chrome, like the HTML accessibility mapping, takes the placeholder as the accessible name when nothing else names a field, so a screen reader does announce it; but it disappears as soon as something is typed, some assistive technologies present it as a hint and not as the name, and it is often too faint to read (1.4.3). A visible label tied to the field is the robust name. Advisory.',
  role: 'An element that is operated (it listens to clicks or keys and takes focus, or what it does was seen) needs a role that says what it is (4.1.2 Name, Role, Value): a button for something that triggers an action, a link for something that goes to another page or place. Exposed with no such role, it is announced as plain text, or not announced as something that can be operated. Whether it can also be reached and operated with the keyboard is 2.1.1, which this does not report.',
  hidden: 'The element takes keyboard focus but is hidden from assistive technology (aria-hidden on it or an ancestor): a keyboard user reaches it and a screen reader announces nothing, or something else (4.1.2 Name, Role, Value; also reported by axe-core as aria-hidden-focus).',
  nested: 'A control inside another control is not exposed reliably: inside a button, a tab, a checkbox or an option its role is presentational in ARIA, and HTML does not allow interactive content inside a link or a button (4.1.2 Name, Role, Value). Browsers and screen readers differ in what they announce.',
  context: 'Some roles only mean something inside their container: a tab inside a tab list, a menu item inside a menu, a tree item inside a tree, an option inside a list box (4.1.2 Name, Role, Value). Outside it, assistive technology may not announce the role, the position or the set, and Chrome drops some roles altogether.',
  linkButton: 'A link goes somewhere: to another page or to a place in this one. A button does something: opens a panel or a dialog, toggles, adds to a cart, submits. The role tells a screen reader user what will happen and how to activate it (Enter only for a link, Enter and Space for a button) (4.1.2 Name, Role, Value). This is inferred from what the element did when it was activated while the page was held (no request left the browser), or from its markup when it was not activated.',
  state: 'A control whose state changes (expanded or collapsed, pressed, checked, selected, a value) has to expose that state, and update it when it changes (4.1.2 Name, Role, Value): aria-expanded on the button of a disclosure or a menu, aria-pressed on a toggle button, aria-checked on a custom checkbox or switch, aria-selected on a tab, aria-valuenow on a slider. A native control exposes its own state.',
  staticState: 'A custom control has to carry the states its role needs, so that assistive technology can announce them (4.1.2 Name, Role, Value). This is read from the markup of the page as it is; whether the state also changes when it should is measured only when the control is activated.',
  inventory: 'Inventory. Nothing to fix on the strength of this entry alone.',
};

function quoted(text: string): string {
  return `"${text}"`;
}

function describe(element: NrvElement): string {
  const role = element.ax ? `exposed as ${element.ax.role}` : 'not in the accessibility tree';
  const text = element.text ? ` with the text ${quoted(element.text)}` : '';
  return `This ${element.tag}${element.roleAttr ? ` (role="${element.roleAttr}")` : ''}, ${role}${text},`;
}

function evidenceOf(candidate: NrvCandidate, survey: NameRoleValueSurvey): Evidence {
  const flags = [...candidate.flags];
  const values: Record<string, string | number | boolean> = { ...candidate.values };
  if (candidate.axeRule) values['axeRule'] = candidate.axeRule;
  const crops: string[] = [];
  const probe = candidate.probe;
  if (probe?.crops) {
    crops.push(probe.crops.before, probe.crops.after);
    if (probe.crops.again) crops.push(probe.crops.again);
  } else {
    const capture = survey.captures[String(candidate.ord)];
    if (capture?.crop) crops.push(capture.crop);
    else flags.push(capture?.covered ? 'covered' : 'notCaptured');
  }
  return { crops, colors: {}, ratios: {}, flags, values };
}

function flagged(candidate: NrvCandidate, flag: string): boolean {
  return candidate.flags.includes(flag);
}

function messageOf(candidate: NrvCandidate, element: NrvElement, config: { behaviourRoleStatus: Status }): { message: string; help: string } {
  const lead = describe(element);
  const held = flagged(candidate, 'axIncomplete') ? ' Recorded as info because the accessibility tree could not be read in full.' : '';
  const axe = candidate.axeRule ? ` axe-core reports this too (${candidate.axeRule}).` : '';
  const name = element.ax?.name ?? '';
  switch (candidate.rule) {
    case 'name-role-value/missing-name': {
      if (flagged(candidate, 'frame')) {
        return { message: `${lead} has no accessible name, and what it holds can be operated (${String(candidate.values['focusables'] ?? 0)} focusable element(s), or the Tab walk went into it). A frame is announced by its name; give it a title.${axe}${held}`, help: HELP.name };
      }
      const why = flagged(candidate, 'disabled')
        ? ' Recorded as likely because it is disabled: it is still announced, without a name.'
        : flagged(candidate, 'noBoxNotInTabOrder')
          ? ' Recorded as likely because it has no size on the page and tabindex="-1": a duplicate the author meant to hide, which a screen reader still meets in browse mode as a link or button without a name. aria-hidden="true", or removing it, would hide it.'
        : flagged(candidate, 'notOperable')
          ? ' Recorded as likely because nothing shows it can be operated: it takes no focus and no listener is on it.'
          : ' It is a control (see "interactiveBy"), and the accessibility tree gives it an empty name: assistive technology announces its role and nothing else.';
      return { message: `${lead} has no accessible name.${why}${axe}${held}`, help: HELP.name };
    }
    case 'name-role-value/name-not-descriptive': {
      const what = flagged(candidate, 'privateUse')
        ? 'is made of glyphs of an icon font (characters of a Private Use Area), which assistive technology cannot read'
        : flagged(candidate, 'generic')
          ? 'only says what kind of element it is'
          : flagged(candidate, 'fileName')
            ? 'is the file name of a picture'
            : flagged(candidate, 'classLike')
              ? 'reads as a class name or an identifier, not as words'
              : flagged(candidate, 'ligature')
                ? 'is the name of a ligature of an icon font, with underscores, which is announced as it is written'
                : flagged(candidate, 'url')
                  ? 'is an address, on a control that is not a link'
                  : 'is made only of symbols';
      return { message: `${lead} has the accessible name ${quoted(name)}, which ${what}. Confirm what it should say.${held}`, help: HELP.nameWords };
    }
    case 'name-role-value/title-only-name':
      return { message: `${lead} is named ${quoted(name)} by its title attribute alone.${held}`, help: HELP.titleOnly };
    case 'name-role-value/placeholder-only-name':
      return { message: `${lead} is named ${quoted(name)} by its placeholder alone: Chrome takes the placeholder as the name when nothing else gives one.${held}`, help: HELP.placeholder };
    case 'name-role-value/no-role': {
      const facts: string[] = [];
      if (element.listeners.length > 0) facts.push(`it has ${element.listeners.join(', ')} listener(s) of its own`);
      if (element.framework.length > 0) facts.push(`a framework holds handlers for it (${element.framework.join(', ')})`);
      if (flagged(candidate, 'focusable')) facts.push(element.sources.includes('tab') ? 'the Tab walk reached it' : `it has tabindex="${String(element.tabindex)}"`);
      if (flagged(candidate, 'cursorPointer')) facts.push('it shows the pointer of a link (cursor: pointer)');
      if (flagged(candidate, 'navigates')) facts.push('activating it tried to go to another page or place');
      if (flagged(candidate, 'changesInPlace')) facts.push('activating it changed the page in place');
      if (flagged(candidate, 'sendsRequest')) facts.push('activating it tried to send a request that writes (stopped by the probe)');
      const anchor = flagged(candidate, 'anchorWithoutHref') ? ' An a element without href is not a link for the browser.' : '';
      const suggested = candidate.values['suggestedRole'] === 'link' ? 'a link' : 'a button (or the role of the widget it is)';
      const why =
        candidate.status === 'fail'
          ? ' It is operable (focusable in sequence, and operated by pointer or seen to act) and exposed with no role of a control.'
          : candidate.status === 'likely'
            ? ' Confirm that it is a control.'
            : ' Advisory: it takes no focus and does not show the pointer, so it may be a container that listens for something else.';
      return { message: `${lead} is operated: ${facts.join('; ')}.${anchor}${why} If it is one, it should be ${suggested}.${held}`, help: HELP.role };
    }
    case 'name-role-value/focusable-hidden':
      return { message: `${lead} is reached by the Tab walk and is hidden from assistive technology (${candidate.flags.filter((flag) => flag.startsWith('aria')).join(', ')}).${axe}${held}`, help: HELP.hidden };
    case 'name-role-value/nested-interactive':
      return { message: `${lead} is a control inside another one (${String(candidate.values['insideOf'])}).${axe}${held}`, help: HELP.nested };
    case 'name-role-value/required-context':
      return {
        message: flagged(candidate, 'noRadiogroup')
          ? `${lead} is a radio button outside any radiogroup: its set and its position in it are not announced. Advisory: ARIA does not require the group.${held}`
          : flagged(candidate, 'roleDropped')
            ? `${lead} has the role ${element.roleAttr} in its markup, outside a ${String(candidate.values['requiredContext'])}, and Chrome does not expose that role (it is ${element.ax?.role ?? 'nothing'} in the accessibility tree).${axe}${held}`
            : `${lead} is outside a ${String(candidate.values['requiredContext'])} (its nearest ancestors in the accessibility tree: ${String(candidate.values['context'])}).${axe}${held}`,
        help: HELP.context,
      };
    case 'name-role-value/link-acts-as-button': {
      if (flagged(candidate, 'static')) {
        return {
          message: `${lead} is a link that points nowhere (${
            element.href?.kind === 'none'
              ? 'an a element without href, which Chrome exposes as a link because a script listens to it; other browsers may not, and it takes no focus'
              : element.href
                ? `href kind: ${element.href.kind}`
                : 'no href'
          })${element.listeners.length + element.framework.length > 0 ? ' and runs a script when activated' : ''}. If it does something rather than go somewhere, it should be a button. Advisory: ${flagged(candidate, 'activatedNoEffect') ? 'activating it showed nothing that could be measured' : 'it was not activated'}, and a script can still navigate.${held}`,
          help: HELP.linkButton,
        };
      }
      const what = flagged(candidate, 'opensDialog')
        ? 'opened a dialog'
        : flagged(candidate, 'showsOrHides')
          ? 'showed or hid part of the page'
          : flagged(candidate, 'changesState')
            ? `changed its own states (${String(candidate.values['statesChanged'] ?? '')})`
            : flagged(candidate, 'changesText')
              ? 'changed text elsewhere on the page'
              : flagged(candidate, 'sendsRequest')
                ? 'tried to send a request that writes (another method than GET; the probe stopped it)'
                : 'changed its own look';
      const level = config.behaviourRoleStatus === 'fail' ? '' : ' Confirm it: the role is inferred from what the link did.';
      return { message: `${lead} is a link, and activating it ${what} without any navigation: no request for another document, no change of the address. It acts as a button.${level}${held}`, help: HELP.linkButton };
    }
    case 'name-role-value/button-acts-as-link': {
      if (flagged(candidate, 'static')) {
        return { message: `${lead} is an a element with an href to another address and the role button. If activating it goes to that address, it is a link. Advisory: ${flagged(candidate, 'activatedNoEffect') ? 'activating it showed nothing that could be measured' : 'it was not activated'}.${held}`, help: HELP.linkButton };
      }
      if (flagged(candidate, 'newWindow')) {
        return { message: `${lead} is a button that opened a new window and changed nothing in place (${String(candidate.values['navigations'] ?? '')}). Advisory: a button that opens a window (to share, to print) can be right.${held}`, help: HELP.linkButton };
      }
      const level = config.behaviourRoleStatus === 'fail' ? '' : ' Confirm it: the role is inferred from what the button did.';
      return {
        message: `${lead} is a button, and activating it went to another page or place (${String(candidate.values['navigations'] ?? '')}), with no form submitted and no field value in the address. It acts as a link.${level}${held}`,
        help: HELP.linkButton,
      };
    }
    case 'name-role-value/missing-state': {
      const expected = String(candidate.values['expected'] ?? '');
      if (flagged(candidate, 'noSelectedTab')) {
        return { message: `${lead} is the first of ${String(candidate.values['tabs'])} tabs of a tab list in which no tab is exposed as selected. The selected tab needs aria-selected="true".${held}`, help: HELP.staticState };
      }
      if (flagged(candidate, 'hasPopup')) {
        return { message: `${lead} opens a popup (aria-haspopup="${String(candidate.values['hasPopup'])}") and has no aria-expanded, so whether the popup is open is not announced. Advisory: it was read from the markup.${held}`, help: HELP.staticState };
      }
      if (flagged(candidate, 'controlsHidden')) {
        return { message: `${lead} controls an element that is hidden (aria-controls="${String(candidate.values['controls'])}") and has no aria-expanded. If it shows that element, it is a disclosure and needs aria-expanded. Advisory: it was read from the markup.${held}`, help: HELP.staticState };
      }
      const exposed = candidate.values['exposedAs'] !== undefined ? ` Chrome exposes it as ${String(candidate.values['exposedAs'])} by default.` : '';
      return { message: `${lead} has no ${expected}, which its role needs.${exposed}${candidate.status === 'advisory' ? ' Advisory: ARIA does not require it for this role.' : ''}${axe}${held}`, help: HELP.staticState };
    }
    case 'name-role-value/state-not-exposed': {
      const flag = candidate.flags.find((value) => ['expandedNotUpdated', 'selectionNotExposed', 'disclosure', 'toggle', 'checkedNotUpdated', 'fixedRegion', 'regionChanged', 'lookChanged'].includes(value));
      const before = String(candidate.values['axBefore'] ?? '');
      const base = `${lead} was activated. Its accessibility properties were the same before and after (${before})`;
      const text: Record<string, string> = {
        expandedNotUpdated: `${base}, while part of the page was shown or hidden: aria-expanded did not change.`,
        selectionNotExposed: `${base}, while another panel was shown: aria-selected did not change.`,
        disclosure: `${base}, while part of the page appeared; activated again, it hid it. It is a disclosure and exposes no aria-expanded.`,
        toggle: `${base}, while its own look changed; activated again, it looked as before. It is a toggle and exposes no pressed state (aria-pressed).`,
        checkedNotUpdated: `${base}, while its own look changed and came back on a second activation: aria-checked did not change.`,
        fixedRegion: `${base}, while something fixed in the window appeared (a drawer, an overlay). Advisory: if it is a menu or a disclosure, it needs aria-expanded; a dialog does not.`,
        regionChanged: `${base}, while part of the page was shown or hidden, and a second activation did not bring it back. Advisory: if it selects or expands something, that state is not exposed.`,
        lookChanged: `${base}, while its own look changed. Advisory: if that look is a state (pressed, selected, on), the state is not exposed.`,
      };
      return { message: `${text[flag ?? 'lookChanged']}${held}`, help: HELP.state };
    }
    default:
      return { message: `${lead} ${String(candidate.rule)}.${held}`, help: HELP.inventory };
  }
}

export const nameRoleValueCheck: Check = {
  id: 'name-role-value',
  evaluate(snapshot, config) {
    const survey = snapshot.nameRoleValue;
    if (!survey) throw new Error('The name-role-value check needs a snapshot collected with the name-role-value survey.');
    const settings = config.nameRoleValue;
    const report = nameRoleValueReport(survey, settings);
    const byOrd = new Map(survey.elements.map((element) => [element.ord, element]));
    const drafts: FindingDraft[] = [];
    for (const candidate of report.candidates) {
      const element = byOrd.get(candidate.ord);
      if (!element || element.selector === '') continue;
      // Said again where findings are made: only a fact of the tree on a proven control is a `fail`, and a measured role only when the owner says so.
      const measuredRole =
        (candidate.rule === 'name-role-value/link-acts-as-button' || candidate.rule === 'name-role-value/button-acts-as-link') && candidate.flags.includes('measured') && settings.behaviourRoleStatus === 'fail';
      const status: Status =
        candidate.status === 'fail' && !['name-role-value/missing-name', 'name-role-value/no-role', 'name-role-value/focusable-hidden'].includes(candidate.rule) && !measuredRole ? 'likely' : candidate.status;
      drafts.push({
        check: 'name-role-value',
        rule: candidate.rule,
        status,
        wcag: NRV_SC,
        selector: element.selector,
        frame: element.frame,
        box: element.box,
        evidence: evidenceOf(candidate, survey),
        ...messageOf(candidate, element, settings),
      });
    }

    const probe = survey.probe;
    const done = probe.probes.filter((entry) => entry.outcome === 'done').length;
    const flags: string[] = [];
    if (!survey.axComplete) flags.push('axIncomplete');
    if (survey.total > survey.elements.length || report.omitted > 0 || survey.listenersBeyond > 0) flags.push('truncated');
    if (!survey.listenersRead) flags.push('listenersUnread');
    if (probe.stopped) flags.push(`probeStopped:${probe.stopped}`);
    const { width, height } = snapshot.environment.viewport;
    const guarded = Object.entries(probe.guarded)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, count]) => `${name} ${count}`)
      .join(', ');
    drafts.push({
      check: 'name-role-value',
      rule: 'name-role-value/survey',
      status: 'info',
      wcag: null,
      selector: 'html',
      frame: '',
      box: { x: 0, y: 0, width, height },
      evidence: {
        crops: [],
        colors: {},
        ratios: {},
        flags,
        values: {
          elements: survey.elements.length,
          totalElements: survey.total,
          controls: report.counts.controls,
          named: report.counts.named,
          noRoleCandidates: report.counts.noRoleCandidates,
          walk: survey.walk,
          probe: probe.mode,
          probesPlanned: probe.planned,
          probesDone: done,
          probesNotDone: probe.probes.length - done,
          stateExposedOnActivation: report.counts.stateExposed,
          actedAsLink: report.counts.linkBehaviour,
          actedAsButton: report.counts.buttonBehaviour,
          requestsBlocked: probe.blocked.length,
          ...(probe.blocked.length > 0 ? { blockedRequests: probe.blocked.join(' | ') } : {}),
          requestsAllowed: probe.allowed,
          unsafeRequests: probe.unsafe,
          popupsClosed: probe.popups,
          ...(guarded !== '' ? { guarded } : {}),
          reloads: probe.reloads,
          framesEmptied: probe.framesEmptied,
          storageRestored: `cookies ${probe.storageRestored.cookies}, localStorage ${probe.storageRestored.localStorage}, sessionStorage ${probe.storageRestored.sessionStorage}`,
          includeAxeCovered: settings.includeAxeCovered,
          ...(report.axeCoveredLeftOut > 0 ? { axeCoveredLeftOut: report.axeCoveredLeftOut } : {}),
          ...(report.omitted > 0 ? { omitted: report.omitted } : {}),
        },
      },
      message:
        `Read ${survey.elements.length} interactive element(s) or element(s) that may be (${report.counts.controls} control(s) with a role, ${report.counts.named} of them named), from the accessibility tree, ${survey.walk === 'none' ? 'without a Tab walk' : survey.walk === 'focus' ? 'the Tab walk of the focus check' : 'a Tab walk'}, activation listeners, framework handlers, tabindex and the pointer.` +
        (probe.mode === 'off'
          ? ' Nothing was activated (probe: off): link and button behaviour and state changes were not measured.'
          : ` Activated ${done} element(s) of ${probe.planned} that qualified, with every request that is not a read of a style sheet, a script, an image, a font or a media file stopped (${probe.blocked.length} kind(s) of request stopped, ${probe.unsafe} write(s) let through), the page reloaded ${probe.reloads} time(s), and cookies and storage put back.`) +
        (probe.stopped ? ` Probing stopped early (${probe.stopped}).` : '') +
        (report.omitted > 0 ? ` ${report.omitted} further finding(s) are not listed (limit of ${settings.maxCandidates}).` : '') +
        (report.axeCoveredLeftOut > 0 ? ` ${report.axeCoveredLeftOut} finding(s) that axe-core also reports were left out (includeAxeCovered: false).` : '') +
        (survey.axComplete ? '' : ' The accessibility tree could not be read in full, so nothing is reported above info.'),
      help: HELP.inventory,
    });
    return drafts;
  },
};
