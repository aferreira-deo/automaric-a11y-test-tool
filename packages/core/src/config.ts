import type { CheckId, Config, FocusConfig, IconConfig } from './types.js';

/**
 * Every threshold and default of the tool lives in this object.
 * Check code reads from Config and never carries its own numbers.
 * Each field is documented on its type in types.ts.
 */
export const defaultConfig: Config = {
  checks: ['focus-indicator', 'icon-contrast'],
  focus: {
    deviceScaleFactor: 2,
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
    minVisibleTextCssPx: 2,
    boundaryWrapperLevels: 3,
    boundaryWrapperSlackCssPx: 40,
    coverGrid: 3,
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
};

export type ConfigInput = { checks?: CheckId[]; focus?: Partial<FocusConfig>; icon?: Partial<IconConfig> };

export function resolveConfig(input: ConfigInput = {}): Config {
  return {
    checks: input.checks ? [...new Set(input.checks)] : [...defaultConfig.checks],
    focus: { ...defaultConfig.focus, ...input.focus },
    icon: { ...defaultConfig.icon, ...input.icon },
  };
}
