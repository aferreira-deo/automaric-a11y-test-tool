import type { CheckId, Config, FocusConfig } from './types.js';

/**
 * Every threshold and default of the tool lives in this object.
 * Check code reads from Config and never carries its own numbers.
 * Each field is documented on its type in types.ts.
 */
export const defaultConfig: Config = {
  checks: ['focus-indicator'],
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
};

export type ConfigInput = { checks?: CheckId[]; focus?: Partial<FocusConfig> };

export function resolveConfig(input: ConfigInput = {}): Config {
  return {
    checks: input.checks ? [...new Set(input.checks)] : [...defaultConfig.checks],
    focus: { ...defaultConfig.focus, ...input.focus },
  };
}
