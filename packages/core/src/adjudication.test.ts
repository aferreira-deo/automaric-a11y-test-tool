import { describe, expect, it } from 'vitest';
import { candidateScan, SELECTORS, statuses } from '../../../e2e/support/candidates.js';
import { applyVerdicts, combineVotes, judgements, stableStringify } from './adjudication.js';
import type { Vote } from './adjudication.js';
import { applyHeadingVerdict, HEADING_QUESTION, headingStatusAfter } from './checks/headings-adjudication.js';
import { resolveAdjudication, resolveConfig } from './config.js';
import { outlineCapture, perceptualHash, perceptualHashOfPng } from './measure/capture.js';
import { createImage, decodePng, encodePng, fillRect } from './measure/image.js';
import type { AiEvidence, Finding, Status } from './types.js';

const vote = (verdict: Vote['verdict'], over: Partial<Vote> = {}): Vote => ({ verdict, confidence: 'high', rationale: `because ${verdict}`, ...over });
const ai = (over: Partial<AiEvidence> = {}): AiEvidence => ({
  provider: 'test',
  model: 'm',
  promptVersion: 'p/q',
  votes: ['yes', 'yes'],
  verdict: 'yes',
  confidence: 'high',
  rationale: 'r',
  statusBefore: 'info',
  inputs: 'text+image',
  fromCache: false,
  ...over,
});

describe('the fixture of candidates', () => {
  it('has a likely, a second likely, an info a judgement can change, an info it cannot, and a likely without a capture', () => {
    const { result } = candidateScan();
    expect(statuses(result.findings)).toEqual({
      [SELECTORS.strong]: 'likely',
      [SELECTORS.second]: 'likely',
      [SELECTORS.weak]: 'info',
      [SELECTORS.label]: 'info',
      [SELECTORS.noCrop]: 'likely',
    });
  });
});

describe('combineVotes', () => {
  it('gives yes or no only when every vote says so with high confidence', () => {
    expect(combineVotes([vote('yes'), vote('yes')])).toEqual({ votes: ['yes', 'yes'], verdict: 'yes', confidence: 'high', rationale: 'because yes' });
    expect(combineVotes([vote('no'), vote('no')])).toMatchObject({ verdict: 'no', confidence: 'high' });
    expect(combineVotes([vote('no')])).toMatchObject({ votes: ['no'], verdict: 'no' });
  });
  it('gives unsure for votes that disagree', () => {
    expect(combineVotes([vote('yes'), vote('no')])).toMatchObject({ votes: ['yes', 'no'], verdict: 'unsure', confidence: 'low' });
  });
  it('gives unsure for a vote of low confidence, an unsure vote, a failed vote and no vote', () => {
    expect(combineVotes([vote('yes'), vote('yes', { confidence: 'low' })])).toMatchObject({ verdict: 'unsure', confidence: 'low' });
    expect(combineVotes([vote('unsure')])).toMatchObject({ verdict: 'unsure', confidence: 'low' });
    expect(combineVotes([vote('yes'), vote('unsure', { problem: 'timeout', rationale: '' })])).toEqual({
      votes: ['yes', 'unsure'],
      verdict: 'unsure',
      confidence: 'low',
      rationale: 'because yes',
      problems: ['timeout'],
    });
    expect(combineVotes([])).toEqual({ votes: [], verdict: 'unsure', confidence: 'low', rationale: '' });
  });
  it('never reads a verdict out of a failed vote', () => {
    expect(combineVotes([vote('yes', { problem: 'http' })])).toMatchObject({ votes: ['unsure'], verdict: 'unsure', problems: ['http'] });
  });
  it('lists problems once, sorted', () => {
    expect(combineVotes([vote('unsure', { problem: 'timeout' }), vote('unsure', { problem: 'http' }), vote('unsure', { problem: 'timeout' })]).problems).toEqual(['http', 'timeout']);
  });
});

