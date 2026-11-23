import { clampDuplicateUnderHeadingsStatus, clampHeadingLabelStatus } from '../config.js';
import { fingerprint } from '../fingerprint.js';
import type { Box, GroupingBlock, GroupingConfig, GroupingControl, GroupingSurvey, JsonValue, WcagRef } from '../types.js';

/**
 * What the grouping check reports, from the survey of a page (section 5.5 of the brief).
 * Everything here is deterministic. Roles, names, descriptions and groups are those of the
 * accessibility tree; which text stands before which control, and how far from it, is read
 * from what was rendered.
 *
 * Nothing here is ever a `fail` (section 3E of the brief: "Never `fail` in v1"). That a visible
 * text is the label of a set of controls is read from its place on the page, and that the names
 * of the options say too little without it is a judgement: a tester confirms both.
 *
 * `groupingCandidates` is also the hand-off to the adjudicator layer.
 */

export const GROUPING_SC: WcagRef = { sc: '1.3.1', level: 'A' };
/** A set of radios or checkboxes under a visible text that nothing ties to it, `likely`. */
export const UNASSOCIATED_LABEL_RULE = 'grouping/unassociated-label';
/** Related controls with names of their own under a visible text, without a group, `advisory`. */
export const UNGROUPED_CONTROLS_RULE = 'grouping/ungrouped-controls';
/** A set held back as `info`, with the reason as a flag. */
export const GROUP_CANDIDATE_RULE = 'grouping/group-candidate';
/** Fields side by side whose names do not identify the parts, `likely`. */
export const SPLIT_FIELD_RULE = 'grouping/split-field';
/** Sections of one form whose fields have the same names, `likely`; under headings, `duplicateUnderHeadingsStatus`. */
export const DUPLICATE_NAMES_RULE = 'grouping/duplicate-names';
/** What a set and a row are fingerprinted under, whichever rule reports them: the id survives a change of status. */
export const SET_FINGERPRINT_RULE = 'grouping/set';
export const ROW_FINGERPRINT_RULE = 'grouping/row';
/** Version of the candidate generator, part of the key of cached verdicts. */
export const GROUPING_GENERATOR_VERSION = '2';

/**
 * Why a set under a visible text is `info` and not above.
 * - `labelFar`: the text is further from the set than a label is (`labelMaxGapEm`, `labelInlineMaxGapEm`).
 * - `labelLong`: the text is a paragraph (`labelMaxChars`, `labelMaxLines`).
 * - `labelSentence`: the text ends as a sentence does and has `labelSentenceMinWords` words or
 *   more: a line of prose before an example, a hint. A question, and a title that ends with a
 *   colon or with nothing, are not held back.
 * - `labelNearerPrevious`: the text is closer to the control before it than to the set: a hint under a field.
 * - `labelNamesContainer`: a region, a form, a dialog or a group that holds the set has the words
 *   of the text as its name, so the text is tied to what holds the set, if not to the set itself.
 * - `independentControls`: checkboxes that are not tied to each other by a `name`, one of which
 *   is required on its own, has a link in its label or is named by a full sentence: lines of
 *   consent under the title of a step, each of which stands for itself.
 * The first four are matters of judgement, which a tester or a model can settle.
 */
export type GroupingReason = 'labelFar' | 'labelLong' | 'labelSentence' | 'labelNearerPrevious' | 'labelNamesContainer' | 'independentControls';

const JUDGEMENT_REASONS: ReadonlySet<GroupingReason> = new Set(['labelFar', 'labelLong', 'labelSentence', 'labelNearerPrevious']);

export interface GroupingCandidate {
  /** Names the candidate within its survey, whatever its selector: the key of its capture in `GroupingSurvey.captures`. */
  key: string;
  /** `set`: radios or checkboxes. `row`: fields side by side. `sections`: sections with the same field names. */
  kind: 'set' | 'row' | 'sections';
  rule: string;
  /** Takes the place of `rule` in the fingerprint (`FindingDraft.fingerprintRule`). */
  fingerprintRule: string;
  /** Id of the finding the check reports for this candidate (`Finding.id`). */
  findingId: string;
  /** Never `fail`. */
  status: 'likely' | 'advisory' | 'info';
  selector: string;
  frame: string;
  box: Box;
  /** Position of the element that holds the controls, when the selector should be that element's and the survey does not have it yet; else null. */
  container: number | null;
  /** What to show in the capture: blocks and controls of the survey by index, and the block to point at (-1 for all of it). */
  capture: { blocks: number[]; controls: number[]; target: number };
  /** Position in the page, for the order of findings. */
  order: number;
  /** Number of controls. */
  controls: number;
  /** The visible text taken for the label, cut; empty when there is none. Text of the page under test. */
  label: string;
  /** Accessible names of the first controls, cut. Text of the page under test. */
  names: string[];
  flags: string[];
  reasons: GroupingReason[];
  values: Record<string, string | number | boolean>;
  crop: string | null;
  cropTarget: Box | null;
  covered: boolean;
  /** Whether a model's judgement could change the status: a set under a plain text that is `likely`, or held back for a reason that is a matter of judgement. */
  adjudicate: boolean;
  /** Compact context for a model. Page text, untrusted. */
  context: { [key: string]: JsonValue };
}

export interface GroupingReport {
  /** `likely` first, then `advisory`, then `info`, each in document order. */
  candidates: GroupingCandidate[];
  /** Left out because of `maxCandidates`. */
  omitted: number;
  /** Left out because a finding of the same rule on the same element is listed. */
  merged: number;
  /** Sets of radios or checkboxes that were looked at, and how many of them are grouped or named with their label. */
  sets: number;
  setsAssociated: number;
  /** Sets with no visible text before them that could be their label. */
  setsWithoutLabel: number;
  /** Runs of radios or checkboxes with more controls than `maxSetSize`, which were not looked at. */
  setsOverMaxSize: number;
  /** Sets, rows and sections held back as `info` because they reach the point where reading the accessibility tree stopped (`maxAxMarks`). */
  heldAtLimit: number;
  /** Rows of fields side by side that were looked at. */
  rows: number;
  /** Controls left out of sets and rows: in the cells of a table, or inside a composite widget. */
  controlsInTables: number;
  controlsInWidgets: number;
}

const GROUP_ROLES: ReadonlySet<string> = new Set(['group', 'radiogroup']);
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

