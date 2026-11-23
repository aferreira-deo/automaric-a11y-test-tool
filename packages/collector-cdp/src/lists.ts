import { fnv1a64, listReport } from '@a11y-vision/core';
import type { Config, ListSurvey } from '@a11y-vision/core';
import type { AgentHeadingPrepared, AgentListSurvey } from './agent.js';
import type { StablePage } from './page.js';

/**
 * Reads what the lists check works from and captures what it reports.
 *
 * The text of the page is read as for the headings check (the same walk, with the settings of
 * `headings`), with what the lists check needs on top: what stands before each line, where each
 * block sits among the elements, series of sibling elements of one shape, and the `ul`, `ol` and
 * `menu` of interest. What has list semantics is what `markAccessibility` marked before this
 * runs; `axComplete` says whether that could be done in full.
 *
 * Core decides what is reported (`listReport`). Two things are then fetched for exactly that:
 * the selector of the element that holds the items of each series, and a capture. Both are
 * bounded by `maxCandidates`, `maxUnstyledLists` and `maxCaptures`.
 *
 * Runs on a page prepared by `withStablePage`. It scrolls what it captures into view; scroll
 * positions are put back by `withStablePage`. Nothing else on the page is touched.
 */
export async function collectLists(page: StablePage, config: Config, axComplete: boolean): Promise<ListSurvey> {
  const { agent } = page;
  const read = await agent<AgentListSurvey>('listSurvey()');
  const survey: ListSurvey = { ...read, axComplete, containers: {}, captures: {} };

  // The elements that hold the items: named now that core has said which ones it reports.
  const wanted = [...new Set(listReport(survey, config.lists).candidates.flatMap((candidate) => (candidate.container === null ? [] : [candidate.container])))];
  if (wanted.length > 0) {
    const selectors = await agent<(string | null)[]>(`listSelectors(${JSON.stringify(wanted)})`);
    wanted.forEach((position, index) => {
      const selector = selectors[index];
      if (typeof selector === 'string') survey.containers[String(position)] = selector;
    });
  }

  const report = listReport(survey, config.lists);
  const used = new Set<string>();
  for (const candidate of report.candidates.slice(0, config.lists.maxCaptures)) {
    // Named after the rule and the element, so that two runs give the same ids.
    const base = `lists/${fnv1a64(JSON.stringify([candidate.fingerprintRule, candidate.frame, candidate.selector]))}`;
    let id = `${base}.png`;
    for (let twin = 2; used.has(id); twin++) id = `${base}-${twin}.png`;
    used.add(id);
    const prepared = await agent<AgentHeadingPrepared>(`prepareList(${JSON.stringify(candidate.capture.kind)}, ${JSON.stringify(candidate.capture.ids)})`);
    // No capture: the finding is reported all the same, and says so.
    if (!prepared.clip) {
      survey.captures[candidate.key] = { crop: null, ...(prepared.covered ? { covered: true } : {}) };
      continue;
    }
    await page.capture(id, prepared.clip);
    const round = (value: number): number => Math.round(value * 100) / 100;
    survey.captures[candidate.key] = {
      crop: id,
      ...(prepared.target
        ? {
            cropTarget: {
              x: round(prepared.target.x - prepared.clip.x),
              y: round(prepared.target.y - prepared.clip.y),
              width: round(prepared.target.width),
              height: round(prepared.target.height),
            },
          }
        : {}),
    };
  }
  return survey;
}
