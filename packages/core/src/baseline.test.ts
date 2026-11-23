import { describe, expect, it } from 'vitest';
import { BaselineError, compareWithBaseline, defaultConfig, emptyBaseline, fingerprint, hasNewFailures, pageKey, parseBaseline, resolveConfig, serializeBaseline } from './index.js';
import type { Baseline, BaselineConfig, Finding } from './index.js';

const key: BaselineConfig = defaultConfig.baseline;

function finding(selector: string, overrides: Partial<Finding> = {}): Finding {
  const base = {
    check: 'focus-indicator' as const,
    rule: 'focus-indicator/no-visible-change',
    status: 'fail' as const,
    wcag: { sc: '2.4.7', level: 'AA' as const },
    selector,
    frame: '',
    box: null,
    evidence: { crops: [], colors: {}, ratios: {}, flags: [] },
    message: 'm',
    help: 'h',
    ...overrides,
  };
  return { id: fingerprint(base), ...base };
}

function written(pages: { url: string; findings: Finding[] }[], from: Baseline = emptyBaseline(key)): Baseline {
  return parseBaseline(JSON.parse(serializeBaseline(compareWithBaseline(pages, from, { update: true }).baseline)));
}

describe('pageKey', () => {
  it('drops the fragment and nothing else by default', () => {
    expect(pageKey('https://example.test/a/?b=2&a=1#top', key)).toBe('https://example.test/a/?b=2&a=1');
    expect(pageKey('https://example.test/a', key)).toBe('https://example.test/a');
    expect(pageKey('https://example.test/a/', key)).not.toBe(pageKey('https://example.test/a', key));
    expect(pageKey('https://example.test/?a=1&b=2', key)).not.toBe(pageKey('https://example.test/?b=2&a=1', key));
  });

  it('keeps the fragment when told to', () => {
    expect(pageKey('https://example.test/#/route', { ...key, stripFragment: false })).toBe('https://example.test/#/route');
  });

  it('sorts the query by name, keeping the order of the values of one name', () => {
    const sorted = { ...key, sortQuery: true };
    expect(pageKey('https://example.test/p?b=2&a=2&a=1', sorted)).toBe('https://example.test/p?a=2&a=1&b=2');
    expect(pageKey('https://example.test/p?b=2&a=1', sorted)).toBe(pageKey('https://example.test/p?a=1&b=2', sorted));
  });

  it('leaves out the named parameters, and the question mark with the last of them', () => {
    const dropped = { ...key, dropQueryParams: ['utm_source', 'sid'] };
    expect(pageKey('https://example.test/p?utm_source=x&id=3&sid=9', dropped)).toBe('https://example.test/p?id=3');
    expect(pageKey('https://example.test/p?sid=9#x', dropped)).toBe('https://example.test/p');
    // A name is the whole name.
    expect(pageKey('https://example.test/p?sid2=9', dropped)).toBe('https://example.test/p?sid2=9');
  });

  it('strips a trailing slash only when told to, and never the root', () => {
    const stripped = { ...key, stripTrailingSlash: true };
    expect(pageKey('https://example.test/a/', stripped)).toBe('https://example.test/a');
    expect(pageKey('https://example.test/a/?q=1', stripped)).toBe('https://example.test/a?q=1');
    expect(pageKey('https://example.test/', stripped)).toBe('https://example.test/');
  });

  it('has settings that survive a bad config value', () => {
    const resolved = resolveConfig({ baseline: { sortQuery: 'yes' as never, dropQueryParams: ['b', 'a', 'a', 3 as never] } }).baseline;
    expect(resolved).toEqual({ stripFragment: true, sortQuery: false, stripTrailingSlash: false, dropQueryParams: ['a', 'b'] });
  });
});