const right = (box: Box): number => box.x + box.width;
const bottom = (box: Box): number => box.y + box.height;

function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(right(a), right(b)) - x, height: Math.max(bottom(a), bottom(b)) - y };
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * A name or a label as it is compared: compatibility forms folded, white space collapsed, the
 * marks of `nameTrimPattern` taken off both ends, lower case. No word is involved.
 */
export function normaliseName(text: string, config: Pick<GroupingConfig, 'nameTrimPattern'>): string {
  let trim: RegExp;
  try {
    trim = new RegExp(config.nameTrimPattern, 'gu');
  } catch {
    trim = /^\s+|\s+$/gu;
  }
  return text.normalize('NFKC').replace(/\s+/g, ' ').replace(trim, '').trim().toLowerCase();
}

const patterns = new Map<string, RegExp | null>();
/** A pattern of the configuration, compiled once; null when it does not compile. */
function compiled(source: string | undefined, flags: string): RegExp | null {
  if (source === undefined || source === '') return null;
  const key = `${flags}\u0000${source}`;
  let pattern = patterns.get(key);
  if (pattern === undefined) {
    try {
      pattern = new RegExp(source, flags);
    } catch {
      pattern = null;
    }
    patterns.set(key, pattern);
  }
  return pattern;
}

type WordConfig = Pick<GroupingConfig, 'unspacedScriptPattern' | 'unspacedCharsPerWord'>;
/** What `Intl.Segmenter` is here: something that cuts a text into parts and says which are words. */
export interface WordCutter {
  segment(text: string): Iterable<{ isWordLike?: boolean }>;
}
let ownCutter: WordCutter | null | undefined;
/** The word segmenter of the runtime (ECMAScript `Intl`, not DOM and not Node), or null where there is none. */
function runtimeCutter(): WordCutter | null {
  if (ownCutter === undefined) {
    try {
      // The root locale: where words end in Chinese, Japanese or Thai is a matter of the script, not of a language setting.
      ownCutter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('und', { granularity: 'word' }) : null;
    } catch {
      ownCutter = null;
    }
  }
  return ownCutter;
}

/**
 * How many words a text has. Runs of text between white space count one each, as they always
 * did, except those in a script that is written without spaces (`unspacedScriptPattern`), which
 * are cut by `Intl.Segmenter` (`cutter`, the one of the runtime unless given); without one,
 * every `unspacedCharsPerWord` characters of such a run count as a word. Words are counted, never
 * looked up: no word of any language is involved.
 */
export function countWords(text: string, config: Partial<WordConfig> = {}, cutter: WordCutter | null = runtimeCutter()): number {
  const runs = text.split(/\s+/).filter(Boolean);
  const unspaced = compiled(config.unspacedScriptPattern, 'u');
  if (!unspaced) return runs.length;
  let words = 0;
  for (const run of runs) {
    if (!unspaced.test(run)) {
      words++;
      continue;
    }
    let own = 0;
    if (cutter) {
      for (const part of cutter.segment(run)) if (part.isWordLike) own++;
    } else {
      const letters = [...run].filter((character) => LETTER_OR_DIGIT.test(character)).length;
      own = Math.ceil(letters / Math.max(1, config.unspacedCharsPerWord ?? 1));
    }
    words += Math.max(1, own);
  }
  return words;
}

const WORD = /[\p{L}\p{N}\p{M}]+/gu;

/**
 * Whether `text` is in `name` as whole words: its words, in order, are words of the name that
 * follow each other. Words are runs of letters, digits and marks, so what stands between them
 * does not matter: "size" is in "size: s", "marital status" in "marital status, single", "do you
 * own a car?" in "do you own a car - yes"; "seat" is not in "seating". In a script that is
 * written without spaces (`unspacedScriptPattern`) the text only has to be in the name.
 */
export function containsWords(name: string, text: string, config: Partial<Pick<GroupingConfig, 'unspacedScriptPattern'>> = {}): boolean {
  const wanted = text.match(WORD) ?? [];
  const have = name.match(WORD) ?? [];
  if (wanted.length === 0 || have.length === 0) return false;
  for (let start = 0; start + wanted.length <= have.length; start++) {
    if (wanted.every((word, at) => have[start + at] === word)) return true;
  }
  return compiled(config.unspacedScriptPattern, 'u')?.test(text) === true && have.join('').includes(wanted.join(''));
}

/**
 * Whether a text reads as a sentence of prose: it ends as one does (`labelSentenceEndPattern`: a
 * full stop, an exclamation mark, an ellipsis, of any script) and has `labelSentenceMinWords`
 * words or more (`countWords`). Punctuation only: no word of any language is involved. A question
 * mark and a colon do not end a sentence here: they end questions and titles, which is what a label is.
 */
export function isSentence(text: string, config: Pick<GroupingConfig, 'labelSentenceEndPattern' | 'labelSentenceMinWords'> & Partial<WordConfig>): boolean {
  const trimmed = text.trim();
  if (countWords(trimmed, config) < config.labelSentenceMinWords) return false;
  return compiled(config.labelSentenceEndPattern, 'u')?.test(trimmed) === true;
}

/** Whether a name is short: few words (`countWords`), few characters, or no name at all. */
export function isShortName(name: string, config: Pick<GroupingConfig, 'shortNameMaxWords' | 'shortNameMaxChars'> & Partial<WordConfig>): boolean {
  return countWords(name, config) <= config.shortNameMaxWords && name.length <= config.shortNameMaxChars;
}

/** Whether the names of a set say too little on their own: at least `ambiguousMinShare` of them are short or empty. */
export function namesAreAmbiguous(
  names: string[],
  config: Pick<GroupingConfig, 'shortNameMaxWords' | 'shortNameMaxChars' | 'ambiguousMinShare'> & Partial<WordConfig>,
): boolean {
  if (names.length === 0) return false;
  return names.filter((name) => isShortName(name, config)).length / names.length >= config.ambiguousMinShare;
}

/**
 * Where a text is in relation to a set of controls: `above` it and no further than a label is,
 * `beside` it on the line of its first control, or `far`.
 */
