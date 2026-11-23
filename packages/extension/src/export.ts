import { EXTENSION_KEY } from '@a11y-vision/core';
import type { Config, Png, ScanResult } from '@a11y-vision/core';
import { toHtmlReport, toJsonReport, toSarifReport } from '@a11y-vision/reporters';
import type { JsonReport } from '@a11y-vision/reporters';
import { decisionFor } from './decisions.js';
import type { Decision, PageDecisions } from './decisions.js';

/** One decision of the auditor in an export. */
export interface ExportedDecision {
  findingId: string;
  /** Signature of the element the decision was made on. */
  signature: string;
  decision: Decision | null;
  note: string;
  at: string;
}

/** What the extension adds to the JSON report of the CLI, under the tool's extension key. */
export interface ReviewBlock {
  /** Where the decisions were made. */
  source: 'extension';
  /** One entry per finding of this report the auditor decided on or wrote a note for, in the order of the findings. */
  decisions: ExportedDecision[];
}

export type ExtensionJsonReport = JsonReport & { [EXTENSION_KEY]: JsonReport[typeof EXTENSION_KEY] & { review: ReviewBlock } };

/**
 * The JSON report in the shape the CLI writes for one page, with the auditor's decisions under
 * the extension key (`review`). Only decisions on findings of this result are in it. Nothing of
 * the settings is: no endpoint, no key.
 */
export function toExtensionJson(result: ScanResult, decisions: PageDecisions | null): ExtensionJsonReport {
  const report = toJsonReport(result);
  const review: ReviewBlock = { source: 'extension', decisions: [] };
  for (const finding of result.findings) {
    const entry = decisionFor(decisions, finding);
    if (entry) review.decisions.push({ findingId: finding.id, signature: finding.signature, decision: entry.decision, note: entry.note, at: entry.at });
  }
  return { ...report, [EXTENSION_KEY]: { ...report[EXTENSION_KEY], review } };
}

export type ExportKind = 'json' | 'html' | 'sarif';

export interface ExportFile {
  name: string;
  type: string;
  text: string;
}

/** A file name from the host of the page and the time of the scan: letters, digits, dots and dashes only. */
export function exportName(result: Pick<ScanResult, 'url' | 'timestamp' | 'tool'>, extension: string): string {
  let host = 'page';
  try {
    host = new URL(result.url).hostname || 'page';
  } catch {
    // Not an address that can be parsed: the name does without the host.
  }
  const safe = (text: string): string => text.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '');
  const stamp = safe(result.timestamp.replace(/\.\d+Z$/, 'Z').replaceAll(':', ''));
  return [safe(result.tool.name), safe(host).slice(0, 80), stamp].filter((part) => part !== '').join('_') + `.${extension}`;
}

/** The file of one kind of export. The reporters are those of the CLI. */
export function exportFile(kind: ExportKind, result: ScanResult, crops: Record<string, Png>, decisions: PageDecisions | null, config: Config): ExportFile {
  switch (kind) {
    case 'json':
      return { name: exportName(result, 'json'), type: 'application/json', text: `${JSON.stringify(toExtensionJson(result, decisions), null, 2)}\n` };
    case 'html':
      return { name: exportName(result, 'html'), type: 'text/html', text: toHtmlReport(result, crops) };
    case 'sarif': {
      const run = { tool: result.tool, timestamp: result.timestamp, pages: [{ requestedUrl: result.url, result }], errors: [] };
      const { sarif } = toSarifReport(run, { maxResults: config.run.sarifMaxResults, urlKey: config.baseline, redactQueryParams: config.run.redactQueryParams });
      return { name: exportName(result, 'sarif'), type: 'application/sarif+json', text: `${JSON.stringify(sarif, null, 2)}\n` };
    }
  }
}
