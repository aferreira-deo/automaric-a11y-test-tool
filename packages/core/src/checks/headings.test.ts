import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import { bodyBaseline, headingCandidates, headingReport, isNumericText, levelInversions, styleSignature } from '../measure/headings.js';
import { runChecks } from '../run.js';
import type { Finding, HeadingSurvey, HeadingsConfig, Snapshot, TextBlock, TextStyle } from '../types.js';

const config = resolveConfig({ checks: ['headings'] });
const BODY: TextStyle = { family: 'arial', size: 16, weight: 400, color: '#1a1a1a', transform: 'none', italic: false };
const TITLE: TextStyle = { ...BODY, size: 24, weight: 700 };
const BOLD: TextStyle = { ...BODY, weight: 700 };
const LINE = 24;

let row = 0;
/** A block of one line. Each call puts it one line under the previous one, at the same left edge, unless told otherwise. */
function block(text: string, over: Partial<TextBlock> = {}): TextBlock {
  const y = over.box?.y ?? row * 40;
  row = Math.round(y / 40) + 1;
  const box = { x: 32, y, width: 400, height: LINE, ...over.box };
  return {
    selector: `#b${row}`,
    frame: '',
    tag: 'div',
    text,
    chars: text.replace(/\s/g, '').length,
    words: text.split(/\s+/).filter(Boolean).length,
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
    box,
  };
}

const PARAGRAPH = 'Body text that goes on for a while so that it is the most common style of the page by far.';
const body = (over: Partial<TextBlock> = {}): TextBlock => block(PARAGRAPH, over);
const title = (text = 'A title', over: Partial<TextBlock> = {}): TextBlock => block(text, { style: TITLE, ...over });

function survey(blocks: TextBlock[], axComplete = true): HeadingSurvey {
  row = 0;
  return { blocks, total: blocks.length, axComplete };
}

function page(make: () => TextBlock[], axComplete = true): HeadingSurvey {
  row = 0;
  const blocks = make();
  return survey(blocks, axComplete);
}

function snapshotOf(headings: HeadingSurvey): Snapshot {
  return {
    environment: { url: 'http://example.test/', devicePixelRatio: 2, viewport: { width: 1280, height: 720 }, colorScheme: 'light' },
    headings,
    nodes: [],
    axTree: [],
    screenshots: { tiles: [], clips: {} },
  };
}

function findings(headings: HeadingSurvey, headingsConfig: Partial<HeadingsConfig> = {}): Finding[] {
  return runChecks(snapshotOf(headings), resolveConfig({ checks: ['headings'], headings: headingsConfig }));
}

const candidatesOf = (headings: HeadingSurvey, over: Partial<HeadingsConfig> = {}) => headingCandidates(headings, { ...config.headings, ...over });
/** The candidate for the block with this text, or undefined when it is not one. */
const candidate = (headings: HeadingSurvey, text: string, over: Partial<HeadingsConfig> = {}) =>
  candidatesOf(headings, over).find((found) => found.text === text);

describe('bodyBaseline', () => {
  it('is the most common size and weight by characters, inside main', () => {
    const blocks = page(() => [body({ inMain: false, style: { ...BODY, size: 13 } }), body({ inMain: false, style: { ...BODY, size: 13 } }), body(), title()]).blocks;
    expect(bodyBaseline(blocks)).toMatchObject({ size: 16, weight: 400, from: 'main', family: 'arial', color: '#1a1a1a' });
  });
  it('falls back to the page when main holds no text', () => {
    const blocks = page(() => [body({ inMain: false }), title('A title', { inMain: false })]).blocks;
    expect(bodyBaseline(blocks)).toMatchObject({ size: 16, from: 'page' });
  });
  it('leaves out headings, links, buttons, navigation, labels, code and text hidden from assistive technology', () => {
    const small = { ...BODY, size: 10 };
    const blocks = page(() => [
      body({ style: small, contexts: ['link'] }),
      body({ style: small, contexts: ['ariaHidden'] }),
      body({ style: small, contexts: ['button'] }),
      body({ style: small, contexts: ['navigation'] }),
      body({ style: small, heading: { level: 2, selector: 'h2' } }),
      block('Short body text.'),
    ]).blocks;
    expect(bodyBaseline(blocks)).toMatchObject({ size: 16 });
  });
  it('still answers when every block is a link', () => {
    expect(bodyBaseline(page(() => [body({ contexts: ['link'] })]).blocks)).toMatchObject({ size: 16 });
    expect(bodyBaseline([])).toBeNull();
  });
  it('does not depend on the order of equally common styles', () => {
    const a = (): TextBlock => block('abcdef', { style: { ...BODY, size: 14 } });
    const b = (): TextBlock => block('ghijkl', { style: { ...BODY, size: 18 } });
    expect(bodyBaseline(page(() => [a(), b()]).blocks)).toEqual(bodyBaseline(page(() => [b(), a()]).blocks));
  });
});

