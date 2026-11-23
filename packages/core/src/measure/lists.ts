import { clampCardListStatus } from '../config.js';
import { fingerprint } from '../fingerprint.js';
import type { Box, JsonValue, ListBlock, ListGroup, ListLine, ListSurvey, ListsConfig, TextContext, WcagRef } from '../types.js';
import { styleSignature } from './headings.js';

/**
 * What the lists check reports, from the survey of a page (section 5.4 of the brief). Everything
 * here is deterministic and works on what was rendered: which content has list semantics is
 * what the accessibility tree said (`ListBlock.inList`), not what the tags say.
 *
 * Nothing here is ever a `fail`: whether content is presented as a list is read from bullets,
 * numbers and layout, and that is a judgement a tester confirms.
 *
 * `listCandidates` is also the hand-off to the adjudicator layer.
 */

export const LISTS_SC: WcagRef = { sc: '1.3.1', level: 'A' };
export const GLYPH_LIST_RULE = 'lists/glyph-list';
export const GLYPH_CANDIDATE_RULE = 'lists/glyph-list-candidate';
/** What a series of lines with bullets or numbers is fingerprinted under, whichever of the two rules reports it. */
export const GLYPH_FINGERPRINT_RULE = 'lists/glyph';
export const PRESENTATIONAL_LIST_RULE = 'lists/presentational-list';
export const REPEATED_STRUCTURE_RULE = 'lists/repeated-structure';
export const KEY_VALUE_RULE = 'lists/key-value';
export const LIST_STYLE_NONE_RULE = 'lists/list-style-none';
/** Version of the candidate generator, part of the key of cached verdicts. */
export const LISTS_GENERATOR_VERSION = '2';

/** What kind of marker a series of lines has. */
export type ListMarkerClass = 'bullet' | 'number' | 'image' | 'shape' | 'counter' | 'listItemMarker';

/**
 * Why a series of lines with bullets or numbers is `info` and not `likely`. Each is a matter of
 * judgement, which a tester or a model can settle.
 * - `fewWeakItems`: fewer than `weakMinItems` lines, all opening with a hyphen, a dash or an
 *   asterisk: asides and footnotes open that way too.
 * - `weakSentences`: lines that open with a hyphen, a dash or an asterisk and end as sentences
 *   do: the lines of a dialogue. Items after such a mark are phrases without closing punctuation,
 *   or the parts of an enumeration, each closed by a semicolon or a comma.
 * - `quotePrefix`: lines that open with the angle that quotes a message in plain-text mail.
 * - `fewSymbolItems`: fewer than `symbolMinItems` lines that open with an arrow, a pictogram or
 *   an emoji: two messages with a warning sign, two links with an arrow.
 * - `itemsAreControls`: lines that open with such a symbol and are each a link or something
 *   that is clicked, and nothing else: calls to action, titles of an accordion.
 * - `colouredMarkers`: the characters the lines open with are in different colours: the
 *   swatches of a legend, the dots of a status. The bullets of a list look the same.
 * - `fewGraphicItems`: fewer than `graphicMinItems` lines, each with the same image or drawn
 *   shape before it: two links with the same icon, two titles with the same ornament.
 * - `mixedGlyphs`: lines that open with different symbols, one of which is used once: symbols
 *   used as labels (a telephone, an envelope) rather than as bullets.
 * - `startsMidSequence`: numbers that follow each other but do not start at the beginning of
 *   their sequence: dates ("12. Mai", "13. Mai"), or a list that goes on from elsewhere.
 * - `fewLetterItems`: fewer than `letterMinItems` lines numbered "A.", "B.": initials of names.
 * - `initialsAndNames`: every line reads as a capital letter, a full stop and one capitalised
 *   word: "A. Martin", "B. Nguyen", however many there are.
 * - `sameWordAfterNumber`: every line goes on with the same word after "1.", "2.": dates
 *   ("1. Mai", "2. Mai"), ranks, floors. The items of a list seldom all open with one word.
 * - `itemsHeadText`: numbered lines that each have further blocks of text under them: steps, or
 *   the numbered titles of sections, which are headings rather than items. Also lines with any
 *   other marker that each have `headedItemMinBlocks` blocks or more: titles of panels with an icon.
 */
export type ListReason =
  | 'fewWeakItems'
  | 'quotePrefix'
  | 'weakSentences'
  | 'fewGraphicItems'
  | 'fewSymbolItems'
  | 'itemsAreControls'
  | 'colouredMarkers'
  | 'mixedGlyphs'
  | 'startsMidSequence'
  | 'fewLetterItems'
  | 'initialsAndNames'
  | 'sameWordAfterNumber'
  | 'itemsHeadText';

export interface ListCandidate {
  /** Names the candidate within its survey, whatever its selector: the key of its capture in `ListSurvey.captures`. */
  key: string;
  kind: 'glyph' | 'presentational' | 'repeated' | 'key-value' | 'unstyled';
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
  /**
   * Position (`ListBlock.chain`) of the element that holds the items, when the selector should be
   * that element's and the survey does not have it yet (`ListSurvey.containers`); else null.
   */
  container: number | null;
  /** What to show in the capture: blocks of the survey by index, or a capture handle of the survey. */
  capture: { kind: 'blocks' | 'elements'; ids: number[] };
  /** Position in the page, for the order of findings. */
  order: number;
  items: number;
  /** The start of the first items. Text of the page under test. */
  texts: string[];
  flags: string[];
  reasons: ListReason[];
  values: Record<string, string | number | boolean>;
  crop: string | null;
  cropTarget: Box | null;
  covered: boolean;
  /** Whether a model's judgement could change the status: series of lines with bullets or numbers, outside navigation. */
  adjudicate: boolean;
  /** Compact context for a model. Page text, untrusted. */
  context: { [key: string]: JsonValue };
}

export interface ListReport {
  /** `likely` first, then `advisory`, then `info`, each in document order. */
  candidates: ListCandidate[];
  /** Left out because of `maxCandidates`, and of `maxUnstyledLists`. */
  omitted: number;
  omittedUnstyled: number;
  /** Left out because a finding of the same rule on the same element is listed: one id, one finding. The one of the highest status stays. */
  merged: number;
}

interface Ordinal {
  system: string;
  /** For "1.2.": "1.". */
  prefix: string;
  value: number;
  /** What stands around the number: brackets, a full stop. Two items of one list agree on it. */
  shape: string;
  first: boolean;
  letterDot: boolean;
  label: string;
}