describe('compareWithBaseline', () => {
  const a = finding('#a');
  const b = finding('#b');
  const likely = finding('#c', { status: 'likely' });

  it('marks nothing as recorded against an empty baseline, and every fail as new', () => {
    const { pages, summary } = compareWithBaseline([{ url: 'https://example.test/', findings: [a, likely] }], emptyBaseline(key));
    expect(pages[0]!.findings.map((f) => f.baseline)).toEqual(['new', undefined]);
    expect(summary).toMatchObject({ new: 1, baselined: 0, stale: 0 });
    expect(hasNewFailures(pages[0]!.findings)).toBe(true);
  });

  it('round-trips: what was written is recorded on the next run, and only a new fail breaks the build', () => {
    const baseline = written([{ url: 'https://example.test/#x', findings: [a, likely] }]);
    const same = compareWithBaseline([{ url: 'https://example.test/', findings: [a, likely] }], baseline);
    expect(same.pages[0]!.findings.map((f) => f.baseline)).toEqual(['baselined', undefined]);
    expect(same.summary).toMatchObject({ new: 0, baselined: 1, stale: 0, notScanned: 0 });
    expect(hasNewFailures(same.pages[0]!.findings)).toBe(false);
    // The input is not changed.
    expect(a.baseline).toBeUndefined();

    const more = compareWithBaseline([{ url: 'https://example.test/', findings: [a, b] }], baseline);
    expect(more.pages[0]!.findings.map((f) => f.baseline)).toEqual(['baselined', 'new']);
    expect(hasNewFailures(more.pages[0]!.findings)).toBe(true);
  });

  it('keeps pages apart: a finding recorded for one page is new on another', () => {
    const baseline = written([{ url: 'https://example.test/one', findings: [a] }]);
    const { pages, summary } = compareWithBaseline(
      [
        { url: 'https://example.test/one', findings: [a] },
        { url: 'https://example.test/two', findings: [a] },
      ],
      baseline,
    );
    expect(pages.map((page) => page.findings[0]!.baseline)).toEqual(['baselined', 'new']);
    expect(summary).toMatchObject({ new: 1, baselined: 1 });
  });

  it('does not cover a failure of another rule or criterion on the same element', () => {
    const baseline = written([{ url: 'https://example.test/', findings: [a] }]);
    const otherRule = finding('#a', { rule: 'focus-indicator/low-contrast', wcag: { sc: '1.4.11', level: 'AA' } });
    // Same id on purpose: the entry still has to agree on the rule.
    const forged = { ...a, rule: 'focus-indicator/obscured' };
    const { pages } = compareWithBaseline([{ url: 'https://example.test/', findings: [otherRule, forged] }], baseline);
    expect(pages[0]!.findings.map((f) => f.baseline)).toEqual(['new', 'new']);
  });

  it('does not record a likely finding, so one that becomes a fail is new', () => {
    const baseline = written([{ url: 'https://example.test/', findings: [likely] }]);
    expect(baseline.pages).toEqual([]);
    const worse = { ...likely, status: 'fail' as const };
    expect(compareWithBaseline([{ url: 'https://example.test/', findings: [worse] }], baseline).pages[0]!.findings[0]!.baseline).toBe('new');
  });

  it('counts entries that no longer occur, prunes them only when asked, and leaves pages that were not scanned alone', () => {
    const baseline = written([
      { url: 'https://example.test/one', findings: [a, b] },
      { url: 'https://example.test/two', findings: [a] },
    ]);
    const run = [{ url: 'https://example.test/one', findings: [a, { ...b, status: 'likely' as const }] }];
    const kept = compareWithBaseline(run, baseline);
    expect(kept.summary).toMatchObject({ new: 0, baselined: 1, stale: 1, notScanned: 1, pruned: 0 });
    expect(kept.baseline.pages.map((page) => page.findings.length)).toEqual([2, 1]);

    const pruned = compareWithBaseline(run, baseline, { prune: true });
    expect(pruned.summary).toMatchObject({ stale: 1, pruned: 1, notScanned: 1 });
    expect(pruned.baseline.pages.map((page) => [page.url, page.findings.map((entry) => entry.selector)])).toEqual([
      ['https://example.test/one', ['#a']],
      ['https://example.test/two', ['#a']],
    ]);
  });

  it('updates by adding: entries of other pages stay, and stale ones stay unless pruned', () => {
    const baseline = written([
      { url: 'https://example.test/one', findings: [a] },
      { url: 'https://example.test/two', findings: [a] },
    ]);
    const { baseline: next, summary, pages } = compareWithBaseline([{ url: 'https://example.test/one', findings: [b] }], baseline, { update: true });
    expect(summary).toMatchObject({ added: 1, stale: 1, pruned: 0, new: 0, baselined: 1 });
    expect(pages[0]!.findings[0]!.baseline).toBe('baselined');
    expect(next.pages.find((page) => page.url.endsWith('/one'))!.findings.map((entry) => entry.selector).sort()).toEqual(['#a', '#b']);
    expect(next.pages.find((page) => page.url.endsWith('/two'))!.findings).toHaveLength(1);
  });

  it('uses the key settings of the file, not those of the run', () => {
    const baseline = written([{ url: 'https://example.test/p?b=1&a=2', findings: [a] }], emptyBaseline({ ...key, sortQuery: true }));
    expect(baseline.pages[0]!.url).toBe('https://example.test/p?a=2&b=1');
    expect(compareWithBaseline([{ url: 'https://example.test/p?a=2&b=1', findings: [a] }], baseline).summary.baselined).toBe(1);
  });
});

