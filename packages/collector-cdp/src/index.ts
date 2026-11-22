import type { Config, Snapshot } from '@a11y-vision/core';
import { createWorld, readEnvironment } from './environment.js';
import { collectFocus } from './focus.js';
import type { CdpSession } from './session.js';

export type { CdpSession } from './session.js';

/** Collects what the configured checks need, and nothing else. */
export async function collectSnapshot(cdp: CdpSession, config: Config): Promise<Snapshot> {
  const world = await createWorld(cdp);
  const { reducedMotion, mediaType, ...environment } = await readEnvironment(world);
  const snapshot: Snapshot = {
    environment,
    nodes: [],
    axTree: [],
    screenshots: { tiles: [], clips: {} },
  };
  if (config.checks.includes('focus-indicator')) {
    snapshot.focus = await collectFocus(
      cdp,
      world,
      { ...environment, reducedMotion, mediaType },
      config.focus,
      snapshot.screenshots.clips,
    );
    // The captures were taken at this scale, whatever the page had before.
    snapshot.environment = { ...environment, devicePixelRatio: config.focus.deviceScaleFactor };
  }
  return snapshot;
}
