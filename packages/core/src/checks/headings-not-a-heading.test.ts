import { describe, expect, it } from 'vitest';
import { applyVerdicts, judgements } from '../adjudication.js';
import { resolveConfig } from '../config.js';
import { bodyBaseline, countSentences, headingReport, nonHeadings, nonHeadingStatus, NOT_A_HEADING_RULE, wordsOf } from '../measure/headings.js';
import type { NonHeadingSignal } from '../measure/headings.js';
import { runChecks } from '../run.js';
import type { AiEvidence, Finding, HeadingSurvey, HeadingsConfig, Snapshot, TextBlock, TextStyle } from '../types.js';
import { applyNotHeadingVerdict, NOT_HEADING_QUESTION, NOT_HEADING_QUESTION_VERSION, notHeadingStatusAfter } from './headings-adjudication.js';

const config = resolveConfig({ checks: ['headings'] });
const BODY: TextStyle = { family: 'arial', size: 16, weight: 400, color: '#1a1a1a', transform: 'none', italic: false };
const H2: TextStyle = { ...BODY, size: 24, weight: 700 };

const PARAGRAPH =
  'Body text that goes on for a while so that it is the most common style of the page by far. It has a second sentence and a third one, so that one paragraph alone holds enough characters to say what body text looks like on a page that has little else, whatever the other blocks of that page are.';
const TWO_SENTENCES = 'The office is closed on public holidays. Requests sent on those days are read the next morning.';
const LONG_SENTENCE =
  'Everything you need to know before you send us the form that asks for a review of the decision that was taken about the request you made last year for a place in one of the schools of the district where you live now';
const LONG_PARAGRAPH =
  'Our team has worked with public bodies and private companies for more than twenty years. We audit websites, train the people who build them and help them fix what we find. Every audit ends with a report that says what to change and in which order.';

interface Part {
  text: string;
  heading?: number;
  id?: string;
  /** Other content met before this block, since the block before it. */
  gap?: number;
  over?: Partial<TextBlock>;
}

/** A page of one-line blocks, one under the other, with the running count of other content worked out from `gap`. */
function page(parts: Part[], end = 0, axComplete = true): HeadingSurvey {
  let count = 0;
  const blocks = parts.map((part, row): TextBlock => {
    count += part.gap ?? 0;
    const box = { x: 32, y: row * 40, width: 400, height: 24 };
    return {
      selector: `#${part.id ?? `b${row}`}`,
      frame: '',
      tag: part.heading ? `h${part.heading}` : 'p',
      text: part.text,
      chars: part.text.replace(/\s/g, '').length,
      words: part.text.split(/\s+/).filter(Boolean).length,
      box,
      lines: 1,
      firstLine: box,
      lastLine: box,
      breaks: 0,
      style: part.heading ? H2 : BODY,
      styleShare: 1,
      contexts: [],
      inMain: true,
      inListItem: false,
      region: 'main',
      heading: part.heading ? { level: part.heading, selector: `#${part.id ?? `b${row}`}` } : null,
      crop: null,
      contentBefore: count,
      ...part.over,
    };
  });
  return { blocks, total: blocks.length, axComplete, otherContent: count + end };
}

const p = (text = PARAGRAPH): Part => ({ text });
const h = (id: string, text: string, level = 2, over: Partial<TextBlock> = {}, gap = 0): Part => ({ id, text, heading: level, over, gap });

function found(survey: HeadingSurvey, over: Partial<HeadingsConfig> = {}) {
  const headings = { ...config.headings, ...over };
  return nonHeadings(survey, bodyBaseline(survey.blocks, headings), headings);
}
const one = (survey: HeadingSurvey, id: string, over: Partial<HeadingsConfig> = {}) => found(survey, over).find((entry) => entry.selector === `#${id}`);

function snapshotOf(headings: HeadingSurvey): Snapshot {
  return {
    environment: { url: 'http://example.test/', devicePixelRatio: 2, viewport: { width: 1280, height: 720 }, colorScheme: 'light' },
    headings,
    nodes: [],
    axTree: [],
    screenshots: { tiles: [], clips: {} },
  };
}
const findingsOf = (survey: HeadingSurvey, over: Partial<HeadingsConfig> = {}): Finding[] =>
  runChecks(snapshotOf(survey), resolveConfig({ checks: ['headings'], headings: over })).filter((finding) => finding.rule === NOT_A_HEADING_RULE);

