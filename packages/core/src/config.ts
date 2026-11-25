import type { AdjudicationConfig, BaselineConfig, CheckId, Config, FocusConfig, GroupingConfig, HeadingsConfig, IconConfig, ListsConfig, NameRoleValueConfig, RunConfig, SelectorConfig } from './types.js';

/**
 * Every threshold and default of the tool lives in this object.
 * Check code reads from Config and never carries its own numbers.
 * Each field is documented on its type in types.ts.
 */
export const defaultConfig: Config = {
  checks: ['focus-indicator', 'icon-contrast', 'headings', 'lists', 'grouping', 'name-role-value'],
  nameRoleValue: {
    probe: 'safe',
    includeAxeCovered: true,
    behaviourRoleStatus: 'likely',
    maxElements: 3000,
    maxListenerElements: 3000,
    maxNameChars: 160,
    itemTextMaxChars: 80,
    maxCandidates: 300,
    maxCaptures: 120,
    clipMarginCssPx: 16,
    maxControlAreaShare: 0.25,
    genericNamePattern:
      '^(?:button|btn|bouton|link|lien|checkbox|check box|case \\u00e0 cocher|radio button|bouton radio|menu item|img|icon|ic\\u00f4ne|picto|pictogramme|graphic|svg|null|undefined|nan|\\[object object\\]|true|false)$',
    classLikeNamePattern: '^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$|^(?:fa|fas|far|fab|fal|bi|mdi|icon|icons|ico|icn|btn|glyphicon|material-icons|ti|la|las|lar|js)-[a-z0-9-]+$',
    fileNamePattern: '\\.(?:png|jpe?g|gif|svg|webp|avif|bmp|ico|tiff?)$',
    urlNamePattern: '^(?:https?:)?//|^www\\.',
    privateUsePattern: '[\\ue000-\\uf8ff\\u{f0000}-\\u{ffffd}\\u{100000}-\\u{10fffd}]',
    titleOnlyStatus: 'advisory',
    placeholderOnlyStatus: 'advisory',
    tabWalk: true,
    maxTabStops: 300,
    maxProbes: 30,
    probeBudgetMs: 60000,
    probeSettleMs: 150,
    activationQuietMs: 150,
    activationQuietMaxMs: 2000,
    probeExcludeSelector: '[data-a11y-vision-no-probe]',
    probeReads: 'cache',
    probeAllowedResourceTypes: ['Stylesheet', 'Image', 'Font', 'Media', 'Script', 'TextTrack', 'Manifest'],
    probeAllowQueryStrings: false,
    probeConfirmToggle: true,
    maxProbeLoads: 30,
    probeLoadTimeoutMs: 15000,
    probeStepTimeoutMs: 10000,
    probeUnloadGraceMs: 300,
    probeCloneMinMatchShare: 0.9,
    probeCloneMaxMissingShare: 0.2,
    probeCloneMaxCountDelta: 0.15,
    probeCacheMaxBytes: 268435456,
    generatedTextNameStatus: 'likely',
    ownChangeMinAreaCssPx2: 6,
    revealMinAreaCssPx2: 200,
    maxVisibilityElements: 30000,
    regionMaxAncestorLevels: 3,
    quietMs: 300,
    quietMaxMs: 3000,
    probeClipSideCssPx: 120,
    probeClipAboveCssPx: 48,
    probeClipBelowCssPx: 240,
  },
  focus: {
    deviceScaleFactor: 2,
    captureSizeTolerancePx: 1,
    clipMarginCssPx: 12,
    maxTabStops: 300,
    maxForced: 100,
    maxTabsInOpaqueFrame: 50,
    maxTabsInElement: 10,
    settleFrames: 2,
    settleTimeoutMs: 250,
    fontsTimeoutMs: 3000,
    navigationTimeoutMs: 15000,
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
    maxNonHeadings: 50,
    sentenceBreakPattern:
      '(?<=(?:(?<!(?:^|[\\s.\\p{Ps}\\p{Pi}"\'])\\p{Lu}\\p{L}{0,2})\\.|[!?\\u061f\\u2026])(?:\\s?[\\p{Pe}\\p{Pf}"\'])*)\\s+(?=(?:[\\p{Ps}\\p{Pi}"\'\\u00bf\\u00a1]\\s?)*[\\p{Lu}\\p{Lo}])|(?<=[\\u3002\\uff01\\uff1f\\uff0e][\\p{Pe}\\p{Pf}]*)(?=[^\\s\\p{Pe}\\p{Pf}\\u3002\\uff01\\uff1f\\uff0e])',
    sentenceMinWords: 3,
    runningTextMinSentences: 3,
    runningTextMinWords: 25,
    questionEndPattern: '[?\\uff1f\\u061f][\\s\\p{Pe}\\p{Pf}"\']*$',
    numberOnlyMaxWords: 3,
    numberOnlyMinShare: 0.6,
    bodyStyleMaxWeightDelta: 100,
    headsNothingMaxGapEm: 1.5,
    longHeadingMinWords: 40,
    quotationMinWords: 8,
    quoteEndPattern: '["\\u00bb\\u203a\\u201d\\u300d\\u300f]\\s?[.!?\\u2026]?$',
    headingRunMinLength: 3,
    unspacedScriptPattern: '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}]',
    unspacedCharsPerWord: 3,
  },
  lists: {
    lineStartChars: 64,
    lineEndChars: 8,
    maxAncestorLevels: 6,
    markerAncestorLevels: 3,
    maxGroups: 400,
    maxGroupItems: 40,
    maxGroupParents: 5000,
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
    quotePrefixPattern: '^>',
    symbolBulletPattern: '^[\\u2190-\\u21ff\\u2b00-\\u2bff\\u25b2-\\u25c5\\u2600-\\u27bf\\u{1f300}-\\u{1faff}]',
    figureStartPattern: '^(?:\\p{Sc}\\s?\\p{Nd}|\\p{Nd}+(?:[.,\\s]\\p{Nd}+)*\\s?[%\\u2030\\u00b0\\u2032\\u2033\\p{Sc}])',
    sentenceEndPattern: '[.!?\\u2026\\u3002\\uff0e\\uff01\\uff1f\\u061f\\u06d4\\u0964][\\p{Pe}\\p{Pf}"\']*$',
    itemSeparatorEndPattern: '[;,\\uff1b\\uff0c\\u3001\\u060c\\u061b]$',
    initialNamePattern: '^\\p{Lu}\\.\\s+\\p{Lu}[\\p{L}\\p{M}\'\\u2019-]*\\s*(?:$|[,;:(/\\u2013\\u2014-])',
    loneMarkerMaxChars: 4,
    pseudoBulletPattern:
      '^[-\\u2010-\\u2013*\\u00b7>\\u203a\\u00bb~+\\u2022\\u2023\\u2043\\u204c\\u204d\\u2219\\u25a0-\\u25ff\\u2600-\\u27bf\\u2b00-\\u2bff\\u2190-\\u21ff\\u30fb\\uff65\\u203b\\u{1f300}-\\u{1faff}]\\ufe0f?$',
    iconGlyphPattern: '^[\\ue000-\\uf8ff\\u{f0000}-\\u{ffffd}\\u{100000}-\\u{10fffd}]+$',
    numberPattern: '^[(\\[]?(\\p{Nd}{1,3}(?:\\.\\p{Nd}{1,3}){0,3})(?:[.)\\]/\\u00b0]\\s+|[\\uff0e\\u3001\\uff09]\\s*)',
    letterPattern: '^\\(?(\\p{L})([.)])\\s+',
    romanPattern: '^\\(?([ivxlcdm]{1,7}|[IVXLCDM]{1,7})[.)]\\s+',
    ideographicNumberPattern: '^([\\u4e00\\u4e8c\\u4e09\\u56db\\u4e94\\u516d\\u4e03\\u516b\\u4e5d\\u5341]{1,3})[\\u3001\\uff0e.\\uff09)]\\s*',
    enclosedNumberPattern: '^([\\u2460-\\u249b\\u2776-\\u277f])\\s*',
    firstLetters: 'aA\u03b1\u0391\u0430\u0410\u05d0\uff41\uff21',
    letterSequences: [
      'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん',
      'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン',
      'いろはにほへとちりぬるをわかよたれそつねならむうゐのおくやまけふこえてあさきゆめみしゑひもせす',
      'イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセス',
      '가나다라마바사아자차카타파하',
    ],
    numericMinDigitShare: 0.5,
    minItems: 2,
    weakMinItems: 3,
    symbolMinItems: 3,
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
    keyMaxWords: 4,
    keySeparatorChars: ':\uff1a',
    keyValueLinePattern: '^([^:\\uff1a]{1,48}?)(?:\\s?:\\s+|\\uff1a\\s*)\\S',
    keyEndPattern: '[:\\uff1a]$',
  },
  grouping: {
    maxControls: 600,
    maxAxMarks: 1500,
    maxNameChars: 160,
    maxLabelTargets: 8,
    maxAncestorLevels: 8,
    maxCandidates: 150,
    maxCaptures: 120,
    clipMarginCssPx: 16,
    minControlSizeCssPx: 4,
    minSetSize: 2,
    maxSetSize: 40,
    labelMaxGapEm: 3,
    labelInlineMaxGapEm: 20,
    labelMaxChars: 160,
    labelMaxLines: 3,
    labelSentenceEndPattern: '[.\\u3002\\uff0e\\uff61\\u06d4\\u0964\\u0589\\u1362\\u104b\\u17d4!\\uff01\\u2026][\\p{Pe}\\p{Pf}"\']*$',
    labelSentenceMinWords: 3,
    unspacedScriptPattern: '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}]',
    unspacedCharsPerWord: 3,
    labelNotePattern: '^[(\\[]?[*\\uff0a\\u2020\\u2021][)\\]]?\\s*[=:\\u2013\\u2014-]?\\s*[\\p{L}\\p{N}]',
    labelLineMaxGapEm: 1.5,
    labelMaxSkipped: 2,
    hintNearerShare: 0.5,
    sameRowMinOverlap: 0.5,
    toleranceCssPx: 3,
    shortNameMaxWords: 2,
    shortNameMaxChars: 24,
    ambiguousMinShare: 0.5,
    nameTrimPattern: '^[\\s*\\uff0a]+|[\\s:\\uff1a*\\uff0a]+$',
    groupExtraControlsMax: 1,
    splitMaxGapEm: 2,
    splitMaxParts: 6,
    duplicateMinShared: 2,
    headingLabelStatus: 'advisory',
    duplicateUnderHeadingsStatus: 'likely',
    messageItems: 4,
    itemTextMaxChars: 60,
    contextMaxItems: 12,
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
    headingDisagreeStatus: 'likely',
    listDisagreeStatus: 'likely',
    groupDisagreeStatus: 'likely',
  },
  baseline: {
    stripFragment: true,
    sortQuery: false,
    stripTrailingSlash: false,
    dropQueryParams: [],
  },
  run: {
    maxUrls: 200,
    sameOrigin: true,
    // What the sitemap protocol allows for one file, uncompressed.
    maxInputBytes: 52428800,
    maxSitemaps: 50,
    sitemapTimeoutMs: 30000,
    // The default of Playwright for a navigation.
    navigationTimeoutMs: 30000,
    httpErrorIsFailure: true,
    sarifMaxResults: 25000,
    sitemapMaxDepth: 16,
    minSecretChars: 8,
    // Names that say what they hold. Short on purpose: a parameter that is dropped from the key
    // of a page makes two addresses one page.
    redactQueryParams: ['access_token', 'api_key', 'apikey', 'auth', 'code', 'id_token', 'key', 'password', 'refresh_token', 'secret', 'sig', 'signature', 'token'],
  },
  selector: {
    // React useId (:r1:, «r1», _r_1_), react-aria, Headless UI, Radix, MUI, Ember, a UUID, and
    // any run of three digits or more.
    unstableIdPattern:
      '^(?:react-aria|headlessui-|radix-|mui-\\d|ember\\d+$)|:[rR][0-9a-zA-Z]*:|\\u00ab[rR][0-9a-zA-Z]*\\u00bb|^_[rR]_[0-9a-zA-Z]+_$|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-|\\d{3,}',
    stableAttributes: ['data-testid', 'data-test', 'data-cy', 'name'],
    signatureMaxTextChars: 200,
    signatureAttributes: ['aria-label', 'title', 'alt', 'name', 'type', 'for', 'placeholder', 'href', 'src', 'action'],
  },
};

