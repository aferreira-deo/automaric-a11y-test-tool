import { beyondAxisOf, fnv1a64, reflowPassReport, reflowPixelPlan } from '@a11y-vision/core';
import type { Config, ReflowLayer, ReflowLayout, ReflowPassName, ReflowPixelTest, ReflowRect, ReflowSurvey } from '@a11y-vision/core';
import type { StablePage } from './page.js';
import { REFLOW_AGENT_GLOBAL, reflowAgentFactory } from './reflow-agent.js';
import type { AgentReflowMeasure, AgentReflowOptions } from './reflow-agent.js';

/** The settings of the in-page part of the reflow check. */
export function reflowAgentOptions(config: Config): AgentReflowOptions {
  const settings = config.reflow;
  return {
    maxElements: settings.maxElements,
    maxTextItems: settings.maxTextItems,
    maxBoxes: settings.maxBoxes,
    maxLinesPerText: settings.maxLinesPerText,
    maxBeyond: settings.maxBeyond,
    sampleChars: settings.sampleChars,
    toleranceCssPx: settings.toleranceCssPx,
    minVisibleTextCssPx: config.headings.minVisibleTextCssPx,
    settleMinMs: settings.settleMinMs,
    settleQuietMs: settings.settleQuietMs,
    settleMaxMs: settings.settleMaxMs,
    scrollSettleMs: settings.scrollSettleMs,
    scrollSettleMaxMs: settings.scrollSettleMaxMs,
    fontsTimeoutMs: config.focus.fontsTimeoutMs,
    layerMaxDescendants: settings.layerMaxDescendants,
  };
}

type Clip = { x: number; y: number; width: number; height: number };

function grow(region: ReflowRect, margin: number): ReflowRect {
  return [region[0] - margin, region[1] - margin, region[2] + 2 * margin, region[3] + 2 * margin];
}

/**
 * Measures the page for the reflow check: at the viewport it has (the baseline), then at each pass
 * (320 by 800 and 800 by 256 CSS px by default) set with `Emulation.setDeviceMetricsOverride` at the
 * capture scale and without mobile emulation, which is what a desktop browser zoomed to 400% lays
 * out. Core decides what is reported (`reflowPassReport`); for exactly that the elements are
 * named, overlapping text is tested by pixels, and evidence is captured, while the pass is still
 * in effect.
 *
 * Runs on a page prepared by `withStablePage`, last. The viewport goes back to `original` (with
 * the capture scale `withStablePage` set) and the scroll positions the passes changed are put
 * back before it returns, also when it fails; after a stop, the step registered with
 * `onRestore` does it once the session lets commands through again.
 */
