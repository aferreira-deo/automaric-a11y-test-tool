import { describe, expect, it } from 'vitest';
import type { Finding, ScanResult } from '@a11y-vision/core';
import { toJsonReport } from '@a11y-vision/reporters';
import { cleanResult, collectSecrets, redactText } from './redaction.js';
import { pageTarget, publicUrl, redactQuery, scrubAddresses } from './urls.js';

const state = {
  cookies: [
    { name: 'sid', value: 'COOKIE-secret-1' },
    { name: 'mode', value: 'findings' },
    { name: 'short', value: 'en-GB' },
    { name: 'encoded', value: 'a%20b%2Fc%3Dsecret' },
  ],
  origins: [
    {
      origin: 'https://example.test',
      localStorage: [
        { name: 'auth', value: JSON.stringify({ user: { token: 'TOKEN-in-json-1', roles: ['administrator-role'], n: 5, inner: JSON.stringify({ refresh: 'REFRESH-nested-twice' }) } }) },
        { name: 'plain', value: 'plain secret value' },
        { name: 'quoted', value: '"a JSON string value"' },
        { name: 'broken', value: '{"not": json' },
      ],
    },
  ],
};

describe('collectSecrets', () => {
  const secrets = collectSecrets(state, 8);

  it('takes the values of cookies and of local storage, and the string values inside those that are JSON, at any depth', () => {
    for (const value of ['COOKIE-secret-1', 'findings', 'TOKEN-in-json-1', 'administrator-role', 'REFRESH-nested-twice', 'plain secret value', 'a JSON string value', '{"not": json']) {
      expect(secrets, value).toContain(value);
    }
    // The JSON text itself too: a page may show it whole.
    expect(secrets).toContain(state.origins[0]!.localStorage[0]!.value);
  });

  it('takes the URL-decoded and the URL-encoded form of each', () => {
    expect(secrets).toContain('a%20b%2Fc%3Dsecret');
    expect(secrets).toContain('a b/c=secret');
    expect(secrets).toContain('plain%20secret%20value');
  });

  it('leaves out what is shorter than the limit, which is a setting, and no name', () => {
    expect(secrets).not.toContain('en-GB');
    expect(collectSecrets(state, 5)).toContain('en-GB');
    expect(secrets).not.toContain('administrator');
    for (const name of ['sid', 'mode', 'auth', 'token', 'refresh']) expect(secrets).not.toContain(name);
  });

  it('gives the longest first, and survives a state that is not one', () => {
    expect(secrets.map((secret) => secret.length)).toEqual([...secrets.map((secret) => secret.length)].sort((a, b) => b - a));
    for (const odd of [null, 3, 'text', [], { cookies: 'x', origins: [null, { localStorage: [null, 3] }] }]) expect(collectSecrets(odd, 8)).toEqual([]);
  });
});

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'a1b2c3d4e5f60718',
    check: 'headings',
    rule: 'headings/unmarked-heading',
    status: 'advisory',
    wcag: { sc: '1.3.1', level: 'A' },
    selector: '#btn-TOKEN-in-json-1',
    frame: '',
    signature: 'div||0000000000000001',
    box: null,
    evidence: { crops: ['headings/findings.png'], colors: {}, ratios: {}, flags: ['findings'], values: { text: 'Session COOKIE-secret-1 of findings', words: 4 } },
    message: 'The text "Session COOKIE-secret-1" looks like a heading; see https://user:pw@example.test/x?token=abc&y=1.',
    help: 'Text that functions as a heading has to be exposed as a heading; findings are never a failure.',
    ...overrides,
  };
}