describe('headingStatusAfter', () => {
  const config = resolveConfig();
  it.each<[Status, AiEvidence['verdict'], Status]>([
    ['likely', 'yes', 'likely'],
    // The default follows the brief to the letter: a no is recorded, and the finding stays on the list.
    ['likely', 'no', 'likely'],
    ['likely', 'unsure', 'likely'],
    ['info', 'yes', 'likely'],
    ['info', 'no', 'info'],
    ['info', 'unsure', 'info'],
    // Not statuses of a heading candidate; whatever comes in, what goes out is likely or info.
    ['advisory', 'yes', 'likely'],
    ['advisory', 'no', 'info'],
    ['fail', 'unsure', 'info'],
  ])('%s with the verdict %s gives %s', (before, verdict, after) => {
    expect(headingStatusAfter(before, verdict, config)).toBe(after);
  });
  it('lowers a likely on a no only when configured to', () => {
    expect(resolveAdjudication().headingDisagreeStatus).toBe('likely');
    const lower = resolveConfig({ adjudication: { headingDisagreeStatus: 'info' } });
    expect(headingStatusAfter('likely', 'no', lower)).toBe('info');
    expect(headingStatusAfter('info', 'no', lower)).toBe('info');
    expect(headingStatusAfter('likely', 'yes', lower)).toBe('likely');
    expect(headingStatusAfter('info', 'yes', lower)).toBe('likely');
  });
  it('reads the former names of the three options, and prefers the new ones', () => {
    const old = resolveAdjudication({ headingNoStatus: 'info', listNoStatus: 'info', groupNoStatus: 'info' });
    expect(old).toMatchObject({ headingDisagreeStatus: 'info', listDisagreeStatus: 'info', groupDisagreeStatus: 'info' });
    expect(Object.keys(old).filter((key) => key.endsWith('NoStatus'))).toEqual([]);
    expect(headingStatusAfter('likely', 'no', resolveConfig({ adjudication: { headingNoStatus: 'info' } }))).toBe('info');
    const both = resolveAdjudication({ headingNoStatus: 'info', headingDisagreeStatus: 'likely', listNoStatus: 'likely', listDisagreeStatus: 'info' });
    expect(both).toMatchObject({ headingDisagreeStatus: 'likely', listDisagreeStatus: 'info', groupDisagreeStatus: 'likely' });
    expect(resolveAdjudication({ headingNoStatus: 'fail' as never }).headingDisagreeStatus).toBe('likely');
  });
  it('cannot be configured to give a fail', () => {
    expect(resolveAdjudication({ headingDisagreeStatus: 'fail' as never }).headingDisagreeStatus).toBe('likely');
    for (const before of ['likely', 'info'] as const) {
      for (const verdict of ['yes', 'no', 'unsure'] as const) {
        expect(['likely', 'info']).toContain(headingStatusAfter(before, verdict, resolveConfig({ adjudication: { headingDisagreeStatus: 'fail' as never } })));
      }
    }
  });
});