describe('wordsOf', () => {
  it('counts runs that hold a letter or a digit, so French punctuation set apart by a space is no word', () => {
    expect(wordsOf('Que faire ? Rien !', config.headings)).toBe(3);
    expect(wordsOf('Notre équipe répond « sous deux jours » : promis', config.headings)).toBe(7);
    expect(wordsOf('', config.headings)).toBe(0);
    expect(wordsOf('— ? !', config.headings)).toBe(0);
  });
  it('cuts text of a script written without spaces into words', () => {
    const japanese = '私たちのチームは二十年以上にわたり公共機関や民間企業と協力してきました。';
    expect(wordsOf(japanese, config.headings)).toBeGreaterThan(8);
    // Without the pattern, a run without spaces is one word, as it always was.
    expect(wordsOf(japanese, { ...config.headings, unspacedScriptPattern: '' })).toBe(1);
  });
});

describe('countSentences', () => {
  const count = (text: string, over: Partial<HeadingsConfig> = {}): number => countSentences(text, { ...config.headings, ...over });
  it('a title is one sentence, whatever it ends with', () => {
    for (const text of ['Opening hours', 'How do I order a new bin?', 'Think different.', 'Que faire si mon employeur refuse ?', 'Wow!']) expect(count(text)).toBe(1);
  });
  it('counts the places where a sentence ends and another begins', () => {
    expect(count(TWO_SENTENCES)).toBe(2);
    expect(count(LONG_PARAGRAPH)).toBe(3);
    expect(count('Is the office open today? It closes at five. Come early tomorrow!')).toBe(3);
    // A last part that is too short for a sentence is counted with the one before it.
    expect(count('Is the office open today? It closes at five. Come early!')).toBe(2);
    // A short word with a capital before the full stop is taken for an abbreviation.
    expect(count('We are now part of the EU. Next year brings more changes.')).toBe(1);
    expect(count('The wait is over… We are open again today.')).toBe(2);
  });
  it('takes French typography: a space before the mark, guillemets around a sentence', () => {
    expect(count('Vous avez une question sur votre dossier ? Notre équipe vous répond « sous deux jours ouvrés » ! Écrivez-nous dès maintenant.')).toBe(3);
    expect(count('« Nous avons tout vérifié. » Il a dit cela hier soir.')).toBe(2);
    expect(count('Il a dit cela hier soir. « Nous avons tout vérifié. »')).toBe(2);
    // A colon ends nothing, with or without a space before it.
    expect(count('Votre dossier : ce qu’il faut savoir avant de commencer')).toBe(1);
  });
  it('a part of fewer than sentenceMinWords words is counted with its neighbour', () => {
    expect(count('Build faster. Ship smarter.')).toBe(1);
    expect(count('M. Dupont est arrivé hier soir. Il repart demain matin.')).toBe(2);
    expect(count('Interview with Dr. Smith of the U.S. Army')).toBe(1);
    expect(count('A long sentence comes first here. Yes.')).toBe(1);
    expect(count('Build faster. Ship smarter.', { sentenceMinWords: 1 })).toBe(2);
  });
  it('a full stop before a small letter or a digit ends nothing', () => {
    expect(count('We deliver in approx. 3 days to e.g. your home address')).toBe(1);
    expect(count('Version 2.5 of the guide is out')).toBe(1);
  });
  it('counts sentences of scripts without spaces or capitals', () => {
    expect(count('私たちのチームは協力してきました。ウェブサイトを監査し、訓練します。')).toBe(2);
    expect(count('هذا النص جملة أولى طويلة. وهذه جملة ثانية بعدها.')).toBe(2);
  });
  it('a pattern that does not compile finds no such place', () => {
    expect(count(TWO_SENTENCES, { sentenceBreakPattern: '(' })).toBe(1);
  });
});

