import type { CheckId, Config } from './types.js';

/**
 * Every threshold and default of the tool lives in this object.
 * Check code reads from Config and never carries its own numbers.
 */
export const defaultConfig: Config = {
  // M0: only the harness check exists. Real checks replace it as milestones land.
  checks: ['noop'],
};

export type ConfigInput = { checks?: CheckId[] };

export function resolveConfig(input: ConfigInput = {}): Config {
  return {
    checks: input.checks ? [...new Set(input.checks)] : [...defaultConfig.checks],
  };
}
