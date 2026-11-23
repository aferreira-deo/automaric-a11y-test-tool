import { describe, expect, it } from 'vitest';
import { applyVerdicts, judgements } from '../adjudication.js';
import { resolveConfig } from '../config.js';
import type { ConfigInput } from '../config.js';
import { createImage, decodePng, encodePng, fillRect } from '../measure/image.js';
import { runChecks } from '../run.js';
import type { AiEvidence, Box, Finding, ListBlock, ListSurvey, Snapshot, Status, TextStyle } from '../types.js';
import { applyListVerdict, LIST_QUESTION, listStatusAfter } from './lists-adjudication.js';

const BODY: TextStyle = { family: 'arial', size: 16, weight: 400, color: '#1a1a1a', transform: 'none', italic: false };

/**
 * A page with one series of each kind the layer has to tell apart: bullets (`likely`, captured),
 * two hyphens (`info`, a matter of judgement), bullets in navigation (`advisory`, a policy), a
 * list with a removed role (`likely`, a fact) and a real list without markers (`info`, inventory).
 */
function snapshotOf(): Snapshot {
  const blocks: ListBlock[] = [];
  const containers: Record<string, string> = {};
  let position = 0;
  const series = (id: string, texts: string[], contexts: ListBlock['contexts'] = []): void => {
    const parent = position++;
    containers[String(parent)] = `#${id}`;
    const first = position;
    for (const text of texts) {
      const box: Box = { x: 32, y: blocks.length * 24, width: 300, height: 20 };
      blocks.push({
        selector: `#${id} > div:nth-of-type(${position - first + 1})`,
        frame: '',
        tag: 'div',
        text,
        chars: text.replace(/\s/g, '').length,
        words: text.split(/\s+/).length,
        box,
        lines: 1,
        firstLine: box,
        style: BODY,
        contexts,
        inList: false,
        heading: false,
        rtl: false,
        chain: [position, position, parent, first + texts.length - 1],
        segments: [{ start: text, box }],
      });
      position++;
    }
  };
  series('strong', ['• flour', '• yeast', '• salt']);
  series('weak', ['- bread', '- butter']);
  series('nav', ['• Delivery', '• Returns'], ['navigation']);
  const image = createImage(400, 200, { r: 255, g: 255, b: 255 });
  fillRect(image, { x: 40, y: 40, width: 200, height: 120 }, { r: 30, g: 30, b: 30 });
  const lists: ListSurvey = {
    blocks,
    totalBlocks: blocks.length,
    groups: [],
    totalGroups: 0,
    parents: 0,
    totalParents: 0,
    lists: [
      { kind: 'presentational', selector: '#presentational', frame: '', tag: 'ul', box: { x: 32, y: 400, width: 300, height: 60 }, ord: 500, items: 2, markers: 2, markersInside: false, target: 0 },
      { kind: 'unstyled', selector: '#unstyled', frame: '', tag: 'ul', box: { x: 32, y: 500, width: 300, height: 60 }, ord: 600, items: 2, markers: 0, markersInside: false, target: 1 },
    ],
    totalLists: 2,
    exposedLists: 1,
    axComplete: true,
    containers,
    captures: { 'glyph:0:0': { crop: 'lists/strong.png', cropTarget: { x: 20, y: 20, width: 100, height: 60 } } },
  };
  return {
    environment: { url: 'http://example.test/', devicePixelRatio: 2, viewport: { width: 1280, height: 720 }, colorScheme: 'light' },
    lists,
    nodes: [],
    axTree: [],
    screenshots: { tiles: [], clips: { 'lists/strong.png': { box: { x: 0, y: 0, width: 200, height: 100 }, scale: 2, png: encodePng(image) } } },
  };
}

function scan(input: ConfigInput = {}) {
  const config = resolveConfig({ ...input, checks: ['lists'] });
  const snapshot = snapshotOf();
  const findings = runChecks(snapshot, config);
  return { config, snapshot, findings, asked: judgements(snapshot, findings, config) };
}

const statusOf = (findings: Finding[]): Record<string, Status> =>
  Object.fromEntries(findings.filter((finding) => finding.rule !== 'lists/survey').map((finding) => [finding.selector, finding.status]));
const ai = (verdict: AiEvidence['verdict']): AiEvidence => ({
  provider: 'test',
  model: 'm',
  promptVersion: 'p/q',
  votes: [verdict, verdict],
  verdict,
  confidence: verdict === 'unsure' ? 'low' : 'high',
  rationale: 'r',
  statusBefore: 'info',
  inputs: 'text+image',
  fromCache: false,
});