describe('nonHeadingStatus', () => {
  const status = (...signals: NonHeadingSignal[]) => nonHeadingStatus(signals);
  it('is likely only when two kinds of measurement agree, or the text is running text by both measures', () => {
    expect(status('severalSentences', 'long')).toBe('likely');
    expect(status('severalSentences', 'bodyStyle')).toBe('likely');
    expect(status('long', 'headsNothing')).toBe('likely');
    expect(status('long', 'quotation')).toBe('likely');
    expect(status('headsNothing', 'headingRun', 'bodyStyle')).toBe('likely');
  });
  it('is advisory for one kind alone, or two weak signals', () => {
    expect(status('severalSentences')).toBe('advisory');
    expect(status('long')).toBe('advisory');
    expect(status('headsNothing', 'headingRun')).toBe('advisory');
    expect(status('headsNothing', 'bodyStyle')).toBe('advisory');
    expect(status('headsNothing', 'numeric')).toBe('advisory');
    expect(status('headsNothing', 'quotation')).toBe('advisory');
  });
  it('is info for the look of body text alone, and nothing for the rest', () => {
    expect(status('bodyStyle')).toBe('info');
    expect(status('quotation')).toBeNull();
    expect(status('bodyStyle', 'numeric')).toBe('info');
    expect(status('headsNothing')).toBeNull();
    expect(status('numeric')).toBeNull();
    expect(status()).toBeNull();
  });
  it('is never fail, whatever the signals', () => {
    const all: NonHeadingSignal[] = ['severalSentences', 'long', 'quotation', 'numeric', 'bodyStyle', 'headsNothing', 'headingRun'];
    for (let mask = 0; mask < 1 << all.length; mask++) {
      expect(['likely', 'advisory', 'info', null]).toContain(nonHeadingStatus(all.filter((_, bit) => mask & (1 << bit))));
    }
  });
});