/** What a line opens with. */
export interface LineMark {
  class: ListMarkerClass | 'keyValue';
  /** Marks of one series agree on this: the image, the shape, the counter. Empty for characters. */
  key: string;
  weak: boolean;
  /** Drawn by `::before`. */
  pseudo: boolean;
  /** What to show for it. */
  glyph: string;
  ordinals: Ordinal[];
  /** The text of the line after the mark; all of it when the mark is not a character of the text. */
  rest: string;
  /** The mark is all there is in its box: the text of the item is in the next box on its line. */
  alone: boolean;
  /** For `keyValue`: the name, before the colon. */
  name?: string;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const LETTER = /\p{L}/gu;
const DIGIT = /\p{N}/gu;
const DECIMAL_DIGIT = /^\p{Nd}$/u;
/** Punctuation and symbols around a word: "Mai," and "Mai" are one word. */
const PUNCTUATION_AROUND = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;
/** Enclosed numbers: first code point of each run in Unicode, and how many it holds. */
const ENCLOSED_RUNS: readonly (readonly [number, number])[] = [
  [0x2460, 20],
  [0x2474, 20],
  [0x2488, 20],
  [0x2776, 10],
];
const IDEOGRAPHIC_DIGITS = '一二三四五六七八九';
const IDEOGRAPHIC_TEN = '十';
const ROMAN: readonly (readonly [string, number])[] = [
  ['m', 1000], ['cm', 900], ['d', 500], ['cd', 400], ['c', 100], ['xc', 90], ['l', 50], ['xl', 40], ['x', 10], ['ix', 9], ['v', 5], ['iv', 4], ['i', 1],
];
/** Text in these places is not an item of a list that lost its semantics. */
const NOT_ITEMS: ReadonlySet<TextContext> = new Set<TextContext>(['ariaHidden', 'code', 'button', 'label', 'term', 'caption']);
/** Lines in different cells of a table are rows or columns of it, not items. */
const CELLS: ReadonlySet<TextContext> = new Set<TextContext>(['tableCell', 'tableHeader']);
const NOT_KEYS: ReadonlySet<TextContext> = new Set<TextContext>(['link', 'navigation', 'quote']);

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function right(box: Box): number {
  return box.x + box.width;
}

function bottom(box: Box): number {
  return box.y + box.height;
}

function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(right(a), right(b)) - x, height: Math.max(bottom(a), bottom(b)) - y };
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Value of a decimal digit of any script: its distance from the zero of its run of ten. */
function digitValue(char: string): number | null {
  if (!DECIMAL_DIGIT.test(char)) return null;
  const code = char.codePointAt(0)!;
  let value = 0;
  while (value < 9 && DECIMAL_DIGIT.test(String.fromCodePoint(code - value - 1))) value++;
  return value;
}

function numberValue(text: string): number | null {
  let value = 0;
  for (const char of text) {
    const digit = digitValue(char);
    if (digit === null) return null;
    value = value * 10 + digit;
  }
  return text === '' ? null : value;
}

function romanValue(text: string): number | null {
  const lower = text.toLowerCase();
  let rest = lower;
  let value = 0;
  for (const [symbol, worth] of ROMAN) {
    while (rest.startsWith(symbol)) {
      value += worth;
      rest = rest.slice(symbol.length);
    }
  }
  if (rest !== '' || value === 0) return null;
  // Written the standard way: "iiii" and "vx" are not numerals.
  let back = '';
  let left = value;
  for (const [symbol, worth] of ROMAN) {
    while (left >= worth) {
      back += symbol;
      left -= worth;
    }
  }
  return back === lower ? value : null;
}

function ideographicValue(text: string): number | null {
  const ten = text.indexOf(IDEOGRAPHIC_TEN);
  const digit = (char: string | undefined): number => (char === undefined ? 0 : IDEOGRAPHIC_DIGITS.indexOf(char) + 1);
  if (ten < 0) return text.length === 1 && digit(text) > 0 ? digit(text) : null;
  if (ten > 1 || text.length - ten > 2) return null;
  const tens = ten === 0 ? 1 : digit(text[0]);
  const units = digit(text[ten + 1]);
  if (tens === 0 || (text.length - ten === 2 && units === 0)) return null;
  return tens * 10 + units;
}

interface Patterns {
  bullet: RegExp;
  weakBullet: RegExp;
  pseudoBullet: RegExp;
  iconGlyph: RegExp;
  number: RegExp;
  letter: RegExp;
  roman: RegExp;
  ideographic: RegExp;
  enclosed: RegExp;
  keyValue: RegExp;
  keyEnd: RegExp;
  symbolBullet: RegExp;
  quotePrefix: RegExp;
  figureStart: RegExp;
  sentenceEnd: RegExp;
  separatorEnd: RegExp;
  initialName: RegExp;
}

function compile(config: ListsConfig): Patterns {
  const make = (source: string): RegExp => new RegExp(source, 'u');
  return {
    bullet: make(config.bulletPattern),
    weakBullet: make(config.weakBulletPattern),
    pseudoBullet: make(config.pseudoBulletPattern),
    iconGlyph: make(config.iconGlyphPattern),
    number: make(config.numberPattern),
    letter: make(config.letterPattern),
    roman: make(config.romanPattern),
    ideographic: make(config.ideographicNumberPattern),
    enclosed: make(config.enclosedNumberPattern),
    keyValue: make(config.keyValueLinePattern),
    keyEnd: make(config.keyEndPattern),
    symbolBullet: make(config.symbolBulletPattern),
    quotePrefix: make(config.quotePrefixPattern),
    figureStart: make(config.figureStartPattern),
    sentenceEnd: make(config.sentenceEndPattern),
    separatorEnd: make(config.itemSeparatorEndPattern),
    initialName: make(config.initialNamePattern),
  };
}

/**
 * A figure after a hyphen ("- 20 %", "- 3,50 €", "- 3 °C at dawn") is a reduction, a negative
 * amount or a temperature below zero, not an item: text that is mostly digits, or that opens
 * with a number and the sign of a unit (`figureStartPattern`). A unit written in letters does
 * not count: "- 200 g de farine" is an ingredient.
 */
function isFigure(text: string, config: ListsConfig, patterns: Patterns): boolean {
  const digits = text.match(DIGIT)?.length ?? 0;
  if (digits === 0) return false;
  const letters = text.match(LETTER)?.length ?? 0;
  return digits / (digits + letters) >= config.numericMinDigitShare || patterns.figureStart.test(text);
}

/**
 * A second symbol right after the first: the first is not a bullet. Five stars are a rating,
 * three hyphens a rule, two arrows an ornament.
 */