/**
 * Deprecated names of three options of the adjudicator layer, still read: `headingNoStatus`,
 * `listNoStatus` and `groupNoStatus` are `headingDisagreeStatus`, `listDisagreeStatus` and
 * `groupDisagreeStatus`. The old names said "no", and for a heading reported as not reading as
 * one the verdict that speaks against the finding is "yes". Where both names are given, the new
 * one is used.
 */
export interface DeprecatedAdjudicationOptions {
  /** @deprecated Use `headingDisagreeStatus`. */
  headingNoStatus?: 'info' | 'likely';
  /** @deprecated Use `listDisagreeStatus`. */
  listNoStatus?: 'info' | 'likely';
  /** @deprecated Use `groupDisagreeStatus`. */
  groupNoStatus?: 'info' | 'likely';
}
export type AdjudicationInput = Partial<AdjudicationConfig> & DeprecatedAdjudicationOptions;

export type ConfigInput = {
  checks?: CheckId[];
  nameRoleValue?: Partial<NameRoleValueConfig>;
  focus?: Partial<FocusConfig>;
  icon?: Partial<IconConfig>;
  headings?: Partial<HeadingsConfig>;
  lists?: Partial<ListsConfig>;
  grouping?: Partial<GroupingConfig>;
  adjudication?: AdjudicationInput;
  baseline?: Partial<BaselineConfig>;
  run?: Partial<RunConfig>;
  selector?: Partial<SelectorConfig>;
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

/**
 * The status of a set of controls whose visible label is a heading or the button that opens it,
 * whatever was configured: `advisory` or `likely` and never `fail`. A configured `fail` becomes
 * `likely`, anything else that is not one of the two becomes the default.
 */
export function clampHeadingLabelStatus(value: unknown): 'advisory' | 'likely' {
  return clampInversionStatus(value, 'advisory');
}

/**
 * The status of sections with the same field names under headings, whatever was configured:
 * `likely` (section 3E of the brief) or `advisory`, and never `fail`. A configured `fail` and
 * anything else that is not one of the two become `likely`.
 */
export function clampDuplicateUnderHeadingsStatus(value: unknown): 'advisory' | 'likely' {
  return clampInversionStatus(value, 'likely');
}

/** Resource types that are never fetched for a copy after an activation (see `NameRoleValueConfig.probeAllowedResourceTypes`). */
const NEVER_FETCHED_TYPES: readonly string[] = ['Document', 'Fetch', 'XHR', 'Ping', 'EventSource', 'WebSocket', 'Other', 'Prefetch', 'SignedExchange', 'CSPViolationReport', 'Preflight'];

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
 * depends on a model is `likely` at most (`headingDisagreeStatus`, `listDisagreeStatus` and `groupDisagreeStatus` take `info` or `likely` only).
 * Their former names (`DeprecatedAdjudicationOptions`) are read where the new one is not given.
 */
export function resolveAdjudication(input: AdjudicationInput = {}): AdjudicationConfig {
  const base = defaultConfig.adjudication;
  const { headingNoStatus, listNoStatus, groupNoStatus, ...current } = input;
  const merged = { ...base, ...current };
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
    headingDisagreeStatus: oneOf(current.headingDisagreeStatus ?? headingNoStatus, ['info', 'likely'], base.headingDisagreeStatus),
    listDisagreeStatus: oneOf(current.listDisagreeStatus ?? listNoStatus, ['info', 'likely'], base.listDisagreeStatus),
    groupDisagreeStatus: oneOf(current.groupDisagreeStatus ?? groupNoStatus, ['info', 'likely'], base.groupDisagreeStatus),
  };
}

