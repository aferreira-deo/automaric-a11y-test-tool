import { contrastRatio, toHex } from '../measure/color.js';
import type { Rgb } from '../measure/color.js';
import { measureBoundary, measureIcon } from '../measure/icon.js';
import type { BoundaryMeasurement } from '../measure/icon.js';
import { decodePng } from '../measure/image.js';
import type { PixelBox } from '../measure/image.js';
import type { Box, Check, Evidence, FindingDraft, IconCandidate, IconConfig, Screenshot, Status, WcagRef } from '../types.js';

const NON_TEXT_CONTRAST: WcagRef = { sc: '1.4.11', level: 'AA' };

const HELP = {
  icon: 'The parts of a graphic that are needed to understand it need at least 3:1 against adjacent colours (1.4.11 Non-text Contrast). A control without visible text is identified by its icon.',
  boundary:
    'The visual information needed to identify a control needs at least 3:1 against adjacent colours (1.4.11 Non-text Contrast). A boundary is subject to it only when it is what identifies the control.',
  inventory: 'Inventory. Nothing to fix on the strength of this entry alone.',
};

const CONTROL_NAME = {
  'text-field': 'field',
  select: 'select',
  checkbox: 'checkbox',
  radio: 'radio button',
  switch: 'switch',
} as const;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseHex(value: string): Rgb | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  return match ? { r: parseInt(match[1]!, 16), g: parseInt(match[2]!, 16), b: parseInt(match[3]!, 16) } : null;
}

