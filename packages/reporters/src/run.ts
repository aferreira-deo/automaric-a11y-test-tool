import type { BaselineSummary, Finding, ScanResult, Status } from '@a11y-vision/core';

/** One page of a run over several pages. */
export interface RunPage {
  /** The address that was asked for. `result.url` is the address of the document that was read. */
  requestedUrl: string;
  result: ScanResult;
  /** Where the captures of this page are, relative to the directory given for captures. */
  cropsDir?: string;
}

/** A page that could not be scanned. It is reported, and the run goes on with the next one. */
export interface PageError {
  url: string;
  message: string;
}

/** What was left out of the list of pages before the run started, and why. All counts. */
export interface InputNotes {
  /** Sitemap entries on another origin than the sitemap. */
  otherOrigin: number;
  /** Entries beyond the limit of pages of a run. */
  overLimit: number;
  /** Addresses given more than once. */
  duplicates: number;
}

/**
 * What a reader of any report has to know about the list of pages, in words: at present, that a
 * sitemap was cut at the limit of pages. Empty when there is nothing to say.
 */
export function inputNote(input: InputNotes | undefined): string {
  return input && input.overLimit > 0
    ? `${input.overLimit} page(s) of the sitemap were NOT scanned: the sitemap lists more pages than the limit for a run (--max-urls or run.maxUrls raises it). Nothing is known about them.`
    : '';
}

export interface Run {
  tool: { name: string; version: string };
  /** ISO 8601, when the run started. */
  timestamp: string;
  pages: RunPage[];
  errors: PageError[];
  /** Present when the run was compared with a baseline file. */
  baseline?: BaselineSummary;
  input?: InputNotes;
}

export interface RunCounts {
  pages: number;
  errors: number;
  fail: number;
  likely: number;
  advisory: number;
  info: number;
  /** `fail` findings that are not recorded in a baseline: all of them when no baseline was used. */
  newFail: number;
  baselinedFail: number;
}

const STATUSES: readonly Status[] = ['fail', 'likely', 'advisory', 'info'];

/** The status of a finding when it is one of the four; `info` otherwise: an unknown status is never shown as a failure. */
export function statusOf(finding: Finding): Status {
  return STATUSES.includes(finding.status) ? finding.status : 'info';
}

export function countRun(run: Pick<Run, 'pages' | 'errors'>): RunCounts {
  const counts: RunCounts = { pages: run.pages.length, errors: run.errors.length, fail: 0, likely: 0, advisory: 0, info: 0, newFail: 0, baselinedFail: 0 };
  for (const page of run.pages) {
    for (const finding of page.result.findings) {
      const status = statusOf(finding);
      counts[status] += 1;
      if (status !== 'fail') continue;
      if (finding.baseline === 'baselined') counts.baselinedFail += 1;
      else counts.newFail += 1;
    }
  }
  return counts;
}