describe('serializeBaseline', () => {
  it('gives the same bytes whatever the order of pages and findings, with no date in them', () => {
    const one = [
      { url: 'https://example.test/b', findings: [finding('#z'), finding('#a')] },
      { url: 'https://example.test/a', findings: [finding('#m')] },
    ];
    const two = [
      { url: 'https://example.test/a', findings: [finding('#m')] },
      { url: 'https://example.test/b', findings: [finding('#a'), finding('#z')] },
    ];
    const text = serializeBaseline(compareWithBaseline(one, emptyBaseline(key), { update: true }).baseline);
    expect(serializeBaseline(compareWithBaseline(two, emptyBaseline(key), { update: true }).baseline)).toBe(text);
    expect(text.endsWith('}\n')).toBe(true);
    const parsed = JSON.parse(text) as Baseline;
    expect(Object.keys(parsed)).toEqual(['version', 'tool', 'urlKey', 'pages']);
    expect(parsed.version).toBe(1);
    expect(parsed.pages.map((page) => page.url)).toEqual(['https://example.test/a', 'https://example.test/b']);
    expect(parsed.pages[1]!.findings.map((entry) => entry.selector)).toEqual(['#a', '#z']);
    expect(Object.keys(parsed.pages[0]!.findings[0]!)).toEqual(['id', 'rule', 'sc', 'frame', 'selector']);
  });
});

describe('parseBaseline', () => {
  const good = JSON.parse(serializeBaseline(compareWithBaseline([{ url: 'https://example.test/', findings: [finding('#a')] }], emptyBaseline(key), { update: true }).baseline)) as Record<string, unknown>;

  it('reads what serializeBaseline writes', () => {
    expect(parseBaseline(good).pages).toHaveLength(1);
  });

  it.each([
    ['not an object', []],
    ['no version', { ...good, version: undefined }],
    ['an older version', { ...good, version: 0 }],
    ['a newer version', { ...good, version: 2 }],
    ['a version as text', { ...good, version: '1' }],
    ['no key settings', { ...good, urlKey: undefined }],
    ['damaged key settings', { ...good, urlKey: { stripFragment: true } }],
    ['no pages', { ...good, pages: undefined }],
    ['a page without findings', { ...good, pages: [{ url: 'https://example.test/' }] }],
    ['a page listed twice', { ...good, pages: [...(good['pages'] as unknown[]), ...(good['pages'] as unknown[])] }],
    ['an entry without a rule', { ...good, pages: [{ url: 'https://example.test/', findings: [{ id: 'x', sc: '', frame: '', selector: '#a' }] }] }],
    ['an entry that is a string', { ...good, pages: [{ url: 'https://example.test/', findings: ['x'] }] }],
  ])('refuses %s', (_name, value) => {
    expect(() => parseBaseline(value)).toThrow(BaselineError);
  });

  it('names the version it found and the one it reads', () => {
    expect(() => parseBaseline({ ...good, version: 7 })).toThrow(/format version 7.*reads version 1/);
  });
});