export function resolveConfig(input: ConfigInput = {}): Config {
  const headings = { ...defaultConfig.headings, ...input.headings };
  headings.inversionStatus = clampInversionStatus(headings.inversionStatus, defaultConfig.headings.inversionStatus);
  headings.extremeInversionStatus = clampInversionStatus(headings.extremeInversionStatus, defaultConfig.headings.extremeInversionStatus);
  const lists = { ...defaultConfig.lists, ...input.lists };
  lists.cardListStatus = clampCardListStatus(lists.cardListStatus);
  const grouping = { ...defaultConfig.grouping, ...input.grouping };
  grouping.headingLabelStatus = clampHeadingLabelStatus(grouping.headingLabelStatus);
  grouping.duplicateUnderHeadingsStatus = clampDuplicateUnderHeadingsStatus(grouping.duplicateUnderHeadingsStatus);
  return {
    checks: input.checks ? [...new Set(input.checks)] : [...defaultConfig.checks],
    nameRoleValue: resolveNameRoleValue(input.nameRoleValue),
    focus: { ...defaultConfig.focus, ...input.focus },
    icon: { ...defaultConfig.icon, ...input.icon },
    headings,
    lists,
    grouping,
    adjudication: resolveAdjudication(input.adjudication),
    baseline: resolveBaselineConfig(input.baseline),
    run: resolveRun(input.run),
    selector: resolveSelector(input.selector),
  };
}