export function labelPlacement(
  label: Box,
  set: Box,
  firstRow: Box,
  fontSize: number,
  config: Pick<GroupingConfig, 'labelMaxGapEm' | 'labelInlineMaxGapEm' | 'sameRowMinOverlap' | 'toleranceCssPx'>,
): 'above' | 'beside' | 'far' {
  const gap = set.y - bottom(label);
  const across = Math.min(right(label), right(set)) - Math.max(label.x, set.x);
  if (gap >= -config.toleranceCssPx && gap <= config.labelMaxGapEm * fontSize && across > 0) return 'above';
  const overlap = Math.min(bottom(label), bottom(firstRow)) - Math.max(label.y, firstRow.y);
  const aside = Math.max(set.x - right(label), label.x - right(set));
  if (overlap >= config.sameRowMinOverlap * Math.min(label.height, firstRow.height) && aside <= config.labelInlineMaxGapEm * fontSize) return 'beside';
  return 'far';
}

/** Whether two boxes are on one row and no further apart than the parts of a split field are. */
export function besideEachOther(a: Box, b: Box, fontSize: number, config: Pick<GroupingConfig, 'sameRowMinOverlap' | 'splitMaxGapEm' | 'toleranceCssPx'>): boolean {
  const overlap = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
  if (overlap < config.sameRowMinOverlap * Math.min(a.height, b.height)) return false;
  const gap = Math.max(b.x - right(a), a.x - right(b));
  return gap >= -config.toleranceCssPx && gap <= config.splitMaxGapEm * fontSize;
}

/** The text of a block that can be a label: the part of it that is tied to nothing, when the rest is the label of a control. */
function freeTextOf(block: GroupingBlock): string {
  return block.freeText ?? block.text;
}

type LabelKind = 'text' | 'heading' | 'disclosure' | 'group' | 'description';

interface LabelHit {
  kind: LabelKind;
  /** Index of the block. */
  block: number;
  /** Free texts on the same visual line right before the block, in document order: with it they are one label. */
  line: number[];
  /** For `group`: the container the block names. */
  group: number;
  /** The control before the text, when there is one in the same frame. */
  previous: number | null;
}

interface Item {
  control: boolean;
  index: number;
}