describe('judgements', () => {
  it('asks about the candidates a judgement can change, in the order of the candidates', () => {
    const { snapshot, config, result } = candidateScan();
    const all = judgements(snapshot, result.findings, config);
    const selectorOf = (id: string): string => result.findings.find((finding) => finding.id === id)!.selector;
    // Likely ones first, then the rest, as the candidates are ordered; the label is not asked about.
    expect(all.map((judgement) => selectorOf(judgement.request.findingId))).toEqual([SELECTORS.strong, SELECTORS.second, SELECTORS.noCrop, SELECTORS.weak]);
    for (const { request } of all) {
      expect(request.question).toBe(HEADING_QUESTION);
      expect(request.check).toBe('headings');
    }
  });
  it('sends an outlined copy of the capture and leaves the evidence as it was', () => {
    const { snapshot, config, result } = candidateScan();
    const original = snapshot.screenshots.clips['headings/strong.png']!.png;
    const before = original.slice();
    const [first] = judgements(snapshot, result.findings, config);
    expect(first!.request.crop).not.toBeNull();
    expect(first!.request.cropHash).toMatch(/^[0-9a-f]{16}$/);
    const sent = decodePng(first!.request.crop!);
    // Magenta just outside the target (20,50 80x15 CSS px at scale 2, gap 3, width 2): at x = 2 * (20 - 3) - 2.
    const at = (x: number, y: number): number[] => [...sent.data.slice((y * sent.width + x) * 3, (y * sent.width + x) * 3 + 3)];
    expect(at(31, 110)).toEqual([255, 0, 255]);
    // The text itself is not painted over.
    expect(at(60, 110)).toEqual([0, 0, 0]);
    expect(original).toEqual(before);
  });
  it('asks from text alone when there is no capture, or none may be sent', () => {
    const { snapshot, config, result } = candidateScan();
    const byId = new Map(result.findings.map((finding) => [finding.id, finding.selector]));
    const noCrop = judgements(snapshot, result.findings, config).find((judgement) => byId.get(judgement.request.findingId) === SELECTORS.noCrop)!;
    expect(noCrop.request.crop).toBeNull();
    expect(noCrop.request.cropHash).toBe('');
    const textOnly = candidateScan({ adjudication: { sendImages: false } });
    expect(judgements(textOnly.snapshot, textOnly.result.findings, textOnly.config).every((judgement) => judgement.request.crop === null)).toBe(true);
    const tooBig = candidateScan({ adjudication: { maxImageBytes: 10 } });
    expect(judgements(tooBig.snapshot, tooBig.result.findings, tooBig.config).every((judgement) => judgement.request.crop === null)).toBe(true);
  });
  it('leaves candidates without a capture alone when told to', () => {
    const { snapshot, config, result } = candidateScan({ adjudication: { judgeWithoutImage: false } });
    expect(judgements(snapshot, result.findings, config)).toHaveLength(3);
  });
  it('asks nothing when the check did not run or reported nothing', () => {
    const { snapshot, config } = candidateScan();
    expect(judgements(snapshot, [], config)).toEqual([]);
    expect(judgements({ ...snapshot, headings: undefined } as never, [], config)).toEqual([]);
  });
});

