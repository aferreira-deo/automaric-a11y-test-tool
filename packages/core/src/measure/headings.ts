import { fingerprint } from '../fingerprint.js';
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

/** The style of body text: the most common size and weight, by number of characters. */
export interface BodyBaseline {
  size: number;
  weight: number;
  /** Most common family and colour of the text that has that size and weight. */
  family: string;
  color: string;
  /** `main`: measured inside main. `page`: no visible text in main, measured on the whole page. */
  from: 'main' | 'page';
}

export type Prominence = 'larger' | 'bolder' | 'matchesHeadingStyle';

/**
 * Why a candidate is not `likely`.
 * - A `TextContext`: all of its text is in a label, a button, a link, a table cell and so on.
 * - `numeric`: a price, a statistic, a date. `quotation`: opens with a quotation mark.
 * - `peersNumeric`: most blocks with its exact style are numbers (see `peerDemotionMinShare`).
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
 */
export type HeadingReason =
  | TextContext
  | 'numeric'
  | 'quotation'
  | 'peersNumeric'
  | 'sentence'
  | 'colon'
  | 'lineBreaks'
  | 'listItem'
  | 'sharesLine'
  | 'repeated'
  | 'notFollowed'
  | 'headsControl'
  | 'tightAbove';

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
  /** What deterministic code reports without a model: `likely` for a strong candidate, else `info`. */
  status: 'likely' | 'info';
  prominence: Prominence[];
  /** Empty for a strong candidate. */
  reasons: HeadingReason[];
  features: HeadingFeatures;
  text: string;
  /** Key in `Snapshot.screenshots.clips`; the clip shows the block with what is above and below it. */
  crop: string | null;
  /** No capture because other content (a banner, a dialog) lay over the block. */
  covered: boolean;
  /**
   * Whether a model's judgement could change the status: true for strong candidates and for weak
   * ones held back only by reasons that are a matter of judgement (a link, a colon, what
   * follows). False when the reason is structural (a label, a number, hidden from assistive
   * technology) or when the accessibility tree could not be read.
   */
  adjudicate: boolean;
  /** Compact context for a model: text, style, what surrounds the block. Page text is untrusted data. */
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
}

/** Reasons that no judgement would overturn. */
const STRUCTURAL: ReadonlySet<HeadingReason> = new Set<HeadingReason>([
  'ariaHidden',
  'numeric',
  'peersNumeric',
  'code',
  'label',
  'button',
  'tableHeader',
  'tableCell',
  'navigation',
]);
/**
 * The reason a block takes from its look-alikes. Only this one: on real pages the style of a
 * table header, a label or a term is often plain bold text, and titles that are links share
 * their style with titles that are not, so those say nothing about other text of that style.
 */
