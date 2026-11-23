import { describe, expect, it } from 'vitest';
import { applyVerdicts, judgements } from '../adjudication.js';
import { resolveAdjudication, resolveConfig } from '../config.js';
import type { ConfigInput } from '../config.js';
import { createImage, decodePng, encodePng, fillRect } from '../measure/image.js';
import { runChecks } from '../run.js';
import type { AiEvidence, Finding, GroupingBlock, GroupingControl, GroupingSurvey, Snapshot, Status, TextStyle } from '../types.js';
import { applyGroupVerdict, GROUP_QUESTION, groupStatusAfter } from './grouping-adjudication.js';

const BODY: TextStyle = { family: 'arial', size: 16, weight: 400, color: '#1a1a1a', transform: 'none', italic: false };

/**
 * A page with one of each kind the layer has to tell apart: a set under a plain text (`likely`,
 * captured), one whose text is far above it (`info`, a matter of judgement), one under a heading
 * (`advisory`, a policy) and a split field whose parts have one name (`likely`, a fact).
 */
function snapshotOf(): Snapshot {
  const controls: GroupingControl[] = [];
  const blocks: GroupingBlock[] = [];
  const containers: Record<string, string> = {};
  let ord = 0;
  let y = 0;
  const text = (value: string, over: Partial<GroupingBlock> = {}): void => {
    blocks.push({
      frame: '',
      at: ord,
      end: ord,
      text: value,
      chars: value.replace(/\s/g, '').length,
      words: value.split(/\s+/).length,
      lines: 1,
      box: { x: 32, y, width: 300, height: 18 },
      style: BODY,
      contexts: [],
      heading: 0,
      labels: [],
      group: -1,
      describes: false,
      otherLabel: false,
      inControl: false,
      disclosure: false,
      free: true,
      ...over,
    });
    y += 24;
  };
  const control = (kind: GroupingControl['kind'], name: string, holder: number, over: Partial<GroupingControl> = {}): void => {
    controls.push({
      selector: `#c${controls.length}`,
      frame: '',
      ord,
      chain: [ord, ord, holder, 0],
      box: { x: 32, y, width: 16, height: 16 },
      kind,
      role: kind === 'field' ? 'textbox' : kind,
      element: 'input',
      name,
      description: '',
      setKey: '',
      form: 0,
      region: '',
      cell: -1,
      inWidget: false,
      fontSize: 16,
      rtl: false,
      ...over,
    });
    ord++;
  };
  const set = (id: string, label: string, over: Partial<GroupingBlock> = {}, gap = 0): void => {
    const holder = ord++;
    containers[String(holder)] = `#${id}`;
    const first = controls.length;
    text(label, over);
    y += gap;
    for (const name of ['Yes', 'No']) {
      control('radio', name, holder, { setKey: `n:${id}` });
      text(name, { free: false, labels: [controls.length - 1], box: { x: 56, y, width: 100, height: 18 } });
    }
    for (const own of controls.slice(first)) own.chain[3] = ord - 1;
    y += 40;
  };
  set('strong', 'Do you have a car?');
  set('weak', 'Do you smoke?', {}, 80);
  set('heading', 'Newsletter', { heading: 2 });
  const holder = ord++;
  containers[String(holder)] = '#row';
  control('field', 'Sort code', holder, { box: { x: 32, y, width: 60, height: 28 } });
  control('field', 'Sort code', holder, { box: { x: 100, y, width: 60, height: 28 } });
  for (const own of controls.slice(-2)) own.chain[3] = ord - 1;

  const image = createImage(400, 200, { r: 255, g: 255, b: 255 });
  fillRect(image, { x: 40, y: 40, width: 200, height: 120 }, { r: 30, g: 30, b: 30 });
  const grouping: GroupingSurvey = {
    controls,
    totalControls: controls.length,
    groups: [],
    blocks,
    totalBlocks: blocks.length,
    axComplete: true,
    containers,
    captures: { 'set:0': { crop: 'grouping/strong.png', cropTarget: { x: 20, y: 20, width: 100, height: 18 } } },
  };
  return {
    environment: { url: 'http://example.test/', devicePixelRatio: 2, viewport: { width: 1280, height: 720 }, colorScheme: 'light' },
    grouping,
    nodes: [],
    axTree: [],
    screenshots: { tiles: [], clips: { 'grouping/strong.png': { box: { x: 0, y: 0, width: 200, height: 100 }, scale: 2, png: encodePng(image) } } },
  };
}

function scan(input: ConfigInput = {}) {
  const config = resolveConfig({ ...input, checks: ['grouping'] });
  const snapshot = snapshotOf();
  const findings = runChecks(snapshot, config);
  return { config, snapshot, findings, asked: judgements(snapshot, findings, config) };
}

const statusOf = (findings: Finding[]): Record<string, Status> =>
  Object.fromEntries(findings.filter((finding) => finding.rule !== 'grouping/survey').map((finding) => [finding.selector, finding.status]));
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