/** A regular expression with the `iu` flags, or the default when the value is not one. */
function pattern(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  try {
    new RegExp(value, 'iu');
    return value;
  } catch {
    return fallback;
  }
}

/**
 * Settings of the name-role-value check, whatever was given: a configuration can come from a JSON
 * file. Statuses take only the values their option allows (`behaviourRoleStatus`: `likely` or
 * `fail`; the status of a name from a title or a placeholder: `advisory` or `info`), numbers are
 * numbers within their range, patterns are regular expressions.
 */
export function resolveNameRoleValue(input: Partial<NameRoleValueConfig> = {}): NameRoleValueConfig {
  const base = defaultConfig.nameRoleValue;
  const merged = { ...base, ...input };
  const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
  const share = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback);
  return {
    probe: oneOf(merged.probe, ['safe', 'off'], base.probe),
    includeAxeCovered: flag(merged.includeAxeCovered, base.includeAxeCovered),
    behaviourRoleStatus: oneOf(merged.behaviourRoleStatus, ['likely', 'fail'], base.behaviourRoleStatus),
    maxElements: atLeast(merged.maxElements, 1, base.maxElements),
    maxListenerElements: atLeast(merged.maxListenerElements, 0, base.maxListenerElements),
    maxNameChars: atLeast(merged.maxNameChars, 8, base.maxNameChars),
    itemTextMaxChars: atLeast(merged.itemTextMaxChars, 8, base.itemTextMaxChars),
    maxCandidates: atLeast(merged.maxCandidates, 1, base.maxCandidates),
    maxCaptures: atLeast(merged.maxCaptures, 0, base.maxCaptures),
    clipMarginCssPx: atLeast(merged.clipMarginCssPx, 0, base.clipMarginCssPx, false),
    maxControlAreaShare: share(merged.maxControlAreaShare, base.maxControlAreaShare),
    genericNamePattern: pattern(merged.genericNamePattern, base.genericNamePattern),
    classLikeNamePattern: pattern(merged.classLikeNamePattern, base.classLikeNamePattern),
    fileNamePattern: pattern(merged.fileNamePattern, base.fileNamePattern),
    urlNamePattern: pattern(merged.urlNamePattern, base.urlNamePattern),
    privateUsePattern: pattern(merged.privateUsePattern, base.privateUsePattern),
    titleOnlyStatus: oneOf(merged.titleOnlyStatus, ['advisory', 'info'], base.titleOnlyStatus),
    placeholderOnlyStatus: oneOf(merged.placeholderOnlyStatus, ['advisory', 'info'], base.placeholderOnlyStatus),
    tabWalk: flag(merged.tabWalk, base.tabWalk),
    maxTabStops: atLeast(merged.maxTabStops, 1, base.maxTabStops),
    maxProbes: atLeast(merged.maxProbes, 0, base.maxProbes),
    probeBudgetMs: duration(merged.probeBudgetMs, 0, base.probeBudgetMs),
    probeSettleMs: duration(merged.probeSettleMs, 0, base.probeSettleMs),
    activationQuietMs: duration(merged.activationQuietMs, 0, base.activationQuietMs),
    activationQuietMaxMs: duration(merged.activationQuietMaxMs, 0, base.activationQuietMaxMs),
    probeExcludeSelector: typeof merged.probeExcludeSelector === 'string' ? merged.probeExcludeSelector.trim() : base.probeExcludeSelector,
    probeReads: oneOf(merged.probeReads, ['cache', 'network'], base.probeReads),
    // A navigation, a script's own request, a beacon, a stream or a socket is never fetched, whatever the list says.
    probeAllowedResourceTypes: names(merged.probeAllowedResourceTypes, base.probeAllowedResourceTypes).filter(
      (type) => !NEVER_FETCHED_TYPES.includes(type) && /^[A-Za-z]+$/.test(type),
    ),
    probeAllowQueryStrings: flag(merged.probeAllowQueryStrings, base.probeAllowQueryStrings),
    probeConfirmToggle: flag(merged.probeConfirmToggle, base.probeConfirmToggle),
    maxProbeLoads: atLeast(merged.maxProbeLoads, 0, base.maxProbeLoads),
    probeLoadTimeoutMs: duration(merged.probeLoadTimeoutMs, 1, base.probeLoadTimeoutMs),
    probeStepTimeoutMs: duration(merged.probeStepTimeoutMs, 1, base.probeStepTimeoutMs),
    probeUnloadGraceMs: duration(merged.probeUnloadGraceMs, 0, base.probeUnloadGraceMs),
    probeCloneMinMatchShare: share(merged.probeCloneMinMatchShare, base.probeCloneMinMatchShare),
    probeCloneMaxMissingShare: share(merged.probeCloneMaxMissingShare, base.probeCloneMaxMissingShare),
    probeCloneMaxCountDelta: share(merged.probeCloneMaxCountDelta, base.probeCloneMaxCountDelta),
    probeCacheMaxBytes: atLeast(merged.probeCacheMaxBytes, 0, base.probeCacheMaxBytes),
    generatedTextNameStatus: oneOf(merged.generatedTextNameStatus, ['likely', 'advisory'], base.generatedTextNameStatus),
    ownChangeMinAreaCssPx2: atLeast(merged.ownChangeMinAreaCssPx2, 0, base.ownChangeMinAreaCssPx2, false),
    revealMinAreaCssPx2: atLeast(merged.revealMinAreaCssPx2, 0, base.revealMinAreaCssPx2, false),
    maxVisibilityElements: atLeast(merged.maxVisibilityElements, 0, base.maxVisibilityElements),
    regionMaxAncestorLevels: atLeast(merged.regionMaxAncestorLevels, 1, base.regionMaxAncestorLevels),
    quietMs: duration(merged.quietMs, 0, base.quietMs),
    quietMaxMs: duration(merged.quietMaxMs, 0, base.quietMaxMs),
    probeClipSideCssPx: atLeast(merged.probeClipSideCssPx, 0, base.probeClipSideCssPx, false),
    probeClipAboveCssPx: atLeast(merged.probeClipAboveCssPx, 0, base.probeClipAboveCssPx, false),
    probeClipBelowCssPx: atLeast(merged.probeClipBelowCssPx, 0, base.probeClipBelowCssPx, false),
  };
}

