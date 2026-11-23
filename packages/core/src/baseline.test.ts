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
    signature: '',
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

  it('never holds a user name or a password', () => {
    expect(pageKey('https://user:secret@example.test/a?b=1', key)).toBe('https://example.test/a?b=1');
    expect(pageKey('https://user@example.test/', key)).toBe('https://example.test/');
    // An "@" further on is part of the path or the query.
    expect(pageKey('https://example.test/@user?mail=a@b.test', key)).toBe('https://example.test/@user?mail=a@b.test');
    expect(pageKey('https://example.test', key)).toBe('https://example.test');
  });

  it('leaves out the parameters whose value is a secret, whatever their case, on top of those of the file', () => {
    const secret = ['token', 'access_token'];
    expect(pageKey('https://example.test/p?id=3&Token=abc&access_token=x', key, secret)).toBe('https://example.test/p?id=3');
    expect(pageKey('https://example.test/p?token=abc', key, secret)).toBe('https://example.test/p');
    expect(pageKey('https://example.test/p?token=abc', key, secret)).toBe(pageKey('https://example.test/p?token=other', key, secret));
    expect(pageKey('https://example.test/p?tokens=abc', key, secret)).toBe('https://example.test/p?tokens=abc');
    expect(pageKey('https://example.test/p?utm=1&token=abc&id=3', { ...key, dropQueryParams: ['utm'] }, secret)).toBe('https://example.test/p?id=3');
    // An empty query stays as it was given when nothing is asked of it.
    expect(pageKey('https://example.test/p?', key, secret)).toBe('https://example.test/p?');
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

  it('does not cover another element that fails in the same place', () => {
    const recorded = finding('main > ul > li:nth-of-type(2) > button', { signature: 'button||1111111111111111' });
    const baseline = written([{ url: 'https://example.test/', findings: [recorded] }]);
    expect(baseline.pages[0]!.findings[0]).toMatchObject({ check: 'focus-indicator', signature: 'button||1111111111111111' });
    // Same rule, criterion, frame, selector and so the same id: another control.
    const other = { ...recorded, signature: 'button||2222222222222222' };
    expect(other.id).toBe(recorded.id);
    const { pages, summary } = compareWithBaseline([{ url: 'https://example.test/', findings: [other] }], baseline);
    expect(pages[0]!.findings[0]!.baseline).toBe('new');
    expect(summary).toMatchObject({ new: 1, baselined: 0, stale: 1 });
    expect(hasNewFailures(pages[0]!.findings)).toBe(true);
    // The element that was recorded is still covered.
    expect(compareWithBaseline([{ url: 'https://example.test/', findings: [recorded, other] }], baseline).summary).toMatchObject({ new: 1, baselined: 1, stale: 0 });
    // An update records both, and they stay apart.
    const both = written([{ url: 'https://example.test/', findings: [other] }], baseline);
    expect(both.pages[0]!.findings.map((entry) => entry.signature)).toEqual(['button||1111111111111111', 'button||2222222222222222']);
  });

  it('does not take an entry for gone when its check did not run', () => {
    const icon = finding('#icon', { check: 'icon-contrast', rule: 'icon-contrast/icon-low-contrast', wcag: { sc: '1.4.11', level: 'AA' } });
    const baseline = written([{ url: 'https://example.test/', findings: [a, icon] }]);
    // A run of another check alone, which finds nothing.
    const narrow = compareWithBaseline([{ url: 'https://example.test/', findings: [], checks: ['headings'] }], baseline, { prune: true });
    expect(narrow.summary).toMatchObject({ stale: 0, pruned: 0, unverified: 2 });
    expect(narrow.baseline.pages[0]!.findings).toHaveLength(2);
    // A run of one of the two checks: its entry is known to be gone, the other one is not.
    const one = compareWithBaseline([{ url: 'https://example.test/', findings: [], checks: ['focus-indicator'] }], baseline, { prune: true });
    expect(one.summary).toMatchObject({ stale: 1, pruned: 1, unverified: 1 });
    expect(one.baseline.pages[0]!.findings.map((entry) => entry.check)).toEqual(['icon-contrast']);
    // An update of such a run adds and takes nothing out.
    const updated = compareWithBaseline([{ url: 'https://example.test/', findings: [b], checks: ['focus-indicator'] }], baseline, { update: true });
    expect(updated.baseline.pages[0]!.findings.map((entry) => entry.selector).sort()).toEqual(['#a', '#b', '#icon']);
    // Two addresses with one key: what either of them looked for was looked for.
    const two = compareWithBaseline(
      [
        { url: 'https://example.test/#x', findings: [], checks: ['focus-indicator'] },
        { url: 'https://example.test/', findings: [], checks: ['icon-contrast'] },
      ],
      baseline,
      { prune: true },
    );
    expect(two.summary).toMatchObject({ stale: 2, pruned: 2, unverified: 0 });
  });

  it('does not take an entry for gone when the page ended on another address', () => {
    const baseline = written([{ url: 'https://example.test/app?tab=1', findings: [a] }]);
    const run = (finalUrl: string) => compareWithBaseline([{ url: 'https://example.test/app?tab=1', findings: [], checks: ['focus-indicator'], finalUrl }], baseline, { prune: true });
    for (const elsewhere of ['https://example.test/sign-in?next=%2Fapp', 'https://login.example.test/app', 'http://example.test/app', 'https://example.test/app/']) {
      const moved = run(elsewhere);
      expect(moved.summary, elsewhere).toMatchObject({ stale: 0, pruned: 0, unverified: 1 });
      expect(moved.baseline.pages[0]!.findings).toHaveLength(1);
      expect(moved.moved).toEqual([{ url: 'https://example.test/app?tab=1', finalUrl: elsewhere }]);
    }
    // The same document: a fragment or another query does not make it another page.
    for (const same of ['https://example.test/app?tab=1', 'https://example.test/app?tab=1#top', 'https://example.test/app?tab=2', 'https://user:pw@example.test/app']) {
      const stayed = run(same);
      expect(stayed.summary, same).toMatchObject({ stale: 1, pruned: 1, unverified: 0 });
      expect(stayed.moved).toEqual([]);
    }
    // With the setting of the file that makes "/app/" the page "/app", it is.
    const slashed = written([{ url: 'https://example.test/app', findings: [a] }], emptyBaseline({ ...key, stripTrailingSlash: true }));
    expect(compareWithBaseline([{ url: 'https://example.test/app', findings: [], finalUrl: 'https://example.test/app/' }], slashed, { prune: true }).summary).toMatchObject({ pruned: 1 });
  });

  it('keys a page without its credentials and without the parameters that hold a secret', () => {
    const baseline = written([{ url: 'https://user:pw@example.test/p?id=3&token=abc', findings: [a] }]);
    expect(baseline.pages[0]!.url).toBe('https://example.test/p?id=3&token=abc');
    const secret = { update: true, redactQueryParams: ['token'] };
    const dropped = parseBaseline(JSON.parse(serializeBaseline(compareWithBaseline([{ url: 'https://example.test/p?id=3&token=abc', findings: [a] }], emptyBaseline(key), secret).baseline)));
    expect(dropped.pages[0]!.url).toBe('https://example.test/p?id=3');
    expect(compareWithBaseline([{ url: 'https://example.test/p?id=3&token=another', findings: [a] }], dropped, { redactQueryParams: ['token'] }).summary).toMatchObject({ new: 0, baselined: 1 });
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
    expect(parsed.version).toBe(2);
    expect(parsed.pages.map((page) => page.url)).toEqual(['https://example.test/a', 'https://example.test/b']);
    expect(parsed.pages[1]!.findings.map((entry) => entry.selector)).toEqual(['#a', '#z']);
    expect(Object.keys(parsed.pages[0]!.findings[0]!)).toEqual(['id', 'check', 'rule', 'sc', 'frame', 'selector', 'signature']);
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
    ['the version before this one', { ...good, version: 1 }],
    ['a newer version', { ...good, version: 3 }],
    ['a version as text', { ...good, version: '2' }],
    ['no key settings', { ...good, urlKey: undefined }],
    ['damaged key settings', { ...good, urlKey: { stripFragment: true } }],
    ['no pages', { ...good, pages: undefined }],
    ['a page without findings', { ...good, pages: [{ url: 'https://example.test/' }] }],
    ['a page listed twice', { ...good, pages: [...(good['pages'] as unknown[]), ...(good['pages'] as unknown[])] }],
    ['an entry without a rule', { ...good, pages: [{ url: 'https://example.test/', findings: [{ id: 'x', check: 'c', sc: '', frame: '', selector: '#a', signature: '' }] }] }],
    ['an entry without a check', { ...good, pages: [{ url: 'https://example.test/', findings: [{ id: 'x', rule: 'r', sc: '', frame: '', selector: '#a', signature: '' }] }] }],
    ['an entry without a signature', { ...good, pages: [{ url: 'https://example.test/', findings: [{ id: 'x', check: 'c', rule: 'r', sc: '', frame: '', selector: '#a' }] }] }],
    ['an entry that is a string', { ...good, pages: [{ url: 'https://example.test/', findings: ['x'] }] }],
  ])('refuses %s', (_name, value) => {
    expect(() => parseBaseline(value)).toThrow(BaselineError);
  });

  it('names the version it found and the one it reads', () => {
    expect(() => parseBaseline({ ...good, version: 7 })).toThrow(/format version 7.*reads version 2; move the old file away/);
    // The format before: why it is not read, and what to do.
    expect(() => parseBaseline({ ...good, version: 1 })).toThrow(/format version 1.*reads version 2 \(an older format does not record which element.*--update-baseline/);
  });
});