describe('isNumericText', () => {
  const numeric = (text: string): boolean => isNumericText(text, text.split(/\s+/).length, config.headings);
  it.each(['$29.99', '98%', '98 %', '2 400 €', '120', '15 ans', '15 years', '10k+ users', '3x faster', '12/03/2026', '€ 12', '24/7'])('%s is a number', (text) => {
    expect(numeric(text)).toBe(true);
  });
  it.each(['Chapter 1', '1. Scope', '2) Method', '1.2. Definitions', '10 things nobody tells you about tides', 'Sur devis', 'Web 2.0 and after', 'A title'])(
    '%s is not',
    (text) => {
      expect(numeric(text)).toBe(false);
    },
  );
});

describe('styleSignature', () => {
  it('is made of family, size, weight, colour and transform', () => {
    expect(styleSignature(TITLE)).toBe('arial|24|700|#1a1a1a|none');
    expect(styleSignature({ ...TITLE, italic: true })).toBe(styleSignature(TITLE));
    expect(styleSignature({ ...TITLE, size: 24.04 })).toBe(styleSignature(TITLE));
    expect(styleSignature({ ...TITLE, color: '#000000' })).not.toBe(styleSignature(TITLE));
  });
});

describe('heading candidates', () => {
  it('a larger, bolder line alone above body text is a strong candidate, reported as likely', () => {
    const headings = page(() => [body(), title(), body()]);
    const found = candidate(headings, 'A title')!;
    expect(found).toMatchObject({ strength: 'strong', status: 'likely', reasons: [], prominence: ['larger', 'bolder'], adjudicate: true });
    expect(found.features).toMatchObject({ sizeRatio: 1.5, aloneOnLine: true, followedByBody: true, leftAligned: true, spaceAbove: 16, spaceBelow: 16 });
    const [finding] = findings(headings).filter((entry) => entry.rule === 'headings/unmarked-heading');
    expect(finding).toMatchObject({ status: 'likely', wcag: { sc: '1.3.1', level: 'A' }, selector: found.selector });
    // The hand-off to the adjudicator: a candidate names its finding.
    expect(finding!.id).toBe(found.findingId);
    expect(finding!.ai).toBeUndefined();
    expect(finding!.evidence.values).toMatchObject({ text: 'A title', fontSizePx: 24, bodyFontSizePx: 16, followedBy: PARAGRAPH });
    expect(found.context).toMatchObject({ text: 'A title', textBefore: PARAGRAPH, textAfter: PARAGRAPH, bodyStyle: { size: 16, weight: 400 } });
  });

  it('text in the style of body text is not a candidate, nor is text under the thresholds', () => {
    const headings = page(() => [
      body(),
      block('Short line'),
      body(),
      block('Slightly larger', { style: { ...BODY, size: 20.5 } }),
      body(),
      block('Medium weight', { style: { ...BODY, weight: 500 } }),
      body(),
      block('Bold small print', { style: { ...BODY, size: 12, weight: 700 } }),
      body(),
    ]);
    expect(candidatesOf(headings)).toEqual([]);
  });

  it('bold capitals count from a smaller size than other bold text', () => {
    const headings = page(() => [body(), block('Column title', { style: { ...BODY, size: 12, weight: 700, transform: 'uppercase' } }), body()]);
    expect(candidate(headings, 'Column title')).toMatchObject({ status: 'likely', prominence: ['bolder'] });
  });

  it('long text, text of mixed styles and text without a letter or digit are not candidates', () => {
    const long = Array.from({ length: 21 }, () => 'word').join(' ');
    const headings = page(() => [
      body(),
      title(long),
      body(),
      title('Four lines', { lines: 4 }),
      body(),
      title('Mixed', { styleShare: 0.6 }),
      body(),
      title('— ★ —'),
      body(),
      block(Array.from({ length: 13 }, () => 'word').join(' '), { style: BOLD }),
      body(),
    ]);
    expect(candidatesOf(headings)).toEqual([]);
  });

  it('a block exposed as a heading is never a candidate', () => {
    const headings = page(() => [body(), title('Real', { heading: { level: 2, selector: 'h2' } }), body()]);
    expect(candidatesOf(headings)).toEqual([]);
  });

  it('a block with the exact style of a real heading is a candidate even when it is neither larger nor bolder', () => {
    const quiet: TextStyle = { ...BODY, size: 15, transform: 'uppercase', color: '#595959' };
    const headings = page(() => [body(), block('Real', { style: quiet, heading: { level: 3, selector: 'h3' } }), body(), block('Look-alike', { style: quiet }), body()]);
    const found = candidate(headings, 'Look-alike')!;
    expect(found).toMatchObject({ status: 'likely', prominence: ['matchesHeadingStyle'] });
    expect(found.features.matchesHeadingLevel).toBe(3);
  });

  it('a real heading styled as body text makes no look-alikes', () => {
    const headings = page(() => [body(), block('Real', { heading: { level: 4, selector: 'h4' } }), body(), block('Short line'), body()]);
    expect(candidatesOf(headings)).toEqual([]);
  });

  it.each(['label', 'caption', 'tableHeader', 'tableCell', 'term', 'button', 'link', 'quote', 'code', 'navigation', 'ariaHidden'] as const)(
    'text in the context %s is info at most',
    (context) => {
      const headings = page(() => [body(), title('A title', { contexts: [context] }), body()]);
      expect(candidate(headings, 'A title')).toMatchObject({ status: 'info', strength: 'weak', reasons: [context] });
      expect(findings(headings).filter((finding) => finding.status !== 'info')).toEqual([]);
    },
  );

  it('says which candidates a judgement could change', () => {
    const adjudicate = (over: Partial<TextBlock>): boolean => candidate(page(() => [body(), title('A title', over), body()]), 'A title')!.adjudicate;
    expect(adjudicate({ contexts: ['link'] })).toBe(true);
    expect(adjudicate({ contexts: ['caption'] })).toBe(true);
    for (const context of ['label', 'button', 'tableHeader', 'tableCell', 'navigation', 'code', 'ariaHidden'] as const) {
      expect(adjudicate({ contexts: [context] }), context).toBe(false);
    }
  });

  it.each([
    ['$29.99', 'numeric'],
    ['15 years', 'numeric'],
    ['“It changed how we work”', 'quotation'],
    ['« Un rapport utile »', 'quotation'],
    ['This reads as a sentence.', 'sentence'],
    ['The most precise tables on any coast.1', 'sentence'],
    ['First this, then that;', 'sentence'],
    ['You will need:', 'colon'],
  ])('%s is info (%s)', (text, reason) => {
    const headings = page(() => [body(), title(text), body()]);
    expect(candidate(headings, text)).toMatchObject({ status: 'info', reasons: [reason] });
  });

  it('questions, exclamations, numbered titles and version numbers stay likely', () => {
    for (const text of ['Does it count?', 'Welcome!', '1. Scope', 'What changed in version 2.0']) {
      expect(candidate(page(() => [body(), title(text), body()]), text), text).toMatchObject({ status: 'likely' });
    }
  });

  it('lines separated by line breaks are info', () => {
    const headings = page(() => [body(), block('12 Harbour Road Portside PS1 2AB', { style: BOLD, breaks: 2, lines: 3 }), body()]);
    expect(candidate(headings, '12 Harbour Road Portside PS1 2AB')).toMatchObject({ status: 'info', reasons: ['lineBreaks'] });
  });

  it('the text of a list item is info', () => {
    const headings = page(() => [body(), block('We never sell your data', { style: BOLD, tag: 'li', inListItem: true }), body({ inListItem: true })]);
    expect(candidate(headings, 'We never sell your data')).toMatchObject({ status: 'info', reasons: ['listItem'], adjudicate: true });
    // A title inside a list item (a card in a list) is not the item itself.
    const card = page(() => [body(), title('Card title', { inListItem: true }), body({ inListItem: true })]);
    expect(candidate(card, 'Card title')).toMatchObject({ status: 'likely' });
  });

  it('a word among prices in the style of prices is taken for one', () => {
    const price: TextStyle = { ...BODY, size: 30, weight: 700 };
    const headings = page(() => [body(), block('$10', { style: price }), body(), block('$40', { style: price }), body(), block('Free', { style: price }), body()]);
    expect(candidate(headings, 'Free')).toMatchObject({ status: 'info', reasons: ['peersNumeric'], adjudicate: false });
    // One price is not a pattern.
    const two = page(() => [body(), block('$10', { style: price }), body(), block('Free', { style: price }), body()]);
    expect(candidate(two, 'Free')).toMatchObject({ status: 'likely' });
  });

  it('a title over a figure is followed by the text after the figure', () => {
    const headings = page(() => [body(), title('Some figures'), block('120', { style: { ...BODY, size: 40, weight: 700 } }), body()]);
    expect(candidate(headings, 'Some figures')).toMatchObject({ status: 'likely' });
  });

  describe('what follows', () => {
    it('nothing after it: notFollowed', () => {
      expect(candidate(page(() => [body(), title('The end')]), 'The end')).toMatchObject({ status: 'info', reasons: ['notFollowed'] });
    });
    it('the next block is in another frame: notFollowed', () => {
      expect(candidate(page(() => [body(), title(), body({ frame: '#frame' })]), 'A title')).toMatchObject({ reasons: ['notFollowed'] });
    });
    it('the next block is beside it, not under it: notFollowed', () => {
      const headings = page(() => [body(), title('Key', { box: { x: 32, y: 40, width: 60, height: LINE } }), body({ box: { x: 300, y: 40, width: 200, height: LINE } })]);
      expect(candidate(headings, 'Key')).toMatchObject({ reasons: ['notFollowed'] });
    });
    it('a line above a larger title, or above a title of its size, is notFollowed', () => {
      const kicker = page(() => [body(), block('Case study', { style: { ...BODY, size: 21, weight: 700 } }), title('How the harbour was saved', { heading: { level: 2, selector: 'h2' } }), body()]);
      expect(candidate(kicker, 'Case study')).toMatchObject({ status: 'info', reasons: ['notFollowed'] });
      const category = page(() => [body(), block('Health', { style: { ...BOLD, color: '#0c419a' } }), block('Flu vaccination this winter', { style: { ...BOLD, size: 16 }, contexts: ['link'] }), body()]);
      expect(candidate(category, 'Health')).toMatchObject({ status: 'info', reasons: ['notFollowed'] });
    });
    it('a title above a smaller title is followed', () => {
      const headings = page(() => [body(), title('Section'), block('Subsection', { style: { ...BODY, size: 19, weight: 700 } }), body()]);
      expect(candidate(headings, 'Section')).toMatchObject({ status: 'likely' });
      expect(candidate(headings, 'Subsection')).toMatchObject({ status: 'likely' });
    });
    it('a plain link or button under it is a call to action: headsControl', () => {
      for (const context of ['link', 'button'] as const) {
        const headings = page(() => [body(), title('Ready when you are'), block('Start now', { contexts: [context] }), body()]);
        expect(candidate(headings, 'Ready when you are'), context).toMatchObject({ status: 'info', reasons: ['headsControl'], adjudicate: true });
      }
    });
    it('a link set as a title, a link of a list and a column of links are content', () => {
      const teaser = page(() => [body(), title('Related'), block('How the lighthouse was moved', { style: { ...BODY, size: 19, weight: 700 }, contexts: ['link'] }), body()]);
      expect(candidate(teaser, 'Related')).toMatchObject({ status: 'likely' });
      const list = page(() => [body(), title('Company'), block('About', { contexts: ['link'], inListItem: true }), body()]);
      expect(candidate(list, 'Company')).toMatchObject({ status: 'likely' });
      const column = page(() => [body(), title('Questions'), block('How long?', { contexts: ['button'] }), block('How much?', { contexts: ['button'] }), body()]);
      expect(candidate(column, 'Questions')).toMatchObject({ status: 'likely' });
    });
  });

  it('a block next to a neighbour of the same style is a peer: repeated', () => {
    const headings = page(() => [body(), title('Starters'), body(), title('One'), title('Two'), body()]);
    expect(candidate(headings, 'Starters')).toMatchObject({ status: 'likely' });
    // The last of the series is followed by body text; the others also head nothing and are not reported.
    expect(candidate(headings, 'Two')).toMatchObject({ status: 'info', reasons: ['repeated'] });
    expect(candidate(headings, 'One')).toBeUndefined();
  });

  it('text right after other text on its line is not reported; a column away, it is alone on its line', () => {
    const beside = (gap: number, region = 'main') =>
      page(() => [
        body({ box: { x: 32, y: 0, width: 200, height: LINE }, region }),
        title('A title', { box: { x: 232 + gap, y: 0, width: 200, height: LINE } }),
        body({ box: { x: 232 + gap, y: 40, width: 200, height: LINE } }),
      ]);
    expect(candidate(beside(8), 'A title')).toBeUndefined();
    expect(candidate(beside(40), 'A title')).toMatchObject({ status: 'likely', features: { aloneOnLine: true, spaceAbove: null } });
    // Text of another region is never on the same line.
    expect(candidate(beside(8, 'aside'), 'A title')).toMatchObject({ status: 'likely' });
  });

  it('a block that is something else by its markup and heads nothing by its position is not reported', () => {
    const headings = page(() => [body(), title('Home', { contexts: ['link', 'navigation'] })]);
    expect(candidatesOf(headings)).toEqual([]);
  });

  it('bold text of body size with less space above than below is info', () => {
    const tight = page(() => [body(), block('By Jane Doe', { style: BOLD, box: { x: 32, y: 28, width: 400, height: LINE } }), body({ box: { x: 32, y: 100, width: 400, height: LINE } })]);
    expect(candidate(tight, 'By Jane Doe')).toMatchObject({ status: 'info', reasons: ['tightAbove'] });
    const even = page(() => [body(), block('A bold title', { style: BOLD }), body()]);
    expect(candidate(even, 'A bold title')).toMatchObject({ status: 'likely', prominence: ['bolder'] });
    // The rule is for bold text of body size only.
    const large = page(() => [body(), title('A title', { box: { x: 32, y: 28, width: 400, height: LINE } }), body({ box: { x: 32, y: 100, width: 400, height: LINE } })]);
    expect(candidate(large, 'A title')).toMatchObject({ status: 'likely' });
  });

  it('two blocks with one selector give one candidate', () => {
    const headings = page(() => [body(), title('First', { selector: '#same' }), body(), title('Second', { selector: '#same' }), body()]);
    const found = candidatesOf(headings);
    expect(found.map((entry) => entry.text)).toEqual(['First']);
    const ids = findings(headings).map((finding) => finding.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('without the accessibility tree nothing is above info', () => {
    const headings = page(() => [body(), title(), body()], false);
    expect(candidate(headings, 'A title')).toMatchObject({ strength: 'strong', status: 'info', adjudicate: false });
    const all = findings(headings);
    expect(all.every((finding) => finding.status === 'info')).toBe(true);
    expect(all.find((finding) => finding.rule === 'headings/heading-candidate')!.evidence.flags).toContain('axIncomplete');
    expect(all.find((finding) => finding.rule === 'headings/survey')!.evidence.flags).toContain('axIncomplete');
  });

  it('reports strong candidates first and counts what the limit leaves out', () => {
    const headings = page(() => [body(), title('Weak', { contexts: ['link'] }), body(), title('Strong one'), body(), title('Strong two'), body()]);
    const report = headingReport(headings, { ...config.headings, maxCandidates: 2 });
    expect(report.candidates.map((entry) => entry.text)).toEqual(['Strong one', 'Strong two']);
    expect(report.omitted).toBe(1);
    const surveyFinding = findings(headings, { maxCandidates: 2 }).find((finding) => finding.rule === 'headings/survey')!;
    expect(surveyFinding.evidence.flags).toContain('truncated');
    expect(surveyFinding.message).toContain('1 further candidate(s) are not listed');
  });

  it('carries the capture of the block and says when there is none', () => {
    const headings = page(() => [body(), title('Shown', { crop: 'headings/a.png' }), body(), title('Under a banner', { covered: true }), body()]);
    const all = findings(headings);
    expect(all.find((finding) => finding.evidence.values?.['text'] === 'Shown')!.evidence.crops).toEqual(['headings/a.png']);
    const hidden = all.find((finding) => finding.evidence.values?.['text'] === 'Under a banner')!;
    expect(hidden.evidence.crops).toEqual([]);
    expect(hidden.evidence.flags).toContain('covered');
  });

  it('is pure: the same survey gives the same findings', () => {
    const make = (): HeadingSurvey => page(() => [body(), title(), body(), title('Other', { contexts: ['link'] }), body()]);
    expect(findings(make())).toEqual(findings(make()));
  });

  it('needs the survey', () => {
    const snapshot = snapshotOf(page(() => []));
    delete snapshot.headings;
    expect(() => runChecks(snapshot, config)).toThrow(/heading survey/);
  });

  it('reports a page without text', () => {
    const [only] = findings(page(() => []));
    expect(only).toMatchObject({ rule: 'headings/survey', status: 'info', wcag: null });
    expect(only!.message).toContain('No visible text');
  });
});

describe('level inversions', () => {
  const heading = (level: number, size: number, text: string, over: Partial<TextBlock> = {}): TextBlock =>
    block(text, { style: { ...BODY, size, weight: 700 }, heading: { level, selector: `#${text}` }, ...over });
  const inversionsOf = (make: () => TextBlock[], over: Partial<HeadingsConfig> = {}) => levelInversions(page(make).blocks, { ...config.headings, ...over });

  it('levels that follow the sizes, skipped levels, repeated h1 and equal sizes are no contradiction', () => {
    expect(
      inversionsOf(() => [heading(1, 32, 'a'), body(), heading(2, 24, 'b'), heading(4, 16, 'c'), heading(2, 24, 'd'), heading(1, 32, 'e'), heading(3, 24, 'f'), heading(2, 24, 'g')]),
    ).toEqual([]);
  });

  it('a heading larger than the heading it is coded under is reported, advisory by default', () => {
    const [found, ...rest] = inversionsOf(() => [heading(2, 24, 'section'), body(), heading(3, 30, 'sub')]);
    expect(rest).toEqual([]);
    expect(found).toMatchObject({ selector: '#sub', kind: 'below-larger', levelGap: 1, sizeRatio: 1.25, extreme: false, status: 'advisory', other: { selector: '#section', level: 2 } });
  });

  it('a heading coded above a preceding larger heading is reported', () => {
    const found = inversionsOf(() => [heading(1, 40, 'top'), heading(3, 30, 'big'), body(), heading(2, 16, 'small')]);
    expect(found.map((entry) => [entry.selector, entry.kind, entry.other.selector])).toEqual([['#small', 'above-smaller', '#big']]);
  });

  it('a heading of its own level or above in between ends the comparison', () => {
    expect(inversionsOf(() => [heading(3, 30, 'big'), heading(2, 17, 'between'), heading(2, 16, 'small')]).map((entry) => entry.selector)).toEqual(['#between']);
  });

  it('extreme: both limits are needed, and the status follows the configuration', () => {
    const make = (): TextBlock[] => [heading(2, 16, 'section'), body(), heading(4, 36, 'detail')];
    expect(inversionsOf(make)[0]).toMatchObject({ extreme: true, status: 'likely', levelGap: 2, sizeRatio: 2.25 });
    expect(inversionsOf(make, { extremeInversionStatus: 'advisory' })[0]).toMatchObject({ extreme: true, status: 'advisory' });
    expect(inversionsOf(make, { extremeInversionMinLevelGap: 3 })[0]).toMatchObject({ extreme: false, status: 'advisory' });
    expect(inversionsOf(make, { inversionStatus: 'likely', extremeInversionMinSizeRatio: 3 })[0]).toMatchObject({ extreme: false, status: 'likely' });
  });

  it('headings of different regions and of different frames are not compared', () => {
    expect(inversionsOf(() => [heading(3, 30, 'main'), heading(2, 14, 'aside', { region: 'aside' })])).toEqual([]);
    expect(inversionsOf(() => [heading(3, 30, 'top'), heading(2, 14, 'framed', { frame: '#frame' })])).toEqual([]);
  });

  it('a heading of several blocks counts once, with the size of most of its text', () => {
    const found = inversionsOf(() => [
      heading(2, 24, 'section'),
      block('Small part', { style: { ...BODY, size: 12 }, heading: { level: 3, selector: '#sub' } }),
      block('The larger part of the heading', { style: { ...BODY, size: 30 }, heading: { level: 3, selector: '#sub' } }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ selector: '#sub', size: 30 });
  });

  it('is reported under 1.3.1 and never as a failure', () => {
    const all = findings(page(() => [heading(2, 16, 'section'), body(), heading(4, 36, 'detail'), body(), heading(3, 30, 'big'), body()]));
    const inversions = all.filter((finding) => finding.rule === 'headings/level-inversion');
    expect(inversions.map((finding) => [finding.selector, finding.status]).sort()).toEqual([
      ['#big', 'advisory'],
      ['#detail', 'likely'],
    ]);
    expect(inversions.find((finding) => finding.selector === '#detail')!.evidence.flags).toContain('extreme');
    expect(all.some((finding) => finding.status === 'fail')).toBe(false);
  });
});
