import { describe, expect, it } from 'vitest';
import { applyVerdicts, judgements } from '../adjudication.js';
import { resolveConfig } from '../config.js';
import {
  bodyBaseline,
  countSentences,
  headingReport,
  isNumberOnlyText,
  NON_HEADING_SIGNALS,
  NON_HEADINGS_GENERATOR_VERSION,
  nonHeadings,
  nonHeadingStatus,
  NOT_A_HEADING_RULE,
  onlyQuestions,
  wordsOf,
} from '../measure/headings.js';
import type { NonHeadingSignal } from '../measure/headings.js';
import { runChecks } from '../run.js';
import type { AiEvidence, Box, Finding, HeadingSurvey, HeadingsConfig, Snapshot, SurveyedHeading, TextBlock, TextStyle } from '../types.js';
import { applyNotHeadingVerdict, NOT_HEADING_QUESTION, NOT_HEADING_QUESTION_VERSION, notHeadingStatusAfter } from './headings-adjudication.js';

const config = resolveConfig({ checks: ['headings'] });
const BODY: TextStyle = { family: 'arial', size: 16, weight: 400, color: '#1a1a1a', transform: 'none', italic: false };
const H2: TextStyle = { ...BODY, size: 24, weight: 700 };

const PARAGRAPH =
  'Body text that goes on for a while so that it is the most common style of the page by far. It has a second sentence and a third one, so that one paragraph alone holds enough characters to say what body text looks like on a page that has little else, whatever the other blocks of that page are.';
const TWO_SENTENCES = 'The office is closed on public holidays. Requests sent on those days are read the next morning.';
const THREE_SENTENCES = `${TWO_SENTENCES} Urgent matters are handled by the person on duty, whose number is on the door.`;
const LONG_SENTENCE =
  'Everything you need to know before you send us the form that asks for a review of the decision that was taken about the request you made last year for a place in one of the schools of the district where you live now';
const LONG_PARAGRAPH =
  'Our team has worked with public bodies and private companies for more than twenty years. We audit websites, train the people who build them and help them fix what we find. Every audit ends with a report that says what to change and in which order.';
const DOUBLE_QUESTION = 'What happens if I miss a payment on my loan? Do I need to contact you before the due date?';
const QUOTED_TITLE = '« On a tout perdu. Il ne nous reste plus rien, même pas les photos de famille »';

interface Part {
  text: string;
  heading?: number;
  id?: string;
  /** Other content met before this block, since the block before it. */
  gap?: number;
  /** The part of it that is text in the page without showing. */
  hidden?: number;
  over?: Partial<TextBlock>;
}

/** A page of one-line blocks, one under the other and 16 pixels apart, with the running count of other content worked out from `gap`. */
function page(parts: Part[], end = 0, axComplete = true): HeadingSurvey {
  let count = 0;
  let hidden = 0;
  const blocks = parts.map((part, row): TextBlock => {
    count += part.gap ?? 0;
    hidden += part.hidden ?? 0;
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
      hiddenBefore: hidden,
      ...part.over,
    };
  });
  return { blocks, total: blocks.length, axComplete, otherContent: count + end, hiddenContent: hidden };
}

const p = (text = PARAGRAPH): Part => ({ text });
const h = (id: string, text: string, level = 2, over: Partial<TextBlock> = {}, gap = 0): Part => ({ id, text, heading: level, over, gap });
/** Puts a block somewhere else on the page. */
const at = (x: number, y: number, width = 400, height = 24): Partial<TextBlock> => {
  const box: Box = { x, y, width, height };
  return { box, firstLine: box, lastLine: box };
};

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
  it('the Arabic question mark ends a sentence; the Arabic semicolon, like any semicolon, does not', () => {
    expect(count('ما هي سياسة الإرجاع؟ هل يمكنني استرداد أموالي بعد ثلاثين يوما؟')).toBe(2);
    expect(count('هذا النص جملة أولى طويلة؛ وهذه جملة ثانية بعدها.')).toBe(1);
  });
  it('a pattern that does not compile finds no such place', () => {
    expect(count(TWO_SENTENCES, { sentenceBreakPattern: '(' })).toBe(1);
  });
});

describe('onlyQuestions', () => {
  const only = (text: string, over: Partial<HeadingsConfig> = {}): boolean => onlyQuestions(text, { ...config.headings, ...over });
  it('is true of text whose every sentence is a question, in English, French, Arabic and with full-width marks', () => {
    expect(only(DOUBLE_QUESTION)).toBe(true);
    expect(only('Que se passe-t-il si je rate un paiement ? Dois-je vous contacter avant la date d’échéance prévue ?')).toBe(true);
    expect(only('ما هي سياسة الإرجاع؟ هل يمكنني استرداد أموالي بعد ثلاثين يوما؟')).toBe(true);
    expect(only('返品はできますか？送料は誰が負担しますか？')).toBe(true);
    expect(only('« Peut-on encore changer de contrat ? »')).toBe(true);
  });
  it('is false as soon as one sentence is not, and without a usable pattern', () => {
    expect(only('Moving house? What to tell us')).toBe(false);
    expect(only('Is the office open today? It closes at five.')).toBe(false);
    expect(only(TWO_SENTENCES)).toBe(false);
    expect(only('')).toBe(false);
    expect(only(DOUBLE_QUESTION, { questionEndPattern: '' })).toBe(false);
    expect(only(DOUBLE_QUESTION, { questionEndPattern: '(' })).toBe(false);
  });
});

