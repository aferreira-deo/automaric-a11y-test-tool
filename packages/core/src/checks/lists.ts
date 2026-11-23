import { LISTS_SC, listReport } from '../measure/lists.js';
import type { ListCandidate, ListReason } from '../measure/lists.js';
import type { Check, Evidence, FindingDraft, ListsConfig } from '../types.js';

const HELP = {
  unmarked:
    'Content presented as a list, with bullets or numbers before each item, has to be exposed as one (1.3.1 Info and Relationships): ul, ol or dl, or role="list" with role="listitem". Whether lines that open with a bullet or a number are the items of a list is read from what is rendered, so this is never reported as a failure without confirmation.',
  presentational:
    'role="presentation" or role="none" on a list removes it and its items from the accessibility tree, while the bullets or numbers go on telling sighted readers that this is a list (1.3.1 Info and Relationships). Either the content is a list and keeps its role, or it is not and shows no markers.',
  repeated:
    'A series of parallel items that is not marked up as a list is not announced as one, nor with the number of its items. Whether such a series has to be a list is a matter of house policy for card grids and search results, and good practice for groups of links: this is advisory.',
  keyValue:
    'Names and values presented in pairs can be marked up as a description list (dl, dt, dd) or as a table, which tells assistive technology which value belongs to which name. Advisory: plain text that reads "name: value" on each line conveys the same in its order.',
  unstyled:
    'Inventory. Safari does not expose a ul or ol as a list when none of its items shows a marker (list-style: none), unless the list has role="list" or is inside a navigation landmark. That is a decision of the browser and not a failure of the page (1.3.1 is met by the markup); it explains why VoiceOver does not announce a list here.',
  inventory: 'Inventory. Nothing to fix on the strength of this entry alone.',
};

const MARKER_TEXT: Record<string, string> = {
  bullet: 'a bullet character',
  number: 'a number or a letter in sequence',
  image: 'the same small image or icon',
  shape: 'the same small drawn shape',
  counter: 'a number from a CSS counter',
  listItemMarker: 'a list-item marker (display: list-item)',
};

const REASON_TEXT: Record<ListReason, string> = {
  fewWeakItems: 'there are few of them and each opens with a hyphen, a dash or an asterisk, which also open asides, footnotes and quoted replies',
  fewGraphicItems: 'there are few of them and what stands before each is an image or a drawn shape, as before two links that share an icon',
  mixedGlyphs: 'the lines open with different symbols, at least one of them used once, as symbols that label a line do',
  startsMidSequence: 'the numbers follow each other but do not start at the beginning of their sequence, as dates do, or a list that goes on from elsewhere',
  fewLetterItems: 'there are few of them and each opens with a single letter and a full stop, as initials of names do',
  itemsHeadText: 'each of these lines has further blocks of text under it, as steps have, and as the titles of sections and panels have',
};

function quoted(texts: string[]): string {
  return texts.map((text) => `"${text}"`).join(', ');
}

function evidenceOf(candidate: ListCandidate): Evidence {
  const flags = [...candidate.flags];
  if (!candidate.crop) flags.push(candidate.covered ? 'covered' : 'notCaptured');
  return { crops: candidate.crop ? [candidate.crop] : [], colors: {}, ratios: {}, flags, values: { ...candidate.values } };
}

function messageOf(candidate: ListCandidate, config: ListsConfig): { message: string; help: string } {
  const sample = candidate.texts.length > 0 ? ` It starts: ${quoted(candidate.texts)}${candidate.items > candidate.texts.length ? ', …' : ''}.` : '';
  const unread = candidate.flags.includes('axIncomplete')
    ? ' Recorded as info because the accessibility tree could not be read in full, so what has list semantics already is not known.'
    : '';
  switch (candidate.kind) {
    case 'glyph': {
      const marker = MARKER_TEXT[String(candidate.values['marker'])] ?? 'a marker';
      const drawn = candidate.flags.includes('pseudoElement') ? ', drawn by ::before' : '';
      const how = candidate.flags.includes('lineBreaks') ? 'lines separated by line breaks' : 'sibling blocks';
      const base = `${candidate.items} ${how} each start with ${marker}${drawn}, one under the other, and none of them is inside a list in the accessibility tree.${sample}`;
      if (candidate.status === 'likely') return { message: `${base} Confirm that they are the items of a list.`, help: HELP.unmarked };
      if (candidate.status === 'advisory') {
        return { message: `${base} They are inside a navigation region, where a group of links without list markup is a matter of good practice.`, help: HELP.repeated };
      }
      const why = candidate.reasons.map((reason) => REASON_TEXT[reason]);
      return { message: `${base}${why.length > 0 ? ` Recorded as info because ${why.join('; ')}.` : ''}${unread}`, help: HELP.unmarked };
    }
    case 'presentational':
      return {
        message: `This ${String(candidate.values['element'])} has role="presentation" or role="none" and is not exposed as a list, and ${String(candidate.values['itemsWithMarker'])} of its ${candidate.items} item(s) still show a bullet or a number. Confirm that the markers are visible; if they are, the content is presented as a list that assistive technology is not told about.${unread}`,
        help: HELP.presentational,
      };
    case 'repeated': {
      const cards = candidate.flags.includes('cards');
      const what = cards ? 'blocks of one shape (cards, results)' : 'links of one shape';
      const where = candidate.flags.includes('navigation') ? ', inside a navigation region,' : '';
      const layout = `${String(candidate.values['rows'])} row(s) of up to ${String(candidate.values['perRow'])}`;
      return {
        message: `${candidate.items} sibling ${what}${where} are laid out in line with even gaps (${layout}) and are not inside a list.${sample}${
          candidate.status === 'likely' ? ` Reported as likely because the configuration asks for it (cardListStatus); the minimum is ${config.minRepeatedItems} items.` : ''
        }${unread}`,
        help: HELP.repeated,
      };
    }
    case 'key-value':
      return {
        message: `${candidate.items} ${candidate.flags.includes('sideBySide') ? 'rows each hold a name and a value side by side' : 'lines each read as a name, a colon and a value'}, outside a description list and outside a table.${sample}${unread}`,
        help: HELP.keyValue,
      };
    default:
      return {
        message: `This ${String(candidate.values['element'])} is exposed as a list of ${candidate.items} item(s) by Chrome and shows no marker on any of them. It has no explicit role and is outside navigation, so Safari does not expose it as a list.`,
        help: HELP.unstyled,
      };
  }
}