export async function collectReflow(page: StablePage, config: Config, original: { width: number; height: number }): Promise<ReflowSurvey> {
  const settings = config.reflow;
  const scale = config.focus.deviceScaleFactor;
  await page.agent('renderAll()');
  const install = (await page.cdp.send('Runtime.evaluate', {
    expression: `globalThis.${REFLOW_AGENT_GLOBAL} = (${reflowAgentFactory.toString()})(${JSON.stringify(reflowAgentOptions(config))}); 1`,
    contextId: page.contextId,
    returnByValue: true,
  })) as { exceptionDetails?: { text: string; exception?: { description?: string } } };
  if (install.exceptionDetails) throw new Error(`Page evaluation failed: ${install.exceptionDetails.exception?.description ?? install.exceptionDetails.text}`);
  const reflow = async <T>(call: string): Promise<T> => {
    const response = (await page.cdp.send('Runtime.evaluate', {
      expression: `globalThis.${REFLOW_AGENT_GLOBAL}.${call}`,
      contextId: page.contextId,
      returnByValue: true,
      awaitPromise: true,
    })) as { result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    if (response.exceptionDetails) throw new Error(`Page evaluation failed: ${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}`);
    return response.result.value as T;
  };
  const metrics = (width: number, height: number): Promise<unknown> =>
    page.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });

  await reflow('begin()');
  // From here the window may be scrolled and the viewport changed: both are put back by this.
  let changed = true;
  const putBack = async (): Promise<void> => {
    if (!changed) return;
    await metrics(original.width, original.height);
    await reflow('restore()');
    changed = false;
  };
  page.onRestore(putBack);

  const survey: ReflowSurvey = { baseline: undefined as unknown as ReflowLayout, passes: [], skipped: [], names: {}, original: { ...original } };
  const name = async (keys: number[]): Promise<void> => {
    const wanted = [...new Set(keys.filter((key) => key > 0 && survey.names[String(key)] === undefined))].sort((a, b) => a - b);
    if (wanted.length === 0) return;
    const names = await reflow<({ selector: string; frame: string } | null)[]>(`name(${JSON.stringify(wanted)})`);
    wanted.forEach((key, index) => {
      const named = names[index];
      if (named) survey.names[String(key)] = named;
    });
  };
  const selectorOf = (key: number): string => {
    const named = survey.names[String(key)];
    return named ? `${named.frame}|${named.selector}` : `#${key}`;
  };

  const measure = async (pass: ReflowPassName, requested: { width: number; height: number }, axis: 'x' | 'y' | null, wait: boolean): Promise<ReflowLayout> => {
    const settled = await reflow<boolean>(`settle(${JSON.stringify(wait)})`);
    const read = await reflow<AgentReflowMeasure>(`measure(${JSON.stringify(axis)})`);
    const scrolls: ReflowLayout['scrolls'] = [];
    const seen = new Set<number>();
    for (const share of settings.stickyScrollPositions) {
      const y = Math.round(read.maxScroll.y * share);
      if (seen.has(y)) continue;
      seen.add(y);
      const at = await reflow<{ x: number; y: number }>(`scrollTo(0, ${y})`);
      scrolls.push({ x: Math.round(at.x), y: Math.round(at.y), layers: await reflow<ReflowLayer[]>('layers()') });
    }
    await reflow('scrollTo(0, 0)');
    return { pass, requested, settled, ...read, scrolls, pixels: {}, captures: {} };
  };

  /** Captures the overlaps core asks to test by pixels: the region as it is, then with one text transparent, the other hidden, and so on. */
  const pixelTests = async (layout: ReflowLayout): Promise<void> => {
    const plan = reflowPixelPlan(survey.baseline, layout, settings).slice(0, settings.maxPixelChecks);
    await name(plan.flatMap((candidate) => [candidate.a, candidate.b]));
    for (const candidate of plan) {
      const test: ReflowPixelTest = { region: candidate.region, top: 'unknown', crops: null };
      layout.pixels[candidate.id] = test;
      const region = grow(candidate.region, 2);
      const shown = await reflow<{ clip: Clip | null }>(`reveal(${JSON.stringify(region)}, false)`);
      if (!shown.clip) {
        test.reason = 'not-in-view';
        continue;
      }
      const top = await reflow<'a' | 'b' | 'layer' | 'unknown'>(`order(${candidate.a}, ${candidate.b}, ${JSON.stringify(candidate.region)})`);
      if (top === 'layer') {
        test.reason = 'layer-over';
        continue;
      }
      test.top = top === 'a' || top === 'b' ? top : 'unknown';
      const victim = candidate.kind === 'text' && top === 'a' ? candidate.b : candidate.a;
      const cover = victim === candidate.a ? candidate.b : candidate.a;
      const base = `reflow/${fnv1a64(JSON.stringify([layout.pass, 'overlap', selectorOf(victim), selectorOf(cover)]))}`;
      const shot = async (suffix: string, clear: number[], hide: number[]): Promise<string | null> => {
        if (clear.length + hide.length > 0 && !(await reflow<boolean>(`paint(${JSON.stringify(clear)}, ${JSON.stringify(hide)})`))) {
          await reflow('unpaint()');
          return null;
        }
        const id = `${base}-${suffix}.png`;
        try {
          await page.capture(id, shown.clip!);
        } finally {
          if (clear.length + hide.length > 0) await reflow('unpaint()');
        }
        return id;
      };
      const normal = await shot('normal', [], []);
      const victimClear = await shot('clear', [victim], []);
      const coverClear = candidate.kind === 'text' ? await shot('other-clear', [cover], []) : null;
      const bothClear = candidate.kind === 'text' ? await shot('both-clear', [victim, cover], []) : null;
      const coverHidden = await shot('other-hidden', [], [cover]);
      const coverHiddenVictimClear = await shot('other-hidden-clear', [victim], [cover]);
      if (!normal || !victimClear || !coverHidden || !coverHiddenVictimClear || (candidate.kind === 'text' && (!coverClear || !bothClear))) {
        test.reason = 'no-selector';
        continue;
      }
      test.crops = { normal, victimClear, coverClear, bothClear, coverHidden, coverHiddenVictimClear };
    }
  };

  /** Names what the findings of a pass are about and captures their evidence, at the viewport of the pass. */
  const evidence = async (layout: ReflowLayout): Promise<void> => {
    const report = reflowPassReport(survey.baseline, layout, settings, page.clips);
    await name(report.candidates.flatMap((candidate) => [candidate.key, ...candidate.related.map((item) => item.key)]));
    let taken = 0;
    for (const candidate of report.candidates) {
      const request = candidate.capture;
      if (!request || request.kind === 'pixel') continue;
      if (taken >= settings.maxCaptures) {
        layout.captures[candidate.id] = null;
        continue;
      }
      let clip: Clip | null;
      if (request.kind === 'viewport') {
        await reflow(`scrollTo(${request.x}, ${request.y})`);
        clip = await reflow<Clip>('viewportClip()');
      } else {
        clip = (await reflow<{ clip: Clip | null }>(`reveal(${JSON.stringify(grow(request.region, settings.clipMarginCssPx))}, true)`)).clip;
      }
      if (!clip || clip.width < 1 || clip.height < 1) {
        layout.captures[candidate.id] = null;
        continue;
      }
      const id = `reflow/${fnv1a64(JSON.stringify([candidate.rule, candidate.pass, selectorOf(candidate.key), candidate.flags.includes('notDisplayed'), candidate.flags.includes('innerScroller')]))}.png`;
      await page.capture(id, clip);
      layout.captures[candidate.id] = id;
      taken++;
    }
    await reflow('scrollTo(0, 0)');
  };

  try {
    survey.baseline = await measure('baseline', { ...original }, 'x', false);
    const passes: { pass: ReflowPassName; on: boolean; width: number; height: number }[] = [
      { pass: 'narrow', on: settings.narrowPass, width: settings.narrowWidthCssPx, height: settings.narrowHeightCssPx },
      { pass: 'short', on: settings.shortPass, width: settings.shortWidthCssPx, height: settings.shortHeightCssPx },
    ];
    for (const { pass, on, width, height } of passes) {
      if (!on) {
        survey.skipped.push(pass);
        continue;
      }
      await metrics(width, height);
      const layout = await measure(pass, { width, height }, beyondAxisOf(pass, survey.baseline, settings), true);
      survey.passes.push(layout);
      await pixelTests(layout);
      await evidence(layout);
    }
  } finally {
    // After a stop the session refuses this; the step registered above runs once it lets it through.
    await putBack().catch(() => undefined);
  }
  return survey;
}
