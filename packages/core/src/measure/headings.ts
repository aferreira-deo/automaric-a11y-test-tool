import { clampInversionStatus } from '../config.js';
import { fingerprint } from '../fingerprint.js';
import { countWords } from './grouping.js';
import type { Box, HeadingSurvey, HeadingsConfig, JsonValue, TextBlock, TextContext, TextStyle, WcagRef } from '../types.js';

/**
 * Heading candidates, from the text blocks of a page. Everything here is deterministic and works
 * on what was rendered: tags play no part, and which blocks are headings already is what the
 * accessibility tree said (`TextBlock.heading`).
 *
 * `headingCandidates` is also the hand-off to the adjudicator layer: each candidate carries the
 * id of the finding the check reports for it, its capture, and a compact context.
 */

export const HEADINGS_SC: WcagRef = { sc: '1.3.1', level: 'A' };
export const UNMARKED_HEADING_RULE = 'headings/unmarked-heading';
export const HEADING_CANDIDATE_RULE = 'headings/heading-candidate';
export const LEVEL_INVERSION_RULE = 'headings/level-inversion';
/**
 * What a candidate is fingerprinted under, whichever of the two rules reports it: its id stays
 * the same when its status changes, from one run to the next or after a model's verdict.
 */
export const CANDIDATE_FINGERPRINT_RULE = 'headings/candidate';
/**
 * Version of the candidate generator, part of the key of cached verdicts: raise it when what a
 * candidate is, or what its `context` holds, changes in a way that makes old verdicts stale.
 */
export const HEADINGS_GENERATOR_VERSION = '1';

/** The style of body text: the most common size and weight, by number of characters. */
export interface BodyBaseline {
  size: number;
  weight: number;
  /** Most common family and colour of the text that has that size and weight. */
  family: string;
  color: string;
  /** `main`: measured inside main. `page`: no text in main, or too little to go by; measured on the whole page. */
  from: 'main' | 'page';
  /** Characters in that size and weight, white space apart, where it was measured. */
  chars: number;
  /** Fewer characters than `baselineMinChars`: too little to say what body text looks like. No candidate is then above `info`. */
  lowText: boolean;
}

export type Prominence = 'larger' | 'bolder' | 'matchesHeadingStyle';

/**
 * Why a candidate is not `likely`.
 * - A `TextContext`: all of its text is in a label, a button, a link, a table cell and so on.
 * - `numeric`: mostly digits, or with a currency or percent sign: a price, a figure, a date.
 * - `statistic`: short and opening with a number ("15 years"); it may be a title ("2026 roadmap").
 * - `quotation`: opens with a quotation mark.
 * - `peersNumeric`: most blocks with its exact style are numbers (see `peerDemotionMinShare`).
 * - `repeatedText`: the same text in the same style several times on the page: a label, a badge.
 * - `italic`: larger than body text, of its weight and in italics: a pull quote.
 * - `sameColourAsBackground`: see `TextBlock.sameColourAsBackground`.
 * - `sentence`, `colon`: how the text ends. `lineBreaks`: lines of text separated by `br`.
 * - `listItem`: the block is the text of a list item (`li`), bold among its siblings.
 * - `sharesLine`: other text sits just before it on its line.
 * - `repeated`: the block before or after it has the same style: a series of peers.
 * - `notFollowed`: nothing comes after it, what comes next is beside it and not under it, or
 *   what comes next is set as a title and is as large as it or larger: it heads nothing.
 * - `headsControl`: what comes next is a button or a link in the style of body text, outside
 *   any list and not the first of a column of them: a tagline over a call to action rather than
 *   a heading over content.
 * - `tightAbove`: bold text of body size with less space above it than below.
 * - `shortFollower`: it is only bolder than body text, and what follows it is one plain block
 *   that is no longer than it or is a single short line that is not a sentence, with nothing of
 *   that kind after it: a label over a value, a name over a remark.
 * - `labelSeries`: it is only bolder than body text and stands in a series of label, one such
 *   line, label again.
 */
export type HeadingReason =
  | TextContext
  | 'numeric'
  | 'statistic'
  | 'quotation'
  | 'peersNumeric'
  | 'repeatedText'
  | 'italic'
  | 'sameColourAsBackground'
  | 'sentence'
  | 'colon'
  | 'lineBreaks'
  | 'listItem'
  | 'sharesLine'
  | 'repeated'
  | 'notFollowed'
  | 'headsControl'
  | 'tightAbove'
  | 'shortFollower'
  | 'labelSeries';

/** The feature vector of section 5.3, step 3. Distances are CSS pixels. */
export interface HeadingFeatures {
  sizeRatio: number;
  weight: number;
  bodyWeight: number;
  colorDiffers: boolean;
  familyDiffers: boolean;
  transform: string;
  italic: boolean;
  words: number;
  chars: number;
  lines: number;
  /** Last character when it is punctuation, else empty. */
  endsWith: string;
  /** No other text just before it on its first line. From boxes, not from `display`. */
  aloneOnLine: boolean;
  /** Distance to the block stacked above it; null when there is none. */
  spaceAbove: number | null;
  /** Distance to the block that follows, when that block is under it; null otherwise. */
  spaceBelow: number | null;
  /** The block that follows is under it and has the size and weight of body text. */
  followedByBody: boolean;
  /** Its left edge and that of the block that follows are aligned. */
  leftAligned: boolean;
  /** Level of a real heading of the page that has exactly its style; null when there is none. */
  matchesHeadingLevel: number | null;
}

export interface HeadingCandidate {
  /** Index of the block in `HeadingSurvey.blocks`. */
  block: number;
  /** Id of the finding the check reports for this candidate (`Finding.id`). */
  findingId: string;
  rule: typeof UNMARKED_HEADING_RULE | typeof HEADING_CANDIDATE_RULE;
  selector: string;
  frame: string;
  /** The text block itself, page coordinates: the part of the capture to outline. */
  box: Box;
  /** `strong`: nothing speaks against it. */
  strength: 'strong' | 'weak';
  /**
   * What deterministic code reports without a model: `likely` for a strong candidate, else `info`.
   * Also `info` for a strong candidate when the accessibility tree could not be read or the body
   * style rests on too little text. Never anything else.
   */
  status: 'likely' | 'info';
  prominence: Prominence[];
  /** Empty for a strong candidate. */
  reasons: HeadingReason[];
  features: HeadingFeatures;
  text: string;
  /**
   * Key in `Snapshot.screenshots.clips`; the clip shows the block with what is above and below it.
   * Null when the block could not be captured, which happens to candidates of any status and with
   * `adjudicate` true: fixed content lay over it (`covered`), it is in a transformed frame, off
   * the viewport, or gone. Whoever judges candidates has to do without a picture then (the
   * `context` is always there), or leave the candidate as it is.
   */
  crop: string | null;
  /** The text of the block inside that capture, CSS pixels from its top-left corner; null when it is not known. */
  cropTarget: Box | null;
  /** No capture because other content (a banner, a dialog) lay over the block. */
  covered: boolean;
  /**
   * Whether a model's judgement could change the status: true for strong candidates and for weak
   * ones held back only by reasons that are a matter of judgement (a link, a colon, what
   * follows, a short title that opens with a number). False when the reason is structural (a
   * label, a price, hidden from assistive technology) or when the accessibility tree could not
   * be read. It says nothing about the capture: `crop` can be null when this is true.
   */
  adjudicate: boolean;
  /**
   * Compact context for a model: text, style, what surrounds the block. Page text is untrusted
   * data, and it is text of the page under test: it leaves the machine only if it is sent to a
   * model, which only happens when a provider is configured.
   */
  context: { [key: string]: JsonValue };
}