describe('isNumberOnlyText', () => {
  const numeric = (text: string, over: Partial<HeadingsConfig> = {}): boolean => isNumberOnlyText(text, { ...config.headings, ...over });
  it.each(['€49.00', '1 299,00 €', '1 299,00 €', '50 %', '98%', '100 $', '12/03/2026', '12 mars 2026', '2024', '2.1.0', '150+', '24/7', '10h30', 'N° 12'])(
    '%s is a number and nothing else',
    (text) => {
      expect(numeric(text)).toBe(true);
    },
  );
  it.each([
    'Save 20% on your first order',
    'Livraison offerte dès 50 € d’achat',
    'Top 5 des destinations à moins de 100 $ cet été',
    'Top 5',
    '98% satisfaction',
    '24/7 support',
    '€9 / month',
    '3D',
    'Lundi 12 mars 2026',
    'Opening hours',
    '€',
    '',
  ])('%s is not', (text) => {
    expect(numeric(text)).toBe(false);
  });
  it('the limits are those of the configuration', () => {
    expect(numeric('98% satisfaction', { numberOnlyMinShare: 0.2 })).toBe(true);
    expect(numeric('12 mars 2026', { numberOnlyMaxWords: 2 })).toBe(false);
  });
});

describe('nonHeadingStatus', () => {
  const status = (...signals: NonHeadingSignal[]) => nonHeadingStatus(signals);
  const all = Object.keys(NON_HEADING_SIGNALS) as NonHeadingSignal[];
  const subsets = Array.from({ length: 1 << all.length }, (_, mask) => all.filter((_, bit) => mask & (1 << bit)));

  it('gives every signal a kind, and says which are strong', () => {
    expect(NON_HEADING_SIGNALS).toEqual({
      severalSentences: { kind: 'text', strong: true },
      long: { kind: 'text', strong: true },
      quotation: { kind: 'text', strong: false },
      numeric: { kind: 'text', strong: false },
      bodyStyle: { kind: 'rendering', strong: false },
      headsNothing: { kind: 'position', strong: false },
      headingRun: { kind: 'position', strong: true },
    });
  });
  it('is likely when a strong signal is confirmed by a signal of another kind', () => {
    expect(status('severalSentences', 'bodyStyle')).toBe('likely');
    expect(status('long', 'headsNothing')).toBe('likely');
    expect(status('headsNothing', 'headingRun', 'bodyStyle')).toBe('likely');
    expect(status('headsNothing', 'headingRun', 'numeric')).toBe('likely');
  });
  it('two signals of one kind never confirm each other', () => {
    expect(status('severalSentences', 'long')).toBe('advisory');
    expect(status('headsNothing', 'headingRun')).toBe('advisory');
    expect(status('severalSentences', 'quotation')).toBeNull();
    expect(status('long', 'quotation')).toBeNull();
    expect(status('severalSentences', 'long', 'quotation', 'numeric')).toBeNull();
  });
  it('whatever the signals, likely means two kinds and a strong signal', () => {
    for (const signals of subsets) {
      if (nonHeadingStatus(signals) !== 'likely') continue;
      expect(new Set(signals.map((signal) => NON_HEADING_SIGNALS[signal].kind)).size, signals.join()).toBeGreaterThanOrEqual(2);
      expect(signals.some((signal) => NON_HEADING_SIGNALS[signal].strong), signals.join()).toBe(true);
    }
  });
  it('a quotation takes their strength from the measures of running text: it never makes a finding likely', () => {
    for (const signals of subsets) {
      if (!signals.includes('quotation') || signals.includes('headingRun')) continue;
      expect(nonHeadingStatus(signals), signals.join()).not.toBe('likely');
    }
    expect(status('severalSentences', 'quotation', 'headsNothing')).toBe('advisory');
    expect(status('severalSentences', 'quotation', 'bodyStyle')).toBe('info');
  });
  it('is advisory for a strong signal alone, or for a heading that heads nothing with a weak signal of another kind', () => {
    expect(status('severalSentences')).toBe('advisory');
    expect(status('long')).toBe('advisory');
    expect(status('headsNothing', 'bodyStyle')).toBe('advisory');
    expect(status('headsNothing', 'numeric')).toBe('advisory');
    expect(status('headsNothing', 'quotation')).toBe('advisory');
  });
  it('is info for the look of body text alone, and nothing for the rest', () => {
    expect(status('bodyStyle')).toBe('info');
    expect(status('bodyStyle', 'numeric')).toBe('info');
    expect(status('quotation')).toBeNull();
    expect(status('headsNothing')).toBeNull();
    expect(status('numeric')).toBeNull();
    expect(status()).toBeNull();
  });
  it('is never fail, whatever the signals', () => {
    for (const signals of subsets) expect(['likely', 'advisory', 'info', null]).toContain(nonHeadingStatus(signals));
  });
});