describe('applyVerdicts', () => {
  const setup = () => {
    const scan = candidateScan();
    const all = judgements(scan.snapshot, scan.result.findings, scan.config);
    const find = (selector: string): Finding => scan.result.findings.find((finding) => finding.selector === selector)!;
    return { ...scan, all, find };
  };

  it('by default records a no without taking the finding off the list', () => {
    const { result, config, all, find } = setup();
    const target = find(SELECTORS.strong);
    const after = applyVerdicts(result.findings, all, new Map([[target.id, ai({ verdict: 'no', votes: ['no', 'no'], fromCache: true })]]), config);
    const kept = after.find((finding) => finding.id === target.id)!;
    expect(kept.status).toBe('likely');
    expect(kept.rule).toBe('headings/unmarked-heading');
    expect(kept.ai).toMatchObject({ verdict: 'no', statusBefore: 'likely', fromCache: true });
    expect(kept.message.startsWith(target.message)).toBe(true);
    expect(kept.message).toContain('does not function as a heading');
    expect(kept.message).toContain('It stays likely');
    expect(kept.message).toContain('from the cache');
  });

  it('moves candidates between likely and info when lowering is configured, and keeps what deterministic code found', () => {
    const { result, all, find } = setup();
    const config = resolveConfig({ checks: ['headings'], adjudication: { headingDisagreeStatus: 'info' } });
    const verdicts = new Map([
      [find(SELECTORS.strong).id, ai({ verdict: 'no', votes: ['no', 'no'] })],
      [find(SELECTORS.weak).id, ai({ verdict: 'yes' })],
      [find(SELECTORS.second).id, ai({ verdict: 'unsure', votes: ['yes', 'no'], confidence: 'low' })],
    ]);
    const after = applyVerdicts(result.findings, all, verdicts, config);
    expect(statuses(after)).toEqual({
      [SELECTORS.strong]: 'info',
      [SELECTORS.second]: 'likely',
      [SELECTORS.weak]: 'likely',
      [SELECTORS.label]: 'info',
      [SELECTORS.noCrop]: 'likely',
    });
    for (const before of result.findings) {
      const now = after.find((finding) => finding.id === before.id)!;
      // Ids, selectors and evidence never change with a verdict.
      expect(now).toBeDefined();
      expect(now.evidence).toEqual(before.evidence);
      expect(now.selector).toBe(before.selector);
      expect(now.message.startsWith(before.message)).toBe(true);
    }
    const lowered = after.find((finding) => finding.selector === SELECTORS.strong)!;
    expect(lowered.rule).toBe('headings/heading-candidate');
    expect(lowered.ai).toMatchObject({ verdict: 'no', statusBefore: 'likely', provider: 'test', model: 'm', promptVersion: 'p/q' });
    expect(lowered.message).toContain('Lowered from likely to info');
    const raised = after.find((finding) => finding.selector === SELECTORS.weak)!;
    expect(raised.rule).toBe('headings/unmarked-heading');
    expect(raised.ai).toMatchObject({ verdict: 'yes', statusBefore: 'info' });
    expect(raised.message).toContain('Raised from info to likely');
    const undecided = after.find((finding) => finding.selector === SELECTORS.second)!;
    expect(undecided.ai).toMatchObject({ verdict: 'unsure', statusBefore: 'likely' });
    expect(undecided.message).toContain('its votes disagree');
    // Untouched findings are the very same objects, and carry no `ai`.
    expect(after.find((finding) => finding.selector === SELECTORS.label)).toBe(find(SELECTORS.label));
    expect(after.find((finding) => finding.selector === SELECTORS.noCrop)!.ai).toBeUndefined();
    expect(after.some((finding) => finding.status === 'fail')).toBe(false);
  });

  it('keeps the order of findings that runChecks gives', () => {
    const { result, config, all, find } = setup();
    const after = applyVerdicts(result.findings, all, new Map([[find(SELECTORS.weak).id, ai()]]), config);
    expect(after.map((finding) => finding.selector)).toEqual(result.findings.map((finding) => finding.selector));
  });

  it('ignores a verdict for a finding nothing was asked about', () => {
    const { result, config, all, find } = setup();
    const after = applyVerdicts(result.findings, all, new Map([[find(SELECTORS.label).id, ai()], ['no-such-id', ai()]]), config);
    expect(after).toEqual(result.findings);
  });

  it('never lets an apply function make a fail, or change the id or the evidence', () => {
    const { result, config, all, find } = setup();
    const rogue = all.map((judgement) => ({
      ...judgement,
      apply: (finding: Finding, evidence: AiEvidence): Finding => ({
        ...finding,
        id: 'changed',
        selector: '#elsewhere',
        status: 'fail',
        evidence: { ...finding.evidence, ratios: { invented: 1 } },
        ai: evidence,
      }),
    }));
    const target = find(SELECTORS.strong);
    const after = applyVerdicts(result.findings, rogue, new Map([[target.id, ai()]]), config);
    const now = after.find((finding) => finding.id === target.id)!;
    expect(now.status).toBe('likely');
    expect(now.selector).toBe(SELECTORS.strong);
    expect(now.evidence).toEqual(target.evidence);
    expect(after.some((finding) => finding.status === 'fail')).toBe(false);
  });

  it('says in the message when the model saw no picture, and why a call failed', () => {
    const finding = setup().find(SELECTORS.noCrop);
    const config = resolveConfig();
    expect(applyHeadingVerdict(finding, ai({ inputs: 'text', statusBefore: 'likely' }), config).message).toContain('from the text alone');
    const failed = applyHeadingVerdict(finding, ai({ verdict: 'unsure', votes: ['unsure'], problems: ['timeout'], statusBefore: 'likely' }), config);
    expect(failed.status).toBe('likely');
    expect(failed.message).toContain('the model did not answer in time');
    const stopped = applyHeadingVerdict(finding, ai({ verdict: 'unsure', votes: ['unsure'], problems: ['stopped'], statusBefore: 'likely' }), config);
    expect(stopped.status).toBe('likely');
    expect(stopped.message).toContain('adjudication was stopped before this candidate');
  });
});