export interface LevelInversion {
  /** Index of a block of the reported heading in `HeadingSurvey.blocks`. */
  block: number;
  selector: string;
  frame: string;
  box: Box;
  level: number;
  size: number;
  text: string;
  /** The heading it contradicts. */
  other: { selector: string; level: number; size: number; text: string };
  /**
   * `above-smaller`: the heading is coded above a heading that precedes it and is visibly larger.
   * `below-larger`: the heading is coded under a heading and is visibly larger than it.
   */
  kind: 'above-smaller' | 'below-larger';
  sizeRatio: number;
  levelGap: number;
  extreme: boolean;
  status: 'advisory' | 'likely';
  crop: string | null;
}

export interface HeadingReport {
  baseline: BodyBaseline | null;
  /** Reported candidates: strong ones in document order, then weak ones in document order. */
  candidates: HeadingCandidate[];
  inversions: LevelInversion[];
  /** Headings the accessibility tree exposes that have visible text. */
  exposedHeadings: number;
  /** Candidates left out because of `maxCandidates`. */
  omitted: number;
  /** Contradictions between levels left out because of `maxInversions`. */
  omittedInversions: number;
  /** Exposed headings that do not read as a heading: `likely` ones first, then `advisory`, then `info`, each in document order. */
  nonHeadings: NonHeading[];
  /** Such headings left out because of `maxNonHeadings`. */
  omittedNonHeadings: number;
}

export const NOT_A_HEADING_RULE = 'headings/heading-not-a-heading';
/** Version of what a `NonHeading` is and of what its `context` holds; part of the key of cached verdicts. */
export const NON_HEADINGS_GENERATOR_VERSION = '2';

/**
 * What says that an exposed heading may not be one. Three kinds, which do not depend on each
 * other (`NON_HEADING_SIGNALS` says which signal is of which kind).
 * From the text:
 * - `severalSentences`: at least `runningTextMinSentences` sentences in at least
 *   `runningTextMinWords` words, and not only questions: running text.
 * - `long`: at least `longHeadingMinWords` words.
 * - `quotation`: it opens and closes with quotation marks, has at least `quotationMinWords`
 *   words and is not a link or a button.
 * - `numeric`: a number and nothing else: a price, a percentage, a figure, a date in digits
 *   (`isNumberOnlyText`).
 * From how it is rendered:
 * - `bodyStyle`: every part of it has the size, weight, family and colour of body text, without
 *   capitals or italics: nothing shows that it is a heading. Never said of a heading that is a
 *   link or a button: its style is that of the control.
 * From what follows it:
 * - `headsNothing`: no text and no other content stands between it and the next heading, which
 *   is of its level or above, has visible text and begins right under it on the page
 *   (`headsNothingMaxGapEm`); or nothing at all follows it on the page.
 * - `headingRun`: it heads nothing and is one of at least `headingRunMinLength` headings that
 *   follow each other that way.
 */
export type NonHeadingSignal = 'severalSentences' | 'long' | 'quotation' | 'numeric' | 'bodyStyle' | 'headsNothing' | 'headingRun';

/** What a signal measures: the text, how it is rendered, or where it stands. */
export type NonHeadingSignalKind = 'text' | 'rendering' | 'position';

/**
 * The kind of each signal, and whether it is strong: on its own a strong signal is worth a
 * finding (`advisory`), a weak one is not. `nonHeadingStatus` derives every status from this
 * table and from nothing else.
 */
export const NON_HEADING_SIGNALS: Readonly<Record<NonHeadingSignal, { kind: NonHeadingSignalKind; strong: boolean }>> = {
  severalSentences: { kind: 'text', strong: true },
  long: { kind: 'text', strong: true },
  quotation: { kind: 'text', strong: false },
  numeric: { kind: 'text', strong: false },
  bodyStyle: { kind: 'rendering', strong: false },
  headsNothing: { kind: 'position', strong: false },
  headingRun: { kind: 'position', strong: true },
};

/** A heading of the accessibility tree whose text does not read as a heading. */
export interface NonHeading {
  /** Index of the first block of the heading in `HeadingSurvey.blocks`. */
  block: number;
  /** Id of the finding the check reports for it (`Finding.id`). */
  findingId: string;
  /** The heading element. */
  selector: string;
  frame: string;
  /** The first block of its text, page coordinates. */
  box: Box;
  level: number;
  /** Its visible text, the blocks joined with a space; each block is cut to `maxTextChars`. */
  text: string;
  /**
   * Never `fail`. `likely` only when signals of two different kinds agree and one of them is
   * strong; `advisory` and `info` as `nonHeadingStatus` says. `advisory` at most for a heading
   * that is a link or a button, and `info` at most when the accessibility tree could not be read
   * in full.
   */
  status: 'likely' | 'advisory' | 'info';
  signals: NonHeadingSignal[];
  words: number;
  sentences: number;
  /** Style of most of its text. */
  style: TextStyle;
  /** All of its text is a link or a button, or the pointer shows it as something to click. */
  control: boolean;
  /**
   * Headings that follow each other with nothing between them, this one included: the ones that
   * head nothing, and the one that closes the run when it is of the level of the one before it.
   * 1 when it is in no run.
   */
  runLength: number;
  /** The text block after it, cut to `contextAfterMaxChars`; null when there is none. */
  followedBy: string | null;
  /** Level of the heading that follows it with nothing in between; null when what follows is no heading. */
  nextHeadingLevel: number | null;
  /** As `HeadingCandidate.crop`, `cropTarget` and `covered`. */
  crop: string | null;
  cropTarget: Box | null;
  covered: boolean;
  /**
   * Whether a model's judgement could change the status: false when the accessibility tree could
   * not be read, and for a finding that is `info`, which no verdict lowers and none may raise.
   */
  adjudicate: boolean;
  /**
   * Compact context for a model: what was read and measured, without what was concluded from it
   * (the signals are left out, so that the model is not led). Text of the page under test:
   * untrusted, and sent only when a provider is configured.
   */
  context: { [key: string]: JsonValue };
}

/** Reasons that no judgement would overturn. */
const STRUCTURAL: ReadonlySet<HeadingReason> = new Set<HeadingReason>([
  'ariaHidden',
  'numeric',
  'code',
  'label',
  'button',
  'tableHeader',
  'tableCell',
  'navigation',
]);
/** Reasons that come from where the block sits on the page: it heads nothing. */
const GEOMETRIC: ReadonlySet<HeadingReason> = new Set<HeadingReason>(['sharesLine', 'repeated', 'notFollowed', 'headsControl']);
/** Reasons that come from what the block heads, which is something, but little. */
const HEADS_LITTLE: ReadonlySet<HeadingReason> = new Set<HeadingReason>(['tightAbove', 'shortFollower', 'labelSeries']);

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const DIGIT = /\p{N}/gu;
const LETTER = /\p{L}/gu;
const CURRENCY_OR_PERCENT = /[\p{Sc}%‰]/u;
const STARTS_WITH_NUMBER = /^[^\p{L}\p{N}]*\p{N}/u;
const ENDS_WITH_PUNCTUATION = /\p{P}$/u;

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function styleSignature(style: TextStyle): string {
  return [style.family, round(style.size, 1), style.weight, style.color, style.transform].join('|');
}