export function groupingReport(survey: GroupingSurvey, config: GroupingConfig): GroupingReport {
  const { controls, groups, blocks } = survey;
  const norm = (text: string): string => normaliseName(text, config);
  const names = controls.map((control) => norm(control.name));
  const tolerance = config.toleranceCssPx;
  const headingStatus = clampHeadingLabelStatus(config.headingLabelStatus);
  const sectionsUnderHeadingsStatus = clampDuplicateUnderHeadingsStatus(config.duplicateUnderHeadingsStatus);
  const notePattern = compiled(config.labelNotePattern, 'u');

  // Controls and texts in one sequence, in document order. A text comes before every control
  // whose position is at least its `at`.
  const items: Item[] = [];
  {
    let next = 0;
    blocks.forEach((block, index) => {
      while (next < controls.length && controls[next]!.ord < block.at) items.push({ control: true, index: next++ });
      items.push({ control: false, index });
    });
    while (next < controls.length) items.push({ control: true, index: next++ });
  }
  const itemOfControl: number[] = new Array<number>(controls.length).fill(-1);
  /** For each item, the last control before it. */
  const controlBefore: number[] = [];
  {
    let last = -1;
    items.forEach((item, at) => {
      controlBefore.push(last);
      if (item.control) {
        itemOfControl[item.index] = at;
        last = item.index;
      }
    });
  }
  /** The texts that are the label of each control. */
  const labelBlocks: number[][] = controls.map(() => []);
  blocks.forEach((block, index) => {
    for (const control of block.labels) labelBlocks[control]?.push(index);
  });

  const ords = controls.map((control) => control.ord);
  /** How many controls have a position from `from` to `to`. */
  const controlsWithin = (from: number, to: number): number => {
    const first = (value: number): number => {
      let low = 0;
      let high = ords.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (ords[middle]! < value) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    return first(to + 1) - first(from);
  };
  const groupSize = groups.map((group) => controlsWithin(group.ord, group.end));
  /** Containers that hold everything from `from` to `to`, innermost first. */
  const holding = (from: number, to: number): number[] =>
    groups
      .map((group, index) => ({ group, index }))
      .filter(({ group }) => group.ord <= from && to <= group.end)
      .sort((a, b) => b.group.ord - a.group.ord)
      .map(({ index }) => index);
  const spanOf = (members: number[]): { from: number; to: number } => ({
    from: Math.min(...members.map((index) => controls[index]!.ord)),
    to: Math.max(...members.map((index) => controls[index]!.ord)),
  });

  /**
   * Whether controls reach a point where reading the accessibility tree stopped (`survey.unread`):
   * one of them stands at or after it, or nothing that was read stands between them and it, so
   * that the set may go on with controls that are not known. What stands clear of such a point
   * is known in full and keeps its status.
   */
  const unread = survey.unread ?? [];
  const reachesUnread = (members: number[]): boolean => {
    if (unread.length === 0) return false;
    const frame = controls[members[0]!]!.frame;
    const { to } = spanOf(members);
    return unread.some((limit) => limit.frame === frame && (to >= limit.from || controlsWithin(to + 1, limit.from - 1) === 0));
  };
  let heldAtLimit = 0;
  /**
   * The status something is reported at, and the flags that say why it is lower than it would be.
   * Without the accessibility tree, names and groups are not known: nothing is above `info`. The
   * same holds for what reaches the point where reading it stopped.
   */
  const settle = <T extends 'likely' | 'advisory' | 'info'>(status: T, members: number[]): { status: T | 'info'; axFlags: string[] } => {
    if (!survey.axComplete) return { status: 'info', axFlags: ['axIncomplete'] };
    if (reachesUnread(members)) {
      heldAtLimit++;
      return { status: 'info', axFlags: ['axIncomplete', 'atReadLimit'] };
    }
    return { status, axFlags: [] };
  };

  /** A text that can be the label of something: some of it is tied to nothing, it is exposed, and it has a letter or a digit. */
  const labelish = (block: GroupingBlock): boolean =>
    block.free &&
    !block.inControl &&
    !block.contexts.includes('ariaHidden') &&
    LETTER_OR_DIGIT.test(block.text) &&
    // Code shown on the page is no label of anything.
    !block.contexts.includes('code') &&
    (block.disclosure || !(block.contexts.includes('button') || block.contexts.includes('link')));

  /** Whether a text is as long as a paragraph, or reads as a sentence of prose: what a hint is, and a label seldom. */
  const proseLike = (text: string, lines: number): boolean => text.length > config.labelMaxChars || lines > config.labelMaxLines || isSentence(text, config);
  /** Whether two texts stand on one visual line, no further apart than the parts of one label are. */
  const onOneLine = (a: GroupingBlock, b: GroupingBlock): boolean => {
    const overlap = Math.min(bottom(a.box), bottom(b.box)) - Math.max(a.box.y, b.box.y);
    if (overlap < config.sameRowMinOverlap * Math.min(a.box.height, b.box.height)) return false;
    const gap = Math.max(b.box.x - right(a.box), a.box.x - right(b.box));
    return gap >= -tolerance && gap <= config.labelLineMaxGapEm * (b.style.size || a.style.size);
  };

  /**
   * Section 5.5, step 3: the nearest visible text before a set that is not bound to a control.
   * Going back from the first control of the set: its own labels are passed over; a hint, the
   * text of a link or a button and text hidden from assistive technology are passed over,
   * `labelMaxSkipped` at most; another control, or the label of one, ends the search with nothing.
   * A legend or the text a container is named by is the answer when that container holds the set.
   */
  const findLabel = (members: number[], descriptions = false): LabelHit | null => {
    const set = new Set(members);
    const first = controls[members[0]!]!;
    const { from, to } = spanOf(members);
    let skipped = 0;
    for (let at = itemOfControl[members[0]!]! - 1; at >= 0; at--) {
      const item = items[at]!;
      if (item.control) {
        if (set.has(item.index)) continue;
        return null;
      }
      const block = blocks[item.index]!;
      if (block.frame !== first.frame) return null;
      const previous = controlBefore[at]! >= 0 && controls[controlBefore[at]!]!.frame === first.frame && !set.has(controlBefore[at]!) ? controlBefore[at]! : null;
      const own = block.labels.length > 0 && block.labels.every((index) => set.has(index)) && !block.otherLabel;
      // Punctuation on its own (the colon after a label, a slash between two fields) is passed over.
      if (!LETTER_OR_DIGIT.test(block.text)) continue;
      if (!block.free) {
        if (own) continue;
        if (block.group >= 0) {
          const group = groups[block.group];
          return group && group.ord <= from && to <= group.end ? { kind: 'group', block: item.index, group: block.group, line: [], previous } : null;
        }
        if (block.labels.length > 0 || block.otherLabel) return null;
        // The description of every control of the set that reads as a label does (a question, a
        // title): the search ends here, and the text before it is not taken for the label. A
        // description that reads as prose is a hint, and is passed over like any other.
        const described = block.described ?? [];
        if (descriptions && described.length > 0 && members.every((index) => described.includes(index)) && !proseLike(block.text, block.lines)) {
          return { kind: 'description', block: item.index, group: -1, line: [], previous };
        }
        // A hint, or text inside a control.
        if (++skipped > config.labelMaxSkipped) return null;
        continue;
      }
      if (!labelish(block)) {
        if (++skipped > config.labelMaxSkipped) return null;
        continue;
      }
      // Text that runs on into the label of a control outside the set belongs there.
      if (block.otherLabel || block.labels.some((index) => !set.has(index))) return null;
      // A note about the marks of the form ("* Required") is the label of nothing, and what stands before it is not looked at.
      if (notePattern?.test(freeTextOf(block).trim())) return null;
      // The rest of its visual line: free text before it is part of the label; the label of a
      // control there makes this text a part of that label, which is the label of no set.
      const line: number[] = [];
      let leftmost = block;
      for (let back = at - 1; back >= 0 && line.length <= config.labelMaxSkipped; back--) {
        const before = items[back]!;
        if (before.control) break;
        const other = blocks[before.index]!;
        if (other.frame !== block.frame || !onOneLine(other, leftmost)) break;
        if (!LETTER_OR_DIGIT.test(other.text)) continue;
        if (!other.free) {
          const labelled = other.labels.map((index) => controls[index]!);
          // The label of a control that stands before it (a radio and its label) ends there: this text starts something new.
          if (labelled.length > 0 && !other.otherLabel && labelled.every((control) => control.ord < other.at)) break;
          if (other.group >= 0) {
            const group = groups[other.group];
            return group && group.ord <= from && to <= group.end ? { kind: 'group', block: before.index, group: other.group, line: [], previous } : null;
          }
          if (other.labels.length > 0 || other.otherLabel) return null;
          break;
        }
        if (!labelish(other) || other.otherLabel || other.labels.length > 0 || other.heading !== block.heading || other.disclosure !== block.disclosure) break;
        line.unshift(before.index);
        leftmost = other;
      }
      return { kind: block.heading > 0 ? 'heading' : block.disclosure ? 'disclosure' : 'text', block: item.index, group: -1, line, previous };
    }
    return null;
  };

  /** The text of a label: the block, with the free texts before it on its line. */
  const labelText = (hit: LabelHit): string =>
    [...hit.line, hit.block]
      .map((index) => freeTextOf(blocks[index]!))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  const labelBox = (hit: LabelHit): Box => hit.line.reduce((box, index) => unionBox(box, blocks[index]!.box), blocks[hit.block]!.box);

  /** The box of controls with their labels. */
  const boxOf = (members: number[]): Box => {
    let box = controls[members[0]!]!.box;
    for (const index of members) {
      box = unionBox(box, controls[index]!.box);
      for (const label of labelBlocks[index]!) {
        const block = blocks[label]!;
        if (block.frame === controls[index]!.frame && !block.free) box = unionBox(box, block.box);
      }
    }
    return box;
  };

  /**
   * The selector a finding is reported on: the lowest element that holds the controls, their
   * labels and the text taken for their label, and no other control; failing that, without that
   * text; failing that, the first control.
   */
  const usedContainers = new Set<string>();
  const place = (members: number[], label: number[] | null, rule: string): { selector: string; container: number | null } => {
    const first = controls[members[0]!]!;
    const { from, to } = spanOf(members);
    const own = members.flatMap((index) => labelBlocks[index]!).filter((index) => blocks[index]!.frame === first.frame);
    const lowest = (texts: number[]): number | null => {
      for (let at = 0; at < first.chain.length; at += 2) {
        const ord = first.chain[at]!;
        const end = first.chain[at + 1]!;
        if (ord > from || to > end) continue;
        if (!texts.every((index) => blocks[index]!.at > ord && blocks[index]!.at <= end + 1)) continue;
        return controlsWithin(ord, end) === members.length ? ord : null;
      }
      return null;
    };
    const position = (label !== null ? lowest([...own, ...label]) : null) ?? lowest(own) ?? lowest([]);
    // One finding per kind and element: a second set that would be named after the same element is named after its first control.
    if (position === null || usedContainers.has(`${rule}:${position}`)) return { selector: first.selector, container: null };
    usedContainers.add(`${rule}:${position}`);
    const known = survey.containers[String(position)];
    return known !== undefined ? { selector: known, container: null } : { selector: first.selector, container: position };
  };

  const id = (rule: string, frame: string, selector: string): string => fingerprint({ rule, wcag: GROUPING_SC, frame, selector });
  const capture = (key: string): Pick<GroupingCandidate, 'crop' | 'cropTarget' | 'covered'> => {
    const taken = survey.captures[key];
    return { crop: taken?.crop ?? null, cropTarget: taken?.cropTarget ?? null, covered: taken?.covered === true };
  };
  const shownNames = (members: number[]): string[] => members.slice(0, config.messageItems).map((index) => cut(controls[index]!.name, config.itemTextMaxChars));

  /**
   * Section 5.5, step 2, for a set under a text that is no legend: whether the set is grouped
   * and named all the same, or the text is tied to it in another way.
   */
  const association = (members: number[], hit: LabelHit): { associated: boolean; flags: string[]; reasons: GroupingReason[] } => {
    const label = blocks[hit.line[0] ?? hit.block]!;
    const text = norm(labelText(hit));
    const { from, to } = spanOf(members);
    // The question is part of the name of every control, whatever sets it off from the rest of the name.
    if (members.every((index) => containsWords(names[index]!, text, config))) return { associated: true, flags: [], reasons: [] };
    const around = holding(from, to);
    const flags: string[] = [];
    const named = around.find((index) => GROUP_ROLES.has(groups[index]!.role) && groups[index]!.name !== '');
    if (named !== undefined) {
      const group = groups[named]!;
      const inside = label.at > group.ord && label.at <= group.end + 1;
      // The text stands before the group, or the group holds this set and little else: the name of the group is the label.
      if (!inside || groupSize[named]! - members.length <= config.groupExtraControlsMax) return { associated: true, flags: [], reasons: [] };
      flags.push('inLargerGroup');
    } else if (around.some((index) => GROUP_ROLES.has(groups[index]!.role))) {
      flags.push('unnamedGroup');
    }
    const reasons: GroupingReason[] = [];
    const sameWords = around.some((index) => {
      const name = norm(groups[index]!.name);
      return containsWords(name, text, config) || containsWords(text, name, config);
    });
    if (sameWords) reasons.push('labelNamesContainer');
    return { associated: false, flags, reasons };
  };

  /** Why a text before a set may not be its label, from where it is and how long it is. */
  const doubts = (members: number[], hit: LabelHit): { reasons: GroupingReason[]; placement: 'above' | 'beside' | 'far' } => {
    const label = blocks[hit.block]!;
    const text = labelText(hit);
    const box = labelBox(hit);
    const set = boxOf(members);
    const firstRow = boxOf([members[0]!]);
    const size = label.style.size || controls[members[0]!]!.fontSize;
    const placement = labelPlacement(box, set, firstRow, size, config);
    const reasons: GroupingReason[] = [];
    if (placement === 'far') reasons.push('labelFar');
    if (text.length > config.labelMaxChars || label.lines > config.labelMaxLines) reasons.push('labelLong');
    else if (isSentence(text, config)) reasons.push('labelSentence');
    if (placement === 'above' && hit.previous !== null) {
      const before = controls[hit.previous]!.box;
      const fromPrevious = box.y - bottom(before);
      const toSet = set.y - bottom(box);
      if (fromPrevious >= -tolerance && fromPrevious < config.hintNearerShare * toSet) reasons.push('labelNearerPrevious');
    }
    return { reasons, placement };
  };

  const found: GroupingCandidate[] = [];
  const report: Omit<GroupingReport, 'candidates' | 'omitted' | 'merged' | 'heldAtLimit'> = {
    sets: 0,
    setsAssociated: 0,
    setsWithoutLabel: 0,
    setsOverMaxSize: 0,
    rows: 0,
    controlsInTables: 0,
    controlsInWidgets: 0,
  };
  for (const control of controls) {
    if (control.inWidget) report.controlsInWidgets++;
    else if (control.cell >= 0) report.controlsInTables++;
  }
  const usable = (control: GroupingControl): boolean => !control.inWidget && control.cell < 0;

  // Section 5.5, step 1: radios and checkboxes by `name`, custom radios by the radiogroup around
  // them, and the others by proximity: controls of one kind that follow each other, with no
  // text between them that could be the label of what comes next.
  const sets: number[][] = [];
  {
    const keyed = new Map<string, number[]>();
    let run: number[] = [];
    const close = (): void => {
      if (run.length > 0) sets.push(run);
      run = [];
    };
    /** A text between two controls that starts something new: free text that is not the label of the first, or the name of a container. */
    const breakBetween = (a: number, b: number): boolean => {
      for (let at = itemOfControl[a]! + 1; at < itemOfControl[b]!; at++) {
        const item = items[at]!;
        if (item.control) return true;
        const block = blocks[item.index]!;
        if (block.group >= 0 && !block.free) return true;
        if (labelish(block) && !block.labels.includes(a)) return true;
      }
      return false;
    };
    controls.forEach((control, index) => {
      if (control.kind === 'field' || !usable(control)) {
        close();
        return;
      }
      if (control.kind === 'radio' && control.setKey !== '') {
        close();
        const members = keyed.get(control.setKey);
        if (members) members.push(index);
        else keyed.set(control.setKey, [index]);
        return;
      }
      const last = run[run.length - 1];
      if (last !== undefined) {
        const before = controls[last]!;
        const sameSet = control.setKey !== '' && control.setKey === before.setKey;
        if (before.kind !== control.kind || before.frame !== control.frame || before.form !== control.form || (!sameSet && breakBetween(last, index))) close();
      }
      run.push(index);
    });
    close();
    sets.push(...keyed.values());
    sets.sort((a, b) => a[0]! - b[0]!);
  }

  for (const members of sets) {
    if (members.length < config.minSetSize) continue;
    if (members.length > config.maxSetSize) {
      report.setsOverMaxSize++;
      continue;
    }
    report.sets++;
    const first = controls[members[0]!]!;
    const hit = findLabel(members, true);
    if (!hit) {
      report.setsWithoutLabel++;
      continue;
    }
    if (hit.kind === 'group') {
      report.setsAssociated++;
      continue;
    }
    const tie = association(members, hit);
    if (tie.associated) {
      report.setsAssociated++;
      continue;
    }
    const text = labelText(hit);
    const doubt = doubts(members, hit);
    const reasons = [...doubt.reasons, ...tie.reasons];
    const memberNames = members.map((index) => names[index]!);
    const ambiguous = namesAreAmbiguous(memberNames, config);
    const switches = members.every((index) => controls[index]!.switch === true);
    // Checkboxes that markup does not tie to each other, one of which stands for itself: lines of consent.
    const oneName = first.setKey !== '' && members.every((index) => controls[index]!.setKey === first.setKey);
    const standsAlone = (control: GroupingControl): boolean => control.required === true || control.linkedLabel === true || isSentence(control.name, config);
    if (first.kind === 'checkbox' && !switches && !oneName && members.some((index) => standsAlone(controls[index]!))) reasons.push('independentControls');
    const flags = [first.kind === 'radio' ? 'radios' : 'checkboxes', ...tie.flags];
    if (hit.line.length > 0) flags.push('labelLine');
    let base: 'likely' | 'advisory' = 'likely';
    if (hit.kind === 'description') {
      // Tied to each control as its description, which is read with it, but not as the name of a group.
      flags.push('describedBy');
      base = 'advisory';
    } else if (hit.kind === 'heading' || hit.kind === 'disclosure') {
      flags.push(hit.kind === 'heading' ? 'headingLabel' : 'disclosureLabel');
      base = headingStatus;
    } else if (switches) {
      flags.push('switches');
      base = 'advisory';
    } else if (!ambiguous) {
      flags.push('selfExplanatory');
      base = 'advisory';
    }
    if (first.proxied) flags.push('styledLabels');
    if (doubt.placement === 'beside') flags.push('labelBeside');
    const { status, axFlags } = settle(reasons.length > 0 ? 'info' : base, members);
    const plain = hit.kind === 'text' && !switches && ambiguous;
    const adjudicate = axFlags.length === 0 && plain && reasons.every((reason) => JUDGEMENT_REASONS.has(reason));
    const named = place(members, [...hit.line, hit.block], SET_FINGERPRINT_RULE);
    const key = `set:${members[0]!}`;
    const shown = shownNames(members);
    found.push({
      key,
      kind: 'set',
      rule: status === 'likely' ? UNASSOCIATED_LABEL_RULE : status === 'advisory' ? UNGROUPED_CONTROLS_RULE : GROUP_CANDIDATE_RULE,
      fingerprintRule: SET_FINGERPRINT_RULE,
      findingId: id(SET_FINGERPRINT_RULE, first.frame, named.selector),
      status,
      selector: named.selector,
      frame: first.frame,
      box: unionBox(boxOf(members), labelBox(hit)),
      container: named.container,
      capture: { blocks: [...hit.line, hit.block], controls: members, target: hit.line.length > 0 ? -1 : hit.block },
      order: Math.min(first.ord, blocks[hit.line[0] ?? hit.block]!.at),
      controls: members.length,
      label: cut(text, config.itemTextMaxChars * 2),
      names: shown,
      flags: [...flags, ...reasons, ...axFlags],
      reasons,
      values: {
        controls: members.length,
        label: cut(text, config.itemTextMaxChars * 2),
        names: shown.join(' | '),
        shortNames: memberNames.filter((name) => isShortName(name, config)).length,
        labelPlacement: doubt.placement,
      },
      ...capture(key),
      adjudicate,
      context: {
        controls: first.kind === 'radio' ? 'radio buttons' : switches ? 'switches' : 'checkboxes',
        count: members.length,
        visibleText: cut(text, config.labelMaxChars),
        textIs: hit.kind,
        textPlacement: doubt.placement,
        controlNames: members.slice(0, config.contextMaxItems).map((index) => cut(controls[index]!.name, config.itemTextMaxChars)),
        flags: [...tie.flags],
        reasons: [...reasons],
      },
    });
  }

  // Split fields: fields that follow each other with nothing between them, side by side on one row.
  const rows: number[][] = [];
  {
    let run: number[] = [];
    const close = (): void => {
      if (run.length >= config.minSetSize && run.length <= config.splitMaxParts) rows.push(run);
      run = [];
    };
    controls.forEach((control, index) => {
      if (control.kind !== 'field' || control.inWidget || control.proxied) {
        close();
        return;
      }
      const last = run[run.length - 1];
      if (last !== undefined) {
        const before = controls[last]!;
        const together =
          last === index - 1 &&
          before.frame === control.frame &&
          before.form === control.form &&
          before.cell === control.cell &&
          besideEachOther(before.box, control.box, Math.max(before.fontSize, control.fontSize), config);
        if (!together) close();
      }
      run.push(index);
    });
    close();
  }
  interface RowDraft {
    members: number[];
    candidate: GroupingCandidate;
  }
  const rowDrafts: RowDraft[] = [];
  for (const members of rows) {
    report.rows++;
    const first = controls[members[0]!]!;
    const partNames = members.map((index) => names[index]!);
    const hit = findLabel(members);
    const { from, to } = spanOf(members);
    const tightGroup =
      hit !== null && hit.kind === 'group' && GROUP_ROLES.has(groups[hit.group]!.role) && groupSize[hit.group]! - members.length <= config.groupExtraControlsMax;
    const doubt = hit !== null && hit.kind !== 'group' ? doubts(members, hit) : null;
    // A text is the label of the row when it is near and spans the row or stands at its start: a
    // text that is over one of the later parts only, or that is the name of a later part and not
    // of the first, is the caption of that part ("Day", "Month", "Year" over three fields).
    const captionOfPart = (own: LabelHit): boolean => {
      const text = norm(labelText(own));
      if (text !== '' && partNames[0] !== text && partNames.includes(text)) return true;
      const box = labelBox(own);
      if (bottom(box) > Math.min(...members.map((index) => controls[index]!.box.y)) + tolerance) return false;
      const under = members.filter((index) => Math.min(right(box), right(controls[index]!.box)) - Math.max(box.x, controls[index]!.box.x) > tolerance);
      return under.length === 1 && under[0] !== members[0];
    };
    const near = doubt !== null && doubt.reasons.length === 0 && hit !== null && !captionOfPart(hit);
    const shared = hit !== null && (near || tightGroup);
    const sharedText = hit === null || !shared ? '' : hit.kind === 'group' ? norm(groups[hit.group]!.name) : norm(labelText(hit));
    // A visible label is tied to one part, by `label` or `aria-labelledby`.
    const visiblyLabelled = (index: number): boolean => labelBlocks[index]!.length > 0;
    const labelled = members.some(visiblyLabelled);
    // Two parts with one name. Not when every field has a visible label of its own: those are
    // fields of their own whose labels have the same words, which is no matter of grouping.
    const duplicate = partNames.some((name, at) => name !== '' && partNames.indexOf(name) !== at) && !members.every(visiblyLabelled);
    const unnamed = partNames.some((name) => name === '');
    const asWhole = sharedText !== '' && partNames.some((name) => name === sharedText);
    // The only visible label is tied to the first part, and a later part has no name but its
    // placeholder ("MM" under the label "Expiry date", then "YY"). When the first part shows a
    // placeholder of its own that is not its name, that label is not the name of its part: it
    // stands for the row. Without that, the label may be that of the first field alone.
    const placeholderOf = (index: number): string => norm(controls[index]!.placeholder ?? '');
    const byPlaceholder = (index: number): boolean => !visiblyLabelled(index) && placeholderOf(index) !== '' && names[index] === placeholderOf(index);
    const oneLabel = visiblyLabelled(members[0]!) && members.slice(1).every((index) => !visiblyLabelled(index));
    const placeholderPart = oneLabel && !unnamed && members.slice(1).some(byPlaceholder);
    const firstHinted = placeholderOf(members[0]!) !== '' && placeholderOf(members[0]!) !== names[members[0]!];
    const flags = ['fields'];
    if (duplicate) flags.push('duplicateNames');
    if (unnamed && (shared || labelled)) flags.push('unnamedPart');
    if (asWhole) flags.push('namedAsWhole');
    const likely = flags.length > 1 || (placeholderPart && firstHinted);
    if (placeholderPart) flags.push('placeholderPart');
    let status: 'likely' | 'advisory';
    if (likely) status = 'likely';
    else if (placeholderPart) status = 'advisory';
    else {
      // Named part by part. Advisory when a plain text stands over the row and nothing ties it to the fields.
      if (hit === null || hit.kind !== 'text' || !near) continue;
      const tie = association(members, hit);
      if (tie.associated || tie.reasons.length > 0) continue;
      flags.push(...tie.flags);
      status = 'advisory';
    }
    const labelBlocksOfRow = hit !== null && hit.kind !== 'group' && near ? [...hit.line, hit.block] : null;
    const rowLabel = hit === null || !shared ? '' : hit.kind === 'group' ? groups[hit.group]!.name : labelText(hit);
    const named = place(members, labelBlocksOfRow, ROW_FINGERPRINT_RULE);
    const key = `row:${members[0]!}`;
    const shown = shownNames(members);
    const own = [...new Set(members.flatMap((index) => labelBlocks[index]!))].filter((index) => blocks[index]!.frame === first.frame);
    const box = (labelBlocksOfRow ?? []).reduce((all, index) => unionBox(all, blocks[index]!.box), boxOf(members));
    const { status: reported, axFlags } = settle(status, members);
    rowDrafts.push({
      members,
      candidate: {
        key,
        kind: 'row',
        rule: reported === 'likely' ? SPLIT_FIELD_RULE : reported === 'advisory' ? UNGROUPED_CONTROLS_RULE : GROUP_CANDIDATE_RULE,
        fingerprintRule: ROW_FINGERPRINT_RULE,
        findingId: id(ROW_FINGERPRINT_RULE, first.frame, named.selector),
        status: reported,
        selector: named.selector,
        frame: first.frame,
        box,
        container: named.container,
        capture: { blocks: [...(labelBlocksOfRow ?? []), ...own], controls: members, target: -1 },
        order: from,
        controls: members.length,
        label: cut(rowLabel, config.itemTextMaxChars * 2),
        names: shown,
        flags: [...flags, ...axFlags],
        reasons: [],
        values: {
          controls: members.length,
          label: cut(rowLabel, config.itemTextMaxChars * 2),
          names: shown.join(' | '),
          unnamedParts: partNames.filter((name) => name === '').length,
          lastPosition: to,
        },
        ...capture(key),
        adjudicate: false,
        context: {},
      },
    });
  }

  // Sections with the same field names (section 3E of the brief). The fields of a form are cut
  // into sections where a name comes back, and where the named container around them changes.
  interface Section {
    members: number[];
    byName: Map<string, number>;
    container: number;
  }
  const scopes = new Map<string, Section[]>();
  const namedAround = controls.map((control) => holding(control.ord, control.ord).find((index) => groups[index]!.name !== '') ?? -1);
  controls.forEach((control, index) => {
    if (control.kind !== 'field' || !usable(control)) return;
    // One form, and inside it one region: log in at the top of a page and sign up in its main part are not two sections of one thing.
    const scope = `${control.frame}\u0000${control.form}\u0000${control.region}`;
    const sections = scopes.get(scope) ?? [];
    if (!scopes.has(scope)) scopes.set(scope, sections);
    const name = names[index]!;
    let current = sections[sections.length - 1];
    if (!current || current.container !== namedAround[index]! || (name !== '' && current.byName.has(name))) {
      current = { members: [], byName: new Map(), container: namedAround[index]! };
      sections.push(current);
    }
    current.members.push(index);
    if (name !== '') current.byName.set(name, index);
  });
  const inReportedSections = new Set<number>();
  let sectionKey = 0;
  for (const sections of scopes.values()) {
    const parent = sections.map((_, index) => index);
    const root = (index: number): number => {
      let at = index;
      while (parent[at] !== at) at = parent[at]!;
      return at;
    };
    const sharedBy = new Map<number, Set<string>>();
    /** Pairs of sections with the same names, and whether the tokens of `autocomplete` tell every such field from its twin. */
    const pairs: { a: number; toldApart: boolean }[] = [];
    const scopeOf = (index: number): string => controls[index]!.autofillScope ?? '';
    for (let a = 0; a < sections.length; a++) {
      for (let b = a + 1; b < sections.length; b++) {
        const one = sections[a]!;
        const other = sections[b]!;
        // A name in a container with a name of its own is told apart by it.
        if (one.container !== other.container) continue;
        const same: string[] = [];
        for (const [name, index] of one.byName) {
          const twin = other.byName.get(name);
          if (twin === undefined) continue;
          if (norm(controls[index]!.description) === norm(controls[twin]!.description)) same.push(name);
        }
        if (same.length < config.duplicateMinShared) continue;
        pairs.push({ a, toldApart: same.every((name) => scopeOf(one.byName.get(name)!) !== scopeOf(other.byName.get(name)!)) });
        parent[root(b)] = root(a);
        for (const at of [a, b]) {
          const known = sharedBy.get(at) ?? new Set<string>();
          for (const name of same) known.add(name);
          sharedBy.set(at, known);
        }
      }
    }
    const components = new Map<number, number[]>();
    sections.forEach((_, index) => {
      if (!sharedBy.has(index)) return;
      const at = root(index);
      components.set(at, [...(components.get(at) ?? []), index]);
    });
    for (const component of components.values()) {
      if (component.length < config.minSetSize) continue;
      // Of each section, the fields from the first shared name to the last.
      const spans = component.map((index) => {
        const section = sections[index]!;
        const shared = sharedBy.get(index)!;
        const hits = section.members.map((member, at) => (shared.has(names[member]!) ? at : -1)).filter((at) => at >= 0);
        return section.members.slice(hits[0], hits[hits.length - 1]! + 1);
      });
      const labels = spans.map((members) => findLabel(members));
      const anchor = spans[1]!;
      const anchorLabel = labels[1] ?? null;
      const first = controls[anchor[0]!]!;
      const underHeadings = labels.every((hit) => hit !== null && hit.kind === 'heading');
      const sharedNames = [...sharedBy.get(component[1]!)!].sort();
      // Without a form around them, that the sections belong to one form is not known: two
      // examples on a page of documentation have the same field names as well.
      const noForm = first.form < 0;
      // `section-*`, `shipping` and `billing` in `autocomplete` say which section a field is in, to the browser if not to a screen reader.
      const own = pairs.filter((pair) => root(pair.a) === root(component[0]!));
      const byAutocomplete = own.length > 0 && own.every((pair) => pair.toldApart);
      const flags = ['fields', ...(underHeadings ? ['headingLabel'] : []), ...(noForm ? ['noForm'] : []), ...(byAutocomplete ? ['autocompleteSections'] : [])];
      const { status, axFlags } = settle(noForm || byAutocomplete ? 'info' : underHeadings ? sectionsUnderHeadingsStatus : 'likely', spans.flat());
      const named = place(anchor, null, DUPLICATE_NAMES_RULE);
      const key = `sections:${sectionKey++}:${anchor[0]!}`;
      const labelBlock = anchorLabel !== null && anchorLabel.kind !== 'group' && doubts(anchor, anchorLabel).reasons.length === 0 ? anchorLabel.block : null;
      const ownLabels = [...new Set(anchor.flatMap((index) => labelBlocks[index]!))].filter((index) => blocks[index]!.frame === first.frame);
      // As the page writes them, not as they are compared.
      const anchorSection = sections[component[1]!]!;
      const shownShared = sharedNames.slice(0, config.messageItems).map((name) => cut(controls[anchorSection.byName.get(name)!]?.name ?? name, config.itemTextMaxChars));
      for (const members of spans) for (const index of members) inReportedSections.add(index);
      found.push({
        key,
        kind: 'sections',
        rule: status === 'info' ? GROUP_CANDIDATE_RULE : DUPLICATE_NAMES_RULE,
        fingerprintRule: DUPLICATE_NAMES_RULE,
        findingId: id(DUPLICATE_NAMES_RULE, first.frame, named.selector),
        status,
        selector: named.selector,
        frame: first.frame,
        box: labelBlock !== null ? unionBox(boxOf(anchor), blocks[labelBlock]!.box) : boxOf(anchor),
        container: named.container,
        capture: { blocks: [...(labelBlock !== null ? [labelBlock] : []), ...ownLabels], controls: anchor, target: -1 },
        order: first.ord,
        controls: anchor.length,
        label: labelBlock !== null ? cut(freeTextOf(blocks[labelBlock]!), config.itemTextMaxChars * 2) : '',
        names: shownShared,
        flags: [...flags, ...axFlags],
        reasons: [],
        values: {
          sections: component.length,
          sharedNames: sharedNames.length,
          names: shownShared.join(' | '),
          firstSection: controls[spans[0]![0]!]!.selector,
          label: labelBlock !== null ? cut(freeTextOf(blocks[labelBlock]!), config.itemTextMaxChars * 2) : '',
        },
        ...capture(key),
        adjudicate: false,
        context: {},
      });
    }
  }
  // A row of parts inside sections that are reported for their names is said once, there.
  for (const draft of rowDrafts) {
    if (draft.candidate.status !== 'likely' && draft.members.every((index) => inReportedSections.has(index))) continue;
    found.push(draft.candidate);
  }

  // One finding per rule and element, so that finding ids stay unique: the one of the highest
  // status stands for it, the first in the page among equals, and the others are counted.
  const rank = { likely: 0, advisory: 1, info: 2 } as const;
  const sorted = found.sort((a, b) => rank[a.status] - rank[b.status] || a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const seen = new Set<string>();
  const ordered = sorted.filter((candidate) => {
    const key = `${candidate.fingerprintRule}\u0000${candidate.frame}\u0000${candidate.selector}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    candidates: ordered.slice(0, config.maxCandidates),
    omitted: Math.max(0, ordered.length - config.maxCandidates),
    merged: sorted.length - ordered.length,
    heldAtLimit,
    ...report,
  };
}

/** The candidates of a survey: what the collector captures and what the adjudicator layer works from. */
export function groupingCandidates(survey: GroupingSurvey, config: GroupingConfig): GroupingCandidate[] {
  return groupingReport(survey, config).candidates;
}
