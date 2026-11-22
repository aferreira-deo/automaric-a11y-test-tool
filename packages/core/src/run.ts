import { focusIndicatorCheck } from './checks/focus-indicator.js';
import { headingsCheck } from './checks/headings.js';
import { iconContrastCheck } from './checks/icon-contrast.js';
import { noopCheck } from './checks/noop.js';
import { fingerprint } from './fingerprint.js';
import { TOOL_NAME, TOOL_VERSION } from './meta.js';
import type { Check, CheckId, Config, Finding, ScanResult, Snapshot } from './types.js';

const registry = new Map<CheckId, Check>([
  [noopCheck.id, noopCheck],
  [focusIndicatorCheck.id, focusIndicatorCheck],
  [iconContrastCheck.id, iconContrastCheck],
  [headingsCheck.id, headingsCheck],
]);

export function registeredChecks(): CheckId[] {
  return [...registry.keys()];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The order of findings in a result. Sorts in place and returns the array. */
export function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort(
    (a, b) =>
      compare(a.check, b.check) ||
      compare(a.frame, b.frame) ||
      compare(a.selector, b.selector) ||
      compare(a.rule, b.rule) ||
      compare(a.id, b.id),
  );
}

/** Runs the configured checks. Output order is independent of check order and collection order. */
export function runChecks(snapshot: Snapshot, config: Config): Finding[] {
  const findings: Finding[] = [];
  for (const id of config.checks) {
    const check = registry.get(id);
    if (!check) throw new Error(`Unknown check "${id}". Available: ${registeredChecks().join(', ')}`);
    for (const { fingerprintRule, ...draft } of check.evaluate(snapshot, config)) {
      findings.push({ id: fingerprint({ ...draft, rule: fingerprintRule ?? draft.rule }), ...draft });
    }
  }
  return sortFindings(findings);
}

export function buildResult(snapshot: Snapshot, config: Config, now: Date): ScanResult {
  return {
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    url: snapshot.environment.url,
    timestamp: now.toISOString(),
    environment: snapshot.environment,
    findings: runChecks(snapshot, config),
  };
}

/** Only `fail` can break a build. */
export function hasFailures(result: ScanResult): boolean {
  return result.findings.some((f) => f.status === 'fail');
}
