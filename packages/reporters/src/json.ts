import { EXTENSION_KEY } from '@a11y-vision/core';
import type { BaselineState, BaselineSummary, Finding, ScanResult } from '@a11y-vision/core';
import { countRun } from './run.js';
import type { InputNotes, PageError, Run, RunCounts } from './run.js';

/** One rule with the nodes it fired on, in the shape of an axe result entry. */
export interface AxeRuleResult {
  id: string;
  impact: null;
  tags: string[];
  description: string;
  help: string;
  helpUrl: string;
  /** `baseline` is there only on a `fail` of a run compared with a baseline file. */
  nodes: { target: string[]; html: string; impact: null; failureSummary: string; findingId: string; baseline?: BaselineState }[];
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
  [EXTENSION_KEY]: Pick<ScanResult, 'environment' | 'findings'> & {
    /** Present when the run was compared with a baseline file. */
    baseline?: BaselineSummary;
    /** In a report of several pages: the address that was asked for, and where the captures of the page are. */
    requestedUrl?: string;
    cropsDir?: string;
  };
}

/**
 * The report of a run over several pages: one report in the shape above per page, in the order
 * the pages were given, and what is about the run as a whole under the extension key. A scan of
 * one address given on the command line keeps the single-page shape.
 */
export interface JsonRunReport {
  testEngine: { name: string; version: string };
  timestamp: string;
  pages: JsonReport[];
  [EXTENSION_KEY]: {
    summary: RunCounts;
    /** Pages that could not be scanned. They are in no other list: nothing is known about them. */
    errors: PageError[];
    baseline?: BaselineSummary;
    input?: InputNotes;
  };
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
      ...(finding.baseline ? { baseline: finding.baseline } : {}),
    });
  }
  return [...groups.values()];
}

export function toJsonReport(result: ScanResult, extra: { baseline?: BaselineSummary; requestedUrl?: string; cropsDir?: string } = {}): JsonReport {
  return {
    testEngine: { ...result.tool },
    url: result.url,
    timestamp: result.timestamp,
    violations: groupByRule(result.findings.filter((f) => f.status === 'fail')),
    incomplete: groupByRule(result.findings.filter((f) => f.status === 'likely')),
    passes: [],
    inapplicable: [],
    [EXTENSION_KEY]: {
      environment: result.environment,
      findings: result.findings,
      ...(extra.baseline ? { baseline: extra.baseline } : {}),
      ...(extra.requestedUrl !== undefined ? { requestedUrl: extra.requestedUrl } : {}),
      ...(extra.cropsDir !== undefined ? { cropsDir: extra.cropsDir } : {}),
    },
  };
}

export function toJsonRunReport(run: Run): JsonRunReport {
  return {
    testEngine: { ...run.tool },
    timestamp: run.timestamp,
    pages: run.pages.map((page) => toJsonReport(page.result, { requestedUrl: page.requestedUrl, ...(page.cropsDir !== undefined ? { cropsDir: page.cropsDir } : {}) })),
    [EXTENSION_KEY]: {
      summary: countRun(run),
      errors: run.errors.map((error) => ({ url: error.url, message: error.message })),
      ...(run.baseline ? { baseline: run.baseline } : {}),
      ...(run.input ? { input: run.input } : {}),
    },
  };
}
