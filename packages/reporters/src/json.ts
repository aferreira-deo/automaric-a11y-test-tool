import { EXTENSION_KEY } from '@a11y-vision/core';
import type { Finding, ScanResult } from '@a11y-vision/core';

/** One rule with the nodes it fired on, in the shape of an axe result entry. */
export interface AxeRuleResult {
  id: string;
  impact: null;
  tags: string[];
  description: string;
  help: string;
  helpUrl: string;
  nodes: { target: string[]; html: string; impact: null; failureSummary: string; findingId: string }[];
}

export interface JsonReport {
  testEngine: { name: string; version: string };
  url: string;
  timestamp: string;
  /** `fail` findings. */
  violations: AxeRuleResult[];
  /** `likely` findings: they need a tester, which is what axe calls incomplete. */
  incomplete: AxeRuleResult[];
  /** Always empty: the tool makes no pass or conformance statement. */
  passes: AxeRuleResult[];
  inapplicable: AxeRuleResult[];
  /** All findings, including `advisory` and `info`, which have no axe equivalent. */
  [EXTENSION_KEY]: Pick<ScanResult, 'environment' | 'findings'>;
}

function groupByRule(findings: Finding[]): AxeRuleResult[] {
  const groups = new Map<string, AxeRuleResult>();
  for (const finding of findings) {
    let group = groups.get(finding.rule);
    if (!group) {
      group = {
        id: finding.rule,
        impact: null,
        // Same tag form axe uses for a success criterion: 2.4.7 -> wcag247
        tags: finding.wcag ? [`wcag${finding.wcag.sc.replaceAll('.', '')}`] : [],
        description: finding.help,
        help: finding.help,
        helpUrl: '',
        nodes: [],
      };
      groups.set(finding.rule, group);
    }
    group.nodes.push({
      target: [finding.selector],
      html: '',
      impact: null,
      failureSummary: finding.message,
      findingId: finding.id,
    });
  }
  return [...groups.values()];
}

export function toJsonReport(result: ScanResult): JsonReport {
  return {
    testEngine: { ...result.tool },
    url: result.url,
    timestamp: result.timestamp,
    violations: groupByRule(result.findings.filter((f) => f.status === 'fail')),
    incomplete: groupByRule(result.findings.filter((f) => f.status === 'likely')),
    passes: [],
    inapplicable: [],
    [EXTENSION_KEY]: { environment: result.environment, findings: result.findings },
  };
}