function symbolFollows(after: string, patterns: Patterns): boolean {
  const next = [...after.trimStart()][0];
  return next !== undefined && patterns.pseudoBullet.test(next);
}

function ordinalsOf(text: string, patterns: Patterns, config: ListsConfig): { ordinals: Ordinal[]; rest: string } {
  const ordinals: Ordinal[] = [];
  let rest = text;
  const shapeOf = (whole: string, token: string): string => whole.replace(token, '#').trim();
  const digits = patterns.number.exec(text);
  if (digits?.[1] !== undefined) {
    const parts = digits[1].split('.');
    const value = numberValue(parts[parts.length - 1]!);
    if (value !== null && parts.every((part) => numberValue(part) !== null)) {
      const prefix = parts.slice(0, -1).map((part) => `${numberValue(part)}.`).join('');
      ordinals.push({ system: 'digits', prefix, value, shape: shapeOf(digits[0], digits[1]), first: value === 1, letterDot: false, label: digits[0].trim() });
      rest = text.slice(digits[0].length);
    }
  }
  const roman = patterns.roman.exec(text);
  if (roman?.[1] !== undefined) {
    const value = romanValue(roman[1]);
    if (value !== null) {
      const upper = roman[1] !== roman[1].toLowerCase();
      ordinals.push({ system: upper ? 'ROMAN' : 'roman', prefix: '', value, shape: shapeOf(roman[0], roman[1]), first: value === 1, letterDot: false, label: roman[0].trim() });
      rest = text.slice(roman[0].length);
    }
  }
  const letter = patterns.letter.exec(text);
  if (letter?.[1] !== undefined) {
    const shape = shapeOf(letter[0], letter[1]);
    const token = letter[1];
    // "A." also opens a name; "A)" and "(a)" do not.
    const common = { prefix: '', shape, letterDot: shape === '#.', label: letter[0].trim() };
    // Letters whose order is not the order of their code points (kana, hangul) are looked up in
    // their sequences; a letter can be in two of them, and the lines after it tell which.
    let listed = false;
    config.letterSequences.forEach((sequence, index) => {
      const position = [...sequence].indexOf(token);
      if (position < 0) return;
      listed = true;
      ordinals.push({ system: `sequence-${index}`, value: position + 1, first: position === 0, ...common });
    });
    if (!listed) ordinals.push({ system: 'letter', value: token.codePointAt(0)!, first: config.firstLetters.includes(token), ...common });
    rest = text.slice(letter[0].length);
  }
  const ideographic = patterns.ideographic.exec(text);
  if (ideographic?.[1] !== undefined) {
    const value = ideographicValue(ideographic[1]);
    if (value !== null) {
      ordinals.push({ system: 'ideographic', prefix: '', value, shape: shapeOf(ideographic[0], ideographic[1]), first: value === 1, letterDot: false, label: ideographic[0].trim() });
      rest = text.slice(ideographic[0].length);
    }
  }
  const enclosed = patterns.enclosed.exec(text);
  if (enclosed?.[1] !== undefined) {
    const code = enclosed[1].codePointAt(0)!;
    const run = ENCLOSED_RUNS.find(([start, size]) => code >= start && code < start + size);
    if (run) {
      const value = code - run[0] + 1;
      ordinals.push({ system: `enclosed-${run[0]}`, prefix: '', value, shape: '#', first: value === 1, letterDot: false, label: enclosed[1] });
      rest = text.slice(enclosed[0].length);
    }
  }
  return { ordinals, rest };
}

/**
 * What the text of a line opens with: a bullet, a number, or nothing (null). `alone` says that
 * the text is all there is in its box and that other text follows on the same line, so that a
 * bullet or a number without anything after it still starts an item.
 */
export function classifyLineStart(text: string, config: ListsConfig, alone = false, patterns: Patterns = compile(config)): LineMark | null {
  const start = alone ? `${text.trim()} x` : text;
  const { ordinals, rest } = ordinalsOf(start, patterns, config);
  const common = { key: '', pseudo: false, alone };
  if (ordinals.length > 0 && LETTER_OR_DIGIT.test(rest)) {
    return { class: 'number', weak: false, glyph: ordinals[0]!.label, ordinals, rest: alone ? '' : rest, ...common };
  }
  const strong = patterns.bullet.exec(start);
  if (strong) {
    const after = start.slice(strong[0].length);
    if (LETTER_OR_DIGIT.test(after) && !symbolFollows(after, patterns)) {
      return { class: 'bullet', weak: false, glyph: strong[0].trim(), ordinals: [], rest: alone ? '' : after, ...common };
    }
  }
  const weak = patterns.weakBullet.exec(start);
  if (weak) {
    const after = start.slice(weak[0].length);
    if (LETTER_OR_DIGIT.test(after) && !isFigure(after, config, patterns) && !symbolFollows(after, patterns)) {
      return { class: 'bullet', weak: true, glyph: weak[0].trim(), ordinals: [], rest: alone ? '' : after, ...common };
    }
  }
  return null;
}

/** What a line opens with, its marker included; `keyValue` when it reads as a name, a colon and a value. */
function markOf(line: ListLine, config: ListsConfig, patterns: Patterns, alone: boolean): LineMark | null {
  const marker = line.marker;
  if (marker) {
    const rest = line.start;
    const drawn = (kind: ListMarkerClass, pseudo: boolean): LineMark => ({ class: kind, key: marker.key, weak: false, pseudo, glyph: '', ordinals: [], rest, alone: false });
    if (marker.kind === 'list-item') return drawn('listItemMarker', false);
    if (marker.kind === 'pseudo-counter') return drawn('counter', true);
    if (marker.kind === 'pseudo-shape') return drawn('shape', true);
    if (marker.kind === 'image') return drawn('image', false);
    if (marker.kind === 'shape') return drawn('shape', false);
    const text = marker.text.trim();
    // A glyph of an icon font: an image as far as a reader is concerned.
    if (patterns.iconGlyph.test(text)) return drawn('image', true);
    if (patterns.pseudoBullet.test(text)) return { class: 'bullet', key: 'pseudo', weak: false, pseudo: true, glyph: text, ordinals: [], rest, alone: false };
    const numbered = ordinalsOf(`${text} x`, patterns, config);
    if (numbered.ordinals.length > 0) return { class: 'number', key: 'pseudo', weak: false, pseudo: true, glyph: text, ordinals: numbered.ordinals, rest, alone: false };
    // Any other generated text (a word, a quotation mark) is no bullet: the text of the line decides.
  }
  const mark = classifyLineStart(line.start, config, alone, patterns);
  if (mark) return mark;
  const pair = patterns.keyValue.exec(line.start);
  const name = pair?.[1]?.trim() ?? '';
  if (name !== '' && /\p{L}/u.test(name) && name.split(/\s+/).length <= config.keyMaxWords) {
    return { class: 'keyValue', key: '', weak: false, pseudo: false, glyph: '', ordinals: [], rest: '', alone: false, name };
  }
  return null;
}