describe('resolveAdjudication', () => {
  it('keeps every duration within what a timer can hold', () => {
    const MAX = 2 ** 31 - 1;
    expect(resolveAdjudication({ timeoutMs: 2 ** 31 }).timeoutMs).toBe(MAX);
    expect(resolveAdjudication({ timeoutMs: 1e15 }).timeoutMs).toBe(MAX);
    expect(resolveAdjudication({ timeoutMs: MAX }).timeoutMs).toBe(MAX);
    expect(resolveAdjudication({ timeoutMs: Infinity }).timeoutMs).toBe(resolveAdjudication().timeoutMs);
    expect(resolveAdjudication({ retryBaseDelayMs: 1e15, retryMaxDelayMs: 1e15, pageBudgetMs: 1e15 })).toMatchObject({ retryBaseDelayMs: MAX, retryMaxDelayMs: MAX, pageBudgetMs: MAX });
  });

  it('has a limit on consecutive failures and a time budget per page by default, and both can be switched off', () => {
    const defaults = resolveAdjudication();
    expect(defaults.maxConsecutiveFailures).toBeGreaterThan(0);
    expect(defaults.pageBudgetMs).toBeGreaterThan(defaults.timeoutMs);
    expect(resolveAdjudication({ maxConsecutiveFailures: 0, pageBudgetMs: 0 })).toMatchObject({ maxConsecutiveFailures: 0, pageBudgetMs: 0 });
    expect(resolveAdjudication({ maxConsecutiveFailures: -2, pageBudgetMs: 'soon' as never })).toMatchObject({ maxConsecutiveFailures: 0, pageBudgetMs: defaults.pageBudgetMs });
  });
});

describe('stableStringify', () => {
  it('does not depend on the order of keys', () => {
    expect(stableStringify({ b: 1, a: [{ d: null, c: 'x' }] })).toBe('{"a":[{"c":"x","d":null}],"b":1}');
    expect(stableStringify({ a: [{ c: 'x', d: null }], b: 1 })).toBe(stableStringify({ b: 1, a: [{ d: null, c: 'x' }] }));
  });
});

describe('perceptualHash', () => {
  const picture = (shift = 0, noise = 0): ReturnType<typeof createImage> => {
    const image = createImage(180, 96, { r: 250, g: 250, b: 250 });
    fillRect(image, { x: 20 + shift, y: 30, width: 90, height: 14 }, { r: 20, g: 20, b: 20 });
    fillRect(image, { x: 20 + shift, y: 60, width: 140, height: 6 }, { r: 90, g: 90, b: 90 });
    if (noise) for (let i = 0; i < image.data.length; i += 97) image.data[i] = Math.max(0, image.data[i]! - noise);
    return image;
  };
  it('is 16 hex digits and the same for the same image, also through PNG', () => {
    const hash = perceptualHash(picture());
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(perceptualHashOfPng(encodePng(picture()))).toBe(hash);
  });
  it('survives faint noise, and changes with the content', () => {
    expect(perceptualHash(picture(0, 1))).toBe(perceptualHash(picture()));
    expect(perceptualHash(picture(60))).not.toBe(perceptualHash(picture()));
  });
  it('copes with an image smaller than its grid', () => {
    expect(perceptualHash(createImage(2, 2, { r: 0, g: 0, b: 0 }))).toBe('0000000000000000');
    expect(perceptualHash({ width: 0, height: 0, data: new Uint8Array(0) })).toBe('0000000000000000');
  });
});

describe('outlineCapture', () => {
  it('clips the rectangle to the capture and falls back to magenta for a colour it cannot read', () => {
    const png = encodePng(createImage(40, 40, { r: 255, g: 255, b: 255 }));
    const out = decodePng(outlineCapture({ box: { x: 0, y: 0, width: 20, height: 20 }, scale: 2, png }, { x: 0, y: 0, width: 20, height: 20 }, { color: 'red', widthCssPx: 2, gapCssPx: 3 }));
    // Everything of the rectangle lies outside: nothing is drawn, nothing throws.
    expect([...out.data].every((value) => value === 255)).toBe(true);
    const inside = decodePng(outlineCapture({ box: { x: 0, y: 0, width: 20, height: 20 }, scale: 2, png }, { x: 8, y: 8, width: 4, height: 4 }, { color: 'red', widthCssPx: 1, gapCssPx: 1 }));
    expect([...inside.data.slice((12 * 40 + 12) * 3, (12 * 40 + 12) * 3 + 3)]).toEqual([255, 0, 255]);
  });
});
