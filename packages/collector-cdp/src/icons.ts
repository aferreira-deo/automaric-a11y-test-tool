import { fnv1a64 } from '@a11y-vision/core';
import type { Box, IconCandidate, IconConfig, IconSurvey } from '@a11y-vision/core';
import type { AgentIconItem, AgentIconPrepared, AgentIconSurvey, AgentRect } from './agent.js';
import type { StablePage } from './page.js';

const NO_BOX: Box = { x: 0, y: 0, width: 0, height: 0 };
/** CSS px. Sub-pixel differences are rounding, not movement. */
const SAME_BOX_TOLERANCE = 0.5;

function sameBox(a: AgentRect | null, b: AgentRect | null): boolean {
  if (!a || !b) return false;
  return (
    Math.abs(a.x - b.x) <= SAME_BOX_TOLERANCE &&
    Math.abs(a.y - b.y) <= SAME_BOX_TOLERANCE &&
    Math.abs(a.width - b.width) <= SAME_BOX_TOLERANCE &&
    Math.abs(a.height - b.height) <= SAME_BOX_TOLERANCE
  );
}

/** Properties through which an author changes what the boundary of a native control looks like. */
const BOUNDARY_PROPERTY = /^(all$|border|background|box-shadow|appearance|-webkit-appearance|accent-color)/;

/**
 * Finds the controls of the icon-contrast check and captures each one once, at rest.
 * Measurement happens later, in core, from the captures stored in the snapshot clips.
 *
 * Runs on a page prepared by `withStablePage`. It blurs the focused element first (a focus ring
 * is not part of a control at rest) and scrolls each control into view; both are put back by
 * `withStablePage`. Controls are measured in the state the page is in: hover, pressed and
 * expanded states are not visited.
 */
export async function collectIcons(page: StablePage, config: IconConfig): Promise<IconSurvey> {
  const { agent } = page;

  /**
   * Static CSS is used for this one question only: is the look of this native control the
   * browser's? Yes unless a non-user-agent rule or the style attribute declares one of the
   * properties above on the control itself. Inherited declarations do not count.
   */
  const authorModified = async (key: number): Promise<boolean> => {
    const styles = await page.matchedStyles(await page.nodeIdOf(key));
    const declares = (properties: { name: string; disabled?: boolean }[]): boolean =>
      properties.some((property) => !property.disabled && BOUNDARY_PROPERTY.test(property.name));
    if (styles.inlineStyle && declares(styles.inlineStyle.cssProperties)) return true;
    return (styles.matchedCSSRules ?? []).some(({ rule }) => rule.origin !== 'user-agent' && declares(rule.style.cssProperties));
  };

  await agent('blurActive()');
  const survey = await agent<AgentIconSurvey>(`iconSurvey(${config.maxCandidates})`);
  const candidates: IconCandidate[] = [];
  for (const item of survey.items) candidates.push(await collectOne(item));
  return { candidates, total: survey.total, skipped: survey.skipped };

  async function collectOne(item: AgentIconItem): Promise<IconCandidate> {
    // Named after the element, so that two runs give the same ids.
    const id = `icon-contrast/${fnv1a64(JSON.stringify([item.frame, item.selector]))}.png`;
    let prepared = await agent<AgentIconPrepared>(`prepareIcon(${item.key})`);
    let captured = false;
    let moving = false;
    for (let attempt = 0; prepared.clip && !prepared.reason && !captured; attempt++) {
      await page.capture(id, prepared.clip);
      // The boxes were read before the capture. On a page that is still loading, the layout can
      // move in between, and the capture would then show something else at those coordinates.
      const after = await agent<AgentRect | null>(`box(${item.key})`);
      if (sameBox(prepared.box, after)) captured = true;
      else if (attempt + 1 >= config.captureAttempts) break;
      else prepared = await agent<AgentIconPrepared>(`prepareIcon(${item.key})`);
    }
    if (prepared.clip && !prepared.reason && !captured) moving = true;
    if (!captured) delete page.clips[id];
    const candidate: IconCandidate = {
      selector: item.selector,
      frame: item.frame,
      // Kept out of the snapshot when it kept moving: two runs would not agree on it.
      box: moving ? NO_BOX : (prepared.box ?? NO_BOX),
      kind: item.kind,
      disabled: item.disabled,
      crop: null,
    };
    if (item.kind === 'icon') {
      candidate.icon = {
        sources: item.sources,
        box: moving ? NO_BOX : (prepared.graphic ?? prepared.box ?? NO_BOX),
        boxFrom: prepared.graphicFrom,
        room: moving ? NO_BOX : (prepared.room ?? prepared.box ?? NO_BOX),
        declaredColor: item.declaredColor,
      };
    } else if (item.control) {
      candidate.boundary = {
        control: item.control,
        // Only a native control has a browser default to be left at.
        authorModified: !item.native || item.disabled || (await authorModified(item.key)),
        boxes: moving ? [] : prepared.boxes,
      };
    }
    if (item.hints.length > 0) candidate.hints = item.hints;
    if (prepared.clipped) candidate.clippedByViewport = true;
    if (!prepared.stable) candidate.unstabilised = true;
    if (!captured) {
      candidate.notCaptured = moving ? 'moving' : (prepared.reason ?? 'outside-viewport');
      return candidate;
    }
    candidate.crop = id;
    return candidate;
  }
}
