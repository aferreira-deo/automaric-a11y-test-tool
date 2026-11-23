import { GROUPING_SC, groupingReport } from '../measure/grouping.js';
import type { GroupingCandidate, GroupingReason } from '../measure/grouping.js';
import type { Check, Evidence, FindingDraft, GroupingConfig } from '../types.js';

const HELP = {
  set:
    'A set of radio buttons or checkboxes that answers one question has to carry that question programmatically (1.3.1 Info and Relationships; related 3.3.2 and 4.1.2): a fieldset with a legend, or role="group" or role="radiogroup" with a name (aria-labelledby pointing at the visible text). Whether the visible text is the label of the set, and whether the names of the options say too little without it, is read from the page: this is never reported as a failure, and a tester confirms it.',
  split:
    'When one value is entered in several fields (the parts of a date, of a phone number), each field needs an accessible name that says which part it is (1.3.1 Info and Relationships; related 3.3.2 and 4.1.2), and the parts are best grouped under the name of the whole. That the fields are parts of one value is read from their place on the page: confirm it. A field without any name is also reported by rule engines such as axe-core.',
  duplicates:
    'Fields with the same accessible name in two sections of one form cannot be told apart by a screen reader user who moves from field to field (1.3.1 Info and Relationships; related 3.3.2). A fieldset with a legend around each section, a named group, or names that say which section they belong to tell them apart. Headings before each section are exposed as structure, but they are not read when moving between fields: under headings this is advisory.',
  related:
    'Related controls under a visible title are best grouped with that title as the name of the group (fieldset and legend, or role="group" with aria-labelledby). Advisory: the names of the controls say what they are on their own, or the title is a heading or the button that opens them, which assistive technology exposes as structure.',
  candidate: 'Recorded for a tester or a model to look at. Nothing to fix on the strength of this entry alone.',
  inventory: 'Inventory. Nothing to fix on the strength of this entry alone.',
};

const REASON_TEXT: Record<GroupingReason, string> = {
  labelFar: 'the text is further from the controls than a label usually is',
  labelLong: 'the text is as long as a paragraph, which a label seldom is',
  labelSentence: 'the text ends as a sentence of prose does, where a label is a question or a title',
  labelNearerPrevious: 'the text is much closer to the control before it than to these controls, as a hint under a field is',
  labelNamesContainer: 'a region, a form, a dialog or a group that holds the controls has the words of that text in its name, so the text is tied to what holds them',
};

function quoted(texts: string[]): string {
  return texts.map((text) => `"${text}"`).join(', ');
}

function evidenceOf(candidate: GroupingCandidate): Evidence {
  const flags = [...candidate.flags];
  if (!candidate.crop) flags.push(candidate.covered ? 'covered' : 'notCaptured');
  return { crops: candidate.crop ? [candidate.crop] : [], colors: {}, ratios: {}, flags, values: { ...candidate.values } };
}

function messageOf(candidate: GroupingCandidate, config: GroupingConfig): { message: string; help: string } {
  const unread = candidate.flags.includes('axIncomplete')
    ? ' Recorded as info because the accessibility tree could not be read in full, so names and groups are not known for certain.'
    : '';
  const names = candidate.names.length > 0 ? `${quoted(candidate.names.map((name) => (name === '' ? '(no name)' : name)))}${candidate.controls > candidate.names.length ? ', …' : ''}` : '';
  const flag = (name: string): boolean => candidate.flags.includes(name);
  switch (candidate.kind) {
    case 'set': {
      const what = flag('radios') ? 'radio buttons' : flag('switches') ? 'switches' : 'checkboxes';
      const where = candidate.values['labelPlacement'] === 'beside' ? 'beside' : 'before';
      const group = flag('unnamedGroup')
        ? ' They are inside a fieldset or a group that has no name.'
        : flag('inLargerGroup')
          ? ` They are inside a named group that also holds more than ${config.groupExtraControlsMax} other control(s), so its name is not the label of this set.`
          : ' They are in no fieldset with a legend and in no named group.';
      const base = `${candidate.controls} ${what} with the accessible names ${names} stand right ${where === 'beside' ? 'beside' : 'under'} the visible text "${candidate.label}", which is the label of no control and the name of no group.${group}`;
      if (candidate.status === 'likely') {
        return {
          message: `${base} Most of the names are short, so they may say little without that text. Confirm that the text is the question or the title of the set.`,
          help: HELP.set,
        };
      }
      if (candidate.status === 'advisory') {
        const why = flag('headingLabel')
          ? 'the text is exposed as a heading, which gives the set a place in the structure of the page without tying it to the controls'
          : flag('disclosureLabel')
            ? 'the text is the button that opens the set'
            : flag('switches')
              ? 'the controls are switches, which mostly stand for themselves'
              : 'most of the names are long enough to say what they are on their own';
        return { message: `${base} Advisory because ${why}.`, help: HELP.related };
      }
      const why = candidate.reasons.map((reason) => REASON_TEXT[reason]);
      return { message: `${base}${why.length > 0 ? ` Recorded as info because ${why.join('; ')}.` : ''}${unread}`, help: HELP.candidate };
    }
    case 'row': {
      const label = candidate.label !== '' ? ` under "${candidate.label}"` : '';
      const base = `${candidate.controls} fields stand side by side on one row${label}, with the accessible names ${names}.`;
      if (candidate.status === 'advisory') {
        return {
          message: `${base} Each has a name of its own; the visible text before them is the label of no control and the name of no group. If they are the parts of one value, a group with that text as its name ties them together.`,
          help: HELP.related,
        };
      }
      const why: string[] = [];
      if (flag('duplicateNames')) why.push('at least two of them have the same name');
      if (flag('unnamedPart')) why.push(`${String(candidate.values['unnamedParts'])} of them ${candidate.values['unnamedParts'] === 1 ? 'has' : 'have'} no name while a visible label stands for the row`);
      if (flag('namedAsWhole')) why.push('one of them is named like the whole and not like its part');
      return {
        message: `${base} If they are the parts of one value, their names do not say which part each is: ${why.join('; ')}. Confirm that they belong together.${unread}`,
        help: candidate.status === 'likely' ? HELP.split : HELP.candidate,
      };
    }
    default: {
      const label = candidate.label !== '' ? `, under "${candidate.label}",` : '';
      const base = `These ${candidate.controls} fields${label} have the same accessible names as fields of ${Number(candidate.values['sections']) - 1} other section(s) of the same form (${quoted(candidate.names)}${
        Number(candidate.values['sharedNames']) > candidate.names.length ? ', …' : ''
      }), starting at ${String(candidate.values['firstSection'])}. No named group and no description tells the sections apart.`;
      if (candidate.status === 'advisory') {
        return { message: `${base} Each section stands under a heading, which is exposed as structure but is not read when moving from field to field: advisory.`, help: HELP.duplicates };
      }
      const formless = flag('noForm') ? ' Recorded as info because the fields are in no form element, so that the sections are parts of one form is not known.' : '';
      return {
        message: `${base}${candidate.status === 'likely' ? ' Confirm that the sections are separate on the page.' : ''}${formless}${unread}`,
        help: candidate.status === 'likely' ? HELP.duplicates : HELP.candidate,
      };
    }
  }
}

