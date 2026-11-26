import { REFLOW_RULES, REFLOW_SC, reflowReadableShare, reflowReport } from '../measure/reflow.js';
import type { ReflowCandidate } from '../measure/reflow.js';
import type { ReflowLayout } from '../reflow-types.js';
import type { Check, Evidence, FindingDraft } from '../types.js';

const HELP = {
  twoDimensional:
    'At a width of 320 CSS px (1280 px at 400% zoom), content that scrolls vertically has to be readable without scrolling horizontally as well (1.4.10 Reflow); content laid out to scroll horizontally has the same requirement at a height of 256 CSS px. Data tables, images, maps, diagrams, video, code and toolbars may need two dimensions; text and controls may not. Measured: the boxes of the lines of text and of the controls that lie beyond the edge of the viewport and are reached by scrolling the document.',
  inner:
    'A region whose own lines of text are wider than the region makes the reader scroll horizontally for every line (1.4.10 Reflow). Likely rather than a failure: whether the region is content that needs two dimensions (a log, a transcript set as code) is a judgement.',
  lost:
    'Reflow (1.4.10) asks that nothing be lost at 320 CSS px: text and controls shown at the larger viewport must still be shown, or be reachable. Measured: lines of text and controls whose boxes lie, wholly or partly, outside what a clipping ancestor shows (overflow: hidden or clip, contain: paint, clip), beyond the edge of a viewport that does not scroll on that axis, or before the start edge of the document.',
  truncated:
    'The text is cut to one line with an ellipsis, or to a number of lines (line-clamp). That is often by design and the whole text may be available elsewhere (a title attribute, the page it links to); it is lost at this viewport all the same (1.4.10 Reflow). Advisory.',
  notDisplayed:
    'Inventory. Text shown at the larger viewport is not displayed in this one (display: none or the like), and no control that discloses content appeared. A responsive layout may leave out what is repeated or secondary; check that nothing needed is gone (1.4.10 Reflow).',
  overlap:
    'At 320 CSS px text must not be made unreadable by other content laid over it (1.4.10 Reflow). Measured: the lines of two elements meet where they did not at the larger viewport; a failure only when the pixels confirm it: with each text made transparent in turn, ink of both coincides, or the ink of one is missing until the other is hidden.',
  sticky:
    'Fixed and sticky content (headers, footers, banners, chat widgets) stays in the viewport while the rest scrolls. In a small viewport it can leave too little room to read (1.4.10 Reflow, and 2.4.11 for focus). The share used here is the working threshold of this tool, not a number of WCAG: the status can be set (stickyObscuresStatus).',
  locked:
    'The document does not scroll on this axis (overflow hidden on the root or on body), and content lies beyond the viewport: what no scrolling brings into view is lost (1.4.10 Reflow).',
  double:
    'A scroll container inside a page that scrolls on the same axis, large enough to hold the main content, gives two scroll bars for one reading direction: the reader has to find out which one moves the text. Likely: whether this is the main content is a judgement (1.4.10 Reflow, and usability).',
  survey: 'Inventory. Nothing to fix on the strength of this entry alone.',
};

const KIND_TEXT: Record<string, string> = {
  table: 'tables',
  image: 'images',
  video: 'video',
  canvas: 'canvas',
  svg: 'SVG drawings',
  frame: 'frames',
  object: 'embedded objects',
  code: 'code',
  toolbar: 'toolbars',
  math: 'formulas',
  application: 'application regions',
  grid: 'grids',
};

function quote(sample: string): string {
  return sample ? ` It starts: "${sample}".` : '';
}

function at(candidate: ReflowCandidate): string {
  return `At ${String(candidate.values['viewport']).replace('x', ' by ')} CSS px`;
}

