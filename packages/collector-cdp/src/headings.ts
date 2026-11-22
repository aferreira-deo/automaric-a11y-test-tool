import { fnv1a64, headingReport } from '@a11y-vision/core';
import type { HeadingSurvey, HeadingsConfig, TextBlock } from '@a11y-vision/core';
import { AGENT_GLOBAL } from './agent.js';
import type { AgentHeadingPrepared, AgentHeadingSurvey } from './agent.js';
import type { StablePage } from './page.js';

interface FrameTree {
  frame: { id: string };
  childFrames?: FrameTree[];
}

interface AxNode {
  ignored?: boolean;
  role?: { value?: unknown };
  properties?: { name: string; value?: { value?: unknown } }[];
  backendDOMNodeId?: number;
}

/** Remote objects of headings and frame elements are held under this group and released at the end. */
const OBJECT_GROUP = 'a11y-vision-headings';
/** Level of an element with the role heading and no `aria-level` (WAI-ARIA). Chrome reports it itself; this is the fallback. */
const DEFAULT_HEADING_LEVEL = 2;

/**
 * Reads the blocks of visible text of the page and captures the ones the headings check reports.
 *
 * Which text is a heading already is taken from the accessibility tree, not from tags: an
 * `h2` with `role="presentation"` or inside `aria-hidden` is not exposed as a heading, and a
 * `div` with the role heading is (verified against Chrome: `Accessibility.getFullAXTree` leaves
 * the former out as headings, reports level 2 for a role heading without `aria-level`, and
 * covers one frame per call).
 *
 * Runs on a page prepared by `withStablePage`. It scrolls each reported block into view; scroll
 * positions are put back by `withStablePage`. Nothing else on the page is touched.
 */
export async function collectHeadings(page: StablePage, config: HeadingsConfig): Promise<HeadingSurvey> {
  const { cdp, agent } = page;
  let axComplete = true;

  /** Calls a method of the agent with a DOM node as its first argument. */
  const onNode = async (backendNodeId: number, call: string): Promise<unknown> => {
    const { object } = (await cdp.send('DOM.resolveNode', {
      backendNodeId,
      executionContextId: page.contextId,
      objectGroup: OBJECT_GROUP,
    })) as { object: { objectId?: string } };
    const { result } = (await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function () { return globalThis.${AGENT_GLOBAL}.${call}; }`,
      returnByValue: true,
    })) as { result: { value?: unknown } };
    return result.value;
  };

  const readFrame = async (tree: FrameTree, top: boolean): Promise<void> => {
    if (!top) {
      // Only documents the agent can look into matter: it reads no text from the others.
      const readable = await cdp
        .send('DOM.getFrameOwner', { frameId: tree.frame.id })
        .then(async (owner) => (await onNode((owner as { backendNodeId: number }).backendNodeId, 'frameReadable(this)')) === true)
        .catch(() => false);
      if (!readable) return;
    }
    try {
      const { nodes } = (await cdp.send('Accessibility.getFullAXTree', { frameId: tree.frame.id })) as { nodes: AxNode[] };
      for (const node of nodes) {
        if (node.ignored || node.role?.value !== 'heading' || node.backendDOMNodeId === undefined) continue;
        const level = node.properties?.find((property) => property.name === 'level')?.value?.value;
        const marked = await onNode(
          node.backendDOMNodeId,
          `markHeading(this, ${typeof level === 'number' && Number.isInteger(level) && level > 0 ? level : DEFAULT_HEADING_LEVEL})`,
        ).catch(() => false);
        if (marked !== true) axComplete = false;
      }
    } catch {
      axComplete = false;
    }
    for (const child of tree.childFrames ?? []) await readFrame(child, false);
  };

  try {
    const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: FrameTree };
    await readFrame(frameTree, true);
  } catch {
    axComplete = false;
  } finally {
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => undefined);
  }

  const read = await agent<AgentHeadingSurvey>('headingSurvey()');
  const blocks: TextBlock[] = read.blocks.map((block) => ({ ...block, crop: null }));
  const survey: HeadingSurvey = { blocks, total: read.total, axComplete };

  // Core decides what is reported; only that is captured.
  const report = headingReport(survey, config);
  const used = new Set<string>();
  for (const index of new Set([...report.candidates.map((candidate) => candidate.block), ...report.inversions.map((inversion) => inversion.block)])) {
    const block = blocks[index];
    if (!block) continue;
    // Named after the element, so that two runs give the same ids.
    const base = `headings/${fnv1a64(JSON.stringify([block.frame, block.selector]))}`;
    let id = `${base}.png`;
    for (let twin = 2; used.has(id); twin++) id = `${base}-${twin}.png`;
    used.add(id);
    const prepared = await agent<AgentHeadingPrepared>(`prepareHeading(${index})`);
    if (prepared.covered) block.covered = true;
    if (!prepared.clip) continue;
    await page.capture(id, prepared.clip);
    block.crop = id;
  }
  return survey;
}
