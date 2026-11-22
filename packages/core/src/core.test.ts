import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildResult, fingerprint, fnv1a64, hasFailures, resolveConfig, runChecks, TOOL_VERSION } from './index.js';
import type { Snapshot } from './index.js';

const snapshot: Snapshot = {
  environment: {
    url: 'http://example.test/',
    devicePixelRatio: 2,
    viewport: { width: 1280, height: 720 },
    colorScheme: 'light',
  },
  nodes: [],
  axTree: [],
  screenshots: { tiles: [], clips: {} },
};

describe('meta', () => {
  it('TOOL_VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(TOOL_VERSION).toBe(pkg.version);
  });
});

describe('fnv1a64', () => {
  // Published FNV-1a 64-bit test vectors.
  it.each([
    ['', 'cbf29ce484222325'],
    ['a', 'af63dc4c8601ec8c'],
    ['foobar', '85944171f73967e8'],
  ])('hashes %j', (input, expected) => {
    expect(fnv1a64(input)).toBe(expected);
  });
});

describe('fingerprint', () => {
  const base = { rule: 'x/y', wcag: { sc: '2.4.7', level: 'AA' as const }, frame: '', selector: '#a' };
  it('is stable', () => {
    expect(fingerprint(base)).toBe(fingerprint({ ...base }));
  });
  it('changes with selector, frame, rule and criterion', () => {
    const ids = new Set([
      fingerprint(base),
      fingerprint({ ...base, selector: '#b' }),
      fingerprint({ ...base, frame: 'f1' }),
      fingerprint({ ...base, rule: 'x/z' }),
      fingerprint({ ...base, wcag: { sc: '1.4.11', level: 'AA' } }),
      fingerprint({ ...base, wcag: null }),
    ]);
    expect(ids.size).toBe(6);
  });
  it('does not confuse adjacent fields', () => {
    expect(fingerprint({ ...base, frame: 'a', selector: 'b' })).not.toBe(
      fingerprint({ ...base, frame: '', selector: 'ab' }),
    );
  });
});

describe('runChecks', () => {
  it('runs the noop check', () => {
    const findings = runChecks(snapshot, resolveConfig());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'noop', status: 'info', selector: 'html', wcag: null });
    expect(findings[0]?.id).toMatch(/^[0-9a-f]{16}$/);
  });
  it('deduplicates configured checks', () => {
    expect(runChecks(snapshot, resolveConfig({ checks: ['noop', 'noop'] }))).toHaveLength(1);
  });
  it('rejects a check that is not registered', () => {
    expect(() => runChecks(snapshot, resolveConfig({ checks: ['headings'] }))).toThrow(/Unknown check "headings"/);
  });
  it('gives identical findings on two runs', () => {
    const config = resolveConfig();
    expect(runChecks(snapshot, config)).toEqual(runChecks(snapshot, config));
  });
});

describe('buildResult', () => {
  it('has no failures for an info-only result', () => {
    const result = buildResult(snapshot, resolveConfig(), new Date('2026-01-01T00:00:00Z'));
    expect(result.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(hasFailures(result)).toBe(false);
  });
});
