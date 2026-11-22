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

describe('toHtmlReport for icon-contrast findings', () => {
  const iconResult: ScanResult = {
    ...result,
    findings: [
      {
        id: 'def',
        check: 'icon-contrast',
        rule: 'icon-contrast/icon-multi-colour',
        status: 'likely',
        wcag: { sc: '1.4.11', level: 'AA' },
        selector: '#menu',
        frame: '#frame',
        box: { x: 1, y: 2, width: 40, height: 40 },
        evidence: {
          crops: ['icon-contrast/x.png'],
          colors: { icon: '#1a1a1a', background: '#ffffff', part2: '#ffe08a' },
          ratios: { contrast: 17.4, part2: 1.29 },
          flags: ['svg', 'pixelColour', 'multiColour'],
        },
        message: 'Icon of 2 colours.',
        help: 'help',
      },
    ],
  };
  const html = toHtmlReport(iconResult, { 'icon-contrast/x.png': Uint8Array.of(1, 2, 3) });

  it('shows the capture, every measured colour and every ratio', () => {
    expect(html).toContain('<figcaption>At rest</figcaption>');
    expect(html).toContain('alt="At rest capture of #menu"');
    expect(html).toContain('src="data:image/png;base64,AQID"');
    for (const colour of ['#1a1a1a', '#ffffff', '#ffe08a']) {
      expect(html).toContain(`<span class="swatch" style="background:${colour}"></span><code>${colour}</code>`);
    }
    expect(html).toContain('<dt>Measured contrast</dt><dd>17.4:1</dd>');
    expect(html).toContain('<dt>Measured part2</dt><dd>1.29:1</dd>');
    expect(html).toContain('svg, pixelColour, multiColour');
    expect(html).toContain('<h2>Likely (1)</h2>');
  });
});

describe('toHtmlReport with hostile values', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const attribute = 'x" onerror="alert(1)';
  // A report can be built from JSON that this version of the collector did not write.
  const hostile = JSON.parse(JSON.stringify(result)) as ScanResult;
  const loose = hostile as unknown as {
    timestamp: unknown;
    tool: { name: unknown; version: unknown };
    environment: { viewport: unknown; devicePixelRatio: unknown; colorScheme: unknown };
    findings: {
      box: unknown;
      wcag: unknown;
      evidence: { ratios: Record<string, unknown>; colors: Record<string, unknown>; flags: unknown[]; crops: unknown[] };
    }[];
  };
  loose.timestamp = payload;
  loose.tool = { name: payload, version: payload };
  loose.environment.viewport = { width: payload, height: { toString: () => payload } };
  loose.environment.devicePixelRatio = payload;
  loose.environment.colorScheme = payload;
  loose.findings[0]!.box = { x: payload, y: payload, width: payload, height: payload };
  loose.findings[0]!.wcag = { sc: payload, level: payload };
  loose.findings[0]!.evidence.ratios = { [payload]: payload };
  loose.findings[0]!.evidence.colors = { [payload]: attribute };
  loose.findings[0]!.evidence.flags = [payload];
  loose.findings[0]!.evidence.crops = [`${attribute}-focused.png`];

  it('escapes every interpolated value', () => {
    const html = toHtmlReport(hostile, { [`${attribute}-focused.png`]: Uint8Array.of(1) });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('" onerror="');
    expect(html).toContain('Viewport unknown by unknown CSS px');
  });
  it('does not throw on a missing environment, a broken box or an unknown status', () => {
    const broken = JSON.parse(JSON.stringify(result)) as ScanResult;
    const parts = broken as unknown as { environment: unknown; findings: { status: unknown; box: unknown; evidence: unknown }[] };
    parts.environment = undefined;
    parts.findings[0]!.status = payload;
    parts.findings[0]!.box = { x: null };
    parts.findings[0]!.evidence = undefined;
    const html = toHtmlReport(broken);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('Viewport unknown by unknown CSS px');
  });
});

describe('toHtmlReport for headings findings', () => {
  const page = toHtmlReport({
    ...result,
    findings: [
      {
        id: 'h1',
        check: 'headings',
        rule: 'headings/unmarked-heading',
        status: 'likely',
        wcag: { sc: '1.3.1', level: 'A' },
        selector: '#title',
        frame: '',
        box: { x: 1, y: 2, width: 30, height: 40 },
        evidence: {
          crops: ['headings/x.png'],
          colors: { text: '#1a1a1a' },
          ratios: { sizeToBodyText: 1.5 },
          flags: ['larger'],
          values: { text: '<img src=x onerror=alert(1)>', 'font<b>': 24, followedByBody: true, broken: { toString: () => '<i>' } as unknown as string },
        },
        message: 'm',
        help: 'h',
      },
    ],
  }, { 'headings/x.png': Uint8Array.of(1, 2, 3) });

  it('shows the values read from the page, escaped', () => {
    expect(page).toContain('<dt>text</dt><dd>&lt;img src=x onerror=alert(1)&gt;</dd>');
    expect(page).toContain('<dt>font&lt;b&gt;</dt><dd>24</dd>');
    expect(page).toContain('<dt>followedByBody</dt><dd>yes</dd>');
    expect(page).toContain('<dt>broken</dt><dd></dd>');
    expect(page).not.toContain('<img src=x');
    expect(page).not.toContain('<i>');
    expect(page).toContain('<figcaption>In context</figcaption>');
  });
});
