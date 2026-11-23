import { defaultConfig } from '@a11y-vision/core';
import { describe, expect, it } from 'vitest';
import { extensionConfig } from './config.js';
import { decisionFor, decisionKey, DecisionStore, emptyPageDecisions, pageStorageKey, parsePageDecisions, withDecision } from './decisions.js';
import { fakeStorage } from './test-support.js';

const limits = extensionConfig.storage;
const now = new Date('2026-01-02T03:04:05.000Z');
const later = new Date('2026-01-02T03:05:00.000Z');
const finding = { id: 'aaaa', signature: 'button||1111' };
const other = { id: 'bbbb', signature: 'a||2222' };

describe('decisions', () => {
  it('are keyed by the finding and by what the element is', () => {
    expect(decisionKey(finding)).toBe('aaaa|button||1111');
    const page = withDecision(emptyPageDecisions(now), finding, { decision: 'confirmed', note: '' }, limits, now);
    expect(decisionFor(page, finding)).toEqual({ decision: 'confirmed', note: '', at: now.toISOString() });
    // Another element at the same selector: the decision is not about it.
    expect(decisionFor(page, { id: 'aaaa', signature: 'button||9999' })).toBeUndefined();
    expect(decisionFor(null, finding)).toBeUndefined();
  });

  it('are changed without touching the page they came from', () => {
    const first = withDecision(emptyPageDecisions(now), finding, { decision: 'confirmed', note: 'seen' }, limits, now);
    const second = withDecision(first, finding, { decision: 'dismissed', note: 'seen' }, limits, later);
    expect(decisionFor(first, finding)?.decision).toBe('confirmed');
    expect(decisionFor(second, finding)).toEqual({ decision: 'dismissed', note: 'seen', at: later.toISOString() });
    expect(second.updatedAt).toBe(later.toISOString());
  });

  it('go away when there is neither a decision nor a note, and stay for a note alone', () => {
    const page = withDecision(emptyPageDecisions(now), finding, { decision: 'confirmed', note: '' }, limits, now);
    expect(withDecision(page, finding, { decision: null, note: '  ' }, limits, later).entries).toEqual({});
    expect(decisionFor(withDecision(page, finding, { decision: null, note: 'to check with a screen reader' }, limits, later), finding)).toEqual({
      decision: null,
      note: 'to check with a screen reader',
      at: later.toISOString(),
    });
  });

  it('cut a note at the limit and keep only so many per page, dropping the oldest', () => {
    const small = { ...limits, maxNoteChars: 5, maxDecisionsPerPage: 2 };
    let page = withDecision(emptyPageDecisions(now), finding, { decision: 'confirmed', note: '1234567890' }, small, now);
    expect(decisionFor(page, finding)?.note).toBe('12345');
    page = withDecision(page, other, { decision: 'dismissed', note: '' }, small, later);
    page = withDecision(page, { id: 'cccc', signature: '' }, { decision: 'dismissed', note: '' }, small, new Date('2026-01-02T03:06:00.000Z'));
    expect(Object.keys(page.entries).sort()).toEqual(['bbbb|a||2222', 'cccc|']);
  });

  it('read from storage are checked: what is not a decision is dropped', () => {
    const parsed = parsePageDecisions(
      {
        version: 1,
        updatedAt: '2025-12-01T00:00:00.000Z',
        entries: {
          good: { decision: 'confirmed', note: 'n', at: '2025-12-01T00:00:00.000Z' },
          noteOnly: { decision: 'maybe', note: 'kept as a note' },
          empty: { decision: null, note: '' },
          bad: 'confirmed',
          long: { decision: 'dismissed', note: 'x'.repeat(limits.maxNoteChars + 10) },
        },
      },
      limits,
      now,
    );
    expect(Object.keys(parsed.entries).sort()).toEqual(['good', 'long', 'noteOnly']);
    expect(parsed.entries['noteOnly']).toEqual({ decision: null, note: 'kept as a note', at: '2025-12-01T00:00:00.000Z' });
    expect(parsed.entries['long']!.note.length).toBe(limits.maxNoteChars);
    for (const junk of [null, 'text', 3, [], { version: 2, entries: {} }, { version: 1 }]) {
      expect(parsePageDecisions(junk, limits, now).entries).toEqual({});
    }
  });

  it('are stored under the address of the page, without its fragment and without parameters that hold secrets', () => {
    expect(pageStorageKey('https://example.test/a/b?x=1&token=SECRET&y=2#part', defaultConfig)).toBe('decisions:https://example.test/a/b?x=1&y=2');
    expect(pageStorageKey('https://user:pw@example.test/a', defaultConfig)).toBe('decisions:https://example.test/a');
  });
});

describe('DecisionStore', () => {
  it('keeps one item per page and gives it back', async () => {
    const area = fakeStorage();
    const store = new DecisionStore(area, limits);
    const key = pageStorageKey('https://example.test/a', defaultConfig);
    expect((await store.load(key, now)).entries).toEqual({});
    const page = withDecision(await store.load(key, now), finding, { decision: 'dismissed', note: 'decorative' }, limits, now);
    await store.save(key, page);
    expect(Object.keys(area.items).sort()).toEqual(['decisions-index', key]);
    expect(decisionFor(await store.load(key, later), finding)).toEqual({ decision: 'dismissed', note: 'decorative', at: now.toISOString() });
    expect((await store.load(pageStorageKey('https://example.test/other', defaultConfig), now)).entries).toEqual({});
  });

  it('removes the item of a page that has no decision left', async () => {
    const area = fakeStorage();
    const store = new DecisionStore(area, limits);
    const key = 'decisions:https://example.test/a';
    const page = withDecision(emptyPageDecisions(now), finding, { decision: 'confirmed', note: '' }, limits, now);
    await store.save(key, page);
    await store.save(key, withDecision(page, finding, { decision: null, note: '' }, limits, later));
    expect(area.items).toEqual({ 'decisions-index': {} });
  });

  it('drops the pages not touched for longest when there are too many, never the one being saved', async () => {
    const area = fakeStorage();
    const store = new DecisionStore(area, { ...limits, maxPages: 2 });
    const save = (name: string, at: string) => store.save(`decisions:${name}`, withDecision(emptyPageDecisions(new Date(at)), finding, { decision: 'confirmed', note: '' }, limits, new Date(at)));
    await save('one', '2026-01-01T00:00:00.000Z');
    await save('two', '2026-01-02T00:00:00.000Z');
    await save('three', '2026-01-03T00:00:00.000Z');
    expect(Object.keys(area.items).sort()).toEqual(['decisions-index', 'decisions:three', 'decisions:two']);
    // An old page that is saved again stays, whatever its date.
    await save('zero', '2025-01-01T00:00:00.000Z');
    expect(Object.keys(area.items).sort()).toEqual(['decisions-index', 'decisions:three', 'decisions:zero']);
  });

  it('ignores an index that is not one', async () => {
    const area = fakeStorage({ 'decisions-index': 'junk' });
    const store = new DecisionStore(area, limits);
    await store.save('decisions:a', withDecision(emptyPageDecisions(now), finding, { decision: 'confirmed', note: '' }, limits, now));
    expect(area.items['decisions-index']).toEqual({ 'decisions:a': now.toISOString() });
  });
});