describe('cleanResult', () => {
  const secrets = [...collectSecrets(state, 8), 'advisory', 'headings'];
  const redactParams = ['token'];
  const clean = (text: string): string => redactText(scrubAddresses(text, redactParams), secrets);
  const result: ScanResult = {
    tool: { name: 'a11y-vision', version: '0.0.0' },
    url: 'https://user:pw@example.test/app?token=abc#COOKIE-secret-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: { url: 'https://example.test/app?token=abc', devicePixelRatio: 2, viewport: { width: 1280, height: 720 }, colorScheme: 'light', navigatedFrom: 'https://example.test/old?token=abc' },
    findings: [finding(), finding({ status: 'fail', baseline: 'new', ai: { provider: 'findings', model: 'm', promptVersion: '1', votes: ['yes'], verdict: 'yes', confidence: 'high', rationale: 'It says COOKIE-secret-1.', statusBefore: 'advisory', inputs: 'text', fromCache: false } })],
  };
  const cleaned = cleanResult(result, clean, (url) => publicUrl(url, redactParams));

  it('replaces the values in the texts that came from the page', () => {
    const [first, second] = cleaned.findings;
    expect(first!.selector).toBe('#btn-[redacted]');
    expect(first!.message).toBe('The text "Session [redacted]" looks like a heading; see https://example.test/x?token=redacted&y=1.');
    expect(first!.evidence.values).toEqual({ text: 'Session [redacted] of [redacted]', words: 4 });
    expect(second!.ai!.rationale).toBe('It says [redacted].');
    expect(cleaned.url).toBe('https://example.test/app?token=redacted#[redacted]');
    expect(cleaned.environment).toEqual({ ...result.environment, url: 'https://example.test/app?token=redacted', navigatedFrom: 'https://example.test/old?token=redacted' });
  });

  it('leaves the words of the tool and the shape of the result as they are, whatever a cookie holds', () => {
    for (const [index, before] of result.findings.entries()) {
      const after = cleaned.findings[index]!;
      expect(Object.keys(after)).toEqual(Object.keys(before));
      for (const field of ['id', 'check', 'rule', 'status', 'wcag', 'signature', 'box', 'help', 'baseline'] as const) expect(after[field], field).toEqual(before[field]);
      expect(after.evidence.crops).toEqual(before.evidence.crops);
      expect(after.evidence.flags).toEqual(before.evidence.flags);
    }
    expect(cleaned.findings[1]!.ai).toEqual({ ...result.findings[1]!.ai, rationale: 'It says [redacted].' });
    // The input is not changed.
    expect(result.findings[0]!.selector).toBe('#btn-TOKEN-in-json-1');
    // And the report made from it has its keys: a value that is also a word of the format rewrote one before.
    const report = JSON.parse(JSON.stringify(toJsonReport(cleaned))) as Record<string, Record<string, unknown>>;
    expect(Object.keys(report['a11yVision']!)).toEqual(['environment', 'findings']);
    expect(JSON.stringify(report)).not.toContain('COOKIE-secret-1');
    expect(JSON.stringify(report)).not.toContain('TOKEN-in-json-1');
  });
});

describe('addresses as they are written', () => {
  const names = ['token', 'access_token', 'key'];

  it('replaces the value of the named parameters and nothing else', () => {
    expect(redactQuery('https://example.test/p?a=1&token=abc&b=2#frag?token=x', names)).toBe('https://example.test/p?a=1&token=redacted&b=2#frag?token=x');
    expect(redactQuery('https://example.test/p?Token=abc&ACCESS_TOKEN=d&keys=1&key', names)).toBe('https://example.test/p?Token=redacted&ACCESS_TOKEN=redacted&keys=1&key');
    expect(redactQuery('https://example.test/p?to%6Ben=abc', names)).toBe('https://example.test/p?to%6Ben=redacted');
    expect(redactQuery('https://example.test/p#a?token=abc', names)).toBe('https://example.test/p#a?token=abc');
    expect(redactQuery('https://example.test/p?token=abc', [])).toBe('https://example.test/p?token=abc');
  });

  it('takes the user name and the password out', () => {
    expect(publicUrl('https://user:pass@example.test/p?token=abc', names)).toBe('https://example.test/p?token=redacted');
    expect(scrubAddresses('page.goto: net::ERR_FAILED at http://user:pass@example.test:8080/p?key=k1. Then https://example.test/q?token=t2, and a@b.test.', names)).toBe(
      'page.goto: net::ERR_FAILED at http://example.test:8080/p?key=redacted Then https://example.test/q?token=redacted and a@b.test.',
    );
  });

  it('keeps what the browser needs apart from what is written', () => {
    expect(pageTarget('https://example.test/p', names)).toEqual({ url: 'https://example.test/p', address: 'https://example.test/p', fromSitemap: false });
    expect(pageTarget('https://u:p%20w@example.test/p?token=abc', names, true)).toEqual({
      url: 'https://example.test/p?token=redacted',
      address: 'https://example.test/p?token=abc',
      credentials: { username: 'u', password: 'p w', origin: 'https://example.test' },
      fromSitemap: true,
    });
  });
});