describe('what is asked about groups', () => {
  it('starts from a likely, an info, an advisory and a likely that is a fact', () => {
    expect(statusOf(scan().findings)).toEqual({ '#strong': 'likely', '#weak': 'info', '#heading': 'advisory', '#row': 'likely' });
  });
  it('asks about sets under a plain text only, with the fixed question', () => {
    const { asked, findings } = scan();
    const selectors = asked.map((judgement) => findings.find((finding) => finding.id === judgement.request.findingId)?.selector);
    expect(selectors).toEqual(['#strong', '#weak']);
    for (const { request } of asked) {
      expect(request.check).toBe('grouping');
      expect(request.question).toBe(GROUP_QUESTION);
      expect(request.questionVersion).toBe('grouping-1');
    }
    // Nothing of the page is in the question.
    expect(GROUP_QUESTION).not.toContain('car');
  });
  it('sends the capture with the text outlined, and a context without it when there is none', () => {
    const { asked, snapshot } = scan();
    const [strong, weak] = asked;
    expect(strong!.request.crop).not.toBeNull();
    expect(strong!.request.cropHash).not.toBe('');
    const sent = decodePng(strong!.request.crop!);
    const kept = decodePng(snapshot.screenshots.clips['grouping/strong.png']!.png);
    expect(sent.data).not.toEqual(kept.data);
    expect(weak!.request.crop).toBeNull();
    expect(weak!.request.context).toMatchObject({ controls: 'radio buttons', count: 2, visibleText: 'Do you smoke?', controlNames: ['Yes', 'No'], reasons: ['labelFar'] });
  });
  it('asks nothing without a capture when told to, and sends no capture when told to', () => {
    expect(scan({ adjudication: { judgeWithoutImage: false } }).asked).toHaveLength(1);
    expect(scan({ adjudication: { sendImages: false } }).asked.map((judgement) => judgement.request.crop)).toEqual([null, null]);
  });
  it('asks nothing when the grouping check did not run', () => {
    const config = resolveConfig({ checks: ['noop'] });
    expect(judgements(snapshotOf(), runChecks(snapshotOf(), config), config)).toEqual([]);
  });
});

describe('what a verdict changes for groups', () => {
  it('moves a status between info and likely and nowhere else', () => {
    const keep = resolveConfig();
    const lowering = resolveConfig({ adjudication: { groupNoStatus: 'info' } });
    expect(groupStatusAfter('likely', 'yes', keep)).toBe('likely');
    expect(groupStatusAfter('info', 'yes', keep)).toBe('likely');
    expect(groupStatusAfter('likely', 'no', keep)).toBe('likely');
    expect(groupStatusAfter('likely', 'no', lowering)).toBe('info');
    expect(groupStatusAfter('info', 'no', keep)).toBe('info');
    expect(groupStatusAfter('likely', 'unsure', lowering)).toBe('likely');
    expect(groupStatusAfter('info', 'unsure', keep)).toBe('info');
  });
  it('takes info or likely for groupNoStatus and nothing else', () => {
    expect(resolveAdjudication().groupNoStatus).toBe('likely');
    expect(resolveAdjudication({ groupNoStatus: 'info' }).groupNoStatus).toBe('info');
    expect(resolveAdjudication({ groupNoStatus: 'fail' as never }).groupNoStatus).toBe('likely');
  });
  const judged = (verdict: AiEvidence['verdict'], input: ConfigInput = {}) => {
    const { config, findings, asked } = scan(input);
    const verdicts = new Map(asked.map((judgement) => [judgement.request.findingId, ai(verdict)]));
    return { before: findings, after: applyVerdicts(findings, asked, verdicts, config) };
  };
  it('raises a set that was held back on a yes, and keeps ids, selectors and evidence', () => {
    const { before, after } = judged('yes');
    expect(statusOf(after)).toEqual({ '#strong': 'likely', '#weak': 'likely', '#heading': 'advisory', '#row': 'likely' });
    const weak = after.find((finding) => finding.selector === '#weak')!;
    const was = before.find((finding) => finding.selector === '#weak')!;
    expect(weak).toMatchObject({ rule: 'grouping/unassociated-label', ai: { verdict: 'yes', statusBefore: 'info' } });
    expect(weak.id).toBe(was.id);
    expect(weak.evidence).toEqual(was.evidence);
    expect(weak.message.startsWith(was.message)).toBe(true);
    expect(weak.message).toContain('Raised from info to likely');
  });
  it('keeps a likely on a no by default, and lowers it only when the configuration says so', () => {
    const kept = judged('no');
    expect(statusOf(kept.after)).toEqual(statusOf(kept.before));
    expect(kept.after.find((finding) => finding.selector === '#strong')).toMatchObject({ status: 'likely', ai: { verdict: 'no', statusBefore: 'likely' } });
    const lowered = judged('no', { adjudication: { groupNoStatus: 'info' } });
    expect(lowered.after.find((finding) => finding.selector === '#strong')).toMatchObject({ status: 'info', rule: 'grouping/group-candidate', ai: { statusBefore: 'likely' } });
    // The split field and the set under a heading are not a model's to move.
    expect(statusOf(lowered.after)).toMatchObject({ '#heading': 'advisory', '#row': 'likely' });
  });
  it('changes nothing on unsure, and never gives a fail', () => {
    for (const verdict of ['yes', 'no', 'unsure'] as const) {
      const { before, after } = judged(verdict, { adjudication: { groupNoStatus: 'fail' as never } });
      if (verdict === 'unsure') expect(statusOf(after)).toEqual(statusOf(before));
      for (const finding of after) expect(finding.status).not.toBe('fail');
    }
  });
  it('leaves a finding that is neither likely nor info as it is', () => {
    const { findings, config } = scan();
    const advisory = findings.find((finding) => finding.selector === '#heading')!;
    expect(applyGroupVerdict(advisory, ai('yes'), config)).toBe(advisory);
  });
});
