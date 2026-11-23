import { fnv1a64, headingReport } from '@a11y-vision/core';
import type { HeadingSurvey, HeadingsConfig, TextBlock } from '@a11y-vision/core';
import type { AgentHeadingPrepared, AgentHeadingSurvey } from './agent.js';
import type { StablePage } from './page.js';

/**
 * Reads the blocks of visible text of the page and captures the ones the headings check reports.
 *
 * Which text is a heading already is taken from the accessibility tree, not from tags: an
 * `h2` with `role="presentation"` or inside `aria-hidden` is not exposed as a heading, and a
 * `div` with the role heading is (verified against Chrome: `Accessibility.getFullAXTree` leaves
 * the former out as headings, reports level 2 for a role heading without `aria-level`, and
 * covers one frame per call). The headings are marked in the page by `markAccessibility` before
 * this runs; `axComplete` says whether that could be done in full.
 *
 * Runs on a page prepared by `withStablePage`. It scrolls each reported block into view; scroll
 * positions are put back by `withStablePage`. Nothing else on the page is touched.
 */
export async function collectHeadings(page: StablePage, config: HeadingsConfig, axComplete: boolean): Promise<HeadingSurvey> {
  const { agent } = page;

  const read = await agent<AgentHeadingSurvey>('headingSurvey()');
  const blocks: TextBlock[] = read.blocks.map((block) => ({ ...block, crop: null }));
  const survey: HeadingSurvey = { blocks, total: read.total, axComplete };

  // Core decides what is reported; only that is captured: at most `maxCandidates` candidates and
  // `maxInversions` contradictions between levels, so the number of captures is bounded by both.
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
    // No capture: `crop` stays null, for a candidate of any status (see HeadingCandidate.crop).
    if (!prepared.clip) continue;
    await page.capture(id, prepared.clip);
    block.crop = id;
    // Where the text is inside the capture: what the adjudicator layer outlines for a model.
    if (prepared.target) {
      const round = (value: number): number => Math.round(value * 100) / 100;
      block.cropTarget = {
        x: round(prepared.target.x - prepared.clip.x),
        y: round(prepared.target.y - prepared.clip.y),
        width: round(prepared.target.width),
        height: round(prepared.target.height),
      };
    }
  }
  return survey;
}