describe('headings that do not read as a heading', () => {
  it('ordinary headings over content are not reported', () => {
    const survey = page([h('a', 'Waste and recycling', 1), h('b', 'Collections'), p(), h('c', 'Opening hours'), p(), h('d', 'Contact', 3), p()]);
    expect(found(survey)).toEqual([]);
    expect(headingReport(survey, config.headings).nonHeadings).toEqual([]);
  });

  it('a paragraph in a heading set as a heading over content is advisory: sentences and length are one kind', () => {
    const entry = one(page([p(), h('para', LONG_PARAGRAPH), p()]), 'para')!;
    expect(entry).toMatchObject({ status: 'advisory', level: 2, sentences: 3, signals: ['severalSentences', 'long'], adjudicate: true, control: false, runLength: 1, nextHeadingLevel: null });
    expect(entry.words).toBe(wordsOf(LONG_PARAGRAPH, config.headings));
    expect(entry.followedBy).toContain('Body text');
  });

  it('several sentences alone, and length alone, are advisory', () => {
    expect(one(page([p(), h('three', THREE_SENTENCES), p()]), 'three')).toMatchObject({ status: 'advisory', signals: ['severalSentences'], sentences: 3 });
    expect(one(page([p(), h('long', LONG_SENTENCE), p()]), 'long')).toMatchObject({ status: 'advisory', signals: ['long'], sentences: 1 });
  });

  it('two sentences are a headline in two clauses, three short ones a title in three parts: not running text', () => {
    const titles = [
      TWO_SENTENCES,
      'Budget 2027 : le gouvernement recule. Les syndicats maintiennent la grève de jeudi dans les transports publics',
      'Mr. Smith goes to Washington. A review of the classic film and its place in American cinema',
      'Who we are. What we do. Why it matters to the people and the communities that we serve',
      'Covid-19 : ce que l’on sait du nouveau variant. Les réponses à vos questions sur la vaccination',
    ];
    expect(found(page([p(), ...titles.flatMap((text, index) => [h(`t${index}`, text), p()])]))).toEqual([]);
  });

  it('two sentences are reported from the length of a long heading, as long', () => {
    const two = 'We answer every request within two working days. If your question is urgent, call the number at the bottom of this page and ask for the person on duty, who will find someone to help you before the end of the day.';
    expect(one(page([p(), h('two', two), p()]), 'two')).toMatchObject({ status: 'advisory', signals: ['long'], sentences: 2 });
  });

  it('text made only of questions is not running text, however many they are', () => {
    const three = 'Where is my order now? When will it be delivered to my home address? Whom do I call if it does not come on that day at all?';
    expect(wordsOf(three, config.headings)).toBeGreaterThanOrEqual(config.headings.runningTextMinWords);
    const questions = [DOUBLE_QUESTION, 'Que se passe-t-il si je rate un paiement ? Dois-je vous contacter avant la date d’échéance prévue ?', three];
    const survey = page([p(), ...questions.flatMap((text, index) => [h(`q${index}`, text, 3), p()])]);
    expect(found(survey)).toEqual([]);
    // The same three with the questions taken for sentences: reported.
    expect(one(survey, 'q2', { questionEndPattern: '' })).toMatchObject({ status: 'advisory', signals: ['severalSentences'] });
  });

  it('two short sentences and a long question are not reported', () => {
    const question = 'Que faire si mon employeur refuse de me remettre les documents dont j’ai besoin pour faire valoir mes droits après la fin de mon contrat de travail ?';
    const survey = page([p(), h('slogan', 'Build faster. Ship smarter.'), p(), h('question', question), p(), h('pair', 'Moving house? What to tell us'), p()]);
    expect(found(survey)).toEqual([]);
  });

  it('the thresholds are those of the configuration', () => {
    const survey = page([p(), h('three', THREE_SENTENCES), p(), h('two', TWO_SENTENCES), p()]);
    expect(one(survey, 'three', { runningTextMinWords: 40 })).toBeUndefined();
    expect(one(survey, 'three', { runningTextMinSentences: 4 })).toBeUndefined();
    expect(one(survey, 'three', { longHeadingMinWords: 10 })).toMatchObject({ status: 'advisory', signals: ['severalSentences', 'long'] });
    // The limits of before the review: two sentences in fifteen words.
    expect(one(survey, 'two')).toBeUndefined();
    expect(one(survey, 'two', { runningTextMinSentences: 2, runningTextMinWords: 15 })).toMatchObject({ status: 'advisory', signals: ['severalSentences'] });
  });

  it('text cut by maxTextChars keeps the word count of the whole text', () => {
    const cut = LONG_SENTENCE.slice(0, 60);
    const survey = page([p(), h('cut', cut, 2, { words: 44 }), p()]);
    expect(one(survey, 'cut', { maxTextChars: 60 })).toMatchObject({ words: 44, signals: ['long'] });
    expect(one(survey, 'cut')).toBeUndefined();
  });

  describe('rendered as body text', () => {
    it('a heading in the exact style of body text is info, and likely when it is also several sentences', () => {
      expect(one(page([p(), h('plain', 'Opening hours', 3, { style: BODY }), p()]), 'plain')).toMatchObject({ status: 'info', signals: ['bodyStyle'], adjudicate: false });
      expect(one(page([p(), h('plain', THREE_SENTENCES, 3, { style: BODY }), p()]), 'plain')).toMatchObject({ status: 'likely', signals: ['severalSentences', 'bodyStyle'] });
      // Two sentences in fewer than forty words are not running text: the look alone, which is info.
      expect(one(page([p(), h('plain', TWO_SENTENCES, 3, { style: BODY }), p()]), 'plain')).toMatchObject({ status: 'info', signals: ['bodyStyle'] });
    });
    it.each<[string, Partial<TextStyle>]>([
      ['larger', { size: 17 }],
      ['bolder', { weight: 600 }],
      ['of a medium weight', { weight: 500 }],
      ['in capitals', { transform: 'uppercase' }],
      ['in italics', { italic: true }],
      ['of another colour', { color: '#595959' }],
      ['of another family', { family: 'georgia' }],
      ['small, bold and in capitals, as a sidebar title', { size: 12, weight: 700, transform: 'uppercase' }],
    ])('a heading that is %s is not', (_, style) => {
      expect(found(page([p(), h('styled', 'Opening hours', 3, { style: { ...BODY, ...style } }), p()]))).toEqual([]);
    });
    it('how much heavier a heading may be and still be set as body text is configured', () => {
      const survey = page([p(), h('medium', 'Opening hours', 3, { style: { ...BODY, weight: 500 } }), p()]);
      expect(found(survey)).toEqual([]);
      expect(one(survey, 'medium', { bodyStyleMaxWeightDelta: 200 })).toMatchObject({ signals: ['bodyStyle'] });
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

  describe('a heading that is a link or a button', () => {
    const control = (text: string, over: Partial<TextBlock> = {}): HeadingSurvey =>
      page([p(), h('header', text, 2, { style: BODY, contexts: ['button'], ...over }), { text: 'Next question', heading: 2, id: 'next', gap: 1, hidden: 1, over: { style: BODY, contexts: ['button'] } }, p()]);
    it('is not said to be set as body text: the header of an accordion has the style of its button', () => {
      expect(found(control('How do I reset my password?'))).toEqual([]);
      expect(found(control(DOUBLE_QUESTION))).toEqual([]);
      expect(found(control('Puis-je modifier mon offre plus tard ? Vais-je perdre les données que j’ai déjà envoyées sur la plateforme ?'))).toEqual([]);
      // The same headings when they are no control: the look of body text is reported.
      expect(one(control('How do I reset my password?', { contexts: [] }), 'header')).toMatchObject({ signals: ['bodyStyle'] });
    });
    it('is not running text by its sentences alone, whatever they are', () => {
      expect(found(control(THREE_SENTENCES))).toEqual([]);
      expect(found(control(THREE_SENTENCES, { contexts: ['link'] }))).toEqual([]);
      expect(found(control(THREE_SENTENCES, { contexts: [], clickable: true }))).toEqual([]);
    });
    it('is advisory at most, with a paragraph in it', () => {
      expect(one(control(LONG_PARAGRAPH), 'header')).toMatchObject({ status: 'advisory', signals: ['severalSentences', 'long'], control: true });
      expect(one(control(LONG_SENTENCE, { contexts: ['link'] }), 'header')).toMatchObject({ status: 'advisory', signals: ['long'], control: true });
      const [finding] = findingsOf(control(LONG_PARAGRAPH));
      expect(finding).toMatchObject({ status: 'advisory' });
      expect(finding!.evidence.flags).toEqual(['severalSentences', 'long', 'control', 'notCaptured']);
    });
    it('is never likely, whatever its text and whatever follows it', () => {
      const texts = [DOUBLE_QUESTION, THREE_SENTENCES, LONG_PARAGRAPH, LONG_SENTENCE, '€49.00', `“${LONG_SENTENCE}”`, 'Opening hours'];
      for (const text of texts) {
        for (const contexts of [['button'], ['link']] as const) {
          const survey = page([p(), h('a', text, 3, { style: BODY, contexts: [...contexts] }), h('b', text, 3, { style: BODY, contexts: [...contexts] }), h('c', text, 3, { style: BODY, contexts: [...contexts] })]);
          for (const entry of found(survey)) expect(entry.status, text).not.toBe('likely');
        }
      }
    });
  });

  describe('a quotation', () => {
    it('over content is the title of an interview or of a testimony: not reported, however many sentences or words it has', () => {
      const long = '« Nous avons attendu les secours pendant trois jours. Personne n’est venu nous chercher avant la fin de la semaine. Il a fallu marcher jusqu’au village voisin pour trouver de l’eau »';
      expect(countSentences(long, config.headings)).toBe(3);
      expect(found(page([p(), h('title', QUOTED_TITLE, 1), p('Par Jeanne Martin. Publié le 12 mars 2026.'), p(), h('long', long), p(), h('longer', `“${LONG_SENTENCE}”`), p()]))).toEqual([]);
      // Without the quotation marks the long ones are reported.
      expect(one(page([p(), h('long', long.slice(2, -2)), p()]), 'long')).toMatchObject({ status: 'advisory', signals: ['severalSentences'] });
    });
    it('that heads nothing is advisory, and never more', () => {
      const quotation = '“They found problems that three earlier audits had missed.”';
      expect(one(page([p(), h('quote', quotation, 3), h('next', 'Next', 3), p()]), 'quote')).toMatchObject({ status: 'advisory', signals: ['quotation', 'headsNothing'] });
      expect(one(page([p(), h('quote', `“${LONG_PARAGRAPH}”`, 3), h('next', 'Next', 3), p()]), 'quote')).toMatchObject({
        status: 'advisory',
        signals: ['severalSentences', 'long', 'quotation', 'headsNothing'],
      });
    });
    it('that is a link is a teaser: quotation marks say nothing', () => {
      const quotation = '“They found problems that three earlier audits had missed.”';
      expect(found(page([p(), h('quote', quotation, 3, { contexts: ['link'] }), h('next', 'Next', 3), p()]))).toEqual([]);
    });
  });

  describe('what follows', () => {
    it('a heading followed at once by a heading of its level or above heads nothing; alone that is not reported', () => {
      const survey = page([p(), h('a', 'Contact'), h('b', 'We answer within two days'), p()]);
      expect(found(survey)).toEqual([]);
    });
    it('with a second weak signal it is advisory: a number, the look of body text', () => {
      expect(one(page([p(), h('price', '€49.00', 3), h('next', 'What is included', 3), p()]), 'price')).toMatchObject({
        status: 'advisory',
        signals: ['numeric', 'headsNothing'],
        nextHeadingLevel: 3,
        followedBy: 'What is included',
      });
      expect(one(page([p(), h('plain', 'A line', 3, { style: BODY }), h('next', 'What is included', 2), p()]), 'plain')).toMatchObject({ status: 'advisory', signals: ['bodyStyle', 'headsNothing'] });
    });
    it('with running text it is likely', () => {
      expect(one(page([p(), h('three', THREE_SENTENCES, 3), h('next', 'Contact us', 3), p()]), 'three')).toMatchObject({ status: 'likely', signals: ['severalSentences', 'headsNothing'] });
      expect(one(page([p(), h('long', LONG_SENTENCE, 3), h('next', 'Contact us', 3), p()]), 'long')).toMatchObject({ status: 'likely', signals: ['long', 'headsNothing'] });
    });
    it('a title that holds a number, a price or a percentage is no number', () => {
      const promos = ['Save 20% on your first order', 'Livraison offerte dès 50 € d’achat', 'Top 5 des destinations à moins de 100 $ cet été'];
      expect(found(page([p(), ...promos.flatMap((text, index) => [h(`promo${index}`, text), h(`after${index}`, 'Our commitments'), p()])]))).toEqual([]);
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

  describe('where the two headings are on the page', () => {
    // Rows of the helper are 40 pixels apart and 24 high: 16 pixels between two headings.
    const pair = (second: Partial<TextBlock>, first: Partial<TextBlock> = {}) => page([p(), h('price', '€49.00', 3, first), h('next', 'What is included', 3, second), p()]);
    it('one right under the other, the first heads nothing', () => {
      expect(one(pair({}), 'price')).toMatchObject({ signals: ['numeric', 'headsNothing'] });
      // Up to one and a half times the font size of the first (24 pixels): 36 pixels.
      expect(one(pair(at(32, 40 + 24 + 36)), 'price')).toMatchObject({ signals: ['numeric', 'headsNothing'] });
    });
    it('further apart, something takes that room, whatever the document holds: nothing is said', () => {
      expect(found(pair(at(32, 40 + 24 + 37)))).toEqual([]);
      expect(found(pair(at(32, 400)))).toEqual([]);
      expect(one(pair(at(32, 400)), 'price', { headsNothingMaxGapEm: 20 })).toMatchObject({ signals: ['numeric', 'headsNothing'] });
      // The allowance follows the font size of the first heading.
      expect(one(pair(at(32, 40 + 24 + 30)), 'price')).toMatchObject({ signals: ['numeric', 'headsNothing'] });
      expect(one(pair(at(32, 40 + 24 + 30), { style: BODY }), 'price')).toMatchObject({ status: 'info', signals: ['numeric', 'bodyStyle'] });
    });
    it('side by side, each heads what is under it: the titles of a row of cards, the heading row of a grid', () => {
      expect(found(pair(at(450, 40)))).toEqual([]);
      expect(found(pair(at(450, 40), {}), { headsNothingMaxGapEm: 100 })).toEqual([]);
      const row = page([
        p(),
        h('g1', 'Design', 3, { style: BODY, ...at(32, 40, 200) }),
        h('g2', 'Build', 3, { style: BODY, ...at(240, 40, 200) }),
        h('g3', 'Ship', 3, { style: BODY, ...at(448, 40, 200) }),
        { text: 'We design it.', over: at(32, 72, 200) },
        { text: 'We build it.', over: at(240, 72, 200) },
        { text: 'We ship it.', over: at(448, 72, 200) },
      ]);
      expect(found(row).map((entry) => [entry.selector, entry.status, entry.signals])).toEqual([
        ['#g1', 'info', ['bodyStyle']],
        ['#g2', 'info', ['bodyStyle']],
        ['#g3', 'info', ['bodyStyle']],
      ]);
    });
    it('cards that wrap to a second row are no run either: the next title is under another column', () => {
      const cards = page([p(), h('c1', '2019', 3, at(32, 40, 200)), h('c2', '2020', 3, at(240, 40, 200)), h('c3', '2021', 3, at(448, 40, 200)), h('c4', '2022', 3, at(32, 80, 200)), h('c5', '2023', 3, at(240, 80, 200)), p()]);
      expect(found(cards)).toEqual([]);
    });
    it('above the first, the second is not what follows it on the page', () => {
      expect(found(pair(at(32, 0)))).toEqual([]);
    });
    it('the boxes are those of the heading elements where the survey lists them', () => {
      const survey = pair({});
      const listed = (y: number): SurveyedHeading[] => [
        { selector: '#price', frame: '', level: 3, box: { x: 32, y: 40, width: 400, height: 24 }, blocksBefore: 1, contentBefore: 0, hiddenBefore: 0 },
        { selector: '#next', frame: '', level: 3, box: { x: 32, y, width: 400, height: 24 }, blocksBefore: 2, contentBefore: 0, hiddenBefore: 0 },
      ];
      expect(one({ ...survey, headings: listed(80) }, 'price')).toMatchObject({ signals: ['numeric', 'headsNothing'] });
      // The text of the second is where it was; its element begins further down (a padding, a picture inside it).
      expect(found({ ...survey, headings: listed(300) })).toEqual([]);
      // An element without a box (display: contents): the boxes of its text.
      const boxless = listed(300).map((heading) => ({ ...heading, box: null }));
      expect(one({ ...survey, headings: boxless }, 'price')).toMatchObject({ signals: ['numeric', 'headsNothing'] });
    });
  });

  describe('headings without visible text', () => {
    const textless = (selector: string, level: number, blocksBefore: number): SurveyedHeading => ({ selector, frame: '', level, box: { x: 32, y: blocksBefore * 40 - 20, width: 200, height: 10 }, blocksBefore, contentBefore: 0, hiddenBefore: 0 });
    const listed = (survey: HeadingSurvey, extra: SurveyedHeading[]): HeadingSurvey => ({
      ...survey,
      headings: [
        ...survey.blocks.flatMap((block, index) => (block.heading ? [{ selector: block.heading.selector, frame: '', level: block.heading.level, box: block.box, blocksBefore: index, contentBefore: 0, hiddenBefore: 0 }] : [])),
        ...extra,
      ].sort((a, b) => a.blocksBefore - b.blocksBefore || (a.selector.startsWith('#hidden') ? -1 : 1)),
    });
    const survey = page([p(), h('price', '€49.00', 3), h('next', 'What is included', 3), p()]);
    it('without the list, the two headings follow each other', () => {
      expect(one(survey, 'price')).toMatchObject({ signals: ['numeric', 'headsNothing'] });
      expect(one(listed(survey, []), 'price')).toMatchObject({ signals: ['numeric', 'headsNothing'] });
    });
    it('a heading that holds only a picture, or is visually hidden, stands between them: the first is not said to head nothing', () => {
      for (const level of [2, 3, 4]) expect(found(listed(survey, [textless('#hidden', level, 2)]))).toEqual([]);
    });
    it('such a heading is never reported itself, and ends a run', () => {
      const run = page([p(), h('a', 'One', 3), h('b', 'Two', 3), h('c', 'Three', 3), h('d', 'Four', 3), p()]);
      expect(found(listed(run, [])).map((entry) => entry.selector)).toEqual(['#a', '#b', '#c']);
      expect(found(listed(run, [textless('#hidden', 3, 3)]))).toEqual([]);
      expect(found(listed(run, [textless('#hidden', 3, 4)])).map((entry) => [entry.selector, entry.runLength])).toEqual([
        ['#a', 3],
        ['#b', 3],
      ]);
    });
    it('after the last text of the page, it is what follows that text', () => {
      const last = page([p(), h('last', 'Thank you', 3, { style: BODY })]);
      expect(one(listed(last, []), 'last')).toMatchObject({ signals: ['bodyStyle', 'headsNothing'] });
      expect(one(listed(last, [textless('#hidden', 2, 2)]), 'last')).toMatchObject({ signals: ['bodyStyle'] });
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
      expect(found(lines(BODY)).map((entry) => [entry.selector, entry.status, entry.runLength])).toEqual([
        ['#l1', 'likely', 4],
        ['#l2', 'likely', 4],
        ['#l3', 'likely', 4],
        ['#l4', 'info', 4],
      ]);
    });
    it('two headings in a row are a title and its subtitle', () => {
      expect(found(page([p(), h('a', 'Contact'), h('b', 'We answer within two days'), p()]))).toEqual([]);
      expect(found(page([p(), h('a', 'Contact'), h('b', 'We answer'), p()]), { headingRunMinLength: 2 }).map((entry) => entry.selector)).toEqual(['#a']);
    });
    it('a heading of a lower level ends the run: levels that go down are a title and its sections', () => {
      expect(found(page([p(), h('a', 'Services', 1), h('b', 'Waste', 2), h('c', 'Collections', 3), p()]))).toEqual([]);
    });
    it('the title of the next section ends a run without being counted in it', () => {
      // Three titles of cards and the title of the next section: a run of three, not of four.
      const cards = found(page([p(), h('a', 'One', 3), h('b', 'Two', 3), h('c', 'Three', 3), h('section', 'Next section', 2), p()]));
      expect(cards.map((entry) => [entry.selector, entry.runLength])).toEqual([
        ['#a', 3],
        ['#b', 3],
        ['#c', 3],
      ]);
      expect(findingsOf(page([p(), h('a', 'One', 3), h('b', 'Two', 3), h('c', 'Three', 3), h('section', 'Next section', 2), p()]))[0]!.message).toContain('one of 3 headings');
      // Two and the title of the next section are two: no run.
      expect(found(page([p(), h('a', 'One', 3), h('b', 'Two', 3), h('section', 'Next section', 2), p()]))).toEqual([]);
    });
  });

  it('a heading hidden from assistive technology, and one without a letter or a digit, are not looked at', () => {
    const survey = page([p(), h('hidden', LONG_PARAGRAPH, 2, { contexts: ['ariaHidden'] }), p(), h('mark', '***', 2, { style: BODY }), p()]);
    expect(found(survey)).toEqual([]);
  });

  it('a heading of several blocks is one heading: its text joined, the style of most of it', () => {
    const first = 'The office is closed on public holidays.';
    const second = 'Requests sent on those days are read the next morning. Urgent matters are handled by the person on duty, whose number is on the door.';
    const survey = page([p(), h('split', first, 2, { style: { ...H2, color: '#0000ee' } }), h('split', second), p()]);
    const all = found(survey);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ selector: '#split', block: 1, text: `${first} ${second}`, sentences: 3, style: H2, status: 'advisory' });
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
    const make = (): HeadingSurvey => page([p(), h('plain', 'Opening hours', 3, { style: BODY }), p(), h('para', LONG_PARAGRAPH), p(), h('three', THREE_SENTENCES, 3, { style: BODY }), p()]);
    expect(found(make()).map((entry) => entry.selector)).toEqual(['#three', '#para', '#plain']);
    const report = headingReport(make(), { ...config.headings, maxNonHeadings: 2 });
    expect(report.nonHeadings.map((entry) => entry.selector)).toEqual(['#three', '#para']);
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
      h('three', THREE_SENTENCES, 3, { style: BODY }),
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
      ['#para', 'advisory'],
      ['#plain', 'info'],
      ['#three', 'likely'],
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
    expect(para.message).toContain('may not function as a heading: it is 3 sentences (');
    expect(para.message).toContain('check what it heads');
    const three = all.find((finding) => finding.selector === '#three')!;
    expect(three.evidence.flags).toEqual(['severalSentences', 'bodyStyle', 'notCaptured']);
    expect(three.message).toContain('does not read as a heading: it is 3 sentences (32 words); it is set as body text is');
    expect(three.message).toContain('Confirm');
    expect(all.find((finding) => finding.selector === '#plain')!.evidence.flags).toEqual(['bodyStyle', 'covered']);
  });

  it('say what was measured, in words', () => {
    const all = findingsOf(survey());
    const message = (selector: string): string => all.find((finding) => finding.selector === selector)!.message;
    expect(message('#l1')).toContain('may not function as a heading: it is one of 3 headings that follow each other with nothing between them');
    expect(message('#plain')).toContain('it is set as body text is (16px at weight 400, against 16px at weight 400, in its family and colour). Recorded as info');
    const price = findingsOf(page([p(), h('price', '€49.00', 3), h('next', 'What is included', 3), p()]))[0]!;
    expect(price.message).toContain('it is a number and nothing else: a price, a figure or a date; nothing stands between it and the next heading, "What is included" (level 3), so it heads no content');
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
    const survey = page([p(), h('three', THREE_SENTENCES, 3, { style: BODY }), p(), h('para', LONG_PARAGRAPH), p(), h('plain', 'Opening hours', 3, { style: BODY }), p()]);
    const resolved = resolveConfig({ checks: ['headings'], ...over });
    const snapshot = snapshotOf(survey);
    const findings = runChecks(snapshot, resolved);
    const all = judgements(snapshot, findings, resolved);
    const find = (selector: string, from: Finding[] = findings): Finding => from.find((finding) => finding.selector === selector)!;
    return { snapshot, findings, all, find, resolved };
  };

  it('asks one fixed question about each of them above info, without page text in the question', () => {
    const { all, find } = setup();
    // `#plain` is info: no verdict lowers it and none may raise it, so nothing is asked about it.
    expect(find('#plain')).toMatchObject({ status: 'info', rule: NOT_A_HEADING_RULE });
    expect(all.map((judgement) => judgement.request.findingId)).toEqual([find('#three').id, find('#para').id]);
    for (const { request } of all) {
      expect(request).toMatchObject({ check: 'headings', question: NOT_HEADING_QUESTION, questionVersion: NOT_HEADING_QUESTION_VERSION, generatorVersion: NON_HEADINGS_GENERATOR_VERSION, crop: null, cropHash: '' });
    }
    expect(NOT_HEADING_QUESTION).toContain('function as a heading for the content that follows it');
    // Raised with the context and the question, so that verdicts given on the former ones are not read from a cache.
    expect(NON_HEADINGS_GENERATOR_VERSION).toBe('2');
    expect(NOT_HEADING_QUESTION_VERSION).toBe('headings-not-heading-2');
  });

  it('gives the model what was read and measured, and not what was concluded from it', () => {
    const { all } = setup();
    const context = all[1]!.request.context as Record<string, unknown>;
    expect(context).toMatchObject({ text: LONG_PARAGRAPH, level: 2, sentences: 3, bodyStyle: { size: 16, weight: 400 }, control: false, contentBetween: true, hiddenContentBetween: false, nextHeadingLevel: 3 });
    expect(context['textAfter']).toContain('Body text');
    expect(context).not.toHaveProperty('signals');
    expect(JSON.stringify(context)).not.toMatch(/severalSentences|bodyStyle"\s*,|headsNothing|headingRun/);
  });

  it('says whether content stands between the heading and the next one, and whether some of it is hidden', () => {
    const contextOf = (survey: HeadingSurvey, id: string, over: Partial<HeadingsConfig> = {}): Record<string, unknown> => one(survey, id, over)!.context;
    // The header of a closed accordion: what follows it in the text is the next header, and the panel between them does not show.
    const accordion = page([p(), h('q1', LONG_PARAGRAPH, 3, { contexts: ['button'] }), { text: 'Next question', heading: 3, id: 'q2', gap: 1, hidden: 1, over: { contexts: ['button'] } }, p()]);
    expect(contextOf(accordion, 'q1')).toMatchObject({ control: true, textAfter: 'Next question', nextHeadingLevel: 3, contentBetween: true, hiddenContentBetween: true });
    // A picture between two headings: content, none of it hidden.
    const picture = page([p(), h('a', LONG_PARAGRAPH, 3), h('b', 'Next', 3, {}, 1), p()]);
    expect(contextOf(picture, 'a')).toMatchObject({ control: false, contentBetween: true, hiddenContentBetween: false });
    // Nothing between them.
    const nothing = page([p(), h('a', LONG_PARAGRAPH, 3), h('b', 'Next', 3), p()]);
    expect(contextOf(nothing, 'a')).toMatchObject({ contentBetween: false, hiddenContentBetween: false, nextHeadingLevel: 3 });
    // The last heading of the page, over text and over nothing.
    expect(contextOf(page([p(), h('a', LONG_PARAGRAPH, 3), p()]), 'a')).toMatchObject({ contentBetween: true, nextHeadingLevel: null });
    expect(contextOf(page([p(), h('a', LONG_PARAGRAPH, 3)]), 'a')).toMatchObject({ contentBetween: false, hiddenContentBetween: false, nextHeadingLevel: null });
    // A survey that did not count: text is known, the rest is not.
    const blocks = nothing.blocks.map(({ contentBefore: _, hiddenBefore: __, ...block }) => block);
    expect(contextOf({ blocks, total: blocks.length, axComplete: true }, 'a')).toMatchObject({ contentBetween: null, hiddenContentBetween: null });
    // A heading without visible text after it is the next heading.
    const hidden: SurveyedHeading = { selector: '#hidden', frame: '', level: 4, box: null, blocksBefore: 2, contentBefore: 0, hiddenBefore: 0 };
    expect(contextOf({ ...page([p(), h('a', LONG_PARAGRAPH, 3), p()]), headings: [hidden] }, 'a')).toMatchObject({ nextHeadingLevel: 4, contentBetween: false });
  });

  it('asks nothing without a capture when that is configured, nor about findings that are not reported', () => {
    const { snapshot, findings, resolved } = setup({ adjudication: { judgeWithoutImage: false } });
    expect(judgements(snapshot, findings, resolved)).toEqual([]);
    const { snapshot: other, findings: reported, resolved: plain, find } = setup();
    expect(judgements(other, [find('#para', reported)], plain).map((judgement) => judgement.request.findingId)).toEqual([find('#para', reported).id]);
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
  ])('%s with the verdict %s and headingDisagreeStatus %s gives %s', (before, verdict, headingDisagreeStatus, after) => {
    expect(notHeadingStatusAfter(before, verdict, resolveConfig({ adjudication: { headingDisagreeStatus } }))).toBe(after);
  });

  it('the former name of the option, headingNoStatus, is still read; the new one wins where both are given', () => {
    expect(notHeadingStatusAfter('likely', 'yes', resolveConfig({ adjudication: { headingNoStatus: 'info' } }))).toBe('info');
    expect(notHeadingStatusAfter('likely', 'yes', resolveConfig({ adjudication: { headingNoStatus: 'info', headingDisagreeStatus: 'likely' } }))).toBe('likely');
    expect(resolveConfig({ adjudication: { headingNoStatus: 'info' } }).adjudication).not.toHaveProperty('headingNoStatus');
  });

  it('a verdict never raises a status', () => {
    const order = ['info', 'advisory', 'likely'];
    for (const headingDisagreeStatus of ['likely', 'info'] as const) {
      for (const before of ['likely', 'advisory', 'info'] as const) {
        for (const verdict of ['yes', 'no', 'unsure'] as const) {
          const after = notHeadingStatusAfter(before, verdict, resolveConfig({ adjudication: { headingDisagreeStatus } }));
          expect(order.indexOf(after)).toBeLessThanOrEqual(order.indexOf(before));
        }
      }
    }
  });

  it('by default records the verdict and leaves every status as it was', () => {
    const { findings, all, find, resolved } = setup();
    const verdicts = new Map([
      [find('#three').id, ai('yes')],
      [find('#para').id, ai('no', { fromCache: true })],
    ]);
    const after = applyVerdicts(findings, all, verdicts, resolved);
    for (const before of findings) {
      const now = find(before.selector, after);
      expect(now).toMatchObject({ id: before.id, status: before.status, rule: before.rule, evidence: before.evidence });
      expect(now.message.startsWith(before.message)).toBe(true);
    }
    expect(find('#three', after).ai).toMatchObject({ verdict: 'yes', statusBefore: 'likely' });
    expect(find('#three', after).message).toContain('that it functions as a heading for what follows. It stays likely');
    expect(find('#para', after).message).toContain('A model judged the same (2 votes, from the text alone (no capture was sent), read from the cache): it does not function as a heading');
    expect(find('#plain', after).ai).toBeUndefined();
    const unsure = applyVerdicts(findings, all, new Map([[find('#para').id, ai('unsure', { votes: ['yes', 'no'] })]]), resolved);
    expect(find('#para', unsure).message).toContain('its votes disagree');
  });

  it('lowers to info when the model disagrees and headingDisagreeStatus is info, and keeps the rule, the id and the evidence', () => {
    const { findings, all, find, resolved } = setup({ adjudication: { headingDisagreeStatus: 'info' } });
    const verdicts = new Map([
      [find('#three').id, ai('yes')],
      [find('#para').id, ai('yes')],
    ]);
    const after = applyVerdicts(findings, all, verdicts, resolved);
    expect(find('#three', after)).toMatchObject({ status: 'info', rule: NOT_A_HEADING_RULE, id: find('#three').id, evidence: find('#three').evidence });
    expect(find('#three', after).message).toContain('Lowered from likely to info');
    expect(find('#para', after)).toMatchObject({ status: 'info' });
    expect(find('#para', after).message).toContain('Lowered from advisory to info');
  });

  it('applyNotHeadingVerdict leaves everything but status, message and ai alone', () => {
    const { find, resolved } = setup();
    const before = find('#para');
    const after = applyNotHeadingVerdict(before, ai('no'), resolved);
    expect({ ...after, message: before.message, ai: undefined }).toEqual({ ...before, ai: undefined });
  });
});
