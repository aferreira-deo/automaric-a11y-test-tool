import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadVerdictCache, saveVerdictCache } from './cache-file.js';

// Inside the repository's ignored output directory, not the system's temporary one.
const root = fileURLToPath(new URL(`../../../test-results/unit-cache-${process.pid}/`, import.meta.url));
const settings = { cacheMaxEntries: 10, maxRationaleChars: 50 };
const KEY = 'a'.repeat(64);
const entry = { votes: ['no' as const, 'no' as const], verdict: 'no' as const, confidence: 'high' as const, rationale: 'a label', inputs: 'text+image' as const };

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the verdict cache file', () => {
  it('starts empty when the file is missing, and writes nothing until there is something to keep', async () => {
    const file = join(root, 'missing', 'verdicts.json');
    const cache = await loadVerdictCache(file, settings);
    expect(cache.get(KEY)).toBeUndefined();
    await saveVerdictCache(file, cache);
    expect(existsSync(file)).toBe(false);
  });

  it('keeps verdicts from one run to the next, and leaves no temporary file', async () => {
    const file = join(root, 'kept', 'deep', 'verdicts.json');
    const cache = await loadVerdictCache(file, settings);
    cache.set(KEY, entry);
    await saveVerdictCache(file, cache);
    expect(cache.dirty).toBe(false);
    expect(await readdir(join(root, 'kept', 'deep'))).toEqual(['verdicts.json']);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, entries: { [KEY]: entry } });
    expect((await loadVerdictCache(file, settings)).get(KEY)).toEqual(entry);
  });

  it('keeps what every writer knows when several save at the same time in one process', async () => {
    const dir = join(root, 'concurrent');
    const file = join(dir, 'verdicts.json');
    const big = { cacheMaxEntries: 10000, maxRationaleChars: 400 };
    const key = (writer: number, n: number): string => (writer * 100000 + n).toString(16).padStart(64, '0');
    const sizes = [300, 600, 900, 1200];
    for (let round = 0; round < 8; round++) {
      await rm(dir, { recursive: true, force: true });
      const caches = await Promise.all(
        sizes.map(async (size, writer) => {
          const cache = await loadVerdictCache(file, big);
          for (let n = 0; n < size; n++) cache.set(key(writer, n), { ...entry, rationale: 'x'.repeat(300) });
          return cache;
        }),
      );
      // Four scans of one process ending together, as tests running in parallel do.
      const results = await Promise.allSettled(caches.map((cache) => saveVerdictCache(file, cache)));
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
      // The file is whole, holds the verdicts of every writer, and nothing was left beside it.
      const stored = JSON.parse(await readFile(file, 'utf8')) as { version: number; entries: Record<string, unknown> };
      expect(Object.keys(stored.entries)).toHaveLength(3000);
      const back = await loadVerdictCache(file, big);
      sizes.forEach((size, writer) => {
        expect(back.get(key(writer, 0))).toBeDefined();
        expect(back.get(key(writer, size - 1))).toBeDefined();
      });
      expect(await readdir(dir)).toEqual(['verdicts.json']);
      expect(caches.every((cache) => !cache.dirty)).toBe(true);
    }
  });

  it('adds to what another run wrote since the file was read, and its own verdicts win', async () => {
    const file = join(root, 'merged', 'verdicts.json');
    const other = 'b'.repeat(64);
    const mine = await loadVerdictCache(file, settings);
    const theirs = await loadVerdictCache(file, settings);
    theirs.set(other, { ...entry, rationale: 'theirs' });
    theirs.set(KEY, { ...entry, rationale: 'theirs' });
    await saveVerdictCache(file, theirs);
    mine.set(KEY, { ...entry, rationale: 'mine' });
    await saveVerdictCache(file, mine);
    const back = await loadVerdictCache(file, settings);
    expect(back.get(other)).toMatchObject({ rationale: 'theirs' });
    expect(back.get(KEY)).toMatchObject({ rationale: 'mine' });
    // What is on disk is not trusted more for being merged: an entry that is not a verdict is dropped.
    await writeFile(file, JSON.stringify({ version: 1, entries: { [other]: { ...entry, verdict: 'fail' }, 'not-a-key': entry } }));
    const next = await loadVerdictCache(file, settings);
    next.set(KEY, entry);
    await saveVerdictCache(file, next);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, entries: { [KEY]: entry } });
  });

  it('starts empty from a file that is not a cache, and replaces it', async () => {
    await mkdir(join(root, 'broken'), { recursive: true });
    const file = join(root, 'broken', 'verdicts.json');
    for (const content of ['{ not json', '[]', '"text"', JSON.stringify({ version: 1, entries: { [KEY]: { ...entry, verdict: 'fail' } } })]) {
      await writeFile(file, content);
      const cache = await loadVerdictCache(file, settings);
      expect(cache.get(KEY)).toBeUndefined();
      cache.set(KEY, entry);
      await saveVerdictCache(file, cache);
      expect((await loadVerdictCache(file, settings)).get(KEY)).toEqual(entry);
    }
  });
});