/** Rows of boxes: boxes that overlap vertically by `sameRowMinOverlap` of the lower of two. Each row from left to right. */
function rowsOf(boxes: Box[], config: Pick<ListsConfig, 'sameRowMinOverlap'>): Box[][] {
  const sorted = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Box[][] = [];
  for (const box of sorted) {
    const row = rows[rows.length - 1];
    const head = row?.[0];
    const overlap = head ? Math.min(bottom(head), bottom(box)) - Math.max(head.y, box.y) : 0;
    if (row && head && overlap >= config.sameRowMinOverlap * Math.min(head.height, box.height) && overlap > 0) row.push(box);
    else rows.push([box]);
  }
  for (const row of rows) row.sort((a, b) => a.x - b.x);
  return rows;
}

function allClose(values: number[], tolerance: number): boolean {
  return values.length === 0 || Math.max(...values) - Math.min(...values) <= tolerance;
}

/**
 * Lines stacked as the items of a list are: on at least two rows, each starting where another
 * one starts (or centred where another one is). A row of lines side by side is not: bullets
 * between items on one line are separators.
 */
export function stackedLines(boxes: Box[], rtl: boolean, config: Pick<ListsConfig, 'sameRowMinOverlap' | 'alignToleranceCssPx'>): boolean {
  if (boxes.length < 2 || rowsOf(boxes, config).length < 2) return false;
  const shared = (values: number[]): boolean =>
    values.every((value, index) => values.some((other, at) => at !== index && Math.abs(other - value) <= config.alignToleranceCssPx));
  return shared(boxes.map((box) => (rtl ? right(box) : box.x))) || shared(boxes.map((box) => box.x + box.width / 2));
}

/**
 * Section 5.4, step 2: "aligned boxes with constant gaps". The boxes are in line when they form
 * one row with even gaps, one column with a shared edge or centre and even gaps, or rows that
 * start at one edge with even gaps inside and between them (a grid, a row that wraps). Boxes
 * that overlap are not a series. Returns the numbers of rows and of boxes in the longest row.
 */
export function regularLayout(
  boxes: Box[],
  config: Pick<ListsConfig, 'sameRowMinOverlap' | 'alignToleranceCssPx' | 'gapToleranceCssPx' | 'gapToleranceShare'>,
): { rows: number; columns: number } | null {
  if (boxes.length < 2) return null;
  const rows = rowsOf(boxes, config);
  const even = (gaps: number[]): boolean => {
    if (gaps.length === 0) return true;
    if (Math.min(...gaps) < -config.alignToleranceCssPx) return false;
    const largest = Math.max(...gaps);
    return largest - Math.min(...gaps) <= Math.max(config.gapToleranceCssPx, config.gapToleranceShare * largest);
  };
  const across: number[] = [];
  for (const row of rows) for (let index = 1; index < row.length; index++) across.push(row[index]!.x - right(row[index - 1]!));
  if (!even(across)) return null;
  const down: number[] = [];
  for (let index = 1; index < rows.length; index++) {
    down.push(Math.min(...rows[index]!.map((box) => box.y)) - Math.max(...rows[index - 1]!.map(bottom)));
  }
  if (!even(down)) return null;
  if (rows.length > 1) {
    const tolerance = config.alignToleranceCssPx;
    const starts = rows.map((row) => row[0]!.x);
    const single = rows.every((row) => row.length === 1);
    const aligned =
      allClose(starts, tolerance) ||
      (single && (allClose(rows.map((row) => right(row[0]!)), tolerance) || allClose(rows.map((row) => row[0]!.x + row[0]!.width / 2), tolerance)));
    if (!aligned) return null;
  }
  return { rows: rows.length, columns: Math.max(...rows.map((row) => row.length)) };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) / 2)]!;
}

interface RunItem {
  block: number;
  segment: number;
  mark: LineMark;
  /** The blocks of the item, the one with the mark first. */
  blocks: number[];
}

/** One way to read the numbers of a run: "i." is a roman numeral and a letter, and the lines after it tell which. */
interface Reading {
  first: Ordinal;
  last: Ordinal;
}

interface Run {
  items: RunItem[];
  /** Position of the element that holds the items; null for lines of one block. */
  container: number | null;
  viaBreaks: boolean;
  /** For numbers: the first and the last number, in the reading that holds for the whole run. */
  sequence: Reading | null;
}

