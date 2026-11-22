import { describe, expect, it } from 'vitest';
import type { ScanResult } from '@a11y-vision/core';
import { toBase64, toHtmlReport } from './html.js';

describe('toBase64', () => {
  // RFC 4648 test vectors.
  it.each([
    ['', ''],
    ['f', 'Zg=='],
    ['fo', 'Zm8='],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg=='],
    ['fooba', 'Zm9vYmE='],
    ['foobar', 'Zm9vYmFy'],
  ])('encodes %j', (input, expected) => {
    expect(toBase64(new TextEncoder().encode(input))).toBe(expected);
  });
  it('encodes high bytes', () => {
    expect(toBase64(Uint8Array.of(255, 254, 253))).toBe('//79');
  });
});

const result: ScanResult = {
  tool: { name: 'a11y-vision', version: '0.0.0' },
  url: 'http://example.test/?q=<script>',
  timestamp: '2026-01-01T00:00:00.000Z',
  environment: {
    url: 'http://example.test/',
    devicePixelRatio: 2,
    viewport: { width: 1280, height: 720 },
    colorScheme: 'light',
  },
  findings: [
    {
      id: 'abc',
      check: 'focus-indicator',
      rule: 'focus-indicator/low-contrast',
      status: 'fail',
      wcag: { sc: '1.4.11', level: 'AA' },
      selector: 'a[title="<b>"]',
      frame: '',
      box: { x: 1, y: 2, width: 30, height: 40 },
      evidence: {
        crops: ['focus-indicator/x-focused.png', 'focus-indicator/missing.png'],
        colors: { indicator: '#c8c8c8', adjacent: '#ffffff' },
        ratios: { contrast: 1.67 },
        flags: ['authorModified'],
      },
      message: 'Measures 1.67:1 & no part reaches 3:1.',
      help: 'help',
    },
  ],
};

describe('toHtmlReport', () => {
  const html = toHtmlReport(result, { 'focus-indicator/x-focused.png': Uint8Array.of(1, 2, 3) });

  it('escapes page-controlled text', () => {
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('a[title=&quot;&lt;b&gt;&quot;]');
    expect(html).toContain('1.67:1 &amp; no part');
  });
  it('embeds the crops it was given and skips the ones it was not', () => {
    expect(html).toContain('src="data:image/png;base64,AQID"');
    expect(html.match(/<img /g)).toHaveLength(1);
  });
  it('shows measured values and counts', () => {
    expect(html).toContain('1.67:1');
    expect(html).toContain('#c8c8c8');
    expect(html).toContain('<h2>Fail (1)</h2>');
    expect(html).not.toContain('<h2>Likely');
  });
  it('makes no conformance statement', () => {
    expect(html).toContain('makes no statement of conformance');
    expect(html.toLowerCase()).not.toMatch(/passes wcag|wcag compliant|conforms to wcag/);
  });
});