function compare(a: string | number, b: string | number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Key with the largest total; ties go to the smaller key, so the result does not depend on order. */
function heaviest(weights: Map<string, number>): string | null {
  let best: string | null = null;
  let bestWeight = -1;
  for (const [key, weight] of weights) {
    if (weight > bestWeight || (weight === bestWeight && best !== null && key < best)) {
      best = key;
      bestWeight = weight;
    }
  }
  return best;
}

/** Text in these contexts is not body text: a marquee of links or a wall of buttons must not set the body style. */
const NOT_BODY: ReadonlySet<TextContext> = new Set<TextContext>(['ariaHidden', 'link', 'button', 'navigation', 'label', 'code']);

/**
 * Section 5.3, step 2: the most common font size and weight, weighted by character count, inside
 * main when main holds text. Headings, and text that is a control, a label, navigation, code or
 * hidden from assistive technology, are left out as long as other text remains.
 */
export function bodyBaseline(blocks: TextBlock[], config: Pick<HeadingsConfig, 'baselineMinChars' | 'baselineMainMinShare'>): BodyBaseline | null {
  const counted = blocks.filter((block) => block.chars > 0);
  const plain = counted.filter((block) => !block.heading && !block.contexts.some((context) => NOT_BODY.has(context)));
  const all = plain.length > 0 ? plain : counted;
  if (all.length === 0) return null;
  const key = (block: TextBlock): string => `${round(block.style.size, 1).toFixed(1).padStart(8, '0')}|${String(block.style.weight).padStart(4, '0')}`;
  const mostCommon = (pool: TextBlock[]): { winner: string; chars: number } => {
    const bySizeAndWeight = new Map<string, number>();
    for (const block of pool) bySizeAndWeight.set(key(block), (bySizeAndWeight.get(key(block)) ?? 0) + block.chars);
    const winner = heaviest(bySizeAndWeight)!;
    return { winner, chars: bySizeAndWeight.get(winner)! };
  };
  const total = (pool: TextBlock[]): number => pool.reduce((sum, block) => sum + block.chars, 0);
  // A few words inside main (a note, a date) do not say what body text looks like when the text
  // of the page is elsewhere: main decides only with enough text, and a fair share of the page's.
  const inMain = all.filter((block) => block.inMain);
  const mainDecides =
    inMain.length > 0 && mostCommon(inMain).chars >= config.baselineMinChars && total(inMain) >= config.baselineMainMinShare * total(all);
  const pool = mainDecides ? inMain : all;
  const { winner, chars } = mostCommon(pool);
  const same = pool.filter((block) => key(block) === winner);
  const families = new Map<string, number>();
  const colors = new Map<string, number>();
  for (const block of same) {
    families.set(block.style.family, (families.get(block.style.family) ?? 0) + block.chars);
    colors.set(block.style.color, (colors.get(block.style.color) ?? 0) + block.chars);
  }
  const first = same[0]!;
  return {
    size: round(first.style.size, 1),
    weight: first.style.weight,
    family: heaviest(families) ?? first.style.family,
    color: heaviest(colors) ?? first.style.color,
    from: mainDecides ? 'main' : 'page',
    chars,
    lowText: chars < config.baselineMinChars,
  };
}

function isLarger(style: TextStyle, baseline: BodyBaseline, config: HeadingsConfig): boolean {
  return style.size / baseline.size >= config.minSizeRatio;
}

function isBolder(style: TextStyle, baseline: BodyBaseline, config: HeadingsConfig): boolean {
  if (style.weight - baseline.weight < config.minWeightDelta) return false;
  const ratio = style.size / baseline.size;
  return ratio >= config.boldMinSizeRatio || (style.transform === 'uppercase' && ratio >= config.uppercaseBoldMinSizeRatio);
}

/** A price, a figure, a date: mostly digits, or with a currency or percent sign. No judgement would make it a heading. */
export function isNumericText(text: string, config: HeadingsConfig): boolean {
  const digits = text.match(DIGIT)?.length ?? 0;
  if (digits === 0) return false;
  const letters = text.match(LETTER)?.length ?? 0;
  return digits / (digits + letters) >= config.numericMinDigitShare || CURRENCY_OR_PERCENT.test(text);
}

/**
 * A number and a unit ("15 years", "3x faster"): short text that opens with a number and is not
 * numbered like a title. "2026 roadmap" and "3D rendering" read the same to code, so this is a
 * reason to hold the text back, not to rule it out.
 */
export function isStatisticText(text: string, words: number, config: HeadingsConfig): boolean {
  if (isNumericText(text, config)) return false;
  return STARTS_WITH_NUMBER.test(text) && words <= config.statisticMaxWords && !new RegExp(config.ordinalStartPattern, 'u').test(text);
}

function right(box: Box): number {
  return box.x + box.width;
}

function bottom(box: Box): number {
  return box.y + box.height;
}

function overlapsHorizontally(a: Box, b: Box, tolerance: number): boolean {
  return a.x < right(b) - tolerance && b.x < right(a) - tolerance;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

interface Scored {
  index: number;
  block: TextBlock;
  prominence: Prominence[];
  reasons: HeadingReason[];
  features: HeadingFeatures;
  follower: TextBlock | null;
  previous: TextBlock | null;
}

/**
 * Section 5.3, steps 2 to 6 and 8, on the blocks of a survey. Pure: the same survey and
 * configuration give the same report.
 */
export function headingReport(survey: HeadingSurvey, config: HeadingsConfig): HeadingReport {
  const { blocks } = survey;
  const baseline = bodyBaseline(blocks, config);
  const allInversions = levelInversions(blocks, config);
  const inversions = allInversions.slice(0, config.maxInversions);
  const omittedInversions = allInversions.length - inversions.length;
  const exposedHeadings = new Set(blocks.filter((block) => block.heading).map((block) => `${block.frame}\u0000${block.heading!.selector}`)).size;
  const allNonHeadings = nonHeadings(survey, baseline, config);
  const keptNonHeadings = allNonHeadings.slice(0, Math.max(0, config.maxNonHeadings));
  const notHeadings = { nonHeadings: keptNonHeadings, omittedNonHeadings: allNonHeadings.length - keptNonHeadings.length };
  if (!baseline) return { baseline, candidates: [], inversions, exposedHeadings, omitted: 0, omittedInversions, ...notHeadings };

  const tolerance = config.boxToleranceCssPx;
  const signatures = blocks.map((block) => styleSignature(block.style));
  const baselineProminent = (style: TextStyle): boolean => isLarger(style, baseline, config) || isBolder(style, baseline, config);

  // Step 5. The styles of real headings, kept only when they set a heading apart from body
  // text: a heading styled as body text says nothing about the other text that has that style.
  const headingStyles = new Map<string, number>();
  blocks.forEach((block, index) => {
    if (!block.heading) return;
    const stands = baselineProminent(block.style) || block.style.transform === 'uppercase';
    if (!stands) return;
    const signature = signatures[index]!;
    headingStyles.set(signature, Math.min(headingStyles.get(signature) ?? block.heading.level, block.heading.level));
  });

  // What a block is whatever surrounds it: its contexts, a number, a quotation.
  const sentenceEnd = new RegExp(config.sentenceEndPattern, 'u');
  const leadInEnd = new RegExp(config.leadInEndPattern, 'u');
  const quoteStart = new RegExp(config.quoteStartPattern, 'u');
  const intrinsic: HeadingReason[][] = blocks.map((block) => {
    const reasons: HeadingReason[] = [...block.contexts];
    if (isNumericText(block.text, config)) reasons.push('numeric');
    else if (isStatisticText(block.text, block.words, config)) reasons.push('statistic');
    if (quoteStart.test(block.text) && !reasons.includes('quote')) reasons.push('quotation');
    if (block.sameColourAsBackground === true) reasons.push('sameColourAsBackground');
    return reasons;
  });
  const numberLike = (index: number): boolean => intrinsic[index]!.includes('numeric') || intrinsic[index]!.includes('statistic');
  const bySignature = new Map<string, number[]>();
  signatures.forEach((signature, index) => {
    if (blocks[index]!.heading) return;
    const members = bySignature.get(signature);
    if (members) members.push(index);
    else bySignature.set(signature, [index]);
  });
  // What a block takes from its look-alikes. Only that they are numbers for good (a short title
  // that opens with a number does not make its look-alikes numbers): on real pages the style
  // of a table header, a label or a term is often plain bold text, and titles that are links
  // share their style with titles that are not, so those say nothing about other text of that
  // style.
  const peersNumeric: boolean[] = blocks.map((block, index) => {
    if (block.heading || numberLike(index)) return false;
    const peers = (bySignature.get(signatures[index]!) ?? []).filter((peer) => peer !== index);
    if (peers.length < config.peerDemotionMinPeers) return false;
    return peers.filter((peer) => intrinsic[peer]!.includes('numeric')).length / peers.length >= config.peerDemotionMinShare;
  });
  const isNumber = (index: number): boolean => numberLike(index) || peersNumeric[index]!;
  // The same text in the same style, anywhere on the page.
  const textKey = (index: number): string => `${signatures[index]!}\u0000${blocks[index]!.text.trim()}`;
  const textCounts = new Map<string, number>();
  blocks.forEach((block, index) => {
    if (!block.heading) textCounts.set(textKey(index), (textCounts.get(textKey(index)) ?? 0) + 1);
  });
  const inFrame = (index: number, frame: string): TextBlock | null => (index >= 0 && index < blocks.length && blocks[index]!.frame === frame ? blocks[index]! : null);
  /** The block after this one has its style and is stacked under it: the first of several items. */
  const startsSeries = (index: number): boolean => {
    const first = blocks[index]!;
    const after = inFrame(index + 1, first.frame);
    return (
      after !== null &&
      signatures[index + 1] === signatures[index] &&
      after.firstLine.y >= bottom(first.lastLine) - tolerance &&
      overlapsHorizontally(after.box, first.box, tolerance)
    );
  };

  const scored: Scored[] = [];
  blocks.forEach((block, index) => {
    // Step 4: what the accessibility tree exposes as a heading is not a candidate.
    if (block.heading) return;
    const signature = signatures[index]!;
    const matched = headingStyles.get(signature) ?? null;
    const prominence: Prominence[] = [];
    if (isLarger(block.style, baseline, config)) prominence.push('larger');
    if (isBolder(block.style, baseline, config)) prominence.push('bolder');
    if (matched !== null) prominence.push('matchesHeadingStyle');
    if (prominence.length === 0) return;
    if (!LETTER_OR_DIGIT.test(block.text)) return;
    if (block.words > config.maxWords || block.chars > config.maxChars || block.lines > config.maxLines) return;
    if (block.styleShare < config.uniformStyleMinShare) return;
    const boldOnly = prominence.length === 1 && prominence[0] === 'bolder';
    if (boldOnly && block.words > config.maxBoldOnlyWords) return;

    const previous = inFrame(index - 1, block.frame);
    // A number set large under a title is a figure, not what the title heads: look past it.
    let next = index + 1;
    while (inFrame(next, block.frame) && isNumber(next) && !isNumber(index)) next++;
    // So is a button or a link beside it on its line, in another style and no larger: "View all"
    // at the other end of the row of a title.
    const besideControl = (other: TextBlock, at: number): boolean => {
      if (!other.contexts.includes('link') && !other.contexts.includes('button')) return false;
      if (signatures[at] === signature || other.style.size > block.style.size + config.sizeToleranceCssPx) return false;
      const a = block.lastLine;
      const b = other.firstLine;
      const overlap = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
      return overlap >= config.sameLineMinOverlap * Math.min(a.height, b.height) && !overlapsHorizontally(other.box, block.box, tolerance);
    };
    for (let passed = 0; passed < config.besideControlsMax; passed++) {
      const other = inFrame(next, block.frame);
      if (!other || !besideControl(other, next)) break;
      next++;
    }
    const follower = inFrame(next, block.frame);
    const direct = inFrame(index + 1, block.frame);

    const reasons: HeadingReason[] = [...intrinsic[index]!];
    if (peersNumeric[index]) reasons.push('peersNumeric');
    if ((textCounts.get(textKey(index)) ?? 0) >= config.repeatedTextMinCount) reasons.push('repeatedText');
    // Large italics of normal weight are how a pull quote is set, with or without quotation marks.
    if (block.style.italic && prominence.length === 1 && prominence[0] === 'larger') reasons.push('italic');
    const text = block.text.trim();
    if (sentenceEnd.test(text)) reasons.push('sentence');
    if (leadInEnd.test(text)) reasons.push('colon');
    if (block.breaks >= config.maxBreaks) reasons.push('lineBreaks');
    if (block.tag === 'li') reasons.push('listItem');

    // Alone on its line, from boxes: the block before it ends on the line this one starts on,
    // right next to it. Further away, or in another region, it is another column.
    let sharesLine = false;
    if (previous && previous.region === block.region) {
      const a = previous.lastLine;
      const b = block.firstLine;
      const overlap = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
      const gap = Math.max(b.x - right(a), a.x - right(b));
      sharesLine =
        overlap >= config.sameLineMinOverlap * Math.min(a.height, b.height) &&
        gap >= -tolerance &&
        gap <= config.sameLineMaxGapEm * block.style.size;
    }
    if (sharesLine) reasons.push('sharesLine');

    const sameStyle = (other: TextBlock | null): boolean => other !== null && styleSignature(other.style) === signature;
    if (sameStyle(previous) || sameStyle(direct)) reasons.push('repeated');

    const under = follower !== null && follower.firstLine.y >= bottom(block.lastLine) - tolerance && overlapsHorizontally(follower.box, block.box, tolerance);
    // A line above text that is itself set as a title, as large or larger: a category or a kicker
    // over a title, not a heading over content.
    const outranked =
      follower !== null &&
      baselineProminent(follower.style) &&
      (follower.style.size > block.style.size + config.sizeToleranceCssPx ||
        (follower.style.size >= block.style.size - config.sizeToleranceCssPx && follower.style.weight >= block.style.weight));
    if (!under || outranked) reasons.push('notFollowed');
    else if ((follower.contexts.includes('button') || follower.contexts.includes('link')) && !follower.inListItem && !baselineProminent(follower.style)) {
      // A plain button or link under the block is a call to action under a tagline. A control
      // set as a title (the link of a teaser) is content, and so are controls of one style
      // stacked under the block (questions that open, a column of links).
      const after = inFrame(next + 1, block.frame);
      const series = after !== null && (after.contexts.includes('button') || after.contexts.includes('link')) && startsSeries(next);
      if (!series) reasons.push('headsControl');
    }

    // Text that is only bolder than body text is how labels, names and notices are set as well as
    // titles. What tells them apart is what follows: a title heads content, a label heads a value.
    // A value is one short line. A line that reads as a full sentence is content, as a paragraph
    // of several lines is (a title over a one-line paragraph is common), unless the candidate is
    // smaller than body text: small print over one line heads nothing, whatever the line says.
    const smallPrint = block.style.size < baseline.size - config.sizeToleranceCssPx;
    const value = (other: TextBlock): boolean =>
      !baselineProminent(other.style) &&
      other.lines <= config.shortFollowerMaxLines &&
      other.words <= config.shortFollowerMaxWords &&
      (smallPrint || !config.sentenceFollowerIsContent || !sentenceEnd.test(other.text.trim()));
    if (boldOnly && under && !outranked && !baselineProminent(follower.style) && !startsSeries(next) && (follower.chars <= block.chars || value(follower))) {
      reasons.push('shortFollower');
    }
    // Label, value, label again, in either direction: keys and values, names and remarks.
    if (boldOnly) {
      const twoAfter = inFrame(index + 2, block.frame);
      const twoBefore = inFrame(index - 2, block.frame);
      const forward = twoAfter !== null && signatures[index + 2] === signature;
      const backward = previous !== null && value(previous) && twoBefore !== null && signatures[index - 2] === signature;
      if (direct !== null && value(direct) && (forward || backward)) reasons.push('labelSeries');
    }

    const stackedAbove =
      previous !== null && bottom(previous.lastLine) <= block.firstLine.y + tolerance && overlapsHorizontally(previous.box, block.box, tolerance);
    const spaceAbove = stackedAbove ? round(Math.max(0, block.box.y - bottom(previous.box))) : null;
    // To whatever comes next under it, a figure included.
    const below = direct !== null && direct.firstLine.y >= bottom(block.lastLine) - tolerance && overlapsHorizontally(direct.box, block.box, tolerance) ? direct : under ? follower : null;
    const spaceBelow = below ? round(Math.max(0, below.box.y - bottom(block.box))) : null;
    if (boldOnly && spaceAbove !== null && spaceBelow !== null && spaceAbove + tolerance < spaceBelow) reasons.push('tightAbove');

    const sizeTolerance = config.sizeToleranceCssPx;
    const features: HeadingFeatures = {
      sizeRatio: round(block.style.size / baseline.size),
      weight: block.style.weight,
      bodyWeight: baseline.weight,
      colorDiffers: block.style.color !== baseline.color,
      familyDiffers: block.style.family !== baseline.family,
      transform: block.style.transform,
      italic: block.style.italic,
      words: block.words,
      chars: block.chars,
      lines: block.lines,
      endsWith: ENDS_WITH_PUNCTUATION.test(text) ? text.slice(-1) : '',
      aloneOnLine: !sharesLine,
      spaceAbove,
      spaceBelow,
      followedByBody:
        under && Math.abs(follower.style.size - baseline.size) <= sizeTolerance && follower.style.weight === baseline.weight,
      leftAligned: under && Math.abs(follower.box.x - block.box.x) <= tolerance,
      matchesHeadingLevel: matched,
    };
    scored.push({ index, block, prominence, reasons: [...new Set(reasons)], features, follower, previous });
  });

  // Not reported at all, to keep the inventory worth reading: text that is not alone on its line,
  // text that both repeats its neighbour and heads nothing (a row of peers), and text that is
  // something else by its markup or content and also heads nothing by its position.
  const kept = scored.filter(({ reasons }) => {
    const geometric = reasons.filter((reason) => GEOMETRIC.has(reason));
    if (geometric.includes('sharesLine') || geometric.length > 1) return false;
    return geometric.length === 0 || reasons.every((reason) => GEOMETRIC.has(reason) || HEADS_LITTLE.has(reason));
  });
  // Two blocks can have the same lowest common element (bare text around a child block): the
  // first one stands for it, so that finding ids stay unique.
  const seen = new Set<string>();
  const unique = kept.filter(({ block }) => {
    const key = `${block.frame}\u0000${block.selector}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const strong = unique.filter(({ reasons }) => reasons.length === 0);
  const weak = unique.filter(({ reasons }) => reasons.length > 0);
  const ordered = [...strong, ...weak].slice(0, config.maxCandidates);

  const candidates = ordered.map(({ index, block, prominence, reasons, features, follower, previous }): HeadingCandidate => {
    const isStrong = reasons.length === 0;
    // Without the accessibility tree, nothing says that the block is not a heading already; with
    // too little text to go by, nothing says that it stands out from body text.
    const status = isStrong && survey.axComplete && !baseline.lowText ? 'likely' : 'info';
    const rule = status === 'likely' ? UNMARKED_HEADING_RULE : HEADING_CANDIDATE_RULE;
    return {
      block: index,
      // Not from `rule`, which follows the status: see CANDIDATE_FINGERPRINT_RULE.
      findingId: fingerprint({ rule: CANDIDATE_FINGERPRINT_RULE, wcag: HEADINGS_SC, frame: block.frame, selector: block.selector }),
      rule,
      selector: block.selector,
      frame: block.frame,
      box: block.box,
      strength: isStrong ? 'strong' : 'weak',
      status,
      prominence,
      reasons,
      features,
      text: block.text,
      crop: block.crop,
      cropTarget: block.crop && block.cropTarget ? { ...block.cropTarget } : null,
      covered: block.covered === true,
      adjudicate: survey.axComplete && !reasons.some((reason) => STRUCTURAL.has(reason)),
      context: {
        text: block.text,
        tag: block.tag,
        style: { ...block.style },
        bodyStyle: { size: baseline.size, weight: baseline.weight, family: baseline.family, color: baseline.color },
        features: { ...features },
        prominence: [...prominence],
        reasons: [...reasons],
        contexts: [...block.contexts],
        region: block.region,
        // Blocks of the page with this text in this style, itself included: one judgement can serve them all.
        sameTextAndStyle: textCounts.get(textKey(index)) ?? 1,
        textBefore: previous ? cut(previous.text, config.contextBeforeMaxChars) : null,
        textAfter: follower ? cut(follower.text, config.contextAfterMaxChars) : null,
      },
    };
  });
  return { baseline, candidates, inversions, exposedHeadings, omitted: unique.length - ordered.length, omittedInversions, ...notHeadings };
}

type WordsConfig = Pick<HeadingsConfig, 'unspacedScriptPattern' | 'unspacedCharsPerWord'>;

/**
 * Words of a text: runs between white space that hold a letter or a digit, so that the `?`, `!`,
 * `:` and guillemets French sets apart with a space are not words. Text of a script written
 * without spaces is cut as `countWords` cuts it.
 */
export function wordsOf(text: string, config: WordsConfig): number {
  const runs = text.split(/\s+/).filter((run) => LETTER_OR_DIGIT.test(run));
  return runs.length === 0 ? 0 : countWords(runs.join(' '), config);
}

/**
 * Sentences of a text: its parts between the places where a sentence ends and another begins
 * (`sentenceBreakPattern`), a part of fewer than `sentenceMinWords` words being counted with the
 * part after it, or with the one before it when it is the last. A title is one sentence whatever
 * it ends with. A pattern that does not compile finds no such place.
 */
export function countSentences(text: string, config: WordsConfig & Pick<HeadingsConfig, 'sentenceBreakPattern' | 'sentenceMinWords'>): number {
  let parts: string[];
  try {
    parts = text.split(new RegExp(config.sentenceBreakPattern, 'u'));
  } catch {
    parts = [text];
  }
  let sentences = 0;
  let carried = 0;
  for (const part of parts) {
    // A capturing group in a configured pattern puts what it matched, or undefined, among the parts.
    if (typeof part !== 'string') continue;
    const words = carried + wordsOf(part, config);
    if (words >= config.sentenceMinWords) {
      sentences++;
      carried = 0;
    } else carried = words;
  }
  return sentences === 0 && carried > 0 ? 1 : sentences;
}

/** The parts of a text between the places where a sentence ends and another begins; the whole text when the pattern does not compile. */
function sentenceParts(text: string, config: Pick<HeadingsConfig, 'sentenceBreakPattern'>): string[] {
  try {
    // A capturing group in a configured pattern puts what it matched, or undefined, among the parts.
    return text.split(new RegExp(config.sentenceBreakPattern, 'u')).filter((part): part is string => typeof part === 'string');
  } catch {
    return [text];
  }
}

/**
 * Whether a text is made only of questions: each of its parts that holds a word ends as
 * `questionEndPattern` says. The heading of an entry in a list of questions often asks two or
 * three, and is a heading. False when the pattern is empty or does not compile.
 */
export function onlyQuestions(text: string, config: WordsConfig & Pick<HeadingsConfig, 'sentenceBreakPattern' | 'questionEndPattern'>): boolean {
  if (!config.questionEndPattern) return false;
  let question: RegExp;
  try {
    question = new RegExp(config.questionEndPattern, 'u');
  } catch {
    return false;
  }
  const parts = sentenceParts(text, config).filter((part) => wordsOf(part, config) > 0);
  return parts.length > 0 && parts.every((part) => question.test(part.trim()));
}

/**
 * A number and nothing else: a price, a percentage, a figure, a date in digits. It holds a digit,
 * has at most `numberOnlyMaxWords` words, and at least `numberOnlyMinShare` of its characters,
 * white space apart, are not letters. A title that holds a number, a price or a percentage
 * ("Save 20% on your first order", "Livraison offerte dès 50 € d'achat") is not.
 */
export function isNumberOnlyText(text: string, config: WordsConfig & Pick<HeadingsConfig, 'numberOnlyMaxWords' | 'numberOnlyMinShare'>): boolean {
  if ((text.match(DIGIT)?.length ?? 0) === 0) return false;
  if (wordsOf(text, config) > config.numberOnlyMaxWords) return false;
  const shown = [...text.replace(/\s/gu, '')].length;
  const letters = text.match(LETTER)?.length ?? 0;
  return shown > 0 && (shown - letters) / shown >= config.numberOnlyMinShare;
}

const STATUS_ORDER = { likely: 0, advisory: 1, info: 2 } as const;

/**
 * The status the signals of a heading give, or null when they are not worth a finding. Never `fail`.
 *
 * Derived from `NON_HEADING_SIGNALS`, which gives each signal a kind (what the text is, how it
 * is rendered, what follows it) and says whether it is strong. Two signals of one kind never
 * confirm each other, whatever they are: they are one measurement taken twice.
 * - `likely`: a strong signal, and signals of at least two different kinds.
 * - `advisory`: a strong signal and one kind only; or no strong signal, and a heading that heads
 *   nothing with a weak signal of another kind (set as body text, a number, a quotation).
 * - `info`: set as body text, and nothing else that counts.
 * - Not reported: everything else. A heading that only heads nothing (the title of a card, the
 *   last title of a column), a number that heads something (a year over its events), a
 *   quotation that heads something.
 *
 * A quotation takes their strength from the measures of running text: the sentences and the
 * length are those of the person quoted, and the quoted words of someone are the usual title of
 * an interview or of a testimony. A quoted title over content is therefore not reported, however
 * long it is; one that heads nothing is `advisory`.
 */
export function nonHeadingStatus(signals: readonly NonHeadingSignal[]): 'likely' | 'advisory' | 'info' | null {
  const kinds = new Set(signals.map((signal) => NON_HEADING_SIGNALS[signal].kind));
  const quoted = signals.includes('quotation');
  const strong = signals.some((signal) => NON_HEADING_SIGNALS[signal].strong && !(quoted && NON_HEADING_SIGNALS[signal].kind === 'text'));
  if (strong) return kinds.size >= 2 ? 'likely' : 'advisory';
  if (kinds.size >= 2 && kinds.has('position')) return 'advisory';
  if (kinds.has('rendering')) return 'info';
  return null;
}

function union(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  return { x, y, width: Math.max(...boxes.map(right)) - x, height: Math.max(...boxes.map(bottom)) - y };
}

/**
 * Headings the accessibility tree exposes whose text does not read as a heading (1.3.1, "heading
 * markup on text that is not a heading"). All of them, by status and then in document order;
 * `headingReport` keeps `maxNonHeadings`. Pure.
 *
 * A heading whose text is all a link or a button, or that the pointer shows as clickable, is
 * never said to head nothing nor to be set as body text: it names what it opens (a teaser, the
 * question of an accordion) and has the style of the control. It is `advisory` at most.
 * Headings hidden from assistive technology are not exposed and are not looked at. Headings
 * without visible text (a picture, a visually hidden title) are never reported; where the survey
 * lists them (`HeadingSurvey.headings`) they are headings like the others for what follows: the
 * heading before one of them is not said to head nothing, since what such a heading holds, and
 * whether it reads as a subsection, cannot be told from text.
 */
export function nonHeadings(survey: HeadingSurvey, baseline: BodyBaseline | null, config: HeadingsConfig): NonHeading[] {
  const { blocks } = survey;
  interface Exposed {
    /** -1 for a heading without visible text. */
    first: number;
    last: number;
    members: number[];
    level: number;
    selector: string;
    frame: string;
    /** Box of the heading element, where the survey gives it. */
    box: Box | null;
    /** Where it begins among the blocks; for a heading without text, what was counted when it began. */
    blocksBefore: number;
    contentBefore: number | undefined;
    hiddenBefore: number | undefined;
  }
  const keyOf = (frame: string, selector: string): string => `${frame}\u0000${selector}`;
  const known = new Map<string, Exposed>();
  const withText: Exposed[] = [];
  blocks.forEach((block, index) => {
    if (!block.heading) return;
    const key = keyOf(block.frame, block.heading.selector);
    const existing = known.get(key);
    if (existing) {
      existing.members.push(index);
      existing.last = index;
      return;
    }
    const heading: Exposed = {
      first: index,
      last: index,
      members: [index],
      level: block.heading.level,
      selector: block.heading.selector,
      frame: block.frame,
      box: null,
      blocksBefore: index,
      contentBefore: block.contentBefore,
      hiddenBefore: block.hiddenBefore,
    };
    known.set(key, heading);
    withText.push(heading);
  });
  if (withText.length === 0) return [];

  // The headings in document order, the ones without visible text in their place among the others.
  const textless: Exposed[] = [];
  for (const listed of survey.headings ?? []) {
    const existing = known.get(keyOf(listed.frame, listed.selector));
    if (existing) {
      existing.box = listed.box;
      continue;
    }
    textless.push({
      first: -1,
      last: -1,
      members: [],
      level: listed.level,
      selector: listed.selector,
      frame: listed.frame,
      box: listed.box,
      blocksBefore: listed.blocksBefore,
      contentBefore: listed.contentBefore,
      hiddenBefore: listed.hiddenBefore,
    });
  }
  const exposed: Exposed[] = [];
  let pending = 0;
  for (const heading of withText) {
    while (pending < textless.length && textless[pending]!.blocksBefore <= heading.first) exposed.push(textless[pending++]!);
    exposed.push(heading);
  }
  exposed.push(...textless.slice(pending));

  const tolerance = config.boxToleranceCssPx;
  const boxOf = (heading: Exposed): Box | null => heading.box ?? union(heading.members.map((index) => blocks[index]!.box));
  const mainBlock = (heading: Exposed): TextBlock => heading.members.map((index) => blocks[index]!).reduce((best, block) => (block.chars > best.chars ? block : best));
  /**
   * On the page: the second begins under the first, in its column, about one line away at most.
   * Headings side by side, and headings with room between them, are not next to each other,
   * whatever the document holds between them.
   */
  const stackedClose = (a: Exposed, b: Exposed): boolean => {
    const above = boxOf(a);
    const below = boxOf(b);
    if (!above || !below) return false;
    const gap = below.y - bottom(above);
    return gap >= -tolerance && gap <= config.headsNothingMaxGapEm * mainBlock(a).style.size && overlapsHorizontally(above, below, tolerance);
  };
  // Nothing between two headings: both have visible text, the second starts at the block after
  // the first, in the same document, nothing else was counted on the way, and the page shows
  // them one right under the other. Without the count, nothing is concluded.
  const nothingBetween = (a: Exposed, b: Exposed): boolean => {
    if (a.members.length === 0 || b.members.length === 0) return false;
    if (b.first !== a.last + 1 || a.frame !== b.frame) return false;
    const from = blocks[a.last]!.contentBefore;
    const to = blocks[b.first]!.contentBefore;
    return from !== undefined && to !== undefined && to === from && stackedClose(a, b);
  };
  const linked = exposed.map((heading, position): boolean => {
    const next = exposed[position + 1];
    return next !== undefined && next.level <= heading.level && nothingBetween(heading, next);
  });
  const endsPage = (heading: Exposed, position: number): boolean => {
    const from = blocks[heading.last]!.contentBefore;
    return (
      position === exposed.length - 1 &&
      heading.last === blocks.length - 1 &&
      survey.total === blocks.length &&
      from !== undefined &&
      survey.otherContent !== undefined &&
      survey.otherContent === from
    );
  };
  // A run: the headings that head nothing, one after the other, and the heading that closes
  // them when it is of the level of the last of them. A heading of a higher level that follows
  // is the title of the next section, and no member.
  const runLength = exposed.map(() => 1);
  for (let start = 0; start < exposed.length; ) {
    let end = start;
    while (linked[end]) end++;
    const closes = end > start && exposed[end] !== undefined && exposed[end]!.level === exposed[end - 1]!.level;
    const length = end - start + (closes ? 1 : 0);
    for (let position = start; position < end; position++) runLength[position] = length;
    if (closes) runLength[end] = length;
    start = end + 1;
  }

  const sizeTolerance = config.sizeToleranceCssPx;
  const plain = (style: TextStyle): boolean =>
    baseline !== null &&
    !baseline.lowText &&
    style.size <= baseline.size + sizeTolerance &&
    style.weight - baseline.weight < config.bodyStyleMaxWeightDelta &&
    style.transform !== 'uppercase' &&
    !style.italic &&
    style.color === baseline.color &&
    style.family === baseline.family;
  let quoteStart: RegExp | null = null;
  let quoteEnd: RegExp | null = null;
  try {
    quoteStart = new RegExp(config.quoteStartPattern, 'u');
    quoteEnd = new RegExp(config.quoteEndPattern, 'u');
  } catch {
    // A pattern that does not compile finds no quotation.
  }

  const found: NonHeading[] = [];
  exposed.forEach((heading, position) => {
    // Without visible text there is nothing to read: never reported.
    if (heading.members.length === 0) return;
    const members = heading.members.map((index) => blocks[index]!);
    // Not exposed where it is hidden from assistive technology, whatever marked it.
    if (members.some((block) => block.contexts.includes('ariaHidden'))) return;
    const first = members[0]!;
    const text = members.map((block) => block.text).join(' ').trim();
    if (!LETTER_OR_DIGIT.test(text)) return;
    const main = mainBlock(heading);
    const wasCut = members.some((block) => block.text.length >= config.maxTextChars);
    const counted = wordsOf(text, config);
    // The text of a block is cut to `maxTextChars`; its count of words is that of all of it.
    const words = wasCut ? Math.max(counted, members.reduce((sum, block) => sum + block.words, 0)) : counted;
    const sentences = countSentences(text, config);
    const control = members.every((block) => block.contexts.includes('link') || block.contexts.includes('button') || block.clickable === true);
    const next = exposed[position + 1];
    const headsNothing = !control && (linked[position]! || endsPage(heading, position));

    const signals: NonHeadingSignal[] = [];
    const long = words >= config.longHeadingMinWords;
    // The header of an accordion and the title of a teaser often hold a question in several
    // parts or a title and its deck: on a heading that is a control, sentences count only with length.
    if (sentences >= config.runningTextMinSentences && words >= config.runningTextMinWords && !onlyQuestions(text, config) && (!control || long)) signals.push('severalSentences');
    if (long) signals.push('long');
    // The quoted words of someone are the usual title of an opinion piece or an interview: on a
    // title that is a link, quotation marks say nothing.
    if (!control && quoteStart !== null && quoteEnd !== null && quoteStart.test(text) && quoteEnd.test(text) && words >= config.quotationMinWords) signals.push('quotation');
    if (isNumberOnlyText(text, config)) signals.push('numeric');
    // The text of a button or of a link is set as the control is, often as body text: that says
    // nothing about the heading that wraps it.
    if (!control && members.every((block) => plain(block.style))) signals.push('bodyStyle');
    if (headsNothing) signals.push('headsNothing');
    if (headsNothing && runLength[position]! >= config.headingRunMinLength) signals.push('headingRun');
    const derived = nonHeadingStatus(signals);
    if (derived === null) return;
    // A heading that is a control is left with the signals of its text, which are of one kind:
    // `advisory` at most. Said again here, so that it holds whatever the table of signals becomes.
    const measured = control && derived === 'likely' ? 'advisory' : derived;
    // Without the whole accessibility tree, which text is a heading and what its level is are not
    // known for certain: recorded, and nothing more.
    const status = survey.axComplete ? measured : 'info';

    const before = blocks[heading.first - 1]?.frame === heading.frame ? blocks[heading.first - 1]! : null;
    const after = blocks[heading.last + 1]?.frame === heading.frame ? blocks[heading.last + 1]! : null;
    const followedBy = after ? cut(after.text, config.contextAfterMaxChars) : null;
    const nextHeadingLevel = linked[position]! && next ? next.level : null;

    // For a model: what stands between this heading and the next one, or the end of the page.
    // Said as it was read, whatever was concluded from it. Null where it is not known.
    const here = blocks[heading.last]!;
    const sameDocument = next === undefined || next.frame === heading.frame;
    const untilBlocks = next === undefined ? survey.total : next.blocksBefore;
    const untilContent = next === undefined ? survey.otherContent : next.contentBefore;
    const untilHidden = next === undefined ? survey.hiddenContent : next.hiddenBefore;
    const textBetween = untilBlocks > heading.last + 1;
    const otherBetween = here.contentBefore !== undefined && untilContent !== undefined ? untilContent > here.contentBefore : null;
    const hiddenBetween = here.hiddenBefore !== undefined && untilHidden !== undefined ? untilHidden > here.hiddenBefore : null;
    found.push({
      block: heading.first,
      findingId: fingerprint({ rule: NOT_A_HEADING_RULE, wcag: HEADINGS_SC, frame: heading.frame, selector: heading.selector }),
      selector: heading.selector,
      frame: heading.frame,
      box: first.box,
      level: heading.level,
      text,
      status,
      signals,
      words,
      sentences,
      style: { ...main.style },
      control,
      runLength: runLength[position]!,
      followedBy,
      nextHeadingLevel,
      crop: first.crop,
      cropTarget: first.crop && first.cropTarget ? { ...first.cropTarget } : null,
      covered: first.covered === true,
      adjudicate: survey.axComplete && status !== 'info',
      context: {
        text,
        level: heading.level,
        tag: first.tag,
        style: { ...main.style },
        bodyStyle: baseline ? { size: baseline.size, weight: baseline.weight, family: baseline.family, color: baseline.color } : null,
        words,
        sentences,
        headingsInRun: runLength[position]!,
        contexts: [...first.contexts],
        // All of it is a link or a button, or is clicked: it may open what it names.
        control,
        region: first.region,
        textBefore: before ? cut(before.text, config.contextBeforeMaxChars) : null,
        textAfter: followedBy,
        // The next heading of the document, whatever stands before it; null when there is none.
        nextHeadingLevel: next && sameDocument ? next.level : null,
        // Whether anything stands between this heading and the next one (or the end of the page):
        // visible text, or other content. And whether some of it is in the page without showing,
        // as the closed panel of an accordion is.
        contentBetween: !sameDocument ? null : textBetween ? true : otherBetween,
        hiddenContentBetween: sameDocument ? hiddenBetween : null,
      },
    });
  });
  return found.sort((a, b) => compare(STATUS_ORDER[a.status], STATUS_ORDER[b.status]) || compare(a.block, b.block));
}

/** The candidates of a survey: what the adjudicator layer works from. */
export function headingCandidates(survey: HeadingSurvey, config: HeadingsConfig): HeadingCandidate[] {
  return headingReport(survey, config).candidates;
}

interface ExposedHeading {
  block: number;
  selector: string;
  frame: string;
  region: string;
  level: number;
  size: number;
  text: string;
  box: Box;
  crop: string | null;
}

/**
 * Section 5.3, step 8. The visual rank of a heading is its font size. Inside one region and in
 * document order, two things are contradictions:
 * - a heading coded above a preceding heading that is visibly larger than it, with no heading
 *   of its own level or above in between;
 * - a heading visibly larger than the heading it is coded under.
 * Skipped levels, several h1 and equal sizes are not.
 *
 * One oversized heading is one contradiction: it is reported as larger than the heading it is
 * coded under, and the headings after it are not measured against it, or each well-ordered
 * heading that follows a promotional block would be reported as smaller than that block.
 *
 * All of them, in document order; `headingReport` keeps `maxInversions`. The status is
 * `advisory` or `likely` whatever the configuration says.
 */
export function levelInversions(blocks: TextBlock[], config: HeadingsConfig): LevelInversion[] {
  const byRegion = new Map<string, ExposedHeading[]>();
  const known = new Map<string, ExposedHeading>();
  const charsOf = new Map<string, number>();
  blocks.forEach((block, index) => {
    if (!block.heading) return;
    const key = `${block.frame}\u0000${block.heading.selector}`;
    const existing = known.get(key);
    if (existing) {
      // A heading of several blocks has the size of most of its text.
      if (block.chars > (charsOf.get(key) ?? 0)) {
        existing.size = block.style.size;
        charsOf.set(key, block.chars);
      }
      return;
    }
    const heading: ExposedHeading = {
      block: index,
      selector: block.heading.selector,
      frame: block.frame,
      region: `${block.frame}\u0000${block.region}`,
      level: block.heading.level,
      size: block.style.size,
      text: block.text,
      box: block.box,
      crop: block.crop,
    };
    known.set(key, heading);
    charsOf.set(key, block.chars);
    const list = byRegion.get(heading.region);
    if (list) list.push(heading);
    else byRegion.set(heading.region, [heading]);
  });

  const ratio = config.inversionMinSizeRatio;
  const found: LevelInversion[] = [];
  const normalStatus = clampInversionStatus(config.inversionStatus, 'advisory');
  const extremeStatus = clampInversionStatus(config.extremeInversionStatus, 'likely');
  for (const headings of byRegion.values()) {
    // The heading each one is coded under, when it is visibly larger than that heading.
    const smallerParent = headings.map((heading, position): ExposedHeading | null => {
      for (let before = position - 1; before >= 0; before--) {
        const candidate = headings[before]!;
        if (candidate.level >= heading.level) continue;
        return heading.size >= candidate.size * ratio ? candidate : null;
      }
      return null;
    });
    const oversized = new Set(headings.filter((_, position) => smallerParent[position] !== null));
    headings.forEach((heading, position) => {
      let other: ExposedHeading | null = null;
      let kind: LevelInversion['kind'] = 'above-smaller';
      for (let before = position - 1; before >= 0; before--) {
        const candidate = headings[before]!;
        if (candidate.level <= heading.level && candidate.size < heading.size * ratio) break;
        if (oversized.has(candidate)) {
          if (candidate.level <= heading.level) break;
          continue;
        }
        if (candidate.size >= heading.size * ratio) {
          if (candidate.level > heading.level) other = candidate;
          break;
        }
      }
      if (!other && smallerParent[position]) {
        other = smallerParent[position]!;
        kind = 'below-larger';
      }
      if (!other) return;
      const sizeRatio = kind === 'above-smaller' ? other.size / heading.size : heading.size / other.size;
      const levelGap = Math.abs(other.level - heading.level);
      const extreme = sizeRatio >= config.extremeInversionMinSizeRatio && levelGap >= config.extremeInversionMinLevelGap;
      found.push({
        block: heading.block,
        selector: heading.selector,
        frame: heading.frame,
        box: heading.box,
        level: heading.level,
        size: heading.size,
        text: heading.text,
        other: { selector: other.selector, level: other.level, size: other.size, text: other.text },
        kind,
        sizeRatio: round(sizeRatio),
        levelGap,
        extreme,
        status: extreme ? extremeStatus : normalStatus,
        crop: heading.crop,
      });
    });
  }
  return found.sort((a, b) => compare(a.block, b.block));
}
