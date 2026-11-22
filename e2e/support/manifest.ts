import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckId, Finding, Status } from '@a11y-vision/core';

export interface ExpectedFinding {
  selector: string;
  check: CheckId;
  status: Status;
  /** Success criterion number. Compared only when present. */
  wcag?: string;
  /** Compared only when present. */
  rule?: string;
  /** Iframe selector path. Compared only when present. */
  frame?: string;
  /** Evidence flags the finding must carry (it may carry others). */
  flags?: string[];
}

export interface Manifest {
  description: string;
  checks: CheckId[];
  expected: ExpectedFinding[];
  /** When true, unexpected `advisory` and `info` findings also fail the comparison. */
  exact?: boolean;
}

export interface Fixture {
  /** e.g. "noop/basic" */
  name: string;
  /** URL path under the fixture server, e.g. "/noop/basic.html" */
  path: string;
  manifest: Manifest;
}

export const fixturesRoot = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const MANIFEST_SUFFIX = '.expected.json';

export function loadFixtures(root: string = fixturesRoot): Fixture[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith(MANIFEST_SUFFIX))
    .map((file) => {
      const name = file.replaceAll('\\', '/').slice(0, -MANIFEST_SUFFIX.length);
      const manifest = JSON.parse(readFileSync(join(root, file), 'utf8')) as Manifest;
      return { name, path: `/${name}.html`, manifest };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

function matches(finding: Finding, expected: ExpectedFinding): boolean {
  return (
    finding.selector === expected.selector &&
    finding.check === expected.check &&
    finding.status === expected.status &&
    (expected.wcag === undefined || finding.wcag?.sc === expected.wcag) &&
    (expected.rule === undefined || finding.rule === expected.rule) &&
    (expected.frame === undefined || finding.frame === expected.frame) &&
    (expected.flags ?? []).every((flag) => finding.evidence.flags.includes(flag))
  );
}

export interface Comparison {
  /** Expected entries no finding matched. */
  missing: ExpectedFinding[];
  /** Findings nobody expected: always `fail` and `likely`; `advisory` and `info` too when `exact`. */
  unexpected: Pick<Finding, 'selector' | 'check' | 'status' | 'rule'>[];
}

export function compareToManifest(findings: Finding[], manifest: Manifest): Comparison {
  const missing = manifest.expected.filter((expected) => !findings.some((f) => matches(f, expected)));
  const unexpected = findings
    .filter((f) => manifest.exact || f.status === 'fail' || f.status === 'likely')
    .filter((f) => !manifest.expected.some((expected) => matches(f, expected)))
    .map(({ selector, check, status, rule }) => ({ selector, check, status, rule }));
  return { missing, unexpected };
}