describe('what is asked about lists', () => {
  it('starts from a likely, an info, an advisory, a likely that is a fact and an inventory entry', () => {
    expect(statusOf(scan().findings)).toEqual({ '#strong': 'likely', '#weak': 'info', '#nav': 'advisory', '#presentational': 'likely', '#unstyled': 'info' });
  });
  it('asks about series of lines with bullets or numbers only, outside navigation, with the fixed question', () => {
    const { asked, findings } = scan();
    const selectors = asked.map((judgement) => findings.find((finding) => finding.id === judgement.request.findingId)?.selector);
    expect(selectors).toEqual(['#strong', '#weak']);
    for (const { request } of asked) {
      expect(request.check).toBe('lists');
      expect(request.question).toBe(LIST_QUESTION);
      expect(request.questionVersion).toBe('lists-1');
    }
    // Nothing of the page is in the question.
    expect(LIST_QUESTION).not.toContain('flour');
  });
  it('sends the capture with the series outlined, and a context without it when there is none', () => {
    const { asked, snapshot } = scan();
    const [strong, weak] = asked;
    expect(strong!.request.crop).not.toBeNull();
    expect(strong!.request.cropHash).not.toBe('');
    const sent = decodePng(strong!.request.crop!);
    const kept = decodePng(snapshot.screenshots.clips['lists/strong.png']!.png);
    expect(sent.data).not.toEqual(kept.data);
    expect(weak!.request.crop).toBeNull();
    expect(weak!.request.context).toMatchObject({ marker: 'bullet', items: 2, itemStarts: ['- bread', '- butter'], reasons: ['fewWeakItems'] });
  });
  it('asks nothing without a capture when told to, and sends no capture when told to', () => {
    expect(scan({ adjudication: { judgeWithoutImage: false } }).asked).toHaveLength(1);
    expect(scan({ adjudication: { sendImages: false } }).asked.map((judgement) => judgement.request.crop)).toEqual([null, null]);
  });
});

describe('what a verdict changes for lists', () => {
  it('moves a status between info and likely and nowhere else', () => {
    const config = resolveConfig();
    const lowering = resolveConfig({ adjudication: { listDisagreeStatus: 'info' } });
    expect(listStatusAfter('info', 'yes', config)).toBe('likely');
    expect(listStatusAfter('likely', 'yes', config)).toBe('likely');
    expect(listStatusAfter('likely', 'no', config)).toBe('likely');
    expect(listStatusAfter('info', 'no', config)).toBe('info');
    expect(listStatusAfter('likely', 'no', lowering)).toBe('info');
    expect(listStatusAfter('likely', 'unsure', lowering)).toBe('likely');
    expect(listStatusAfter('info', 'unsure', config)).toBe('info');
    for (const before of ['fail', 'likely', 'advisory', 'info'] as const) {
      for (const verdict of ['yes', 'no', 'unsure'] as const) expect(['likely', 'info']).toContain(listStatusAfter(before, verdict, lowering));
    }
  });
  it('leaves a finding that is not likely or info alone', () => {
    const { findings, config } = scan();
    const advisory = findings.find((finding) => finding.selector === '#nav')!;
    expect(applyListVerdict(advisory, ai('yes'), config)).toBe(advisory);
  });
  const judged = (verdict: AiEvidence['verdict'], input: ConfigInput = {}) => {
    const { snapshot, findings, asked, config } = scan(input);
    const verdicts = new Map(asked.map((judgement) => [judgement.request.findingId, ai(verdict)]));
    return { before: findings, after: applyVerdicts(findings, asked, verdicts, config), snapshot };
  };
  it('raises a held-back series on yes and keeps everything else', () => {
    const { before, after } = judged('yes');
    expect(statusOf(after)).toEqual({ ...statusOf(before), '#weak': 'likely' });
    const weak = after.find((finding) => finding.selector === '#weak')!;
    expect(weak.rule).toBe('lists/glyph-list');
    expect(weak.ai).toMatchObject({ verdict: 'yes', statusBefore: 'info' });
    expect(weak.message).toContain('Raised from info to likely');
  });
  it('keeps a likely on no by default, with the verdict recorded, and lowers it when configured', () => {
    const kept = judged('no');
    expect(statusOf(kept.after)).toEqual(statusOf(kept.before));
    expect(kept.after.find((finding) => finding.selector === '#strong')!.message).toContain('It stays likely');
    const lowered = judged('no', { adjudication: { listDisagreeStatus: 'info' } });
    expect(statusOf(lowered.after)).toEqual({ ...statusOf(lowered.before), '#strong': 'info' });
    expect(lowered.after.find((finding) => finding.selector === '#strong')).toMatchObject({ rule: 'lists/glyph-list-candidate', ai: { statusBefore: 'likely' } });
  });
  it('changes nothing on unsure', () => {
    const { before, after } = judged('unsure');
    expect(statusOf(after)).toEqual(statusOf(before));
  });
  it('keeps ids, selectors and evidence, and never makes a fail', () => {
    for (const verdict of ['yes', 'no', 'unsure'] as const) {
      const { before, after } = judged(verdict, { adjudication: { listDisagreeStatus: 'info' } });
      expect(after.map((finding) => finding.id).sort()).toEqual(before.map((finding) => finding.id).sort());
      for (const finding of after) {
        const was = before.find((entry) => entry.id === finding.id)!;
        expect(finding.selector).toBe(was.selector);
        expect(finding.evidence).toEqual(was.evidence);
        expect(finding.status).not.toBe('fail');
      }
    }
  });
});