/** A page box in the pixels of a capture. Edges are rounded to the nearest pixel. */
function toPixels(box: Box, clip: Screenshot): PixelBox {
  const x0 = Math.round((box.x - clip.box.x) * clip.scale);
  const y0 = Math.round((box.y - clip.box.y) * clip.scale);
  const x1 = Math.round((box.x + box.width - clip.box.x) * clip.scale);
  const y1 = Math.round((box.y + box.height - clip.box.y) * clip.scale);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function px(cssPx: number, scale: number, min = 1): number {
  return Math.max(min, Math.round(cssPx * scale));
}

function evaluateCandidate(candidate: IconCandidate, clips: Record<string, Screenshot>, config: IconConfig): FindingDraft[] {
  const drafts: FindingDraft[] = [];
  const baseFlags: string[] = [];
  if (candidate.icon) baseFlags.push(...candidate.icon.sources);
  if (candidate.boundary) baseFlags.push(candidate.boundary.control);
  if (candidate.unstabilised) baseFlags.push('unstabilised');
  if (candidate.clippedByViewport) baseFlags.push('clippedByViewport');
  if (candidate.hints?.includes('inactive')) baseFlags.push('maybeInactive');
  if (candidate.hints?.includes('logo')) baseFlags.push('maybeLogo');

  const emit = (rule: string, status: Status, message: string, help: string, evidence: Partial<Evidence> = {}): void => {
    drafts.push({
      check: 'icon-contrast',
      rule: `icon-contrast/${rule}`,
      status,
      wcag: NON_TEXT_CONTRAST,
      selector: candidate.selector,
      frame: candidate.frame,
      // A control that kept moving has no box to report.
      box: candidate.notCaptured === 'moving' ? null : candidate.box,
      evidence: {
        crops: candidate.crop ? [candidate.crop] : [],
        colors: {},
        ratios: {},
        ...evidence,
        flags: [...baseFlags, ...(evidence.flags ?? [])],
      },
      message,
      help,
    });
  };

  if (candidate.disabled) {
    emit('disabled', 'info', 'The control is disabled, so the 3:1 requirement of 1.4.11 does not apply. It was not measured.', HELP.inventory, {
      flags: ['disabled'],
    });
    return drafts;
  }

  const clip = candidate.crop ? clips[candidate.crop] : undefined;
  if (candidate.crop && !clip) throw new Error(`Snapshot is missing the crop of ${candidate.selector}`);
  if (!clip) {
    const why = {
      'no-box': 'The control has no box',
      'outside-viewport': 'The control could not be brought into the viewport',
      covered: 'Other content lies in front of the control',
      moving: 'The control kept moving while it was being captured (the page was still changing its layout)',
    }[candidate.notCaptured ?? 'outside-viewport'];
    emit('not-measured', 'info', `${why}, so it was not measured.`, HELP.inventory);
    return drafts;
  }
  const image = decodePng(clip.png);
  const scale = clip.scale;
  const threshold = config.contrastThreshold;

  if (candidate.boundary) {
    const { control, authorModified, boxes } = candidate.boundary;
    const name = CONTROL_NAME[control];
    if (!authorModified) {
      emit(
        'boundary-default',
        'info',
        `The ${name} has the browser default appearance and no author rule changes its border or background, so the 3:1 requirement of 1.4.11 does not apply.`,
        HELP.inventory,
        { flags: ['browserDefault'] },
      );
      return drafts;
    }
    const options = {
      reachPx: px(config.boundaryReachCssPx, scale),
      depthPx: px(config.boundaryDepthCssPx, scale),
      sideShare: config.boundarySideShare,
      minSidePx: px(config.boundaryMinSideCssPx, scale),
      clusterDeltaE: config.boundaryClusterDeltaE,
      minShare: config.boundaryMinShare,
    };
    let best: (BoundaryMeasurement & { wrapper: boolean }) | null = null;
    for (const [index, box] of boxes.entries()) {
      const measured = measureBoundary(image, toPixels(box, clip), options);
      if (measured && (!best || measured.ratio > best.ratio)) best = { ...measured, wrapper: index > 0 };
      // The control's own edge is preferred as evidence: a wrapper is only looked at when it is not enough.
      if (best && best.ratio >= threshold) break;
    }
    if (!best) {
      emit('not-measured', 'info', `No edge of the ${name} lies inside the capture, so its boundary was not measured.`, HELP.inventory);
      return drafts;
    }
    const ratio = round2(best.ratio);
    const evidence: Partial<Evidence> = {
      colors: { edge: toHex(best.a), adjacent: toHex(best.b) },
      ratios: { contrast: ratio },
      flags: [best.side, ...(best.wrapper ? ['wrapper'] : [])],
    };
    const where = best.wrapper ? 'an element wrapped around it' : `the ${name}`;
    if (best.ratio >= threshold) {
      emit(
        'boundary-measured',
        'info',
        `The ${best.side} edge of ${where} shows ${toHex(best.a)} next to ${toHex(best.b)}, ${ratio}:1.`,
        HELP.inventory,
        evidence,
      );
      return drafts;
    }
    const wrappers = boxes.length > 1 ? `, nor of the ${boxes.length - 1} element(s) wrapped tightly around it,` : '';
    const measuredText = `No edge of the ${name}${wrappers} reaches ${threshold}:1: the strongest is ${toHex(best.a)} next to ${toHex(best.b)}, ${ratio}:1 (${best.side} edge).`;
    if (control === 'select') {
      emit(
        'boundary-low-contrast',
        'info',
        `${measuredText} Recorded as info because a select usually shows an arrow, which may be what identifies it.`,
        HELP.boundary,
        { ...evidence, flags: [...(evidence.flags ?? []), 'otherCue'] },
      );
    } else {
      emit(
        'boundary-low-contrast',
        'likely',
        `${measuredText} Confirm that nothing else identifies the ${name}.`,
        HELP.boundary,
        evidence,
      );
    }
    return drafts;
  }

  if (!candidate.icon) return drafts;
  const { icon } = candidate;
  const declared = icon.declaredColor ? parseHex(icon.declaredColor) : null;
  const target = {
    box: toPixels(icon.box, clip),
    room: icon.boxFrom === 'graphic' ? toPixels(icon.room, clip) : null,
    declared,
    subpixelText: icon.sources.includes('font-glyph'),
  };
  const measured = measureIcon(image, target, {
    backgroundGapPx: px(config.backgroundGapCssPx, scale),
    backgroundBandPx: px(config.backgroundBandCssPx, scale),
    clusterDeltaE: config.clusterDeltaE,
    uniformBackgroundMinShare: config.uniformBackgroundMinShare,
    minBackgroundShare: config.minBackgroundShare,
    minInkShare: config.minInkShare,
    minPartShare: config.minPartShare,
    minSolidPartShare: config.minSolidPartShare,
    blendToleranceRgb: config.blendToleranceRgb,
    minInteriorShare: config.minInteriorShare,
    flatBlockPx: px(config.flatBlockCssPx, scale, 3),
    maxParts: config.maxParts,
    complexResidualShare: config.complexResidualShare,
    declaredBlendMinShare: config.declaredBlendMinShare,
  });

  if (measured.outcome === 'no-ink') {
    const background = measured.background[0];
    if (declared && background && contrastRatio(declared, background) < threshold) {
      const ratio = round2(contrastRatio(declared, background));
      emit(
        'icon-not-distinguishable',
        'likely',
        `Nothing in the icon could be told apart from its background ${toHex(background)}. Its declared colour is ${toHex(declared)}, ${ratio}:1. Confirm that the icon is meant to be visible in this state.`,
        HELP.icon,
        { colors: { icon: toHex(declared), background: toHex(background) }, ratios: { contrast: ratio }, flags: ['declaredColour'] },
      );
    } else {
      emit(
        'not-measured',
        'info',
        'No graphic could be told apart from the background inside the control, so nothing was measured.',
        HELP.inventory,
      );
    }
    return drafts;
  }

  const main = measured.parts[0]!;
  const flags = [measured.colourFrom === 'declared' ? 'declaredColour' : 'pixelColour'];
  if (measured.thin) flags.push('thin');
  if (measured.declaredMismatch) flags.push('declaredMismatch');
  if (measured.parts.length > 1) flags.push('multiColour');
  if (!measured.uniformBackground) flags.push('variedBackground');
  if (measured.complex) flags.push('complex');
  const mainRatio = round2(main.ratio);
  const colors: Record<string, string> = { icon: toHex(main.color), background: toHex(main.against) };
  const ratios: Record<string, number> = { contrast: mainRatio };
  measured.parts.slice(1).forEach((part, index) => {
    colors[`part${index + 2}`] = toHex(part.color);
    ratios[`part${index + 2}`] = round2(part.ratio);
  });
  const evidence: Partial<Evidence> = { colors, ratios, flags };
  const listed = measured.parts.map((part) => `${toHex(part.color)} at ${round2(part.ratio)}:1`).join(', ');

  if (measured.complex) {
    const best = round2(measured.bestRatio);
    if (measured.bestRatio >= threshold) {
      emit(
        'icon-complex',
        'info',
        `The graphic has too many colours to be measured as an icon (a picture, a photo or a detailed logo). Its strongest colour is at ${best}:1 against the background.`,
        HELP.inventory,
        evidence,
      );
    } else {
      emit(
        'icon-low-contrast',
        'likely',
        `The graphic has many colours and none of them reaches ${threshold}:1 against the background ${toHex(main.against)}: the strongest is at ${best}:1. Reported as likely because which part is needed to understand it is a judgement.`,
        HELP.icon,
        { ...evidence, ratios: { ...ratios, best } },
      );
    }
    return drafts;
  }

  if (measured.parts.length > 1) {
    if (measured.parts.every((part) => part.ratio >= threshold)) {
      emit('icon-measured', 'info', `Icon of ${measured.parts.length} colours, all at ${threshold}:1 or more against the background: ${listed}.`, HELP.inventory, evidence);
    } else {
      emit(
        'icon-multi-colour',
        'likely',
        `Icon of ${measured.parts.length} colours, at least one under ${threshold}:1 against the background ${toHex(main.against)}: ${listed}. Confirm whether a part under ${threshold}:1 is needed to understand the icon.`,
        HELP.icon,
        evidence,
      );
    }
    return drafts;
  }

  const source = measured.colourFrom === 'declared' ? 'declared colour' : 'colour read from pixels';
  if (!measured.uniformBackground) {
    if (main.ratio >= threshold) {
      emit(
        'icon-measured',
        'info',
        `Icon ${toHex(main.color)} (${source}) on a background of several colours: at least ${mainRatio}:1, against ${toHex(main.against)}.`,
        HELP.inventory,
        evidence,
      );
    } else {
      emit(
        'icon-varied-background',
        'likely',
        `Icon ${toHex(main.color)} (${source}) is on a background of several colours and measures ${mainRatio}:1 against one of them, ${toHex(main.against)}. Confirm that the icon is not lost where it crosses that colour.`,
        HELP.icon,
        evidence,
      );
    }
    return drafts;
  }

  if (main.ratio >= threshold) {
    emit(
      'icon-measured',
      'info',
      `Icon ${toHex(main.color)} (${source}) measured at ${mainRatio}:1 against its background ${toHex(main.against)}.`,
      HELP.inventory,
      evidence,
    );
    return drafts;
  }

  // Precision before recall: every source of doubt turns a failure into a `likely`.
  const doubts: string[] = [];
  if (main.ratio >= config.likelyBandFloor) doubts.push(`the ratio is within measurement error of ${threshold}:1`);
  if (measured.thin) doubts.push('its strokes are too thin for a pixel to show their true colour, which may be stronger');
  if (measured.declaredMismatch) doubts.push(`the colour its styles declare (${icon.declaredColor ?? ''}) was not found in the capture`);
  if (candidate.unstabilised) {
    doubts.push('transitions and animations could not be switched off on it, so the capture may show an intermediate state');
  }
  if (candidate.clippedByViewport) doubts.push('the control reaches beyond the viewport and was captured in part');
  if (candidate.hints?.includes('inactive')) {
    doubts.push(
      'its styles or class names suggest that the control is inactive (no pointer events, a not-allowed cursor or a class naming it disabled), and an inactive control is exempt',
    );
  }
  if (candidate.hints?.includes('logo')) doubts.push('its markup names it a logo, and a logotype is exempt');
  const measuredText = `Icon ${toHex(main.color)} (${source}) measures ${mainRatio}:1 against its background ${toHex(main.against)}, under ${threshold}:1, and the control has no visible text.`;
  emit(
    'icon-low-contrast',
    doubts.length > 0 ? 'likely' : 'fail',
    doubts.length > 0 ? `${measuredText} Reported as likely because ${doubts.join('; ')}.` : measuredText,
    HELP.icon,
    evidence,
  );
  return drafts;
}

export const iconContrastCheck: Check = {
  id: 'icon-contrast',
  evaluate(snapshot, config) {
    const survey = snapshot.icons;
    if (!survey) throw new Error('The icon-contrast check needs a snapshot collected with the icon survey.');

    const drafts = survey.candidates.flatMap((candidate) => evaluateCandidate(candidate, snapshot.screenshots.clips, config.icon));

    const icons = survey.candidates.filter((candidate) => candidate.kind === 'icon').length;
    const boundaries = survey.candidates.length - icons;
    const beyond = survey.total - survey.candidates.length;
    const skipped = Object.entries(survey.skipped)
      .filter(([, count]) => count > 0)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([reason, count]) => `${count} ${reason}`);
    const { width, height } = snapshot.environment.viewport;
    drafts.push({
      check: 'icon-contrast',
      rule: 'icon-contrast/survey',
      status: 'info',
      wcag: null,
      selector: 'html',
      frame: '',
      box: { x: 0, y: 0, width, height },
      evidence: { crops: [], colors: {}, ratios: {}, flags: beyond > 0 ? ['truncated'] : [] },
      message:
        `Looked at ${icons} control(s) without visible text that show a graphic and ${boundaries} form control(s) identified by a boundary.` +
        (beyond > 0 ? ` ${beyond} more were found and not measured (limit of ${config.icon.maxCandidates}).` : '') +
        (skipped.length > 0 ? ` Left out: ${skipped.join(', ')}.` : ''),
      help: HELP.inventory,
    });
    return drafts;
  },
};