function messageOf(candidate: ReflowCandidate, related: (role: string) => string | null): { message: string; help: string } {
  const v = candidate.values;
  const flags = new Set(candidate.flags);
  const where = at(candidate);
  const tail = flags.has('viewportNotApplied')
    ? ' Recorded as info because the viewport measured is not the one asked for.'
    : flags.has('notSettled')
      ? ' The layout was still changing when it was measured, so nothing is reported above likely.'
      : flags.has('unsettled')
        ? ' Something on the page kept moving by script while it was measured, so this is likely rather than a failure.'
        : '';
  switch (candidate.rule) {
    case REFLOW_RULES.twoDimensional: {
      if (flags.has('innerScroller')) {
        return {
          message: `${where}, ${String(v['linesWiderThanScroller'])} line(s) of text inside this region are wider than the ${String(v['scrollerClientWidth'])} px it shows, so each has to be scrolled horizontally to be read.${quote(candidate.sample)}${flags.has('atBaseline') ? ' Recorded as info because it is the same at the baseline viewport.' : ''}${tail}`,
          help: HELP.inner,
        };
      }
      const edge = v['axis'] === 'y' ? 'below the bottom edge' : 'beyond the edge';
      const what = `${String(v['linesBeyond'])} line(s) of text and ${String(v['controlsBeyond'])} control(s)`;
      const base = `${where}, the document is ${String(v['overflowCssPx'])} px ${v['axis'] === 'y' ? 'taller' : 'wider'} than the viewport and needs scrolling in a second direction: ${what} inside this element lie ${edge} of the viewport, up to ${String(v['reachBeyondCssPx'])} px.${quote(candidate.sample)}`;
      if (flags.has('exceptedOnly')) {
        return {
          message: `${where}, the document is ${String(v['overflowCssPx'])} px wider than the viewport because of ${String(v['exceptedKinds'] ?? '').split(' ').map((kind) => KIND_TEXT[kind] ?? kind).join(', ')}, which may need two dimensions; no text or control outside such content lies beyond the edge. Recorded as info.${tail}`,
          help: HELP.twoDimensional,
        };
      }
      if (flags.has('atBaseline')) return { message: `${base} Recorded as info because the same content lies beyond the edge at the baseline viewport too.${tail}`, help: HELP.twoDimensional };
      return {
        message: `${base}${flags.has('excepted') ? ' Content that may need two dimensions is beyond the edge as well.' : ''}${flags.has('documentScrollsBothAxes') ? ' The document scrolls on both axes: two scroll bars.' : ''}${tail}`,
        help: HELP.twoDimensional,
      };
    }
    case REFLOW_RULES.lost: {
      if (flags.has('notDisplayed')) {
        return {
          message: `${where}, ${String(v['textsNotDisplayed'])} element(s) with text (${String(v['charsNotDisplayed'])} characters) shown at the baseline viewport are not displayed${flags.has('offScreen') ? ` or parked wholly off screen (${String(v['textsMovedOffScreen'])}), where no scrolling reaches and no control names them in aria-controls` : ''}, and no control that discloses content (a menu button, a summary) appeared. The first is this element.${quote(candidate.sample)}`,
          help: HELP.notDisplayed,
        };
      }
      const what = `${String(v['linesCut'])} line(s) of text${Number(v['controlsCut']) > 0 ? ` and ${String(v['controlsCut'])} control(s)` : ''}`;
      // The physical side that was measured, whatever the direction of the page.
      const side = typeof v['side'] === 'string' ? String(v['side']) : '';
      const why = flags.has('rootOverflowHidden')
        ? `lie beyond the ${side || 'right'} edge of a viewport that does not scroll horizontally (overflow-x: hidden on the root or on body), inside this element`
        : flags.has('fixedBeyondViewport')
          ? `of this fixed element lie beyond the ${side ? `${side} edge of the ` : ''}viewport, where neither scrolling the page nor a scroll container of its own brings them`
          : flags.has('beforeStartEdge')
            ? `lie before the start edge of the document${side ? ` (beyond its ${side} edge)` : ''}, where no scrolling reaches`
            : 'are cut off by this element, which clips what overflows it';
      const first = related('firstCut');
      const base = `${where}, ${what} shown in full at the baseline viewport ${why}.${first ? ` The first is ${first}.` : ''}${quote(candidate.sample)}`;
      if (flags.has('ellipsis') || flags.has('lineClamp')) return { message: `${base} The text is truncated with ${flags.has('ellipsis') ? 'an ellipsis' : 'a line clamp'}.${tail}`, help: HELP.truncated };
      if (flags.has('clipsAtBaseline')) return { message: `${base} Recorded as info because this element already hides part of what it holds at the baseline viewport, as the viewport of a carousel does.${tail}`, help: HELP.lost };
      if (flags.has('moving')) return { message: `${base} Recorded as info because what is cut moves through this element by itself (an animation, a ticker, a script), so it is shown in turn.${tail}`, help: HELP.lost };
      if (flags.has('carousel')) return { message: `${base} Recorded as info because this element is the viewport of a carousel (scroll snapping, aria-roledescription, controls that name it or previous and next controls beside it, a track that slides).${tail}`, help: HELP.lost };
      if (flags.has('revealControl')) return { message: `${base} Advisory rather than a failure because a control inside it or beside it (a button, a summary, an element with aria-expanded) may show what is hidden.${tail}`, help: HELP.lost };
      return { message: `${base}${tail}`, help: HELP.lost };
    }
    case REFLOW_RULES.overlap: {
      const other = related('other');
      const met = `${where}, the text of this element and ${other ?? 'another element'} meet (${Math.round(Number(v['overlapShare']) * 100)}% of the middle band of a line), which they do not at the baseline viewport.${quote(candidate.sample)}`;
      if (flags.has('pixelConfirmed')) {
        const how = [
          ...(flags.has('glyphsOverlap') ? [`${String(v['inkBothPx'])} device pixels are ink of both texts`] : []),
          ...(flags.has('inkCovered') ? [`${Math.round(Number(v['coveredShare']) * 100)}% of the ink of this text is missing until the other is hidden`] : []),
        ].join(', and ');
        return { message: `${met}${flags.has('decorativeCover') ? ' The other is decorative (aria-hidden or inert), so only ink of this text that it hides counts.' : ''} Confirmed by pixels: ${how}.${tail}`, help: HELP.overlap };
      }
      return {
        message: `${met} Measured from boxes only (${flags.has('notTested') ? 'beyond the limit of tests by pixels' : 'the region could not be captured'}), so ${candidate.status === 'likely' ? 'likely' : 'info, since which of the two is painted on top is not known'}.${tail}`,
        help: HELP.overlap,
      };
    }
    case REFLOW_RULES.sticky: {
      const share = Math.round(Number(v['readableShare']) * 100);
      const scrolled = flags.has('mainScroller') ? 'the scroll container that holds the page' : 'the page';
      const base = `${where}, fixed and stuck elements leave ${share}% of the viewport to read${flags.has('afterScroll') ? ` once ${scrolled} is scrolled (${String(v['scrollY'])} px)` : flags.has('mainScroller') ? ' (the document does not scroll; the scroll container that holds the page was scrolled to look)' : ''}, under the ${Math.round(Number(v['threshold']) * 100)}% this tool asks for. ${String(v['layers'])} element(s) take part; this one takes the most room.`;
      if (flags.has('atBaseline')) return { message: `${base} Recorded as info because the baseline viewport has the same problem (${Math.round(Number(v['readableShareAtBaseline']) * 100)}%).${tail}`, help: HELP.sticky };
      if (flags.has('loweredDismissible')) {
        return {
          message: `${base} ${String(v['dismissibleLayers'])} of them can be dismissed (an open dialog, or a banner with a control to close, accept or refuse); without them ${Math.round(Number(v['readableShareWithoutDismissible']) * 100)}% is readable, so the status is one level lower.${tail}`,
          help: HELP.sticky,
        };
      }
      return { message: `${base}${tail}`, help: HELP.sticky };
    }
    case REFLOW_RULES.locked: {
      const first = related('firstUnreachable');
      const base = `${where}, the document does not scroll vertically (overflow-y: ${String(v['overflowY'])}) and ${String(v['unreachableTexts'])} element(s) with text, ${String(v['unreachableControls'])} control(s) and ${String(v['unreachableOther'])} other piece(s) of content lie below the viewport where no scroll container brings them.${first ? ` The first is ${first}.` : ''}${quote(candidate.sample)}${flags.has('fullScreenLayer') ? ' A fixed layer covers the whole viewport.' : ''}`;
      if (flags.has('modalOpen')) return { message: `${base} Recorded as info because an open modal layer (a dialog, or a layer over the whole viewport) stops the page from scrolling while it is open: what lies behind it is not lost. Its own content is measured on its own (content-lost).${tail}`, help: HELP.locked };
      if (flags.has('atBaseline')) return { message: `${base} Recorded as info because the document locks content out of reach at the baseline viewport as well (a dialog or a consent wall that stops scrolling while it is open does that at every size).${tail}`, help: HELP.locked };
      if (candidate.status === 'likely') return { message: `${base} Likely: what is out of reach is no text and no control.${tail}`, help: HELP.locked };
      return { message: `${base}${tail}`, help: HELP.locked };
    }
    case REFLOW_RULES.double:
    default: {
      const vertical = v['axis'] !== 'x';
      return {
        message: `${where}, the page scrolls ${vertical ? 'vertically' : 'horizontally'} and so does this element, which takes ${Math.round(Number(v['scrollerShareOfViewport']) * 100)}% of the viewport ${vertical ? 'height' : 'width'} and holds ${String(v['textChars'])} characters of text: two scroll bars for the same direction.${flags.has('atBaseline') ? (candidate.status === 'info' ? ' Recorded as info because the baseline viewport has it too and it takes less of the viewport than a scroller that holds the page (nestedScrollerAtBaselineMinShare).' : ' The baseline viewport has it too; reported all the same, as it is what the reader of the reflowed page gets.') : ''}${tail}`,
        help: HELP.double,
      };
    }
  }
}

