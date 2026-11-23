import type { CheckId, Finding, Status } from '@a11y-vision/core';
import { decisionFor } from './decisions.js';
import type { DecisionEntry, PageDecisions } from './decisions.js';
import { CHECKS } from './settings.js';

/**
 * What the panel shows, worked out from what it holds. Pure functions over data: nothing here
 * touches the DOM or `chrome.*`, so the same views can feed another renderer.
 */

export const STATUS_ORDER: readonly Status[] = ['fail', 'likely', 'advisory', 'info'];

/** The status of a finding when it is one of the four; `info` otherwise: an unknown status is never shown as a failure. */
export function statusOf(finding: Pick<Finding, 'status'>): Status {
  return STATUS_ORDER.includes(finding.status) ? finding.status : 'info';
}

export type GroupBy = 'status' | 'check';
export type ShowFilter = 'all' | 'to-review' | 'confirmed' | 'dismissed';

export interface FindingItem {
  finding: Finding;
  entry: DecisionEntry | undefined;
}

export interface FindingGroup {
  /** A status or a check id. */
  key: string;
  by: GroupBy;
  items: FindingItem[];
}

export function matchesFilter(entry: DecisionEntry | undefined, show: ShowFilter): boolean {
  const decision = entry?.decision ?? null;
  if (show === 'to-review') return decision === null;
  if (show === 'confirmed') return decision === 'confirmed';
  if (show === 'dismissed') return decision === 'dismissed';
  return true;
}

/**
 * The findings as the queue shows them: in groups by status (fail first) or by check (in the
 * order the checks are listed), each group in the order the other one gives, then in the order
 * of the result. Groups without a finding to show are left out.
 */
export function groupFindings(findings: readonly Finding[], decisions: PageDecisions | null, by: GroupBy, show: ShowFilter): FindingGroup[] {
  const checkOrder: readonly string[] = CHECKS;
  const rank = (finding: Finding): [number, number] => {
    const status = STATUS_ORDER.indexOf(statusOf(finding));
    const at = checkOrder.indexOf(finding.check);
    const check = at === -1 ? checkOrder.length : at;
    return by === 'status' ? [status, check] : [check, status];
  };
  const items = findings
    .map((finding, index) => ({ finding, entry: decisionFor(decisions, finding), index, rank: rank(finding) }))
    .filter((item) => matchesFilter(item.entry, show))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.index - b.index);
  const groups: FindingGroup[] = [];
  for (const { finding, entry } of items) {
    const key = by === 'status' ? statusOf(finding) : finding.check;
    let group = groups.at(-1);
    if (!group || group.key !== key) groups.push((group = { key, by, items: [] }));
    group.items.push({ finding, entry });
  }
  return groups;
}

export function countStatuses(findings: readonly Finding[]): Record<Status, number> {
  const counts: Record<Status, number> = { fail: 0, likely: 0, advisory: 0, info: 0 };
  for (const finding of findings) counts[statusOf(finding)] += 1;
  return counts;
}

/** The checks to run, from what is ticked: those the panel offers, in its order. */
export function selectedChecks(ticked: readonly string[]): CheckId[] {
  return CHECKS.filter((check) => ticked.includes(check));
}