export const listsCheck: Check = {
  id: 'lists',
  evaluate(snapshot, config) {
    const survey = snapshot.lists;
    if (!survey) throw new Error('The lists check needs a snapshot collected with the list survey.');
    const report = listReport(survey, config.lists);
    const drafts: FindingDraft[] = report.candidates.map((candidate) => ({
      check: 'lists',
      rule: candidate.rule,
      // The id of the finding is `candidate.findingId`, whichever rule reports it.
      fingerprintRule: candidate.fingerprintRule,
      // Said again where findings are made: nothing of this check is a `fail`.
      status: candidate.status === 'likely' || candidate.status === 'advisory' ? candidate.status : 'info',
      wcag: LISTS_SC,
      selector: candidate.selector,
      frame: candidate.frame,
      box: candidate.box,
      evidence: evidenceOf(candidate),
      ...messageOf(candidate, config.lists),
    }));

    const count = (kind: ListCandidate['kind'], status?: ListCandidate['status']): number =>
      report.candidates.filter((candidate) => candidate.kind === kind && (status === undefined || candidate.status === status)).length;
    const beyond = {
      blocks: survey.totalBlocks - survey.blocks.length,
      groups: survey.totalGroups - survey.groups.length,
      lists: survey.totalLists - survey.lists.length,
    };
    const captured = report.candidates.filter((candidate) => candidate.crop !== null).length;
    const flags: string[] = [];
    if (beyond.blocks > 0 || beyond.groups > 0 || beyond.lists > 0 || report.omitted > 0 || report.omittedUnstyled > 0) flags.push('truncated');
    if (!survey.axComplete) flags.push('axIncomplete');
    const { width, height } = snapshot.environment.viewport;
    drafts.push({
      check: 'lists',
      rule: 'lists/survey',
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
          textBlocks: survey.blocks.length,
          exposedLists: survey.exposedLists,
          likely: report.candidates.filter((candidate) => candidate.status === 'likely').length,
          glyphLists: count('glyph'),
          presentationalLists: count('presentational'),
          repeatedStructures: count('repeated'),
          keyValueLayouts: count('key-value'),
          listsWithoutMarkers: count('unstyled'),
          captures: captured,
        },
      },
      message:
        `Read ${survey.blocks.length} block(s) of visible text and ${survey.groups.length} series of sibling elements of one shape. The accessibility tree exposes ${survey.exposedLists} list(s).` +
        ` Reported: ${count('glyph')} series of lines with bullets or numbers outside list semantics, ${count('presentational')} list(s) with a removed role and visible markers,` +
        ` ${count('repeated')} series of blocks of one shape, ${count('key-value')} layout(s) of names and values, and ${count('unstyled')} real list(s) without markers.` +
        (report.omitted > 0 ? ` ${report.omitted} further finding(s) are not listed (limit of ${config.lists.maxCandidates}).` : '') +
        (report.omittedUnstyled > 0 ? ` ${report.omittedUnstyled} further list(s) without markers are not listed (limit of ${config.lists.maxUnstyledLists}).` : '') +
        (beyond.blocks > 0 ? ` ${beyond.blocks} more block(s) of text were not read (limit of ${config.headings.maxBlocks}).` : '') +
        (beyond.groups > 0 ? ` ${beyond.groups} more series of sibling elements were not read (limit of ${config.lists.maxGroups}).` : '') +
        (beyond.lists > 0 ? ` ${beyond.lists} more list element(s) were not read (limit of ${config.lists.maxListElements}).` : '') +
        (survey.axComplete ? '' : ' The accessibility tree could not be read in full, so nothing is reported above info.'),
      help: HELP.inventory,
    });
    return drafts;
  },
};