describe('headings that do not read as a heading', () => {
  it('ordinary headings over content are not reported', () => {
    const survey = page([h('a', 'Waste and recycling', 1), h('b', 'Collections'), p(), h('c', 'Opening hours'), p(), h('d', 'Contact', 3), p()]);
    expect(found(survey)).toEqual([]);
    expect(headingReport(survey, config.headings).nonHeadings).toEqual([]);
  });

  it('a paragraph in a heading is likely: several sentences and long', () => {
    const entry = one(page([p(), h('para', LONG_PARAGRAPH), p()]), 'para')!;
    expect(entry).toMatchObject({ status: 'likely', level: 2, sentences: 3, signals: ['severalSentences', 'long'], adjudicate: true, runLength: 1, nextHeadingLevel: null });
    expect(entry.words).toBe(wordsOf(LONG_PARAGRAPH, config.headings));
    expect(entry.followedBy).toContain('Body text');
  });

  it('several sentences alone, and length alone, are advisory', () => {
    expect(one(page([p(), h('two', TWO_SENTENCES), p()]), 'two')).toMatchObject({ status: 'advisory', signals: ['severalSentences'] });
    expect(one(page([p(), h('long', LONG_SENTENCE), p()]), 'long')).toMatchObject({ status: 'advisory', signals: ['long'], sentences: 1 });
  });

  it('two short sentences and a long question are not reported', () => {
    const question = 'Que faire si mon employeur refuse de me remettre les documents dont j’ai besoin pour faire valoir mes droits après la fin de mon contrat de travail ?';
    const survey = page([p(), h('slogan', 'Build faster. Ship smarter.'), p(), h('question', question), p(), h('pair', 'Moving house? What to tell us'), p()]);
    expect(found(survey)).toEqual([]);
  });

  it('the thresholds are those of the configuration', () => {
    const survey = page([p(), h('two', TWO_SENTENCES), p()]);
    expect(one(survey, 'two', { runningTextMinWords: 30 })).toBeUndefined();
    expect(one(survey, 'two', { runningTextMinSentences: 3 })).toBeUndefined();
    expect(one(survey, 'two', { longHeadingMinWords: 10 })).toMatchObject({ status: 'likely', signals: ['severalSentences', 'long'] });
  });

  it('text cut by maxTextChars keeps the word count of the whole text', () => {
    const cut = LONG_SENTENCE.slice(0, 60);
    const survey = page([p(), h('cut', cut, 2, { words: 44 }), p()]);
    expect(one(survey, 'cut', { maxTextChars: 60 })).toMatchObject({ words: 44, signals: ['long'] });
    expect(one(survey, 'cut')).toBeUndefined();
  });

  describe('rendered as body text', () => {
    it('a heading in the exact style of body text is info, and likely when it is also several sentences', () => {
      expect(one(page([p(), h('plain', 'Opening hours', 3, { style: BODY }), p()]), 'plain')).toMatchObject({ status: 'info', signals: ['bodyStyle'] });
      expect(one(page([p(), h('plain', TWO_SENTENCES, 3, { style: BODY }), p()]), 'plain')).toMatchObject({ status: 'likely', signals: ['severalSentences', 'bodyStyle'] });
    });
    it.each<[string, Partial<TextStyle>]>([
      ['larger', { size: 17 }],
      ['bolder', { weight: 600 }],
      ['in capitals', { transform: 'uppercase' }],
      ['in italics', { italic: true }],
      ['of another colour', { color: '#595959' }],
      ['of another family', { family: 'georgia' }],
      ['small, bold and in capitals, as a sidebar title', { size: 12, weight: 700, transform: 'uppercase' }],
    ])('a heading that is %s is not', (_, style) => {
      expect(found(page([p(), h('styled', 'Opening hours', 3, { style: { ...BODY, ...style } }), p()]))).toEqual([]);
    });
    it('a smaller heading that differs in nothing else is', () => {
      expect(one(page([p(), h('small', 'Opening hours', 3, { style: { ...BODY, size: 14 } }), p()]), 'small')).toMatchObject({ signals: ['bodyStyle'] });
    });
    it('nothing is said when there is too little text to know what body text looks like', () => {
      const survey = page([p('Short text.'), h('plain', 'Opening hours', 3, { style: BODY }), p('More.')]);
      expect(bodyBaseline(survey.blocks, config.headings)?.lowText).toBe(true);
      expect(found(survey)).toEqual([]);
    });
    it('every block of the heading has to be', () => {
      const survey = page([p(), h('mixed', 'Opening', 3, { style: BODY }), h('mixed', 'hours', 3, { style: H2 }), p()]);
      expect(found(survey)).toEqual([]);
    });
  });

  describe('what follows', () => {
    it('a heading followed at once by a heading of its level or above heads nothing; alone that is not reported', () => {
      const survey = page([p(), h('a', 'Contact'), h('b', 'We answer within two days'), p()]);
      expect(found(survey)).toEqual([]);
    });
    it('with a second weak signal it is advisory: a number, the look of body text, a quotation', () => {
      expect(one(page([p(), h('price', '€49.00', 3), h('next', 'What is included', 3), p()]), 'price')).toMatchObject({
        status: 'advisory',
        signals: ['numeric', 'headsNothing'],
        nextHeadingLevel: 3,
        followedBy: 'What is included',
      });
      expect(one(page([p(), h('plain', 'A line', 3, { style: BODY }), h('next', 'What is included', 2), p()]), 'plain')).toMatchObject({ status: 'advisory', signals: ['bodyStyle', 'headsNothing'] });
      const quotation = '“They found problems that three earlier audits had missed.”';
      expect(one(page([p(), h('quote', quotation, 3), h('next', 'Next', 3), p()]), 'quote')).toMatchObject({ status: 'advisory', signals: ['quotation', 'headsNothing'] });
      // Over content it is the title of an interview, and as a link it is a teaser: neither is reported.
      expect(found(page([p(), h('quote', quotation, 3), p()]))).toEqual([]);
      expect(found(page([p(), h('quote', quotation, 3, { contexts: ['link'] }), h('next', 'Next', 3), p()]))).toEqual([]);
      expect(one(page([p(), h('quote', `“${LONG_SENTENCE}”`, 3), p()]), 'quote')).toMatchObject({ status: 'likely', signals: ['long', 'quotation'] });
    });
    it('a number over content is not reported, nor is the name of a work in quotation marks', () => {
      expect(found(page([p(), h('year', '2024', 3), p(), h('date', '12/03/2026', 3), p(), h('work', '« Tartuffe »', 3), p()]))).toEqual([]);
    });
    it('a heading of a lower level after it is a subsection: it heads that', () => {
      expect(found(page([p(), h('price', '€49.00', 2), h('sub', 'What is included', 3), p()]))).toEqual([]);
    });
    it('text between the two is content', () => {
      expect(found(page([p(), h('price', '€49.00', 3), p('per month'), h('next', 'What is included', 3), p()]))).toEqual([]);
    });
    it('so is anything else that was counted between them: a picture, a control, a closed panel', () => {
      expect(found(page([p(), h('price', '€49.00', 3), h('next', 'What is included', 3, {}, 1), p()]))).toEqual([]);
    });
    it('a survey that did not count says nothing about what follows', () => {
      const survey = page([p(), h('price', '€49.00', 3), h('next', 'What is included', 3), p()]);
      const blocks = survey.blocks.map(({ contentBefore: _, ...block }) => block);
      expect(found({ blocks, total: blocks.length, axComplete: true })).toEqual([]);
    });
    it('a heading of another document is not what follows', () => {
      const survey = page([p(), h('price', '€49.00', 3), h('next', 'What is included', 3, { frame: 'iframe' }), p()]);
      expect(found(survey)).toEqual([]);
    });
    it('a heading that is a link or a button, or that is clicked, names what it opens', () => {
      const run = (over: Partial<TextBlock>) => page([p(), h('a', '€10', 3, over), h('b', '€20', 3, over), h('c', '€30', 3, over), h('d', '€40', 3, over), p()]);
      expect(found(run({})).map((entry) => entry.selector)).toEqual(['#a', '#b', '#c']);
      expect(found(run({ contexts: ['link'] }))).toEqual([]);
      expect(found(run({ contexts: ['button'] }))).toEqual([]);
      expect(found(run({ clickable: true }))).toEqual([]);
    });
    it('the last text of the page heads nothing, unless something else follows it or the page was not read to its end', () => {
      const make = (end: number) => page([p(), h('last', 'Thank you', 3, { style: BODY })], end);
      expect(one(make(0), 'last')).toMatchObject({ status: 'advisory', signals: ['bodyStyle', 'headsNothing'], followedBy: null, nextHeadingLevel: null });
      expect(one(make(1), 'last')).toMatchObject({ status: 'info', signals: ['bodyStyle'] });
      expect(one({ ...make(0), total: 9 }, 'last')).toMatchObject({ status: 'info', signals: ['bodyStyle'] });
    });
  });

  describe('runs of headings', () => {
    const lines = (style: TextStyle, tail: Part[] = [p()]) =>
      page([p(), h('l1', 'Example Company Ltd', 4, { style }), h('l2', '12 Harbour Street', 4, { style }), h('l3', 'Bristol BS1 4XY', 4, { style }), h('l4', 'United Kingdom', 4, { style }), ...tail]);
    it('three or more headings with nothing between them are advisory, except the one that closes the run over content', () => {
      const all = found(lines(H2));
      expect(all.map((entry) => [entry.selector, entry.status, entry.runLength])).toEqual([
        ['#l1', 'advisory', 4],
        ['#l2', 'advisory', 4],
        ['#l3', 'advisory', 4],
      ]);
      expect(all[0]!.signals).toEqual(['headsNothing', 'headingRun']);
    });
    it('rendered as body text they are likely, and the last one is info', () => {
      expect(found(lines(BODY)).map((entry) => [entry.selector, entry.status])).toEqual([
        ['#l1', 'likely'],
        ['#l2', 'likely'],
        ['#l3', 'likely'],
        ['#l4', 'info'],
      ]);
    });
    it('two headings in a row are a title and its subtitle', () => {
      expect(found(page([p(), h('a', 'Contact'), h('b', 'We answer within two days'), p()]))).toEqual([]);
      expect(found(page([p(), h('a', 'Contact'), h('b', 'We answer'), p()]), { headingRunMinLength: 2 }).map((entry) => entry.selector)).toEqual(['#a']);
    });
    it('a heading of a lower level ends the run: levels that go down are a title and its sections', () => {
      expect(found(page([p(), h('a', 'Services', 1), h('b', 'Waste', 2), h('c', 'Collections', 3), p()]))).toEqual([]);
    });
    it('a run can end on a heading of a higher level', () => {
      expect(found(page([p(), h('a', 'One', 3), h('b', 'Two', 3), h('c', 'Section', 2), p()])).map((entry) => entry.selector)).toEqual(['#a', '#b']);
    });
  });

  it('a heading hidden from assistive technology, and one without a letter or a digit, are not looked at', () => {
    const survey = page([p(), h('hidden', LONG_PARAGRAPH, 2, { contexts: ['ariaHidden'] }), p(), h('mark', '***', 2, { style: BODY }), p()]);
    expect(found(survey)).toEqual([]);
  });

  it('a heading of several blocks is one heading: its text joined, the style of most of it', () => {
    const first = 'The office is closed on public holidays.';
    const second = 'Requests sent on those days are read the next morning.';
    const survey = page([p(), h('split', first, 2, { style: { ...H2, color: '#0000ee' } }), h('split', second), p()]);
    const all = found(survey);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ selector: '#split', block: 1, text: `${first} ${second}`, sentences: 2, style: H2, status: 'advisory' });
  });

  it('without the whole accessibility tree nothing is above info, and no model is asked', () => {
    const survey = page([p(), h('para', LONG_PARAGRAPH), p()], 0, false);
    expect(one(survey, 'para')).toMatchObject({ status: 'info', adjudicate: false });
    const [finding] = findingsOf(survey);
    expect(finding).toMatchObject({ status: 'info' });
    expect(finding!.evidence.flags).toContain('axIncomplete');
    expect(finding!.message).toContain('could not be read in full');
  });

  it('lists likely ones first, keeps maxNonHeadings and counts the rest', () => {
    const make = (): HeadingSurvey => page([p(), h('plain', 'Opening hours', 3, { style: BODY }), p(), h('two', TWO_SENTENCES), p(), h('para', LONG_PARAGRAPH), p()]);
    expect(found(make()).map((entry) => entry.selector)).toEqual(['#para', '#two', '#plain']);
    const report = headingReport(make(), { ...config.headings, maxNonHeadings: 2 });
    expect(report.nonHeadings.map((entry) => entry.selector)).toEqual(['#para', '#two']);
    expect(report.omittedNonHeadings).toBe(1);
    const survey = runChecks(snapshotOf(make()), resolveConfig({ checks: ['headings'], headings: { maxNonHeadings: 2 } })).find((finding) => finding.rule === 'headings/survey')!;
    expect(survey.evidence.flags).toContain('truncated');
    expect(survey.evidence.values).toMatchObject({ notHeadings: 2 });
    expect(survey.message).toContain('1 more of those are not listed');
  });

  it('is pure', () => {
    const make = (): HeadingSurvey => page([p(), h('para', LONG_PARAGRAPH), h('next', 'Next'), p()]);
    expect(found(make())).toEqual(found(make()));
  });
});