/** A list of non-empty strings without repeats, or the default when the value is not a list. */
function names(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return [...new Set(value.filter((name): name is string => typeof name === 'string' && name.trim() !== '').map((name) => name.trim()))];
}

/**
 * The settings for selectors and signatures, whatever was given. A pattern that is not a regular
 * expression is put back to the default: a typo must not bring generated ids back into a baseline.
 */
export function resolveSelector(input: Partial<SelectorConfig> = {}): SelectorConfig {
  const base = defaultConfig.selector;
  let unstableIdPattern = typeof input.unstableIdPattern === 'string' ? input.unstableIdPattern : base.unstableIdPattern;
  try {
    new RegExp(unstableIdPattern, 'u');
  } catch {
    unstableIdPattern = base.unstableIdPattern;
  }
  // An attribute name goes into a selector as it is: only names that need no escaping are taken.
  const attribute = /^[A-Za-z_][\w.-]*$/;
  return {
    unstableIdPattern,
    stableAttributes: names(input.stableAttributes, base.stableAttributes).filter((name) => attribute.test(name)),
    signatureMaxTextChars: atLeast(input.signatureMaxTextChars, 0, base.signatureMaxTextChars),
    signatureAttributes: names(input.signatureAttributes, base.signatureAttributes).filter((name) => attribute.test(name)),
  };
}

