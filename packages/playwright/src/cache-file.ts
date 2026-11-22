import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createMemoryCache, validCachedVerdict } from '@a11y-vision/adjudicators';
import type { CachedVerdict, MemoryCache } from '@a11y-vision/adjudicators';
import type { AdjudicationConfig } from '@a11y-vision/core';

/**
 * The verdict cache kept in a local JSON file. A file that is missing, unreadable or not what
 * this version writes gives an empty cache: a cache is never a reason for a scan to fail.
 * Entries are validated on the way in, so an edited file cannot put anything but a verdict
 * (`yes`, `no`, `unsure`, never a status) into a result. A well-formed verdict that someone wrote
 * into the file by hand is read like any other: which is why findings say when their verdict
 * came from the cache, and why by default a verdict takes no finding off the list.
 *
 * The file holds verdicts and the model's rationales, which can quote text of the pages that
 * were scanned. It stays on this machine: nothing reads it but this module.
 */
export async function loadVerdictCache(file: string, settings: Pick<AdjudicationConfig, 'cacheMaxEntries' | 'maxRationaleChars'>): Promise<MemoryCache> {
  let from: unknown;
  try {
    from = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    from = undefined;
  }
  return createMemoryCache({ maxEntries: settings.cacheMaxEntries, maxRationaleChars: settings.maxRationaleChars, from });
}

/** Saves in progress in this process, by file: the next save of a file starts when the one before it has ended. */
const saving = new Map<string, Promise<void>>();

/** The entries of the file as it is now, each one checked; none when the file is missing or not a cache of this version. */
async function entriesOnDisk(file: string, version: number): Promise<Record<string, CachedVerdict>> {
  const entries: Record<string, CachedVerdict> = {};
  let stored: { version?: unknown; entries?: unknown } | null;
  try {
    stored = JSON.parse(await readFile(file, 'utf8')) as { version?: unknown; entries?: unknown } | null;
  } catch {
    return entries;
  }
  if (stored === null || typeof stored !== 'object' || stored.version !== version || stored.entries === null || typeof stored.entries !== 'object') return entries;
  for (const [key, value] of Object.entries(stored.entries as Record<string, unknown>)) {
    // Rationales were cut when they were stored; no second limit is applied here.
    const entry = /^[0-9a-f]{64}$/.test(key) ? validCachedVerdict(value, Number.MAX_SAFE_INTEGER) : undefined;
    if (entry) entries[key] = entry;
  }
  return entries;
}

/** `rename`, tried again a few times when the file is held for a moment by another process (Windows: EPERM, EBUSY, EACCES). */
async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
      await new Promise((done) => setTimeout(done, 20 * (attempt + 1)));
    }
  }
}

async function save(file: string, cache: MemoryCache): Promise<void> {
  if (!cache.dirty) return;
  await mkdir(dirname(file), { recursive: true });
  const mine = cache.toJSON();
  // What is in the file now, which may be more than this cache read when it was loaded, with the
  // verdicts of this cache put over it. The size limit is applied when a file is loaded.
  const merged = { version: mine.version, entries: { ...(await entriesOnDisk(file, mine.version)), ...mine.entries } };
  // A name no other save has, in this process or another: two writers never share a temporary file.
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(merged)}\n`);
    await renameOver(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  cache.markSaved();
}

/**
 * Writes the cache when it has something new: the entries of the file as it is at that moment,
 * with those of this cache over them, written beside the file under a name of its own and renamed
 * over it. A run that is interrupted leaves the old file whole, and the file is never a mix of two
 * writes.
 *
 * Within one process, saves of the same file run one after the other, so each one sees what the
 * one before wrote and no verdict is lost. Between two processes there is no lock: when both read
 * the file before either has renamed, the later rename wins and the verdicts the other added in
 * that moment are lost (they are asked for again next time). Lost, never corrupted.
 */
export function saveVerdictCache(file: string, cache: MemoryCache): Promise<void> {
  const path = resolve(file);
  const before = saving.get(path) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(() => save(path, cache));
  saving.set(path, mine);
  // The entry is dropped once nothing waits behind it, whether the save worked or not.
  const done = (): void => {
    if (saving.get(path) === mine) saving.delete(path);
  };
  mine.then(done, done);
  return mine;
}
