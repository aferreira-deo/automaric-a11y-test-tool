import { describe, expect, it } from 'vitest';
import type { Finding, ScanResult } from '@a11y-vision/core';
import { toJsonReport } from './json.js';

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: 'id',
    check: 'focus-indicator',
    rule: 'focus-indicator/no-visible-change',
    status: 'fail',
    wcag: { sc: '2.4.7', level: 'AA' },
    selector: '#a',
    frame: '',
    box: null,
    evidence: { crops: [], colors: {}, ratios: {}, flags: [] },
    message: 'm',
    help: 'h',
    ...overrides,
  };
}

const base: Omit<ScanResult, 'findings'> = {
  tool: { name: 'a11y-vision', version: '0.0.0' },
  url: 'http://example.test/',
  timestamp: '2026-01-01T00:00:00.000Z',
  environment: {
    url: 'http://example.test/',
    devicePixelRatio: 2,
    viewport: { width: 1280, height: 720 },
    colorScheme: 'light',
  },
};

describe('toJsonReport', () => {
  it('maps statuses to axe buckets and keeps everything under the extension key', () => {
    const findings = [
      finding({ id: '1', selector: '#a' }),
      finding({ id: '2', selector: '#b' }),
      finding({ id: '3', status: 'likely', rule: 'focus-indicator/low-contrast', wcag: { sc: '1.4.11', level: 'AA' } }),
      finding({ id: '4', status: 'advisory' }),
      finding({ id: '5', status: 'info', wcag: null }),
    ];
    const report = toJsonReport({ ...base, findings });

    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.nodes.map((n) => n.target)).toEqual([['#a'], ['#b']]);
    expect(report.violations[0]?.tags).toEqual(['wcag247']);
    expect(report.incomplete).toHaveLength(1);
    expect(report.incomplete[0]?.tags).toEqual(['wcag1411']);
    expect(report.passes).toEqual([]);
    expect(report.a11yVision.findings).toHaveLength(5);
  });
});