function layoutValues(prefix: string, layout: ReflowLayout, settings: Parameters<typeof reflowReadableShare>[1]): Record<string, string | number | boolean> {
  const vp = layout.viewport;
  const readable = reflowReadableShare(layout, settings);
  return {
    [`${prefix}Viewport`]: `${vp.width}x${vp.height}`,
    [`${prefix}Document`]: `${vp.scrollWidth}x${vp.scrollHeight}`,
    [`${prefix}Texts`]: layout.texts.length,
    [`${prefix}Boxes`]: layout.boxes.length,
    [`${prefix}Elements`]: layout.elements,
    ...(readable !== null ? { [`${prefix}ReadableShare`]: readable } : {}),
    ...(layout.settled ? {} : { [`${prefix}NotSettled`]: true }),
    ...(layout.truncated ? { [`${prefix}Truncated`]: true } : {}),
    ...(layout.frames.opaque > 0 ? { [`${prefix}FramesNotRead`]: layout.frames.opaque } : {}),
    ...(layout.textsBeyond > 0 ? { [`${prefix}TextsNotRead`]: layout.textsBeyond } : {}),
    ...(layout.boxesBeyond > 0 ? { [`${prefix}BoxesNotRead`]: layout.boxesBeyond } : {}),
  };
}

export const reflowCheck: Check = {
  id: 'reflow',
  evaluate(snapshot, config) {
    const survey = snapshot.reflow;
    if (!survey) throw new Error('The reflow check needs a snapshot collected with the reflow survey.');
    const settings = config.reflow;
    const report = reflowReport(survey, settings, snapshot.screenshots.clips);
    const named = (key: number): { selector: string; frame: string } | null => (key === 0 ? null : (survey.names[String(key)] ?? null));
    const drafts: FindingDraft[] = [];
    const flags = new Set<string>();
    const values: Record<string, string | number | boolean> = survey.baseline ? { ...layoutValues('baseline', survey.baseline, settings) } : {};
    let listed = 0;
    for (const { layout, report: pass } of report.passes) {
      Object.assign(values, layoutValues(layout.pass, layout, settings), {
        [`${layout.pass}OverlapCandidates`]: pass.overlapCandidates,
        [`${layout.pass}OverlapClearedByPixels`]: pass.clearedByPixels,
      });
      for (const [rule, omitted] of Object.entries(pass.omitted)) {
        values[`${layout.pass}Omitted:${rule.slice('reflow/'.length)}`] = omitted;
        flags.add('truncated');
      }
      if (layout.truncated) flags.add('truncated');
      for (const candidate of pass.candidates) {
        const name = named(candidate.key);
        const relatedName = (role: string): string | null => {
          const entry = candidate.related.find((item) => item.role === role);
          const target = entry ? named(entry.key) : null;
          return target ? target.selector : null;
        };
        const crop = layout.captures[candidate.id] ?? (candidate.capture?.kind === 'pixel' ? (layout.pixels[candidate.id]?.crops?.normal ?? null) : null);
        const extraCrops = candidate.capture?.kind === 'pixel' ? [layout.pixels[candidate.id]?.crops?.coverHidden].filter((id): id is string => typeof id === 'string') : [];
        const evidence: Evidence = {
          crops: [...(crop ? [crop] : []), ...extraCrops.filter((id) => id !== crop)],
          colors: {},
          ratios: {},
          flags: [...candidate.flags, ...(crop ? [] : ['notCaptured']), ...(name || candidate.key === 0 ? [] : ['unnamed'])].sort(),
          values: {
            ...candidate.values,
            ...Object.fromEntries(
              candidate.related.flatMap((item) => {
                const target = named(item.key);
                return target ? [[`${item.role}Selector`, target.frame ? `${target.frame} >>> ${target.selector}` : target.selector]] : [];
              }),
            ),
          },
        };
        const otherSelector = candidate.rule === REFLOW_RULES.overlap ? (relatedName('other') ?? '') : '';
        drafts.push({
          check: 'reflow',
          rule: candidate.rule,
          fingerprintRule: `${candidate.rule}@${candidate.pass}${otherSelector ? `#${otherSelector}` : ''}${candidate.flags.includes('notDisplayed') ? '#notDisplayed' : ''}${candidate.flags.includes('innerScroller') ? '#inner' : ''}`,
          status: candidate.status,
          wcag: REFLOW_SC,
          selector: name?.selector ?? 'html',
          frame: name?.frame ?? '',
          box: candidate.box ? { x: candidate.box[0], y: candidate.box[1], width: candidate.box[2], height: candidate.box[3] } : null,
          evidence,
          ...messageOf(candidate, relatedName),
        });
        listed++;
      }
    }
    const { width, height } = snapshot.environment.viewport;
    const ran = survey.passes.map((layout) => `${layout.pass} ${layout.requested.width} by ${layout.requested.height}`);
    const reference = survey.reference;
    const baselineText =
      reference && reference.source === 'configured'
        ? `at a reference viewport of ${reference.width} by ${reference.height} CSS px (the caller's, ${survey.original.width} by ${survey.original.height}, is smaller than referenceMinWidthCssPx by referenceMinHeightCssPx)`
        : `at the baseline viewport of ${survey.original.width} by ${survey.original.height} CSS px`;
    for (const layout of [survey.baseline, ...survey.passes]) {
      if (!layout) continue;
      if (layout.motion) values[`${layout.pass}Unsettled`] = layout.motion;
      if (layout.budgetSpent) values[`${layout.pass}SettleBudgetSpent`] = true;
    }
    if (survey.stopped) {
      values['stopped'] = survey.stopped.reason;
      values['stoppedDetail'] = survey.stopped.detail;
      flags.add('stopped');
    }
    drafts.push({
      check: 'reflow',
      rule: REFLOW_RULES.survey,
      status: 'info',
      wcag: null,
      selector: 'html',
      frame: '',
      box: { x: 0, y: 0, width, height },
      evidence: { crops: [], colors: {}, ratios: {}, flags: [...flags].sort(), values: { ...values, findings: listed, passes: survey.passes.map((layout) => layout.pass).join(' '), ...(survey.skipped.length > 0 ? { passesSkipped: survey.skipped.join(' ') } : {}) } },
      message:
        (survey.stopped
          ? `The survey stopped before its end: ${survey.stopped.reason === 'navigated' ? 'the page went to another document while a pass was in effect (it reloads or navigates when the viewport changes), so nothing more could be measured' : `a step failed (${survey.stopped.detail})`}. `
          : '') +
        `Measured the page ${survey.baseline ? baselineText : '(no baseline)'} and in ${ran.length} pass(es)${ran.length > 0 ? `: ${ran.join(', ')}` : ''}; the viewport was put back afterwards.` +
        ` Reported ${listed} finding(s).` +
        (survey.skipped.length > 0 ? ` Switched off: ${survey.skipped.join(', ')}.` : '') +
        (flags.has('truncated') ? ' Some of the page was not examined, or some findings are not listed, at the limits of the configuration (see the values).' : ''),
      help: HELP.survey,
    });
    return drafts;
  },
};