describe('the findings of headings/heading-not-a-heading', () => {
  const survey = (): HeadingSurvey =>
    page([
      p(),
      h('para', LONG_PARAGRAPH, 2, { crop: 'headings/para.png', cropTarget: { x: 16, y: 48, width: 400, height: 24 } }),
      p(),
      h('two', TWO_SENTENCES),
      p(),
      h('plain', 'Opening hours', 3, { style: BODY, covered: true }),
      p(),
      h('l1', 'One', 4),
      h('l2', 'Two', 4),
      h('l3', 'Three', 4),
      p(),
    ]);

  it('carry the text, the measurements, the signals and the capture, under 1.3.1', () => {
    const all = findingsOf(survey());
    expect(all.map((finding) => [finding.selector, finding.status])).toEqual([
      ['#l1', 'advisory'],
      ['#l2', 'advisory'],
      ['#para', 'likely'],
      ['#plain', 'info'],
      ['#two', 'advisory'],
    ]);
    const para = all[2]!;
    expect(para).toMatchObject({ check: 'headings', rule: NOT_A_HEADING_RULE, wcag: { sc: '1.3.1', level: 'A' } });
    expect(para.evidence).toMatchObject({
      crops: ['headings/para.png'],
      colors: { text: '#1a1a1a', bodyText: '#1a1a1a' },
      ratios: { sizeToBodyText: 1.5 },
      flags: ['severalSentences', 'long'],
      values: { text: LONG_PARAGRAPH, level: 2, sentences: 3, fontSizePx: 24, fontWeight: 700, bodyFontSizePx: 16, bodyFontWeight: 400, headingsInRun: 1 },
    });
    expect(para.evidence.values!['followedBy']).toContain('Body text');
    expect(para.message).toContain('does not read as a heading: it is 3 sentences (');
    expect(para.message).toContain('Confirm');
    expect(all.find((finding) => finding.selector === '#two')!.evidence.flags).toEqual(['severalSentences', 'notCaptured']);
    expect(all.find((finding) => finding.selector === '#plain')!.evidence.flags).toEqual(['bodyStyle', 'covered']);
  });

  it('say what was measured, in words', () => {
    const all = findingsOf(survey());
    const message = (selector: string): string => all.find((finding) => finding.selector === selector)!.message;
    expect(message('#l1')).toContain('may not function as a heading: it is one of 3 headings that follow each other with nothing between them');
    expect(message('#plain')).toContain('it is set as body text is (16px at weight 400, against 16px at weight 400, in its family and colour). Recorded as info');
    const price = findingsOf(page([p(), h('price', '€49.00', 3), h('next', 'What is included', 3), p()]))[0]!;
    expect(price.message).toContain('it is a number: a price, a figure or a date; nothing stands between it and the next heading, "What is included" (level 3), so it heads no content');
    const long = findingsOf(page([p(), h('long', LONG_SENTENCE), p()]), { messageTextMaxChars: 12 })[0]!;
    expect(long.message).toContain('The heading "Everything y…" (level 2) may not function as a heading: it is 44 words long.');
  });

  it('are never fail, and their ids differ from those of other rules on the same element', () => {
    const big = page([p(), h('small', 'A section', 2, { style: { ...H2, size: 16 } }), h('para', LONG_PARAGRAPH, 3, { style: { ...H2, size: 40 } }), p()]);
    const all = runChecks(snapshotOf(big), config);
    expect(all.some((finding) => finding.status === 'fail')).toBe(false);
    const onPara = all.filter((finding) => finding.selector === '#para');
    expect(onPara.map((finding) => finding.rule).sort()).toEqual(['headings/heading-not-a-heading', 'headings/level-inversion']);
    expect(new Set(onPara.map((finding) => finding.id)).size).toBe(2);
  });
});

