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
