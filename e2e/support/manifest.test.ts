import { describe, expect, it } from 'vitest';
import type { Finding } from '@a11y-vision/core';
import { compareToManifest, loadFixtures } from './manifest.js';
import type { Manifest } from './manifest.js';

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: 'id',
    check: 'focus-indicator',
    rule: 'focus-indicator/no-visible-change',
    status: 'fail',
    wcag: { sc: '2.4.7', level: 'AA' },
    selector: '#a',
    frame: '',
    signature: '',
    box: null,
    evidence: { crops: [], colors: {}, ratios: {}, flags: [] },
    message: '',
    help: '',
    ...overrides,
  };
}

const manifest: Manifest = {
  description: '',
  checks: ['focus-indicator'],
  expected: [{ selector: '#a', check: 'focus-indicator', status: 'fail', wcag: '2.4.7' }],
};

describe('compareToManifest', () => {
  it('accepts a matching run', () => {
    expect(compareToManifest([finding({})], manifest)).toEqual({ missing: [], unexpected: [] });
  });
  it('reports a missing expected finding', () => {
    expect(compareToManifest([], manifest).missing).toEqual(manifest.expected);
  });
  it('treats a different status as missing plus unexpected', () => {
    const result = compareToManifest([finding({ status: 'likely' })], manifest);
    expect(result.missing).toHaveLength(1);
    expect(result.unexpected).toHaveLength(1);
  });
  it('treats a different criterion as a mismatch', () => {
    const result = compareToManifest([finding({ wcag: { sc: '1.4.11', level: 'AA' } })], manifest);
    expect(result.missing).toHaveLength(1);
  });
  it('flags unexpected fail and likely findings', () => {
    const extra = [finding({}), finding({ selector: '#b' }), finding({ selector: '#c', status: 'likely' })];
    expect(compareToManifest(extra, manifest).unexpected.map((f) => f.selector)).toEqual(['#b', '#c']);
  });
  it('tolerates unexpected advisory and info unless exact', () => {
    const extra = [
      finding({}),
      finding({ selector: '#b', status: 'info' }),
      finding({ selector: '#c', status: 'advisory' }),
    ];
    expect(compareToManifest(extra, manifest).unexpected).toEqual([]);
    expect(compareToManifest(extra, { ...manifest, exact: true }).unexpected).toHaveLength(2);
  });
});

describe('loadFixtures', () => {
  it('finds the noop fixture', () => {
    expect(loadFixtures().find((f) => f.name === 'noop/basic')).toMatchObject({
      path: '/noop/basic.html',
      manifest: { checks: ['noop'] },
    });
  });
});
