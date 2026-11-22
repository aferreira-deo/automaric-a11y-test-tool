import type { Config, Snapshot } from '@a11y-vision/core';
import { createWorld, readEnvironment } from './environment.js';
import { collectFocus } from './focus.js';
import { collectIcons } from './icons.js';
import { withStablePage } from './page.js';
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
  const focus = config.checks.includes('focus-indicator');
  const icons = config.checks.includes('icon-contrast');
  if (focus || icons) {
    const original = { ...environment, reducedMotion, mediaType };
    await withStablePage(cdp, world, original, config, snapshot.screenshots.clips, async (page) => {
      // The focus walk goes first: it needs focus where the page left it, and ends with nothing focused.
      if (focus) snapshot.focus = await collectFocus(page, config.focus);
      if (icons) snapshot.icons = await collectIcons(page, config.icon);
    });
    // The captures were taken at this scale, whatever the page had before.
    snapshot.environment = { ...environment, devicePixelRatio: config.focus.deviceScaleFactor };
  }
  return snapshot;
}