describe('a model and headings that do not read as one', () => {
  const ai = (verdict: AiEvidence['verdict'], over: Partial<AiEvidence> = {}): AiEvidence => ({
    provider: 'test',
    model: 'm',
    promptVersion: 'p/q',
    votes: [verdict, verdict],
    verdict,
    confidence: verdict === 'unsure' ? 'low' : 'high',
    rationale: 'r',
    statusBefore: 'info',
    inputs: 'text',
    fromCache: false,
    ...over,
  });
  const setup = (over: Parameters<typeof resolveConfig>[0] = {}) => {
    const survey = page([p(), h('para', LONG_PARAGRAPH), p(), h('two', TWO_SENTENCES), p(), h('plain', 'Opening hours', 3, { style: BODY }), p()]);
    const resolved = resolveConfig({ checks: ['headings'], ...over });
    const snapshot = snapshotOf(survey);
    const findings = runChecks(snapshot, resolved);
    const all = judgements(snapshot, findings, resolved);
    const find = (selector: string, from: Finding[] = findings): Finding => from.find((finding) => finding.selector === selector)!;
    return { snapshot, findings, all, find, resolved };
  };

  it('asks one fixed question about each of them, with their context and without page text in the question', () => {
    const { all, find } = setup();
    expect(all.map((judgement) => judgement.request.findingId)).toEqual([find('#para').id, find('#two').id, find('#plain').id]);
    for (const { request } of all) {
      expect(request).toMatchObject({ check: 'headings', question: NOT_HEADING_QUESTION, questionVersion: NOT_HEADING_QUESTION_VERSION, generatorVersion: '1', crop: null, cropHash: '' });
    }
    expect(NOT_HEADING_QUESTION).toContain('function as a heading for the content that follows it');
    expect(all[0]!.request.context).toMatchObject({ text: LONG_PARAGRAPH, level: 2, signals: ['severalSentences', 'long'], sentences: 3, bodyStyle: { size: 16, weight: 400 } });
    expect((all[0]!.request.context as { textAfter: string }).textAfter).toContain('Body text');
  });

  it('asks nothing without a capture when that is configured, nor about findings that are not reported', () => {
    const { snapshot, findings, resolved } = setup({ adjudication: { judgeWithoutImage: false } });
    expect(judgements(snapshot, findings, resolved)).toEqual([]);
    const { snapshot: other, findings: reported, resolved: plain, find } = setup();
    expect(judgements(other, [find('#two', reported)], plain).map((judgement) => judgement.request.findingId)).toEqual([find('#two', reported).id]);
  });

  it.each<[Finding['status'], AiEvidence['verdict'], 'likely' | 'info', Finding['status']]>([
    ['likely', 'no', 'likely', 'likely'],
    ['advisory', 'no', 'likely', 'advisory'],
    ['info', 'no', 'likely', 'info'],
    ['likely', 'yes', 'likely', 'likely'],
    ['advisory', 'yes', 'likely', 'advisory'],
    ['likely', 'yes', 'info', 'info'],
    ['advisory', 'yes', 'info', 'info'],
    ['info', 'yes', 'info', 'info'],
    ['likely', 'no', 'info', 'likely'],
    ['advisory', 'no', 'info', 'advisory'],
    ['likely', 'unsure', 'info', 'likely'],
    ['advisory', 'unsure', 'likely', 'advisory'],
    // Not a status of this rule: what goes out is never fail.
    ['fail', 'no', 'likely', 'info'],
  ])('%s with the verdict %s and headingNoStatus %s gives %s', (before, verdict, headingNoStatus, after) => {
    expect(notHeadingStatusAfter(before, verdict, resolveConfig({ adjudication: { headingNoStatus } }))).toBe(after);
  });

  it('a verdict never raises a status', () => {
    const order = ['info', 'advisory', 'likely'];
    for (const headingNoStatus of ['likely', 'info'] as const) {
      for (const before of ['likely', 'advisory', 'info'] as const) {
        for (const verdict of ['yes', 'no', 'unsure'] as const) {
          const after = notHeadingStatusAfter(before, verdict, resolveConfig({ adjudication: { headingNoStatus } }));
          expect(order.indexOf(after)).toBeLessThanOrEqual(order.indexOf(before));
        }
      }
    }
  });

  it('by default records the verdict and leaves every status as it was', () => {
    const { findings, all, find, resolved } = setup();
    const verdicts = new Map([
      [find('#para').id, ai('yes')],
      [find('#two').id, ai('no', { fromCache: true })],
      [find('#plain').id, ai('unsure', { votes: ['yes', 'no'] })],
    ]);
    const after = applyVerdicts(findings, all, verdicts, resolved);
    for (const before of findings) {
      const now = find(before.selector, after);
      expect(now).toMatchObject({ id: before.id, status: before.status, rule: before.rule, evidence: before.evidence });
      expect(now.message.startsWith(before.message)).toBe(true);
    }
    expect(find('#para', after).ai).toMatchObject({ verdict: 'yes', statusBefore: 'likely' });
    expect(find('#para', after).message).toContain('that it functions as a heading for what follows. It stays likely');
    expect(find('#two', after).message).toContain('A model judged the same (2 votes, from the text alone (no capture was sent), read from the cache): it does not function as a heading');
    expect(find('#plain', after).message).toContain('its votes disagree');
  });

  it('lowers to info on a yes when headingNoStatus is info, and keeps the rule, the id and the evidence', () => {
    const { findings, all, find, resolved } = setup({ adjudication: { headingNoStatus: 'info' } });
    const verdicts = new Map([
      [find('#para').id, ai('yes')],
      [find('#two').id, ai('yes')],
    ]);
    const after = applyVerdicts(findings, all, verdicts, resolved);
    expect(find('#para', after)).toMatchObject({ status: 'info', rule: NOT_A_HEADING_RULE, id: find('#para').id, evidence: find('#para').evidence });
    expect(find('#para', after).message).toContain('Lowered from likely to info');
    expect(find('#two', after)).toMatchObject({ status: 'info' });
    expect(find('#two', after).message).toContain('Lowered from advisory to info');
  });

  it('applyNotHeadingVerdict leaves everything but status, message and ai alone', () => {
    const { find, resolved } = setup();
    const before = find('#two');
    const after = applyNotHeadingVerdict(before, ai('no'), resolved);
    expect({ ...after, message: before.message, ai: undefined }).toEqual({ ...before, ai: undefined });
  });
});
