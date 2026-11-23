import type { AdjudicationConfig, CheckId, Config, FocusConfig, HeadingsConfig, IconConfig, ListsConfig } from './types.js';

/**
 * Every threshold and default of the tool lives in this object.
 * Check code reads from Config and never carries its own numbers.
 * Each field is documented on its type in types.ts.
 */
export const defaultConfig: Config = {
  checks: ['focus-indicator', 'icon-contrast', 'headings', 'lists'],
  focus: {
    deviceScaleFactor: 2,
    captureSizeTolerancePx: 1,
    clipMarginCssPx: 12,
    maxTabStops: 300,
    maxForced: 100,
    maxTabsInOpaqueFrame: 50,
    settleFrames: 2,
    settleTimeoutMs: 250,
    fontsTimeoutMs: 3000,
    diffDeltaE: 2,
    minComponentAreaCssPx2: 1,
    maxComponents: 12,
    adjacentGapCssPx: 0.5,
    adjacentBandCssPx: 1.5,
    clusterDeltaE: 5,
    minIndicatorShare: 0.2,
    minorPartMinShare: 0.02,
    minorPartSolidCssPx: 1,
    minAdjacentShare: 0.1,
    contrastThreshold: 3,
    likelyBandFloor: 2.7,
    strokeMaxThicknessCssPx: 8,
    fillMinCoverage: 0.5,
    defaultRingMaxCssPx: 6,
    obscuredGrid: 5,
    coverGrid: 3,
    opaqueCoverMinAlpha: 1,
    invisibleCoverMaxOpacity: 0,
    geometryToleranceCssPx: 1,
  },
  icon: {
    maxCandidates: 300,
    clipMarginCssPx: 8,
    minControlSizeCssPx: 4,
    maxGraphicSizeCssPx: 64,
    iconFontFamilyPattern: 'icon|glyph|awesome|material symbols|fontello|icomoon',
    inactiveHintPattern: 'disabled|inactive',
    logoHintPattern: 'logo|brand',
    homeLinkNamePattern: '\\bhome\\b|\\bhomepage\\b',
    minVisibleTextCssPx: 2,
    boundaryWrapperLevels: 3,
    boundaryWrapperSlackCssPx: 40,
    coverGrid: 3,
    minPaintedSizeCssPx: 1,
    boxToleranceCssPx: 1,
    boundaryProbeInsetCssPx: 2,
    sameBoxToleranceCssPx: 0.5,
    boundaryAuthorPropertyPattern: '^(all$|border|background|box-shadow|appearance|-webkit-appearance|accent-color)',
    clusterDeltaE: 5,
    backgroundGapCssPx: 0.5,
    backgroundBandCssPx: 1.5,
    uniformBackgroundMinShare: 0.6,
    minBackgroundShare: 0.05,
    minInkShare: 0.004,
    minPartShare: 0.12,
    minSolidPartShare: 0.01,
    blendToleranceRgb: 14,
    minInteriorShare: 0.1,
    minInteriorPixels: 2,
    flatBlockMinPx: 3,
    flatBlockCssPx: 2,
    maxParts: 3,
    complexResidualShare: 0.25,
    declaredBlendMinShare: 0.9,
    contrastThreshold: 3,
    likelyBandFloor: 2.7,
    boundaryReachCssPx: 3,
    boundaryDepthCssPx: 4,
    boundarySideShare: 0.3,
    boundaryMinSideCssPx: 6,
    boundaryMinShare: 0.06,
    boundaryClusterDeltaE: 2,
    captureAttempts: 3,
  },
  headings: {
    maxBlocks: 6000,
    maxTextChars: 300,
    maxCandidates: 150,
    maxInversions: 50,
    minVisibleTextCssPx: 2,
    minFontSizeCssPx: 1,
    regionSelector:
      'main,nav,aside,header,footer,article,dialog,form,search,[role="main"],[role="navigation"],[role="complementary"],[role="banner"],[role="contentinfo"],[role="region"],[role="article"],[role="dialog"],[role="alertdialog"],[role="form"],[role="search"]',
    clipMarginCssPx: 16,
    clipAboveCssPx: 48,
    clipBelowCssPx: 96,
    contextBeforeMaxChars: 160,
    contextAfterMaxChars: 240,
    messageTextMaxChars: 80,
    baselineMinChars: 200,
    baselineMainMinShare: 0.1,
    minSizeRatio: 1.3,
    minWeightDelta: 200,
    boldMinSizeRatio: 0.95,
    uppercaseBoldMinSizeRatio: 0.7,
    maxWords: 20,
    maxChars: 160,
    maxLines: 3,
    maxBoldOnlyWords: 12,
    uniformStyleMinShare: 0.9,
    maxBreaks: 2,
    sentenceEndPattern:
      '([.\\u3002\\u06d4\\u0964\\u0965;\\uff1b\\u061b,\\uff0c\\u3001\\u060c\\u2026]|\\p{L}[.\\u3002][\\p{N}*\\u2020\\u2021]{1,2})$',
    leadInEndPattern: '[:\\uff1a]$',
    quoteStartPattern: '^["\\u00ab\\u2039\\u201c\\u201e\\u201a\\u2018\\u300c\\u300e]',
    numericMinDigitShare: 0.5,
    statisticMaxWords: 3,
    ordinalStartPattern: '^\\p{N}+(\\.\\p{N}+)*[.)]\\s|^\\p{N}{1,2}(\\.\\p{N}{1,2})*\\s+\\p{Lu}',
    repeatedTextMinCount: 3,
    shortFollowerMaxLines: 1,
    shortFollowerMaxWords: 15,
    sentenceFollowerIsContent: true,
    besideControlsMax: 2,
    mergeMaxGapEm: 0.4,
    peerDemotionMinShare: 0.66,
    peerDemotionMinPeers: 2,
    sameLineMinOverlap: 0.5,
    sameLineMaxGapEm: 1,
    boxToleranceCssPx: 2,
    sizeToleranceCssPx: 0.25,
    inversionStatus: 'advisory',
    extremeInversionStatus: 'likely',
    inversionMinSizeRatio: 1.15,
    extremeInversionMinSizeRatio: 1.5,
    extremeInversionMinLevelGap: 2,
  },
  lists: {
    lineStartChars: 64,
    maxAncestorLevels: 6,
    markerAncestorLevels: 3,
    maxGroups: 400,
    maxGroupItems: 40,
    maxListElements: 400,
    maxAxMarks: 3000,
    maxCandidates: 150,
    maxUnstyledLists: 50,
    maxCaptures: 120,
    maxTargetBlocks: 60,
    clipMarginCssPx: 16,
    clipMarkerRoomCssPx: 32,
    messageItems: 4,
    itemTextMaxChars: 60,
    contextMaxItems: 12,
    markerMinSizeCssPx: 3,
    markerMaxSizeCssPx: 24,
    markerMaxGapEm: 2,
    markerRoomEm: 1,
    shapeDepth: 3,
    bulletPattern:
      '^[\\u2022\\u2023\\u2043\\u204c\\u204d\\u2219\\u25a0-\\u25ff\\u2600-\\u27bf\\u2b00-\\u2bff\\u2190-\\u21ff\\u30fb\\uff65\\u203b\\u{1f300}-\\u{1faff}]\\ufe0f?\\s*',
    weakBulletPattern: '^[-\\u2010-\\u2013*\\u00b7>\\u203a\\u00bb~]\\s+',
    pseudoBulletPattern:
      '^[-\\u2010-\\u2013*\\u00b7>\\u203a\\u00bb~+\\u2022\\u2023\\u2043\\u204c\\u204d\\u2219\\u25a0-\\u25ff\\u2600-\\u27bf\\u2b00-\\u2bff\\u2190-\\u21ff\\u30fb\\uff65\\u203b\\u{1f300}-\\u{1faff}]\\ufe0f?$',
    iconGlyphPattern: '^[\\ue000-\\uf8ff\\u{f0000}-\\u{ffffd}\\u{100000}-\\u{10fffd}]+$',
    numberPattern: '^\\(?(\\p{Nd}{1,3}(?:\\.\\p{Nd}{1,3}){0,3})(?:[.)\\]/\\u00b0]\\s+|[\\uff0e\\u3001\\uff09]\\s*)',
    letterPattern: '^\\(?(\\p{L})([.)])\\s+',
    romanPattern: '^\\(?([ivxlcdm]{1,7}|[IVXLCDM]{1,7})[.)]\\s+',
    ideographicNumberPattern: '^([\\u4e00\\u4e8c\\u4e09\\u56db\\u4e94\\u516d\\u4e03\\u516b\\u4e5d\\u5341]{1,3})[\\u3001\\uff0e.\\uff09)]\\s*',
    enclosedNumberPattern: '^([\\u2460-\\u249b\\u2776-\\u277f])\\s*',
    firstLetters: 'aA\u03b1\u0391\u0430\u0410\u05d0\u3042\u30a2\uff41\uff21',
    numericMinDigitShare: 0.5,
    minItems: 2,
    weakMinItems: 3,
    letterMinItems: 3,
    graphicMinItems: 3,
    headedItemMinBlocks: 3,
    alignToleranceCssPx: 3,
    sameRowMinOverlap: 0.5,
    minRepeatedItems: 3,
    gapToleranceCssPx: 4,
    gapToleranceShare: 0.1,
    linkSeparatorMaxChars: 2,
    repeatedItemMaxChars: 300,
    cardListStatus: 'advisory',
    keyValueMinPairs: 3,
    keyMaxWords: 5,
    keyValueLinePattern: '^([^:\\uff1a]{1,48}?)(?:\\s?:\\s+|\\uff1a\\s*)\\S',
    keyEndPattern: '[:\\uff1a]$',
  },
  adjudication: {
    provider: 'none',
    baseUrl: '',
    model: '',
    apiKeyEnv: '',
    providerLabel: '',
    allowRemote: false,
    votes: 2,
    temperature: 0,
    seed: null,
    timeoutMs: 120000,
    maxConsecutiveFailures: 3,
    pageBudgetMs: 600000,
    concurrency: 2,
    maxRetries: 2,
    retryBaseDelayMs: 500,
    retryMaxDelayMs: 8000,
    maxCallsPerPage: 120,
    maxOutputTokens: 400,
    maxTokensField: 'max_tokens',
    responseFormat: 'json_schema',
    imageUrlShape: 'object',
    sendImages: true,
    maxImageBytes: 4000000,
    judgeWithoutImage: true,
    maxResponseChars: 100000,
    maxRationaleChars: 400,
    cacheMaxEntries: 5000,
    outlineColor: '#ff00ff',
    outlineWidthCssPx: 2,
    outlineGapCssPx: 3,
    headingNoStatus: 'likely',
    listNoStatus: 'likely',
  },
};