/** Section 5.4 on a survey. Pure: the same survey and configuration give the same report. */
export function listReport(survey: ListSurvey, config: ListsConfig): ListReport {
  const { blocks } = survey;
  const patterns = compile(config);
  const tolerance = config.alignToleranceCssPx;
  const top = (status: 'likely' | 'advisory' | 'info'): 'likely' | 'advisory' | 'info' => (survey.axComplete ? status : 'info');
  const axFlags = survey.axComplete ? [] : ['axIncomplete'];

  const ordOf = (index: number): number => blocks[index]!.chain[0] ?? -1;
  const inside = (index: number, from: number, to: number): boolean => ordOf(index) >= from && ordOf(index) <= to;
  const sameRow = (a: Box, b: Box): boolean => {
    const overlap = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
    return overlap > 0 && overlap >= config.sameRowMinOverlap * Math.min(a.height, b.height);
  };
  const eligible = (block: ListBlock): boolean => !block.inList && !block.heading && !block.contexts.some((context) => NOT_ITEMS.has(context));

  // What each line opens with.
  const marks: (LineMark | null)[][] = blocks.map((block, index) => {
    if (!eligible(block)) return block.segments.map(() => null);
    return block.segments.map((line, segment) => {
      const next = blocks[index + 1];
      // A bullet or a number in a box of its own, with the text of the item in the next box on its line.
      const alone =
        segment === 0 && block.segments.length === 1 && block.chars <= config.loneMarkerMaxChars && next !== undefined && next.frame === block.frame && sameRow(block.firstLine, next.firstLine);
      const mark = markOf(line, config, patterns, alone);
      // A title that holds a colon is no name and value: links and quotations are left out.
      return mark?.class === 'keyValue' && block.contexts.some((context) => NOT_KEYS.has(context)) ? null : mark;
    });
  });

  const compatible = (a: LineMark, b: LineMark): boolean => a.class === b.class && a.pseudo === b.pseudo && a.key === b.key;
  const follows = (a: Ordinal, b: Ordinal): boolean => a.system === b.system && a.prefix === b.prefix && a.shape === b.shape && b.value === a.value + 1;
  const begin = (mark: LineMark): Reading[] => mark.ordinals.map((ordinal) => ({ first: ordinal, last: ordinal }));
  /** The readings that go on with the next mark; none when its number does not follow. */
  const extend = (readings: Reading[], mark: LineMark): Reading[] =>
    readings.flatMap((reading) => mark.ordinals.filter((ordinal) => follows(reading.last, ordinal)).map((ordinal) => ({ first: reading.first, last: ordinal })));

  const runs: Run[] = [];
  const inBreakRun = new Set<number>();

  // Lines of one block, separated by forced line breaks.
  blocks.forEach((block, index) => {
    if (block.segments.length < 2) return;
    let items: RunItem[] = [];
    let readings: Reading[] = [];
    const close = (): void => {
      if (items.length >= 2) {
        runs.push({ items, container: null, viaBreaks: true, sequence: readings[0] ?? null });
        inBreakRun.add(index);
      }
      items = [];
      readings = [];
    };
    block.segments.forEach((_, segment) => {
      const mark = marks[index]![segment];
      if (!mark) {
        close();
        return;
      }
      const last = items[items.length - 1];
      const next = last && compatible(last.mark, mark) ? extend(readings, mark) : [];
      if (!last || !compatible(last.mark, mark) || (mark.class === 'number' && next.length === 0)) {
        close();
        readings = begin(mark);
      } else {
        readings = next;
      }
      items.push({ block: index, segment, mark, blocks: [index] });
    });
    close();
  });

  // Lines in sibling blocks: each the first text of its element, the elements side by side under one parent.
  const siblings = (a: number, b: number, alone: boolean): { container: number; itemB: [number, number] } | null => {
    const first = blocks[a]!;
    const second = blocks[b]!;
    if (first.frame !== second.frame || first.chain.length < 2 || second.chain.length < 2) return null;
    const target = second.chain[0]!;
    let at = -1;
    for (let index = 0; index < first.chain.length; index += 2) {
      if (first.chain[index]! <= target && target <= first.chain[index + 1]!) {
        at = index;
        break;
      }
    }
    // Not found among the recorded ancestors, or the element of the first line holds the second.
    if (at <= 0) return null;
    const container = first.chain[at]!;
    let other = -1;
    for (let index = 0; index < second.chain.length; index += 2) {
      if (second.chain[index] === container) {
        other = index;
        break;
      }
    }
    if (other <= 0) return null;
    const from = first.chain[at - 2]!;
    const to = first.chain[at - 1]!;
    // The line is the first text of its item, and everything up to the next line belongs to it.
    if (a > 0 && inside(a - 1, from, to)) return null;
    for (let between = a + 1; between < b; between++) {
      if (inside(between, from, to)) continue;
      // A mark in a cell of its own, the text of its item in the next cell of the same parent and
      // the next mark on a later row: the cells of a flat grid, two to an item.
      const text = blocks[between]!;
      const flat =
        alone && b === a + 2 && inside(between, container, first.chain[at + 1]!) && sameRow(first.firstLine, text.firstLine) && !sameRow(first.firstLine, second.firstLine);
      if (!flat) return null;
    }
    return { container, itemB: [second.chain[other - 2]!, second.chain[other - 1]!] };
  };
  {
    let items: RunItem[] = [];
    let readings: Reading[] = [];
    let container: number | null = null;
    let lastRange: [number, number] | null = null;
    const close = (): void => {
      const range = lastRange;
      if (items.length >= 2 && range) {
        // The blocks of each item: up to the next item, and for the last one what its element holds.
        items.forEach((item, position) => {
          const next = items[position + 1];
          const owned: number[] = [item.block];
          for (let index = item.block + 1; next ? index < next.block : index < blocks.length && inside(index, range[0], range[1]); index++) owned.push(index);
          // The last mark of a flat grid: its text is in the next cell.
          const beside = blocks[item.block + 1];
          if (item.mark.alone && owned.length === 1 && beside && beside.frame === blocks[item.block]!.frame && sameRow(blocks[item.block]!.firstLine, beside.firstLine)) {
            owned.push(item.block + 1);
          }
          item.blocks = owned;
        });
        runs.push({ items, container, viaBreaks: false, sequence: readings[0] ?? null });
      }
      items = [];
      readings = [];
      container = null;
      lastRange = null;
    };
    blocks.forEach((block, index) => {
      const mark = marks[index]![0];
      if (!mark || inBreakRun.has(index) || block.contexts.some((context) => CELLS.has(context))) return;
      const last = items[items.length - 1];
      if (last && compatible(last.mark, mark)) {
        const relation = siblings(last.block, index, last.mark.alone);
        const next = extend(readings, mark);
        if (relation && (container === null || container === relation.container) && (mark.class !== 'number' || next.length > 0)) {
          readings = next;
          container = relation.container;
          lastRange = relation.itemB;
          items.push({ block: index, segment: 0, mark, blocks: [index] });
          return;
        }
      }
      close();
      readings = begin(mark);
      items.push({ block: index, segment: 0, mark, blocks: [index] });
    });
    close();
  }

  const lineOf = (item: RunItem): ListLine => blocks[item.block]!.segments[item.segment]!;
  const selectorOfContainer = (position: number | null, fallback: string): { selector: string; container: number | null } => {
    if (position === null) return { selector: fallback, container: null };
    const known = survey.containers[String(position)];
    return known === undefined ? { selector: fallback, container: position } : { selector: known, container: null };
  };
  const capture = (key: string): Pick<ListCandidate, 'crop' | 'cropTarget' | 'covered'> => {
    const taken = survey.captures[key];
    return { crop: taken?.crop ?? null, cropTarget: taken?.crop && taken.cropTarget ? { ...taken.cropTarget } : null, covered: taken?.covered === true };
  };
  const id = (rule: string, frame: string, selector: string): string => fingerprint({ rule, wcag: LISTS_SC, frame, selector });

  /** How a line ends; for a mark that stands alone, how the text beside it ends. */
  const endOf = (item: RunItem): string => {
    const line = lineOf(item);
    const text = item.mark.alone ? (blocks[item.block + 1]?.text ?? '') : (line.end ?? line.start);
    return text.trim();
  };
  /** The text of an item after its mark. */
  const restOf = (item: RunItem): string => (item.mark.alone ? (blocks[item.block + 1]?.text ?? '') : item.mark.rest).trim();
  /** The start of an item as it reads: a mark that stands alone, with the text beside it. */
  const shown = (item: RunItem): string => (item.mark.alone ? `${lineOf(item).start} ${blocks[item.block + 1]?.text ?? ''}`.trim() : lineOf(item).start);
  /** Blocks of an item apart from a mark that stands alone. */
  const textBlocks = (item: RunItem): number => item.blocks.length - (item.mark.alone ? 1 : 0);
  /**
   * Items after a hyphen or a dash, as against the lines of a dialogue and other sentences that
   * open with one: none ends as a sentence does, or all but the last end with the semicolon or
   * the comma of an enumeration.
   */
  const phrases = (items: RunItem[]): boolean => {
    const ends = items.map(endOf);
    if (!ends.some((end) => patterns.sentenceEnd.test(end))) return true;
    return ends.length > 1 && ends.slice(0, -1).every((end) => patterns.separatorEnd.test(end));
  };
  const firstWord = (text: string): string => (text.split(/\s+/)[0] ?? '').replace(PUNCTUATION_AROUND, '');

  const found: ListCandidate[] = [];
  /** Series of lines of one block that are reported, by rule: a second one gets a fingerprint of its own. */
  const reportedInBlock = new Set<string>();
  const ruleInBlock = (rule: string, run: Run): string => {
    if (!run.viaBreaks) return rule;
    const first = run.items[0]!;
    const key = `${rule}\u0000${first.block}`;
    if (!reportedInBlock.has(key)) {
      reportedInBlock.add(key);
      return rule;
    }
    // Stable from run to run: the line the series starts at.
    return `${rule}@${first.segment}`;
  };
  /** Blocks that belong to something reported: a series of blocks of one shape around them is not reported again. */
  const claimed = new Set<number>();
  const usedContainers = new Set<number>();

  for (const run of runs) {
    const first = run.items[0]!;
    const firstBlock = blocks[first.block]!;
    const kind = first.mark.class;
    const boxes = run.items.map((item) => lineOf(item).box);
    if (!stackedLines(boxes, firstBlock.rtl, config)) continue;
    const owned = [...new Set(run.items.flatMap((item) => item.blocks))];
    const key = `${kind === 'keyValue' ? 'key-value' : 'glyph'}:${first.block}:${first.segment}`;
    const texts = run.items.slice(0, config.messageItems).map((item) => cut(shown(item), config.itemTextMaxChars));
    const box = owned.map((index) => blocks[index]!.box).reduce(unionBox);
    // A second series under one element is named after its first line, so that the two stay apart.
    const free = run.container !== null && !usedContainers.has(run.container);
    const named = selectorOfContainer(free ? run.container : null, firstBlock.selector);
    const base = {
      key,
      selector: named.selector,
      frame: firstBlock.frame,
      box,
      container: named.container,
      capture: { kind: 'blocks' as const, ids: owned.slice(0, config.maxTargetBlocks) },
      order: ordOf(first.block),
      items: run.items.length,
      texts,
      ...capture(key),
    };

    if (kind === 'keyValue') {
      if (run.items.length < config.keyValueMinPairs) continue;
      // The names of a sheet of values differ from each other and are set in one style. Names
      // that come back are the speakers of a chat; a name in two styles is a person and a verb.
      const names = run.items.map((item) => (item.mark.name ?? '').toLowerCase());
      if (new Set(names).size < names.length) continue;
      const styles = new Set(run.items.map((item) => lineOf(item).keyStyle ?? ''));
      if (styles.size > 1 || [...styles].some((style) => style.includes('\n'))) continue;
      if (run.container !== null) usedContainers.add(run.container);
      for (const index of owned) claimed.add(index);
      const fingerprintRule = ruleInBlock(KEY_VALUE_RULE, run);
      found.push({
        ...base,
        kind: 'key-value',
        rule: KEY_VALUE_RULE,
        fingerprintRule,
        findingId: id(fingerprintRule, base.frame, base.selector),
        status: top('advisory'),
        flags: ['colonLines', ...(run.viaBreaks ? ['lineBreaks'] : []), ...axFlags],
        reasons: [],
        values: { pairs: run.items.length, firstItems: texts.join(' | ') },
        adjudicate: false,
        context: {},
      });
      continue;
    }

    if (run.items.length < config.minItems) continue;
    const reasons: ListReason[] = [];
    if (kind === 'bullet' && run.items.every((item) => item.mark.weak)) {
      // A hyphen, a dash, an asterisk or an angle opens a line for many reasons. Such lines are
      // `likely` only when there are enough of them and they read as items do.
      const quoted = run.items.every((item) => patterns.quotePrefix.test(item.mark.glyph));
      if (run.items.length < config.weakMinItems) reasons.push('fewWeakItems');
      if (quoted) reasons.push('quotePrefix');
      else if (run.items.length >= config.weakMinItems && !phrases(run.items)) reasons.push('weakSentences');
    }
    if ((kind === 'image' || kind === 'shape') && run.items.length < config.graphicMinItems) reasons.push('fewGraphicItems');
    if (kind === 'bullet' && run.items.every((item) => patterns.symbolBullet.test(item.mark.glyph))) {
      // An arrow, a triangle, a pictogram or an emoji is also an icon: of a message, of a link, of
      // something that opens. It takes more lines, and lines that are more than a control each.
      if (run.items.length < config.symbolMinItems) reasons.push('fewSymbolItems');
      const control = (index: number): boolean => blocks[index]!.contexts.includes('link') || blocks[index]!.clickable === true;
      if (run.items.every((item) => textBlocks(item) === 1 && item.blocks.every(control))) reasons.push('itemsAreControls');
    }
    if (kind === 'bullet' && !first.mark.pseudo) {
      const colours = new Set(run.items.flatMap((item) => lineOf(item).startColor ?? []));
      if (colours.size > 1) reasons.push('colouredMarkers');
    }
    if (kind === 'bullet') {
      const uses = new Map<string, number>();
      for (const item of run.items) uses.set(item.mark.glyph, (uses.get(item.mark.glyph) ?? 0) + 1);
      if (uses.size > 1 && [...uses.values()].some((count) => count === 1)) reasons.push('mixedGlyphs');
    }
    const ordinal = run.sequence?.first ?? null;
    if (kind === 'number' && ordinal) {
      if (!ordinal.first) reasons.push('startsMidSequence');
      if (ordinal.letterDot && run.items.length < config.letterMinItems) reasons.push('fewLetterItems');
      if (!first.mark.pseudo) {
        if (ordinal.letterDot && run.items.every((item) => patterns.initialName.test(lineOf(item).start))) reasons.push('initialsAndNames');
        const words = run.items.map((item) => firstWord(restOf(item)));
        if (ordinal.system === 'digits' && ordinal.shape === '#.' && /\p{L}/u.test(words[0]!) && words.every((word) => word === words[0])) reasons.push('sameWordAfterNumber');
      }
      if (!run.viaBreaks && run.items.some((item) => textBlocks(item) > 1)) reasons.push('itemsHeadText');
    } else if (!run.viaBreaks && run.items.every((item) => textBlocks(item) >= config.headedItemMinBlocks)) {
      // An icon or a bullet before the title of each panel of a sidebar, of each section of a page.
      reasons.push('itemsHeadText');
    }
    const navigation = owned.every((index) => blocks[index]!.contexts.includes('navigation'));
    const status = top(reasons.length > 0 ? 'info' : navigation ? 'advisory' : 'likely');
    if (run.container !== null) usedContainers.add(run.container);
    for (const index of owned) claimed.add(index);
    const classFlag: string = kind;
    const lastOrdinal = run.sequence?.last ?? null;
    const glyphs = [...new Set(run.items.map((item) => item.mark.glyph).filter((glyph) => glyph !== ''))];
    const before = blocks[first.block - 1];
    const after = blocks[owned[owned.length - 1]! + 1];
    const fingerprintRule = ruleInBlock(GLYPH_FINGERPRINT_RULE, run);
    found.push({
      ...base,
      kind: 'glyph',
      rule: status === 'info' ? GLYPH_CANDIDATE_RULE : GLYPH_LIST_RULE,
      fingerprintRule,
      findingId: id(fingerprintRule, base.frame, base.selector),
      status,
      flags: [classFlag, ...(first.mark.pseudo ? ['pseudoElement'] : []), ...(run.viaBreaks ? ['lineBreaks'] : []), ...reasons, ...(navigation ? ['navigation'] : []), ...axFlags],
      reasons,
      values: {
        items: run.items.length,
        marker: kind,
        ...(glyphs.length > 0 ? { markers: glyphs.slice(0, config.messageItems).join(' ') } : {}),
        ...(ordinal && lastOrdinal ? { sequence: `${ordinal.label} … ${lastOrdinal.label}` } : {}),
        firstItems: texts.join(' | '),
      },
      adjudicate: survey.axComplete && !navigation,
      context: {
        marker: kind,
        drawnBy: first.mark.pseudo ? 'generated content' : firstBlock.segments[first.segment]?.marker ? 'a graphic or a list marker' : 'characters of the text',
        separatedBy: run.viaBreaks ? 'line breaks inside one block' : 'sibling blocks',
        items: run.items.length,
        itemStarts: run.items.slice(0, config.contextMaxItems).map((item) => cut(shown(item), config.itemTextMaxChars)),
        blocksPerItem: round(owned.length / run.items.length, 1),
        reasons: [...reasons],
        contexts: [...firstBlock.contexts],
        tag: firstBlock.tag,
        textBefore: before && before.frame === firstBlock.frame ? cut(before.text, config.itemTextMaxChars * 2) : null,
        textAfter: after && after.frame === firstBlock.frame ? cut(after.text, config.itemTextMaxChars * 2) : null,
      },
    });
  }

  // Section 5.4, step 3: a name and its value side by side, row after row, in two styles or with a colon.
  const usable = (block: ListBlock): boolean => eligible(block) && !block.contexts.some((context) => CELLS.has(context));
  const pairAt = (index: number): boolean => {
    const name = blocks[index];
    const value = blocks[index + 1];
    if (!name || !value || name.frame !== value.frame || claimed.has(index) || claimed.has(index + 1)) return false;
    if (!usable(name) || !usable(value) || name.contexts.some((context) => NOT_KEYS.has(context))) return false;
    if (name.lines !== 1 || name.words > config.keyMaxWords || !LETTER_OR_DIGIT.test(name.text) || !LETTER_OR_DIGIT.test(value.text)) return false;
    if (!sameRow(name.firstLine, value.firstLine)) return false;
    const after = name.rtl ? right(value.firstLine) <= name.firstLine.x + tolerance : value.firstLine.x >= right(name.firstLine) - tolerance;
    return after && (styleSignature(name.style) !== styleSignature(value.style) || patterns.keyEnd.test(name.text.trim()));
  };
  for (let index = 0; index < blocks.length; index++) {
    if (!pairAt(index)) continue;
    const pairs = [index];
    const edge = (block: ListBlock): number => (block.rtl ? right(block.firstLine) : block.firstLine.x);
    for (let next = index + 2; pairAt(next); next += 2) {
      const previous = blocks[pairs[pairs.length - 1]!]!;
      const name = blocks[next]!;
      const stacked = name.firstLine.y >= bottom(previous.firstLine) - tolerance;
      const sameNames = Math.abs(edge(name) - edge(previous)) <= tolerance && styleSignature(name.style) === styleSignature(previous.style);
      const value = blocks[next + 1]!;
      const before = blocks[pairs[pairs.length - 1]! + 1]!;
      const sameValues = Math.abs(value.firstLine.x - before.firstLine.x) <= tolerance || Math.abs(right(value.firstLine) - right(before.firstLine)) <= tolerance;
      if (!stacked || !sameNames || !sameValues) break;
      pairs.push(next);
    }
    if (pairs.length < config.keyValueMinPairs) continue;
    // Names that come back are not the names of a sheet of values.
    if (new Set(pairs.map((at) => blocks[at]!.text.trim().toLowerCase())).size < pairs.length) continue;
    const firstBlock = blocks[index]!;
    const last = pairs[pairs.length - 1]! + 1;
    const owned: number[] = [];
    for (let at = index; at <= last; at++) {
      owned.push(at);
      claimed.add(at);
    }
    // The lowest recorded element that holds the first name and the last value.
    let position: number | null = null;
    const target = ordOf(last);
    for (let at = 0; at < firstBlock.chain.length; at += 2) {
      if (firstBlock.chain[at]! <= target && target <= firstBlock.chain[at + 1]!) {
        position = firstBlock.chain[at]!;
        break;
      }
    }
    const free = position !== null && !usedContainers.has(position);
    if (position !== null) usedContainers.add(position);
    const named = selectorOfContainer(free ? position : null, firstBlock.selector);
    const key = `key-value:${index}:pairs`;
    const texts = pairs.slice(0, config.messageItems).map((at) => cut(`${blocks[at]!.text} ${blocks[at + 1]!.text}`, config.itemTextMaxChars));
    found.push({
      key,
      kind: 'key-value',
      rule: KEY_VALUE_RULE,
      fingerprintRule: KEY_VALUE_RULE,
      findingId: id(KEY_VALUE_RULE, firstBlock.frame, named.selector),
      status: top('advisory'),
      selector: named.selector,
      frame: firstBlock.frame,
      box: owned.map((at) => blocks[at]!.box).reduce(unionBox),
      container: named.container,
      capture: { kind: 'blocks', ids: owned.slice(0, config.maxTargetBlocks) },
      order: ordOf(index),
      items: pairs.length,
      texts,
      flags: ['sideBySide', ...axFlags],
      reasons: [],
      values: { pairs: pairs.length, firstItems: texts.join(' | ') },
      ...capture(key),
      adjudicate: false,
      context: {},
    });
    index = last;
  }

  // Section 5.4, step 2: siblings of one shape, in line with even gaps.
  const claimedOrds = [...claimed].map(ordOf).sort((a, b) => a - b);
  const anyClaimed = (from: number, to: number): boolean => {
    let low = 0;
    let high = claimedOrds.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (claimedOrds[middle]! < from) low = middle + 1;
      else high = middle;
    }
    return low < claimedOrds.length && claimedOrds[low]! <= to;
  };
  const accepted: [number, number][] = [];
  const cardStatus = clampCardListStatus(config.cardListStatus);
  survey.groups.forEach((group: ListGroup, index) => {
    const { items } = group;
    if (items.length < config.minRepeatedItems) return;
    // Inside an item of a series that is reported: the tags of each card, the links of each result.
    if (accepted.some(([from, to]) => group.ord >= from && group.ord <= to)) return;
    if (anyClaimed(items[0]!.ord, items[items.length - 1]!.end)) return;
    if (items.some((item) => item.chars === 0 || item.controls > 0 || item.lists > 0)) return;
    // Buttons side by side are a toolbar, not a list.
    if (items.every((item) => item.buttonChars >= item.chars)) return;
    // Links with more text between them than separators are links inside a sentence (a signature, a byline).
    const links =
      items.every((item) => item.blocks <= 1 && item.links === 1 && item.linkChars >= item.chars) && group.looseChars <= config.linkSeparatorMaxChars * group.count;
    // Blocks that each hold nothing but several links are groups of links themselves, looked at in their own right.
    const linkGroups = items.every((item) => item.links >= 2 && item.linkChars >= item.chars);
    const cards = !links && !linkGroups && items.every((item) => item.blocks >= 2 || item.graphics > 0);
    if (!links && !cards) return;
    if (cards && median(items.map((item) => item.chars)) > config.repeatedItemMaxChars) return;
    const layout = regularLayout(items.map((item) => item.box), config);
    if (!layout) return;
    // One under the other, each under a heading of its own that leads nowhere: the sections of a
    // document. The results of a search and the teasers of a feed have titles that are links.
    if (cards && layout.columns === 1 && items.every((item) => item.heading === 'plain')) return;
    for (const item of items) accepted.push([item.ord, item.end]);
    const key = `repeated:${index}`;
    const texts = items.slice(0, config.messageItems).map((item) => cut(item.text, config.itemTextMaxChars));
    found.push({
      key,
      kind: 'repeated',
      rule: REPEATED_STRUCTURE_RULE,
      fingerprintRule: REPEATED_STRUCTURE_RULE,
      findingId: id(REPEATED_STRUCTURE_RULE, group.frame, group.selector),
      status: top(cards ? cardStatus : 'advisory'),
      selector: group.selector,
      frame: group.frame,
      box: items.map((item) => item.box).reduce(unionBox),
      container: null,
      capture: { kind: 'elements', ids: [group.target] },
      order: group.ord,
      items: group.count,
      texts,
      flags: [cards ? 'cards' : 'links', ...(group.navigation ? ['navigation'] : []), ...axFlags],
      reasons: [],
      values: { items: group.count, rows: layout.rows, perRow: layout.columns, firstItems: texts.join(' | ') },
      ...capture(key),
      adjudicate: false,
      context: {},
    });
  });

  // Section 5.4, step 4, and the inventory of lists without markers.
  survey.lists.forEach((list, index) => {
    const key = `list:${index}`;
    const base = {
      key,
      selector: list.selector,
      frame: list.frame,
      box: list.box,
      container: null,
      capture: { kind: 'elements' as const, ids: [list.target] },
      order: list.ord,
      items: list.items,
      texts: [],
      reasons: [],
      ...capture(key),
      adjudicate: false,
      context: {},
    };
    if (list.kind === 'presentational') {
      if (list.markers < config.minItems) return;
      found.push({
        ...base,
        kind: 'presentational',
        rule: PRESENTATIONAL_LIST_RULE,
        fingerprintRule: PRESENTATIONAL_LIST_RULE,
        findingId: id(PRESENTATIONAL_LIST_RULE, list.frame, list.selector),
        status: top('likely'),
        flags: [...(list.markersInside ? ['markersInside'] : []), ...axFlags],
        values: { items: list.items, itemsWithMarker: list.markers, element: list.tag },
      });
    } else {
      found.push({
        ...base,
        kind: 'unstyled',
        rule: LIST_STYLE_NONE_RULE,
        fingerprintRule: LIST_STYLE_NONE_RULE,
        findingId: id(LIST_STYLE_NONE_RULE, list.frame, list.selector),
        status: 'info',
        flags: [...axFlags],
        values: { items: list.items, element: list.tag },
      });
    }
  });

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
  const inventory = ordered.filter((candidate) => candidate.kind === 'unstyled');
  const others = ordered.filter((candidate) => candidate.kind !== 'unstyled');
  const kept = [...others.slice(0, config.maxCandidates), ...inventory.slice(0, config.maxUnstyledLists)];
  return {
    candidates: kept,
    omitted: Math.max(0, others.length - config.maxCandidates),
    omittedUnstyled: Math.max(0, inventory.length - config.maxUnstyledLists),
    merged: sorted.length - ordered.length,
  };
}

/** The candidates of a survey: what the collector captures and what the adjudicator layer works from. */
export function listCandidates(survey: ListSurvey, config: ListsConfig): ListCandidate[] {
  return listReport(survey, config).candidates;
}
