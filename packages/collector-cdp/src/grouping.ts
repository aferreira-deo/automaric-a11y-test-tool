import { fnv1a64, groupingReport } from '@a11y-vision/core';
import type { Config, GroupingSurvey } from '@a11y-vision/core';
import type { AgentGroupingSurvey, AgentHeadingPrepared } from './agent.js';
import type { StablePage } from './page.js';

/**
 * Reads what the grouping check works from and captures what it reports.
 *
 * The form controls, their roles, names and descriptions, and the groups around them are those
 * the accessibility tree exposes: `markAccessibility` marked them before this runs, and
 * `axComplete` says whether that could be done in full. The text of the page is read as for the
 * headings check (the same walk, with the settings of `headings`), with what the grouping check
 * needs on top: where each text stands among the controls, and what it is tied to (a control
 * through `label` or `aria-labelledby`, a group through `legend` or `aria-labelledby`, anything
 * through `aria-describedby`).
 *
 * Core decides what is reported (`groupingReport`). Two things are then fetched for exactly
 * that: the selector of the element that holds each set, and a capture. Both are bounded by
 * `maxCandidates` and `maxCaptures`.
 *
 * Runs on a page prepared by `withStablePage`. It scrolls what it captures into view; scroll
 * positions are put back by `withStablePage`. Nothing else on the page is touched: no control
 * is focused, changed or submitted.
 */
export async function collectGrouping(page: StablePage, config: Config, axComplete: boolean): Promise<GroupingSurvey> {
  const { agent } = page;
  const read = await agent<AgentGroupingSurvey>('groupingSurvey()');
  const survey: GroupingSurvey = { ...read, axComplete, containers: {}, captures: {} };

  // The elements that hold the controls: named now that core has said which ones it reports.
  const wanted = [...new Set(groupingReport(survey, config.grouping).candidates.flatMap((candidate) => (candidate.container === null ? [] : [candidate.container])))];
  if (wanted.length > 0) {
    const selectors = await agent<(string | null)[]>(`listSelectors(${JSON.stringify(wanted)})`);
    wanted.forEach((position, index) => {
      const selector = selectors[index];
      if (typeof selector === 'string') survey.containers[String(position)] = selector;
    });
  }

  const report = groupingReport(survey, config.grouping);
  const used = new Set<string>();
  for (const candidate of report.candidates.slice(0, config.grouping.maxCaptures)) {
    // Named after the rule and the element, so that two runs give the same ids.
    const base = `grouping/${fnv1a64(JSON.stringify([candidate.fingerprintRule, candidate.frame, candidate.selector]))}`;
    let id = `${base}.png`;
    for (let twin = 2; used.has(id); twin++) id = `${base}-${twin}.png`;
    used.add(id);
    const { blocks, controls, target } = candidate.capture;
    const prepared = await agent<AgentHeadingPrepared>(`prepareGrouping(${JSON.stringify(blocks)}, ${JSON.stringify(controls)}, ${target})`);
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
