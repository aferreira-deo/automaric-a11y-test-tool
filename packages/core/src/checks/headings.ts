import { CANDIDATE_FINGERPRINT_RULE, HEADINGS_SC, headingReport, HEADING_CANDIDATE_RULE, LEVEL_INVERSION_RULE } from '../measure/headings.js';
import type { BodyBaseline, HeadingCandidate, HeadingReason, LevelInversion } from '../measure/headings.js';
import type { Check, Evidence, FindingDraft, HeadingsConfig } from '../types.js';

const HELP = {
  unmarked:
    'Text that functions as a heading for the content that follows it has to be exposed as a heading (1.3.1 Info and Relationships): h1 to h6, or role="heading" with aria-level. Whether a piece of text functions as a heading is a judgement, so this is never reported as a failure without confirmation.',
  inversion:
    'Heading levels convey the structure that the visual presentation shows (1.3.1 Info and Relationships). A heading that looks subordinate to another and is coded at a higher level than it contradicts that structure. Skipped levels and several h1 are not contradictions.',
  inventory: 'Inventory. Nothing to fix on the strength of this entry alone.',
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const REASON_TEXT: Record<HeadingReason, string> = {
  label: 'it is the label or legend of a form control',
  caption: 'it is the caption of a table or figure',
  tableHeader: 'it is a table header cell',
  tableCell: 'it is in a table cell',
  term: 'it is the term of a description list',
  button: 'it is the text of a button or of another control',
  link: 'all of it is a link',
  quote: 'it is a quotation',
  quotation: 'it opens with a quotation mark',
  code: 'it is code',
  navigation: 'it is inside a navigation region or a menu',
  ariaHidden: 'it is hidden from assistive technology (aria-hidden or inert), so it is not a heading that lost its role',
  numeric: 'it is a number: a price, a figure or a date',
  statistic: 'it is short and opens with a number, as a statistic does',
  peersNumeric: 'most text with exactly its style is a number (a price, a statistic), so it stands where a number would',
  repeatedText: 'the same text in the same style is on the page several times, as a label or a badge is',
  italic: 'it is large, in italics and of the weight of body text, as a pull quote is',
  sameColourAsBackground: 'its colour is exactly that of the background behind it, so it shows only if it lies over a picture',
  sentence: 'it ends like a sentence',
  colon: 'it ends with a colon, as a lead-in does',
  lineBreaks: 'it is several lines separated by line breaks',
  listItem: 'it is an item of a list',
  sharesLine: 'other text sits right before it on the same line',
  repeated: 'the text right before or after it has the same style, as in a series of items',
  notFollowed: 'no text follows under it, or what follows is set as a title and is as large as it or larger',
  headsControl: 'what follows it is a plain button or link, as a call to action under a tagline',
  tightAbove: 'it is bold text of body size with less space above it than below it',
  shortFollower: 'it is only bolder than body text and what follows it is a single short line that is no sentence, or is no longer than it, as a value under a label',
  labelSeries: 'it is only bolder than body text and stands in a series of labels, each over one short line that is no sentence',
};

function reasonText(reason: HeadingReason): string {
  return REASON_TEXT[reason];
}

function quote(text: string, config: HeadingsConfig): string {
  return `"${text.length > config.messageTextMaxChars ? `${text.slice(0, config.messageTextMaxChars)}…` : text}"`;
}

function px(value: number): string {
  return `${Math.round(value * 10) / 10}px`;
}

function look(candidate: HeadingCandidate, baseline: BodyBaseline): string {
  const { features, prominence } = candidate;
  const parts: string[] = [];
  const size = features.sizeRatio * baseline.size;
  if (prominence.includes('larger')) parts.push(`${px(size)}, ${features.sizeRatio} times the size of body text (${px(baseline.size)})`);
  if (prominence.includes('bolder')) parts.push(`weight ${features.weight} against ${features.bodyWeight} for body text`);
  if (features.matchesHeadingLevel !== null) {
    parts.push(`exactly the style of a heading of level ${features.matchesHeadingLevel} on this page`);
  }
  return parts.join('; ');
}

function candidateEvidence(candidate: HeadingCandidate, baseline: BodyBaseline): Evidence {
  const { features } = candidate;
  const style = candidate.context['style'] as { color: string; family: string; size: number };
  const colors: Record<string, string> = {};
  if (HEX_COLOR.test(style.color)) colors['text'] = style.color;
  if (HEX_COLOR.test(baseline.color)) colors['bodyText'] = baseline.color;
  const flags: string[] = [...candidate.prominence, ...candidate.reasons];
  if (features.transform === 'uppercase') flags.push('uppercase');
  if (features.colorDiffers) flags.push('colourDiffers');
  if (features.familyDiffers) flags.push('familyDiffers');
  if (features.aloneOnLine) flags.push('aloneOnLine');
  if (features.followedByBody) flags.push('followedByBody');
  if (features.leftAligned) flags.push('leftAligned');
  const values: Record<string, string | number | boolean> = {
    text: candidate.text,
    fontSizePx: style.size,
    fontWeight: features.weight,
    fontFamily: style.family,
    bodyFontSizePx: baseline.size,
    bodyFontWeight: baseline.weight,
    words: features.words,
    lines: features.lines,
  };
  if (features.spaceAbove !== null) values['spaceAbovePx'] = features.spaceAbove;
  if (features.spaceBelow !== null) values['spaceBelowPx'] = features.spaceBelow;
  if (features.matchesHeadingLevel !== null) values['matchesHeadingLevel'] = features.matchesHeadingLevel;
  if (!candidate.crop) flags.push(candidate.covered ? 'covered' : 'notCaptured');
  if (baseline.lowText) flags.push('lowText');
  const after = candidate.context['textAfter'];
  if (typeof after === 'string') values['followedBy'] = after;
  return {
    crops: candidate.crop ? [candidate.crop] : [],
    colors,
    ratios: { sizeToBodyText: features.sizeRatio },
    flags,
    values,
  };
}

function candidateFinding(candidate: HeadingCandidate, baseline: BodyBaseline, axComplete: boolean, config: HeadingsConfig): FindingDraft {
  const evidence = candidateEvidence(candidate, baseline);
  const base = {
    check: 'headings' as const,
    rule: candidate.rule,
    // The id of the finding is `candidate.findingId`, whichever rule reports it.
    fingerprintRule: CANDIDATE_FINGERPRINT_RULE,
    wcag: HEADINGS_SC,
    selector: candidate.selector,
    frame: candidate.frame,
    box: candidate.box,
  };
  const looks = look(candidate, baseline);
  if (candidate.status === 'likely') {
    return {
      ...base,
      status: 'likely',
      evidence,
      message: `${quote(candidate.text, config)} looks like a heading (${looks}), stands on its own line above the text that follows it, and the accessibility tree does not expose it as a heading. Confirm that it functions as a heading for what follows.`,
      help: HELP.unmarked,
    };
  }
  const why = candidate.reasons.map(reasonText);
  if (candidate.strength === 'strong' && !axComplete) {
    why.push('the accessibility tree could not be read in full, so it may be exposed as a heading already');
    evidence.flags.push('axIncomplete');
  }
  if (candidate.strength === 'strong' && baseline.lowText) {
    why.push(`the page has too little plain text to say what its body text looks like (${baseline.chars} characters in the most common style), so its prominence is not established`);
  }
  return {
    ...base,
    rule: HEADING_CANDIDATE_RULE,
    status: 'info',
    evidence,
    message: `${quote(candidate.text, config)} is more prominent than body text (${looks}) and is not exposed as a heading. Recorded as info because ${why.join('; ')}.`,
    help: HELP.unmarked,
  };
}

function inversionFinding(inversion: LevelInversion, config: HeadingsConfig): FindingDraft {
  const { other } = inversion;
  const relation =
    inversion.kind === 'above-smaller'
      ? `is coded above the heading before it, ${quote(other.text, config)} (level ${other.level}, ${px(other.size)}), and is visibly smaller than it`
      : `is coded under ${quote(other.text, config)} (level ${other.level}, ${px(other.size)}) and is visibly larger than it`;
  const degree = inversion.extreme
    ? ` The two are ${inversion.levelGap} levels apart and differ in size by a factor of ${inversion.sizeRatio}, which is beyond the limits for an extreme contradiction (${config.extremeInversionMinLevelGap} levels, ${config.extremeInversionMinSizeRatio}).`
    : '';
  return {
    check: 'headings',
    rule: LEVEL_INVERSION_RULE,
    // Clamped where it is computed; said again here, where findings are made: never `fail`.
    status: inversion.status === 'likely' ? 'likely' : 'advisory',
    wcag: HEADINGS_SC,
    selector: inversion.selector,
    frame: inversion.frame,
    box: inversion.box,
    evidence: {
      crops: inversion.crop ? [inversion.crop] : [],
      colors: {},
      ratios: { size: inversion.sizeRatio },
      flags: [inversion.kind === 'above-smaller' ? 'aboveSmaller' : 'belowLarger', ...(inversion.extreme ? ['extreme'] : [])],
      values: {
        text: inversion.text,
        level: inversion.level,
        fontSizePx: inversion.size,
        otherHeading: other.selector,
        otherText: other.text,
        otherLevel: other.level,
        otherFontSizePx: other.size,
        levelGap: inversion.levelGap,
      },
    },
    message: `The heading ${quote(inversion.text, config)} (level ${inversion.level}, ${px(inversion.size)}) ${relation}.${degree} Confirm which of the two levels matches the structure the page shows.`,
    help: HELP.inversion,
  };
}

export const headingsCheck: Check = {
  id: 'headings',
  evaluate(snapshot, config) {
    const survey = snapshot.headings;
    if (!survey) throw new Error('The headings check needs a snapshot collected with the heading survey.');
    const report = headingReport(survey, config.headings);
    const drafts: FindingDraft[] = [];
    const { baseline } = report;
    if (baseline) for (const candidate of report.candidates) drafts.push(candidateFinding(candidate, baseline, survey.axComplete, config.headings));
    for (const inversion of report.inversions) drafts.push(inversionFinding(inversion, config.headings));

    const likely = report.candidates.filter((candidate) => candidate.status === 'likely').length;
    const beyond = survey.total - survey.blocks.length;
    const flags: string[] = [];
    if (beyond > 0 || report.omitted > 0 || report.omittedInversions > 0) flags.push('truncated');
    if (!survey.axComplete) flags.push('axIncomplete');
    if (baseline?.lowText) flags.push('lowText');
    const { width, height } = snapshot.environment.viewport;
    drafts.push({
      check: 'headings',
      rule: 'headings/survey',
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
          exposedHeadings: report.exposedHeadings,
          likely,
          candidates: report.candidates.length - likely,
          ...(baseline ? { bodyFontSizePx: baseline.size, bodyFontWeight: baseline.weight, bodyStyleFrom: baseline.from, bodyStyleChars: baseline.chars } : {}),
        },
      },
      message:
        `Read ${survey.blocks.length} block(s) of visible text.` +
        (baseline
          ? ` Body text is ${px(baseline.size)} at weight ${baseline.weight}, the most common style ${baseline.from === 'main' ? 'inside main' : 'on the page (no main region, or too little text inside it)'}.` +
            (baseline.lowText
              ? ` That is ${baseline.chars} character(s) of plain text, too little to go by (under ${config.headings.baselineMinChars}), so no candidate is reported above info.`
              : '')
          : ' No visible text was found.') +
        ` The accessibility tree exposes ${report.exposedHeadings} heading(s) with visible text.` +
        ` ${likely} block(s) look like headings without being exposed as one, and ${report.candidates.length - likely} more are recorded as candidates.` +
        (report.omitted > 0 ? ` ${report.omitted} further candidate(s) are not listed (limit of ${config.headings.maxCandidates}).` : '') +
        (report.omittedInversions > 0
          ? ` ${report.omittedInversions} further contradiction(s) between heading levels are not listed (limit of ${config.headings.maxInversions}).`
          : '') +
        (beyond > 0 ? ` ${beyond} more block(s) of text were not read (limit of ${config.headings.maxBlocks}).` : '') +
        (survey.axComplete ? '' : ' The accessibility tree could not be read in full, so nothing is reported above info.'),
      help: HELP.inventory,
    });
    return drafts;
  },
};
