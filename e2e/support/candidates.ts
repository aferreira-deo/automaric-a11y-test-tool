import { buildResult, createImage, encodePng, fillRect, resolveConfig } from '@a11y-vision/core';
import type { Config, ConfigInput, ScanResult, Snapshot, TextBlock, TextStyle } from '@a11y-vision/core';

/**
 * A snapshot with heading candidates of every kind the adjudicator layer has to tell apart,
 * built by hand: no browser is involved. Used by the unit tests of the layer.
 */

const BODY: TextStyle = { family: 'arial', size: 16, weight: 400, color: '#1a1a1a', transform: 'none', italic: false };
const TITLE: TextStyle = { ...BODY, size: 24, weight: 700 };
const PARAGRAPH =
  'Body text that goes on for a while so that it is the most common style of the page by far. It has a second sentence and a third one, so that one paragraph alone holds enough characters to say what body text looks like on a page that has little else, whatever the other blocks of that page are.';

export const SELECTORS = {
  /** Reported as `likely` by deterministic code; has a capture. */
  strong: '#strong',
  /** A second `likely`, with a capture. */
  second: '#second',
  /** Held back as `info` for a reason that is a matter of judgement (it ends with a colon); has a capture. */
  weak: '#weak',
  /** `info` for a structural reason (a label): a judgement would change nothing, so it is never sent. */
  label: '#label',
  /** `likely`, and could not be captured. */
  noCrop: '#no-crop',
} as const;

export interface CandidateTexts {
  strong?: string;
  second?: string;
  weak?: string;
  noCrop?: string;
}

export function candidateSnapshot(texts: CandidateTexts = {}): Snapshot {
  let row = 0;
  const clips: Snapshot['screenshots']['clips'] = {};
  const block = (selector: string, text: string, over: Partial<TextBlock> = {}): TextBlock => {
    const box = { x: 32, y: row++ * 40, width: 400, height: 24 };
    return {
      selector,
      frame: '',
      tag: 'div',
      text,
      chars: text.replace(/\s/g, '').length,
      words: text.split(/\s+/).filter(Boolean).length,
      box,
      lines: 1,
      firstLine: box,
      lastLine: box,
      breaks: 0,
      style: BODY,
      styleShare: 1,
      contexts: [],
      inMain: true,
      inListItem: false,
      region: 'main',
      heading: null,
      crop: null,
      ...over,
    };
  };
  const captured = (selector: string, text: string, shade: number, over: Partial<TextBlock> = {}): TextBlock => {
    const id = `headings/${selector.slice(1)}.png`;
    // 200 by 120 CSS px at scale 2, with a dark bar where the text is.
    const image = createImage(400, 240, { r: 255, g: 255, b: 255 });
    fillRect(image, { x: 40, y: 100, width: 160 + shade, height: 30 }, { r: shade, g: shade, b: shade });
    clips[id] = { box: { x: 0, y: 0, width: 200, height: 120 }, scale: 2, png: encodePng(image) };
    return block(selector, text, { style: TITLE, crop: id, cropTarget: { x: 20, y: 50, width: 80 + shade / 2, height: 15 }, ...over });
  };
  const body = (name: string): TextBlock => block(`#body-${name}`, PARAGRAPH);
  const blocks = [
    body('0'),
    captured(SELECTORS.strong, texts.strong ?? 'Opening hours', 0),
    body('1'),
    captured(SELECTORS.second, texts.second ?? 'How to find us', 40),
    body('2'),
    captured(SELECTORS.weak, texts.weak ?? 'Things to know before you come:', 80),
    body('3'),
    captured(SELECTORS.label, 'Your name', 120, { contexts: ['label'] }),
    body('4'),
    block(SELECTORS.noCrop, texts.noCrop ?? 'Contact', { style: TITLE, covered: true }),
    body('5'),
  ];
  return {
    environment: { url: 'http://example.test/', devicePixelRatio: 2, viewport: { width: 1280, height: 720 }, colorScheme: 'light' },
    headings: { blocks, total: blocks.length, axComplete: true },
    nodes: [],
    axTree: [],
    screenshots: { tiles: [], clips },
  };
}

export const SCANNED_AT = new Date('2026-01-01T00:00:00Z');

/** The snapshot, the configuration and what deterministic code reports for it. */
export function candidateScan(input: ConfigInput = {}, texts: CandidateTexts = {}): { snapshot: Snapshot; config: Config; result: ScanResult } {
  const config = resolveConfig({ ...input, checks: ['headings'] });
  const snapshot = candidateSnapshot(texts);
  return { snapshot, config, result: buildResult(snapshot, config, SCANNED_AT) };
}

/** Status by selector, for the candidates only. */
export function statuses(findings: ScanResult['findings']): Record<string, string> {
  const wanted = new Set<string>(Object.values(SELECTORS));
  return Object.fromEntries(findings.filter((finding) => wanted.has(finding.selector)).map((finding) => [finding.selector, finding.status]));
}