const INHERITABLE: ReadonlySet<HeadingReason> = new Set<HeadingReason>(['numeric']);
/** Reasons that come from where the block sits on the page. */
const GEOMETRIC: ReadonlySet<HeadingReason> = new Set<HeadingReason>(['sharesLine', 'repeated', 'notFollowed', 'headsControl']);

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
export function bodyBaseline(blocks: TextBlock[]): BodyBaseline | null {
  const counted = blocks.filter((block) => block.chars > 0);
  const plain = counted.filter((block) => !block.heading && !block.contexts.some((context) => NOT_BODY.has(context)));
  const pools = [plain.filter((block) => block.inMain), plain, counted.filter((block) => block.inMain), counted];
  const pool = pools.find((candidates) => candidates.length > 0);
  if (!pool) return null;
  const inMain = pool.filter((block) => block.inMain);
  const bySizeAndWeight = new Map<string, number>();
  const key = (block: TextBlock): string => `${round(block.style.size, 1).toFixed(1).padStart(8, '0')}|${String(block.style.weight).padStart(4, '0')}`;
  for (const block of pool) bySizeAndWeight.set(key(block), (bySizeAndWeight.get(key(block)) ?? 0) + block.chars);
  const winner = heaviest(bySizeAndWeight)!;
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
    from: inMain.length > 0 ? 'main' : 'page',
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

/** A price, a statistic, a date: mostly digits, a currency or percent sign, or a number and a unit. */
export function isNumericText(text: string, words: number, config: HeadingsConfig): boolean {
  const digits = text.match(DIGIT)?.length ?? 0;
  if (digits === 0) return false;
  const letters = text.match(LETTER)?.length ?? 0;
  if (digits / (digits + letters) >= config.numericMinDigitShare) return true;
  if (CURRENCY_OR_PERCENT.test(text)) return true;
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

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
  const baseline = bodyBaseline(blocks);
  const inversions = levelInversions(blocks, config);
  const exposedHeadings = new Set(blocks.filter((block) => block.heading).map((block) => `${block.frame}\u0000${block.heading!.selector}`)).size;
  if (!baseline) return { baseline, candidates: [], inversions, exposedHeadings, omitted: 0 };

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
    if (isNumericText(block.text, block.words, config)) reasons.push('numeric');
    if (quoteStart.test(block.text) && !reasons.includes('quote')) reasons.push('quotation');
    return reasons;
  });
  const bySignature = new Map<string, number[]>();
  signatures.forEach((signature, index) => {
    if (blocks[index]!.heading) return;
    const members = bySignature.get(signature);
    if (members) members.push(index);
    else bySignature.set(signature, [index]);
  });
  const inherited: HeadingReason[][] = blocks.map((block, index) => {
    if (block.heading) return [];
    const peers = (bySignature.get(signatures[index]!) ?? []).filter((peer) => peer !== index);
    if (peers.length < config.peerDemotionMinPeers) return [];
    const counts = new Map<HeadingReason, number>();
    for (const peer of peers) {
      for (const reason of intrinsic[peer]!) if (INHERITABLE.has(reason)) counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    return [...counts]
      .filter(([reason, count]) => count / peers.length >= config.peerDemotionMinShare && !intrinsic[index]!.includes(reason))
      .map(([reason]) => `peers${capitalise(reason)}` as HeadingReason)
      .sort();
  });
  const isNumber = (index: number): boolean => intrinsic[index]!.includes('numeric') || inherited[index]!.includes('peersNumeric');

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

    const previous = index > 0 && blocks[index - 1]!.frame === block.frame ? blocks[index - 1]! : null;
    // A number set large under a title is a figure, not what the title heads: look past it.
    let next = index + 1;
    while (next < blocks.length && blocks[next]!.frame === block.frame && isNumber(next) && !isNumber(index)) next++;
    const follower = next < blocks.length && blocks[next]!.frame === block.frame ? blocks[next]! : null;
    const direct = index + 1 < blocks.length && blocks[index + 1]!.frame === block.frame ? blocks[index + 1]! : null;

    const reasons: HeadingReason[] = [...intrinsic[index]!, ...inherited[index]!];
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
      const at = blocks.indexOf(follower);
      const after = at + 1 < blocks.length && blocks[at + 1]!.frame === block.frame ? blocks[at + 1]! : null;
      const series =
        after !== null &&
        (after.contexts.includes('button') || after.contexts.includes('link')) &&
        styleSignature(after.style) === styleSignature(follower.style) &&
        after.firstLine.y >= bottom(follower.lastLine) - tolerance &&
        overlapsHorizontally(after.box, follower.box, tolerance);
      if (!series) reasons.push('headsControl');
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
    return geometric.length === 0 || reasons.every((reason) => GEOMETRIC.has(reason) || reason === 'tightAbove');
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
    // Without the accessibility tree, nothing says that the block is not a heading already.
    const status = isStrong && survey.axComplete ? 'likely' : 'info';
    const rule = status === 'likely' ? UNMARKED_HEADING_RULE : HEADING_CANDIDATE_RULE;
    return {
      block: index,
      findingId: fingerprint({ rule, wcag: HEADINGS_SC, frame: block.frame, selector: block.selector }),
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
        textBefore: previous ? cut(previous.text, 160) : null,
        textAfter: follower ? cut(follower.text, 240) : null,
      },
    };
  });
  return { baseline, candidates, inversions, exposedHeadings, omitted: unique.length - ordered.length };
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
  for (const headings of byRegion.values()) {
    headings.forEach((heading, position) => {
      let other: ExposedHeading | null = null;
      let kind: LevelInversion['kind'] = 'above-smaller';
      for (let before = position - 1; before >= 0; before--) {
        const candidate = headings[before]!;
        if (candidate.size >= heading.size * ratio) {
          if (candidate.level > heading.level) other = candidate;
          break;
        }
        if (candidate.level <= heading.level) break;
      }
      if (!other) {
        for (let before = position - 1; before >= 0; before--) {
          const candidate = headings[before]!;
          if (candidate.level >= heading.level) continue;
          if (heading.size >= candidate.size * ratio) {
            other = candidate;
            kind = 'below-larger';
          }
          break;
        }
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
        status: extreme ? config.extremeInversionStatus : config.inversionStatus,
        crop: heading.crop,
      });
    });
  }
  return found.sort((a, b) => compare(a.block, b.block));
}