export type ConfigInput = {
  checks?: CheckId[];
  focus?: Partial<FocusConfig>;
  icon?: Partial<IconConfig>;
  headings?: Partial<HeadingsConfig>;
  lists?: Partial<ListsConfig>;
  adjudication?: Partial<AdjudicationConfig>;
};

/**
 * The status of a contradiction between heading levels, whatever was configured: whether two
 * levels contradict the visual order is a judgement, so it is `advisory` or `likely` and never
 * `fail`. A configured `fail` becomes `likely`, the highest status allowed; anything else that is
 * not one of the two becomes `fallback`.
 */
export function clampInversionStatus(value: unknown, fallback: 'advisory' | 'likely'): 'advisory' | 'likely' {
  if (value === 'advisory' || value === 'likely') return value;
  return value === 'fail' ? 'likely' : fallback;
}

/**
 * The status of a series of blocks of one shape (card grids, search results), whatever was
 * configured: whether such a series is a list is a judgement and a house policy, so it is
 * `advisory` or `likely` and never `fail`. A configured `fail` becomes `likely`, anything
 * else that is not one of the two becomes the default.
 */
export function clampCardListStatus(value: unknown): 'advisory' | 'likely' {
  return clampInversionStatus(value, 'advisory');
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function atLeast(value: unknown, min: number, fallback: number, whole = true): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, whole ? Math.floor(value) : value);
}

