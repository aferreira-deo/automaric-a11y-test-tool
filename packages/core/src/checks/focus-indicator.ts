import { toHex } from '../measure/color.js';
import { connectedComponents, diffMask, unionBox } from '../measure/diff.js';
import { decodePng } from '../measure/image.js';
import type { PixelBox } from '../measure/image.js';
import { measureComponent } from '../measure/indicator.js';
import type { ComponentMeasurement } from '../measure/indicator.js';
import type { Check, Evidence, FindingDraft, FocusConfig, FocusStop, Snapshot, Status, WcagRef } from '../types.js';

const FOCUS_VISIBLE: WcagRef = { sc: '2.4.7', level: 'AA' };
const NON_TEXT_CONTRAST: WcagRef = { sc: '1.4.11', level: 'AA' };
const FOCUS_NOT_OBSCURED: WcagRef = { sc: '2.4.11', level: 'AA' };

const HELP = {
  visible: 'A keyboard-operable component needs a visible change when it receives focus (2.4.7 Focus Visible).',
  contrast:
    'An author-styled focus indicator needs at least 3:1 against adjacent colours, on at least one side (1.4.11 Non-text Contrast).',
  obscured:
    'A focused component must not be entirely hidden by author-created content (2.4.11 Focus Not Obscured (Minimum)).',
  inventory: 'Inventory. Nothing to fix on the strength of this entry alone.',
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function evaluateStop(stop: FocusStop, snapshot: Snapshot, config: FocusConfig): FindingDraft[] {
  const drafts: FindingDraft[] = [];
  const flags: string[] = [];
  if (stop.reachedBy === 'forced') flags.push('forced');
  if (stop.authorModified) flags.push('authorModified');

  const emit = (
    rule: string,
    status: Status,
    wcag: WcagRef | null,
    message: string,
    help: string,
    evidence: Partial<Evidence> = {},
  ): void => {
    drafts.push({
      check: 'focus-indicator',
      rule: `focus-indicator/${rule}`,
      status,
      wcag,
      selector: stop.selector,
      frame: stop.frame,
      box: stop.box,
      evidence: {
        crops: stop.crops ? [stop.crops.focused, stop.crops.unfocused] : [],
        colors: {},
        ratios: {},
        ...evidence,
        flags: [...flags, ...(evidence.flags ?? [])],
      },
      message,
      help,
    });
  };

  if (stop.opaqueFrame) {
    emit(
      'frame-not-measured',
      'info',
      null,
      'Focus entered a cross-origin iframe. Its content was not measured.',
      HELP.inventory,
    );
    return drafts;
  }

  if (stop.obscured && stop.obscured.sampled > 0 && stop.obscured.covered > 0) {
    const { covered, sampled, by } = stop.obscured;
    if (covered === sampled) {
      emit(
        'obscured',
        'fail',
        FOCUS_NOT_OBSCURED,
        `When it received focus, the element was entirely covered by fixed or sticky content (${by}).`,
        HELP.obscured,
      );
    } else {
      emit(
        'partly-obscured',
        'info',
        FOCUS_NOT_OBSCURED,
        `When it received focus, the element was partly covered by fixed or sticky content (${by}): ${covered} of ${sampled} sampled points.`,
        HELP.inventory,
      );
    }
  }

  if (!stop.crops) {
    // An element that stays fully covered has already been reported above.
    if (stop.notCaptured !== 'obscured') {
      emit(
        'not-captured',
        'info',
        null,
        stop.notCaptured === 'no-box'
          ? 'The focused element has no box, so its focus indicator was not measured.'
          : 'The focused element could not be brought into the viewport, so its focus indicator was not measured.',
        HELP.inventory,
      );
    }
    return drafts;
  }

  const focusedClip = snapshot.screenshots.clips[stop.crops.focused];
  const unfocusedClip = snapshot.screenshots.clips[stop.crops.unfocused];
  if (!focusedClip || !unfocusedClip) {
    throw new Error(`Snapshot is missing the crops of ${stop.selector}`);
  }
  const scale = focusedClip.scale;
  const focused = decodePng(focusedClip.png);
  const unfocused = decodePng(unfocusedClip.png);
  const mask = diffMask(focused, unfocused, config.diffDeltaE);
  const minArea = Math.max(1, Math.round(config.minComponentAreaCssPx2 * scale * scale));
  const components = connectedComponents(mask, minArea);

  if (components.length === 0) {
    if (stop.textEntry) {
      emit(
        'caret-only',
        'likely',
        FOCUS_VISIBLE,
        'Nothing but the text caret changes when this field receives focus. Confirm whether the caret is a sufficient indicator here.',
        HELP.visible,
      );
    } else if (stop.outsideChange) {
      const { x, y, width, height } = stop.outsideChange;
      emit(
        'change-outside-element',
        'likely',
        FOCUS_VISIBLE,
        `Nothing changed in or around the element, but something changed elsewhere in the viewport (${Math.round(width)} by ${Math.round(height)} CSS px at ${Math.round(x)}, ${Math.round(y)}). Confirm that it indicates focus on this element.`,
        HELP.visible,
      );
    } else if (stop.reachedBy === 'forced') {
      emit(
        'no-visible-change',
        'likely',
        FOCUS_VISIBLE,
        'No pixel changed when the focus state was forced on this element. It is not in the Tab order, so the state was simulated; confirm with real focus.',
        HELP.visible,
      );
    } else {
      emit(
        'no-visible-change',
        'fail',
        FOCUS_VISIBLE,
        'No pixel changed anywhere in the viewport when this element received keyboard focus.',
        HELP.visible,
      );
    }
    return drafts;
  }

  if (stop.geometryChanged) {
    emit(
      'appears-on-focus',
      'info',
      FOCUS_VISIBLE,
      'The element moves or resizes when it receives focus, which is itself a visible change. Indicator contrast was not measured.',
      HELP.inventory,
    );
    return drafts;
  }

  const clip = focusedClip.box;
  if (!stop.authorModified) {
    const changed = unionBox(components)!;
    const reach = config.defaultRingMaxCssPx;
    const left = clip.x + changed.x / scale;
    const top = clip.y + changed.y / scale;
    const right = left + changed.width / scale;
    const bottom = top + changed.height / scale;
    const nearElement =
      left >= stop.box.x - reach &&
      top >= stop.box.y - reach &&
      right <= stop.box.x + stop.box.width + reach &&
      bottom <= stop.box.y + stop.box.height + reach;
    if (nearElement) {
      emit(
        'browser-default',
        'info',
        NON_TEXT_CONTRAST,
        'The focus indicator is the browser default and no author rule modifies it, so the 3:1 requirement of 1.4.11 does not apply.',
        HELP.inventory,
        { flags: ['browserDefault'] },
      );
      return drafts;
    }
    // The change reaches beyond a default ring: other rules (sibling, :focus-within) draw it.
  }

  const options = {
    adjacentGapPx: Math.max(1, Math.round(config.adjacentGapCssPx * scale)),
    adjacentBandPx: Math.max(1, Math.round(config.adjacentBandCssPx * scale)),
    clusterDeltaE: config.clusterDeltaE,
    minIndicatorShare: config.minIndicatorShare,
    minorPartMinShare: config.minorPartMinShare,
    minorPartSolidPx: Math.max(2, Math.round(config.minorPartSolidCssPx * scale)),
    minAdjacentShare: config.minAdjacentShare,
    strokeMaxThicknessPx: Math.round(config.strokeMaxThicknessCssPx * scale),
    fillMinCoverage: config.fillMinCoverage,
  };
  const all = components
    .slice(0, config.maxComponents)
    .map((component) => measureComponent(focused, mask, component, options));
  // A changed fill leaves unchanged text inside it, and the enclosed counters of letters become
  // separate little regions bordered by text. They are holes in the fill, not indicators.
  const inside = (inner: PixelBox, outer: PixelBox): boolean =>
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height;
  const fills = all.filter((m) => m.kind === 'fill');
  const measurements = all.filter((m) => !fills.some((fill) => fill !== m && inside(m.bbox, fill.bbox)));

  type Measured = ComponentMeasurement & { best: NonNullable<ComponentMeasurement['best']> };
  const measured = measurements.filter((m): m is Measured => m.best !== null);
  // Stable sort: on equal ratios the larger component (earlier in the list) wins.
  const best = [...measured].sort((a, b) => b.best.ratio - a.best.ratio)[0];

  if (!best) {
    emit(
      'unmeasured',
      'likely',
      NON_TEXT_CONTRAST,
      'The focus indicator fills the whole captured area, so nothing adjacent could be sampled. Check its contrast by hand.',
      HELP.contrast,
    );
    return drafts;
  }

  const ratio = round2(best.best.ratio);
  const indicator = toHex(best.best.indicator);
  const adjacent = toHex(best.best.adjacent);
  const evidence: Partial<Evidence> = {
    colors: { indicator, adjacent },
    ratios: { contrast: ratio },
    flags: [best.kind, ...(best.noisy ? ['noisy'] : [])],
  };

  if (best.best.ratio >= config.contrastThreshold) {
    emit(
      'measured',
      'info',
      NON_TEXT_CONTRAST,
      `Focus indicator ${indicator} measured at ${ratio}:1 against the adjacent colour ${adjacent}.`,
      HELP.inventory,
      evidence,
    );
    return drafts;
  }

  // Precision before recall: every source of doubt turns a failure into a `likely`.
  const doubts: string[] = [];
  if (best.best.ratio >= config.likelyBandFloor) {
    doubts.push(`the ratio is within anti-aliasing error of ${config.contrastThreshold}:1`);
  }
  if (measurements.every((m) => m.kind === 'fill')) {
    doubts.push('the indicator is a change of fill, and what a fill must contrast with is a judgement');
  }
  if (best.noisy) doubts.push('the surrounding colours are too varied to sample reliably');
  if (stop.reachedBy === 'forced') doubts.push('the focus state was simulated');

  const measuredText = `Focus indicator ${indicator} measures ${ratio}:1 against the adjacent colour ${adjacent}, and no part of it reaches ${config.contrastThreshold}:1.`;
  emit(
    'low-contrast',
    doubts.length > 0 ? 'likely' : 'fail',
    NON_TEXT_CONTRAST,
    doubts.length > 0 ? `${measuredText} Reported as likely because ${doubts.join('; ')}.` : measuredText,
    HELP.contrast,
    evidence,
  );
  return drafts;
}

export const focusIndicatorCheck: Check = {
  id: 'focus-indicator',
  evaluate(snapshot, config) {
    const walk = snapshot.focus;
    if (!walk) throw new Error('The focus-indicator check needs a snapshot collected with the focus walk.');

    const drafts = walk.stops.flatMap((stop) => evaluateStop(stop, snapshot, config.focus));

    const tabbed = walk.stops.filter((stop) => stop.reachedBy === 'tab').length;
    const reason = {
      cycle: 'focus returned to an element already visited',
      limit: 'a configured limit was reached',
      'no-focusable': 'nothing on the page takes focus',
    }[walk.stoppedBy];
    const unreached =
      walk.unreached > 0
        ? ` ${walk.unreached} focusable element(s) were never reached with Tab; ${walk.forced} of them were measured with a forced focus state.`
        : '';
    const { width, height } = snapshot.environment.viewport;
    drafts.push({
      check: 'focus-indicator',
      rule: 'focus-indicator/walk',
      status: 'info',
      wcag: null,
      selector: 'html',
      frame: '',
      box: { x: 0, y: 0, width, height },
      evidence: { crops: [], colors: {}, ratios: {}, flags: [walk.stoppedBy] },
      message: `Tab walk: ${tabbed} stop(s); it ended because ${reason}.${unreached}`,
      help: HELP.inventory,
    });
    return drafts;
  },
};