export const groupingCheck: Check = {
  id: 'grouping',
  evaluate(snapshot, config) {
    const survey = snapshot.grouping;
    if (!survey) throw new Error('The grouping check needs a snapshot collected with the grouping survey.');
    const report = groupingReport(survey, config.grouping);
    const drafts: FindingDraft[] = report.candidates.map((candidate) => ({
      check: 'grouping',
      rule: candidate.rule,
      // The id of the finding is `candidate.findingId`, whichever rule reports it.
      fingerprintRule: candidate.fingerprintRule,
      // Said again where findings are made: nothing of this check is a `fail`.
      status: candidate.status === 'likely' || candidate.status === 'advisory' ? candidate.status : 'info',
      wcag: GROUPING_SC,
      selector: candidate.selector,
      frame: candidate.frame,
      box: candidate.box,
      evidence: evidenceOf(candidate),
      ...messageOf(candidate, config.grouping),
    }));

    const count = (kind: GroupingCandidate['kind']): number => report.candidates.filter((candidate) => candidate.kind === kind).length;
    const beyond = { controls: survey.totalControls - survey.controls.length, blocks: survey.totalBlocks - survey.blocks.length };
    const flags: string[] = [];
    if (beyond.controls > 0 || beyond.blocks > 0 || report.omitted > 0 || report.merged > 0) flags.push('truncated');
    if (!survey.axComplete) flags.push('axIncomplete');
    const { width, height } = snapshot.environment.viewport;
    const named = survey.groups.filter((group) => group.name !== '').length;
    drafts.push({
      check: 'grouping',
      rule: 'grouping/survey',
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
          controls: survey.controls.length,
          namedGroups: named,
          sets: report.sets,
          setsGroupedOrNamed: report.setsAssociated,
          setsWithoutVisibleLabel: report.setsWithoutLabel,
          rowsOfFields: report.rows,
          controlsInTables: report.controlsInTables,
          controlsInWidgets: report.controlsInWidgets,
          likely: report.candidates.filter((candidate) => candidate.status === 'likely').length,
          reportedSets: count('set'),
          reportedRows: count('row'),
          reportedSections: count('sections'),
          captures: report.candidates.filter((candidate) => candidate.crop !== null).length,
          ...(report.merged > 0 ? { sameElementNotListed: report.merged } : {}),
        },
      },
      message:
        `Read ${survey.controls.length} form control(s) and ${named} named group(s) or container(s) from the accessibility tree.` +
        ` Looked at ${report.sets} set(s) of radio buttons or checkboxes: ${report.setsAssociated} are in a named group or carry their question in their names, ${report.setsWithoutLabel} have no visible text before them that could be their label.` +
        ` Looked at ${report.rows} row(s) of fields side by side.` +
        ` Reported: ${count('set')} set(s), ${count('row')} row(s) and ${count('sections')} group(s) of sections with the same field names.` +
        (report.controlsInTables > 0 ? ` ${report.controlsInTables} control(s) in the cells of a table were left out: the headers of the table may say what they are.` : '') +
        (report.controlsInWidgets > 0 ? ` ${report.controlsInWidgets} control(s) inside a toolbar, a menu, a tab list, a tree or a grid were left out.` : '') +
        (report.omitted > 0 ? ` ${report.omitted} further finding(s) are not listed (limit of ${config.grouping.maxCandidates}).` : '') +
        (report.merged > 0 ? ` ${report.merged} further finding(s) are not listed because one of the same kind on the same element is.` : '') +
        (beyond.controls > 0 ? ` ${beyond.controls} more control(s) were not read (limit of ${config.grouping.maxControls}).` : '') +
        (beyond.blocks > 0 ? ` ${beyond.blocks} more block(s) of text were not read (limit of ${config.headings.maxBlocks}).` : '') +
        (survey.axComplete ? '' : ' The accessibility tree could not be read in full, so nothing is reported above info.'),
      help: HELP.inventory,
    });
    return drafts;
  },
};
