import { focusIndicatorCheck } from './checks/focus-indicator.js';
import { groupingCheck } from './checks/grouping.js';
import { headingsCheck } from './checks/headings.js';
import { iconContrastCheck } from './checks/icon-contrast.js';
import { listsCheck } from './checks/lists.js';
import { nameRoleValueCheck } from './checks/name-role-value.js';
import { noopCheck } from './checks/noop.js';
import { fingerprint, signatureKey } from './fingerprint.js';
import { TOOL_NAME, TOOL_VERSION } from './meta.js';
import type { Check, CheckId, Config, Finding, ScanResult, Snapshot } from './types.js';

const registry = new Map<CheckId, Check>([
  [noopCheck.id, noopCheck],
  [focusIndicatorCheck.id, focusIndicatorCheck],
  [iconContrastCheck.id, iconContrastCheck],
  [headingsCheck.id, headingsCheck],
  [listsCheck.id, listsCheck],
  [groupingCheck.id, groupingCheck],
  [nameRoleValueCheck.id, nameRoleValueCheck],
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
      const { check: checkId, rule, status, wcag, selector, frame, ...rest } = draft;
      // What the collector said the element at this selector is; nothing when it said nothing.
      const signature = snapshot.signatures?.[signatureKey(frame, selector)] ?? '';
      findings.push({ id: fingerprint({ ...draft, rule: fingerprintRule ?? rule }), check: checkId, rule, status, wcag, selector, frame, signature, ...rest });
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
