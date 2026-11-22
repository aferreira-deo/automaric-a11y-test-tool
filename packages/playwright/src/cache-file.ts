import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createMemoryCache } from '@a11y-vision/adjudicators';
import type { MemoryCache } from '@a11y-vision/adjudicators';
import type { AdjudicationConfig } from '@a11y-vision/core';

/**
 * The verdict cache kept in a local JSON file. A file that is missing, unreadable or not what
 * this version writes gives an empty cache: a cache is never a reason for a scan to fail.
 * Entries are validated on the way in, so an edited file cannot put anything but a verdict
 * (`yes`, `no`, `unsure`, never a status) into a result.
 *
 * The file holds verdicts and the model's rationales, which can quote text of the pages that
 * were scanned. It stays on this machine: nothing reads it but this function.
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

/**
 * Writes the cache when it has something new. Written beside the file and renamed over it, so a
 * run that is interrupted leaves the old file whole. Two runs that end at the same time each
 * write what they know and the later one wins: verdicts can be lost that way, never corrupted.
 */
export async function saveVerdictCache(file: string, cache: MemoryCache): Promise<void> {
  if (!cache.dirty) return;
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(cache.toJSON())}\n`);
  await rename(temporary, file);
  cache.markSaved();
}