/** The longest delay a timer takes (2^31 - 1 ms, about 24.8 days). Beyond it, `setTimeout` fires at once. */
export const MAX_TIMER_MS = 2147483647;

/** A duration in milliseconds that a timer can hold: `atLeast`, cut to `MAX_TIMER_MS`. */
function duration(value: unknown, min: number, fallback: number): number {
  return Math.min(MAX_TIMER_MS, atLeast(value, min, fallback));
}

/**
 * Settings of the adjudicator layer, with anything that is not a usable value put back to its
 * default: a configuration can come from a JSON file. Whatever is configured, a status that
 * depends on a model is `likely` at most (`headingNoStatus` and `listNoStatus` take `info` or `likely` only).
 */
export function resolveAdjudication(input: Partial<AdjudicationConfig> = {}): AdjudicationConfig {
  const base = defaultConfig.adjudication;
  const merged = { ...base, ...input };
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  return {
    provider: oneOf(merged.provider, ['none', 'openai-compatible'], base.provider),
    baseUrl: text(merged.baseUrl),
    model: text(merged.model),
    apiKeyEnv: text(merged.apiKeyEnv),
    providerLabel: text(merged.providerLabel),
    allowRemote: merged.allowRemote === true,
    votes: atLeast(merged.votes, 1, base.votes),
    temperature: atLeast(merged.temperature, 0, base.temperature, false),
    seed: typeof merged.seed === 'number' && Number.isInteger(merged.seed) ? merged.seed : null,
    timeoutMs: duration(merged.timeoutMs, 1, base.timeoutMs),
    maxConsecutiveFailures: atLeast(merged.maxConsecutiveFailures, 0, base.maxConsecutiveFailures),
    pageBudgetMs: duration(merged.pageBudgetMs, 0, base.pageBudgetMs),
    concurrency: atLeast(merged.concurrency, 1, base.concurrency),
    maxRetries: atLeast(merged.maxRetries, 0, base.maxRetries),
    retryBaseDelayMs: duration(merged.retryBaseDelayMs, 0, base.retryBaseDelayMs),
    retryMaxDelayMs: duration(merged.retryMaxDelayMs, 0, base.retryMaxDelayMs),
    maxCallsPerPage: atLeast(merged.maxCallsPerPage, 0, base.maxCallsPerPage),
    maxOutputTokens: atLeast(merged.maxOutputTokens, 1, base.maxOutputTokens),
    maxTokensField: oneOf(merged.maxTokensField, ['max_tokens', 'max_completion_tokens', 'none'], base.maxTokensField),
    responseFormat: oneOf(merged.responseFormat, ['json_schema', 'json_object', 'none'], base.responseFormat),
    imageUrlShape: oneOf(merged.imageUrlShape, ['object', 'string'], base.imageUrlShape),
    sendImages: merged.sendImages !== false,
    maxImageBytes: atLeast(merged.maxImageBytes, 0, base.maxImageBytes),
    judgeWithoutImage: merged.judgeWithoutImage !== false,
    maxResponseChars: atLeast(merged.maxResponseChars, 1, base.maxResponseChars),
    maxRationaleChars: atLeast(merged.maxRationaleChars, 0, base.maxRationaleChars),
    cacheMaxEntries: atLeast(merged.cacheMaxEntries, 0, base.cacheMaxEntries),
    outlineColor: /^#[0-9a-f]{6}$/i.test(text(merged.outlineColor)) ? text(merged.outlineColor) : base.outlineColor,
    outlineWidthCssPx: atLeast(merged.outlineWidthCssPx, 0, base.outlineWidthCssPx, false),
    outlineGapCssPx: atLeast(merged.outlineGapCssPx, 0, base.outlineGapCssPx, false),
    headingNoStatus: oneOf(merged.headingNoStatus, ['info', 'likely'], base.headingNoStatus),
    listNoStatus: oneOf(merged.listNoStatus, ['info', 'likely'], base.listNoStatus),
  };
}

export function resolveConfig(input: ConfigInput = {}): Config {
  const headings = { ...defaultConfig.headings, ...input.headings };
  headings.inversionStatus = clampInversionStatus(headings.inversionStatus, defaultConfig.headings.inversionStatus);
  headings.extremeInversionStatus = clampInversionStatus(headings.extremeInversionStatus, defaultConfig.headings.extremeInversionStatus);
  const lists = { ...defaultConfig.lists, ...input.lists };
  lists.cardListStatus = clampCardListStatus(lists.cardListStatus);
  return {
    checks: input.checks ? [...new Set(input.checks)] : [...defaultConfig.checks],
    focus: { ...defaultConfig.focus, ...input.focus },
    icon: { ...defaultConfig.icon, ...input.icon },
    headings,
    lists,
    adjudication: resolveAdjudication(input.adjudication),
  };
}