/** The settings of the baseline key, whatever was given: booleans are booleans and the names are strings. */
export function resolveBaselineConfig(input: Partial<BaselineConfig> = {}): BaselineConfig {
  const base = defaultConfig.baseline;
  const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
  const names = Array.isArray(input.dropQueryParams) ? input.dropQueryParams.filter((name): name is string => typeof name === 'string' && name !== '') : base.dropQueryParams;
  return {
    stripFragment: flag(input.stripFragment, base.stripFragment),
    sortQuery: flag(input.sortQuery, base.sortQuery),
    stripTrailingSlash: flag(input.stripTrailingSlash, base.stripTrailingSlash),
    dropQueryParams: [...new Set(names)].sort(),
  };
}

function resolveRun(input: Partial<RunConfig> = {}): RunConfig {
  const base = defaultConfig.run;
  /** A whole number of at least `min`, or the default: a limit is never switched off by a bad value. */
  const count = (value: unknown, fallback: number, min = 1): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= min ? value : fallback;
  return {
    maxUrls: count(input.maxUrls, base.maxUrls),
    sameOrigin: typeof input.sameOrigin === 'boolean' ? input.sameOrigin : base.sameOrigin,
    maxInputBytes: count(input.maxInputBytes, base.maxInputBytes),
    maxSitemaps: count(input.maxSitemaps, base.maxSitemaps),
    sitemapTimeoutMs: count(input.sitemapTimeoutMs, base.sitemapTimeoutMs),
    navigationTimeoutMs: count(input.navigationTimeoutMs, base.navigationTimeoutMs),
    httpErrorIsFailure: typeof input.httpErrorIsFailure === 'boolean' ? input.httpErrorIsFailure : base.httpErrorIsFailure,
    // Never above what GitHub accepts.
    sarifMaxResults: Math.min(count(input.sarifMaxResults, base.sarifMaxResults), base.sarifMaxResults),
    sitemapMaxDepth: count(input.sitemapMaxDepth, base.sitemapMaxDepth, 3),
    minSecretChars: count(input.minSecretChars, base.minSecretChars),
    redactQueryParams: [...new Set(names(input.redactQueryParams, base.redactQueryParams).map((name) => name.toLowerCase()))],
  };
}
