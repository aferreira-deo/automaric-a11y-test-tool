import { elementSignature } from '@a11y-vision/core';
import type { Config, Snapshot } from '@a11y-vision/core';
import type { AgentSignature } from './agent.js';
import { createWorld, readEnvironment } from './environment.js';
import { collectFocus } from './focus.js';
import { collectGrouping } from './grouping.js';
import { collectHeadings } from './headings.js';
import { collectIcons } from './icons.js';
import { collectLists } from './lists.js';
import { markAccessibility } from './accessibility.js';
import { withStablePage } from './page.js';
import type { CdpSession } from './session.js';

export type { CdpSession } from './session.js';

/** The document in the main frame: `loaderId` changes when the frame goes to another document, and not when it only changes its address. */
interface MainDocument {
  loaderId: string;
  url: string;
}

async function mainDocument(cdp: CdpSession): Promise<MainDocument> {
  const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { loaderId: string; url: string } } };
  return { loaderId: frameTree.frame.loaderId, url: frameTree.frame.url };
}

/** Documents waited for in a row before giving up: the page goes on from one to the next. */
const LOAD_ATTEMPTS = 3;

/**
 * Waits for the document in the main frame, `timeoutMs` at most: until it is `parsed`
 * (`DOMContentLoaded`), or until it is `loaded` with its images and style sheets (`load`).
 */
async function waitForDocument(cdp: CdpSession, state: 'parsed' | 'loaded', timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) return;
    const expression = `new Promise((resolve) => {
      const parsed = ${JSON.stringify(state === 'parsed')};
      if (document.readyState === 'complete' || (parsed && document.readyState === 'interactive')) resolve(true);
      else {
        if (parsed) document.addEventListener('DOMContentLoaded', () => resolve(true), { once: true });
        addEventListener('load', () => resolve(true), { once: true });
        setTimeout(() => resolve(false), ${Math.floor(left)});
      }
    })`;
    try {
      await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      return;
    } catch {
      // That document was replaced while it loaded: the next one is waited for.
    }
  }
}

/**
 * Collects what the configured checks need, and nothing else.
 *
 * A page can go to another document while it is read: a redirect by script or by
 * `meta refresh` that fires after `load` (seen on a site that had moved to a new domain: the
 * old address loads, then sends the browser on a moment later). Everything the collector holds
 * then belongs to a document that is gone, and Chrome answers "Cannot find context with
 * specified id" or "Could not find node with given id"; or nothing fails and what was read is
 * half of one page and half of another. So the document of the main frame is compared before
 * and after: when it changed, the new one is waited for and read from the start, once, and the
 * snapshot says where the scan started (`environment.navigatedFrom`). A page that navigates
 * again during the second reading is an error that says so.
 *
 * A document that is still being parsed is waited for before it is read, for the same reason:
 * Chrome renumbers the nodes of a document when it has parsed it, and what was asked about a
 * node before that then fails.
 */
export async function collectSnapshot(cdp: CdpSession, config: Config): Promise<Snapshot> {
  const attempt = async (): Promise<{ from: MainDocument; to: MainDocument | null; snapshot?: Snapshot; error?: unknown }> => {
    // The document that is read is one that has been parsed: asked again after the wait, as
    // the page may have gone to another document while it was waited for.
    let from = await mainDocument(cdp);
    for (let round = 0; round < LOAD_ATTEMPTS; round++) {
      await waitForDocument(cdp, 'parsed', config.focus.navigationTimeoutMs);
      const now = await mainDocument(cdp);
      if (now.loaderId === from.loaderId) break;
      from = now;
    }
    let snapshot: Snapshot | undefined;
    let error: unknown;
    try {
      snapshot = await collectOnce(cdp, config);
    } catch (caught) {
      error = caught ?? new Error('Collection failed.');
    }
    const now = await mainDocument(cdp).catch(() => null);
    return { from, to: now && now.loaderId !== from.loaderId ? now : null, ...(snapshot ? { snapshot } : {}), ...(error !== undefined ? { error } : {}) };
  };

  const first = await attempt();
  if (!first.to) {
    if (first.snapshot) return first.snapshot;
    throw first.error;
  }
  await waitForDocument(cdp, 'loaded', config.focus.navigationTimeoutMs);
  const second = await attempt();
  if (second.to) {
    throw new Error(
      `The page went from ${first.from.url} to ${first.to.url} while it was being read, and on to ${second.to.url} while it was read again. Scan it once it has settled, or scan the address it ends on.`,
    );
  }
  if (!second.snapshot) {
    const reason = second.error instanceof Error ? second.error.message : String(second.error);
    throw new Error(`The page went from ${first.from.url} to ${first.to.url} while it was being read, and reading it there failed: ${reason}`);
  }
  second.snapshot.environment.navigatedFrom = first.from.url;
  return second.snapshot;
}

async function collectOnce(cdp: CdpSession, config: Config): Promise<Snapshot> {
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
  const headings = config.checks.includes('headings');
  const lists = config.checks.includes('lists');
  const grouping = config.checks.includes('grouping');
  if (focus || icons || headings || lists || grouping) {
    const original = { ...environment, reducedMotion, mediaType };
    await withStablePage(cdp, world, original, config, snapshot.screenshots.clips, async (page) => {
      // The focus walk goes first: it needs focus where the page left it, and ends with nothing focused.
      if (focus) snapshot.focus = await collectFocus(page, config.focus);
      if (icons) snapshot.icons = await collectIcons(page, config.icon);
      // Last: they read the page as the other collectors left it and only scroll. What the
      // accessibility tree exposes as headings, lists, form controls and groups is read once for all, with everything
      // the browser skips rendering for (content-visibility: auto) rendered, as the text is.
      if (headings || lists || grouping) {
        await page.agent('renderAll()');
        const exposed = await markAccessibility(page, {
          lists,
          maxLists: config.lists.maxAxMarks,
          grouping: grouping ? { maxMarks: config.grouping.maxAxMarks, maxNameChars: config.grouping.maxNameChars } : null,
        });
        if (headings) snapshot.headings = await collectHeadings(page, config.headings, exposed.headings);
        if (lists) snapshot.lists = await collectLists(page, config, exposed.headings && exposed.lists);
        if (grouping) snapshot.grouping = await collectGrouping(page, config, exposed.headings && exposed.grouping, exposed.groupingUnmarked);
      }
      // What each element that was named is, hashed here: the text it is made from stays in this function.
      const signatures: Record<string, string> = {};
      for (const [key, tag, role, material] of await page.agent<AgentSignature[]>('signatures()')) signatures[key] = elementSignature(tag, role, material);
      snapshot.signatures = signatures;
    });
    // The captures were taken at this scale, whatever the page had before.
    snapshot.environment = { ...environment, devicePixelRatio: config.focus.deviceScaleFactor };
  }
  return snapshot;
}
