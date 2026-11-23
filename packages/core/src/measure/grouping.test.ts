import { describe, expect, it } from 'vitest';
import { defaultConfig, resolveConfig } from '../config.js';
import type { Box, GroupingBlock, GroupingConfig, GroupingControl, GroupingGroup, GroupingSurvey, TextStyle } from '../types.js';
import {
  besideEachOther,
  containsWords,
  DUPLICATE_NAMES_RULE,
  GROUP_CANDIDATE_RULE,
  groupingReport,
  isSentence,
  isShortName,
  labelPlacement,
  namesAreAmbiguous,
  normaliseName,
  SPLIT_FIELD_RULE,
  UNASSOCIATED_LABEL_RULE,
  UNGROUPED_CONTROLS_RULE,
} from './grouping.js';

const config = defaultConfig.grouping;
const BODY: TextStyle = { family: 'arial', size: 16, weight: 400, color: '#1a1a1a', transform: 'none', italic: false };

/**
 * A page written by hand, top to bottom: texts, controls and the containers around them get
 * positions as a walk of the document would give them. No browser is involved.
 */
class Page {
  controls: GroupingControl[] = [];
  blocks: GroupingBlock[] = [];
  groups: GroupingGroup[] = [];
  containers: Record<string, string> = {};
  private ord = 0;
  private y = 0;
  private open: { ord: number; end: number; group: number }[] = [];
  private chains: { control: number; holders: { ord: number; end: number }[] }[] = [];
  form = 0;

  /** Opens an element; with a role it is a container of the accessibility tree. Close it with `end()`. */
  begin(id: string, role = '', name = ''): this {
    const holder = { ord: this.ord++, end: 0, group: -1 };
    this.containers[String(holder.ord)] = `#${id}`;
    if (role !== '') {
      holder.group = this.groups.length;
      this.groups.push({ selector: `#${id}`, frame: '', ord: holder.ord, end: 0, role, name });
    }
    this.open.push(holder);
    return this;
  }

  end(): this {
    const holder = this.open.pop()!;
    holder.end = this.ord - 1;
    if (holder.group >= 0) this.groups[holder.group]!.end = holder.end;
    return this;
  }

  /** A line of text of its own. Returns its index. */
  text(text: string, over: Partial<GroupingBlock> = {}): number {
    const box: Box = { x: 32, y: this.y, width: 300, height: 18 };
    this.y += 24;
    this.blocks.push({
      frame: '',
      at: this.ord,
      end: this.ord,
      text,
      chars: text.replace(/\s/g, '').length,
      words: text.split(/\s+/).filter(Boolean).length,
      lines: 1,
      box,
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
    return this.blocks.length - 1;
  }

  /** The legend of the container that was opened last. */
  legend(text: string): number {
    return this.text(text, { free: false, group: this.open[this.open.length - 1]!.group });
  }

  /** A control on a line of its own, with its label after it when `label` is given. Returns its index. */
  control(kind: GroupingControl['kind'], name: string, over: Partial<GroupingControl> = {}, label: string | null = name): number {
    const index = this.controls.length;
    const ord = this.ord++;
    this.controls.push({
      selector: `#c${index}`,
      frame: '',
      ord,
      chain: [],
      box: { x: 32, y: this.y, width: kind === 'field' ? 160 : 16, height: kind === 'field' ? 28 : 16 },
      kind,
      role: kind === 'field' ? 'textbox' : kind,
      element: kind === 'field' ? 'input:text' : `input:${kind}`,
      name,
      description: '',
      setKey: '',
      form: this.form,
      region: '',
      cell: -1,
      inWidget: false,
      fontSize: 16,
      rtl: false,
      ...over,
    });
    this.chains.push({ control: index, holders: [...this.open].reverse() });
    if (label !== null && label !== '') this.text(label, { free: false, labels: [index], box: { x: 56, y: this.y, width: 200, height: 18 } });
    else this.y += 24;
    return index;
  }

  radios(name: string, options: string[], over: Partial<GroupingControl> = {}): number[] {
    return options.map((option) => this.control('radio', option, { setKey: `n:0:${this.form}:${name}`, ...over }));
  }

  checkboxes(options: string[], over: Partial<GroupingControl> = {}): number[] {
    return options.map((option) => this.control('checkbox', option, over));
  }

  /** Fields side by side on one row, 8 px apart; `labelled` says which of them have a visible label, set above them. */
  row(names: string[], over: Partial<GroupingControl> = {}, labelled: boolean[] = []): number[] {
    const y = this.y + (labelled.some(Boolean) ? 24 : 0);
    const indexes = names.map((name, at) => {
      const x = 32 + at * 68;
      if (labelled[at]) this.text(name, { free: false, labels: [this.controls.length], box: { x, y: y - 24, width: 60, height: 18 } });
      this.y = y;
      return this.control('field', name, { box: { x, y, width: 60, height: 28 }, ...over }, null);
    });
    this.y = y + 40;
    return indexes;
  }

  gap(px: number): this {
    this.y += px;
    return this;
  }

  survey(over: Partial<GroupingSurvey> = {}): GroupingSurvey {
    while (this.open.length > 0) this.end();
    for (const { control, holders } of this.chains) {
      const own = this.controls[control]!;
      own.chain = [own.ord, own.ord, ...holders.flatMap((holder) => [holder.ord, holder.end])];
    }
    return {
      controls: this.controls,
      totalControls: this.controls.length,
      groups: this.groups,
      blocks: this.blocks,
      totalBlocks: this.blocks.length,
      axComplete: true,
      containers: this.containers,
      captures: {},
      ...over,
    };
  }
}

const report = (page: Page, input: Partial<GroupingConfig> = {}, over: Partial<GroupingSurvey> = {}) =>
  groupingReport(page.survey(over), resolveConfig({ grouping: input }).grouping);
const summary = (page: Page, input: Partial<GroupingConfig> = {}, over: Partial<GroupingSurvey> = {}) =>
  report(page, input, over).candidates.map((candidate) => `${candidate.status} ${candidate.rule} ${candidate.selector}`);

describe('names', () => {
  it('compares names without case, white space, the colon of a label and the asterisk of a required field', () => {
    expect(normaliseName('  Date de  naissance * :', config)).toBe('date de naissance');
    expect(normaliseName('* Email：', config)).toBe('email');
    expect(normaliseName('Ｆｕｌｌ ｗｉｄｔｈ', config)).toBe('full width');
    // A pattern that does not compile takes nothing but white space off.
    expect(normaliseName(' A: ', { nameTrimPattern: '(' })).toBe('a:');
  });
  it('calls a name short by its words and its characters, in any language', () => {
    for (const name of ['yes', 'non', 'not sure', 'はい', '', '18-25']) expect(isShortName(name, config), name).toBe(true);
    for (const name of ['i agree to the terms', 'a vegetarian meal', 'internationalisation-localisation']) expect(isShortName(name, config), name).toBe(false);
  });
  it('calls the names of a set ambiguous from half of them', () => {
    expect(namesAreAmbiguous(['yes', 'no'], config)).toBe(true);
    expect(namesAreAmbiguous(['none', 'student', 'one year, paid monthly', 'two years, paid at once'], config)).toBe(true);
    expect(namesAreAmbiguous(['none', 'by email, within two days', 'by phone, within the hour'], config)).toBe(false);
    expect(namesAreAmbiguous([], config)).toBe(false);
  });
  it('tells a sentence of prose from a question and a title, by its end and its length', () => {
    for (const text of ['Add the disabled attribute and the labels are styled to match.', 'Select all that apply.', 'Choisissez une option !', '複数選択できます。 はい。 どうぞ。', 'Wait for it…', 'See the note (below).']) {
      expect(isSentence(text, config), text).toBe(true);
    }
    for (const text of ['Do you have a car?', 'Avez-vous déjà un compte ?', 'Civilité :', 'Date of birth', 'Tél.', 'No. 2', 'Size (cm)']) {
      expect(isSentence(text, config), text).toBe(false);
    }
    // A pattern that does not compile holds nothing back.
    expect(isSentence('One two three.', { labelSentenceEndPattern: '(', labelSentenceMinWords: 3 })).toBe(false);
  });
  it('finds a text in a name as whole words only', () => {
    expect(containsWords('seat window', 'seat')).toBe(true);
    expect(containsWords('window seat', 'seat')).toBe(true);
    expect(containsWords('a seat here', 'seat')).toBe(true);
    expect(containsWords('seat', 'seat')).toBe(true);
    expect(containsWords('seating', 'seat')).toBe(false);
    expect(containsWords('apple', 'a')).toBe(false);
    expect(containsWords('seat', '')).toBe(false);
  });
});

describe('geometry', () => {
  const set: Box = { x: 32, y: 100, width: 200, height: 48 };
  const first: Box = { x: 32, y: 100, width: 200, height: 20 };
  it('takes a text for a label up to three font sizes above the set', () => {
    const above = (gap: number): Box => ({ x: 32, y: 100 - gap - 18, width: 120, height: 18 });
    expect(labelPlacement(above(8), set, first, 16, config)).toBe('above');
    expect(labelPlacement(above(48), set, first, 16, config)).toBe('above');
    expect(labelPlacement(above(49), set, first, 16, config)).toBe('far');
    // Above, but not over the set.
    expect(labelPlacement({ x: 400, y: 70, width: 100, height: 18 }, set, first, 16, config)).toBe('far');
  });
  it('takes a text for a label beside the first control, up to twenty font sizes away', () => {
    expect(labelPlacement({ x: 0, y: 101, width: 100, height: 18 }, { ...set, x: 420 }, { ...first, x: 420 }, 16, config)).toBe('beside');
    expect(labelPlacement({ x: 0, y: 101, width: 99, height: 18 }, { ...set, x: 420 }, { ...first, x: 420 }, 16, config)).toBe('far');
    // A text that wraps the controls is beside them.
    expect(labelPlacement({ x: 32, y: 100, width: 400, height: 20 }, set, first, 16, config)).toBe('beside');
  });
  it('takes two fields for parts of one up to two font sizes apart on one row', () => {
    const a: Box = { x: 0, y: 0, width: 60, height: 28 };
    expect(besideEachOther(a, { x: 92, y: 0, width: 60, height: 28 }, 16, config)).toBe(true);
    expect(besideEachOther(a, { x: 93, y: 0, width: 60, height: 28 }, 16, config)).toBe(false);
    expect(besideEachOther(a, { x: 68, y: 40, width: 60, height: 28 }, 16, config)).toBe(false);
    expect(besideEachOther({ x: 68, y: 0, width: 60, height: 28 }, a, 16, config)).toBe(true);
  });
});

describe('sets of radios and checkboxes', () => {
  const question = (build: (page: Page) => void): Page => {
    const page = new Page();
    page.begin('form');
    build(page);
    return page;
  };
  const plain = (): Page =>
    question((page) => {
      page.begin('q');
      page.text('Do you have a car?');
      page.radios('car', ['Yes', 'No']);
      page.end();
    });

  it('reports a set under a text that nothing ties to it as likely, on the element that holds both', () => {
    const [candidate] = report(plain()).candidates;
    expect(candidate).toMatchObject({ status: 'likely', rule: UNASSOCIATED_LABEL_RULE, selector: '#q', label: 'Do you have a car?', names: ['Yes', 'No'], controls: 2, adjudicate: true });
    expect(candidate!.flags).toEqual(['radios']);
    expect(candidate!.context).toMatchObject({ controls: 'radio buttons', visibleText: 'Do you have a car?', controlNames: ['Yes', 'No'], textIs: 'text' });
  });
  it('asks the collector for the selector of that element first, and names the first control until it has it', () => {
    const [candidate] = groupingReport({ ...plain().survey(), containers: {} }, config).candidates;
    // The element opened second: after the form.
    expect(candidate).toMatchObject({ selector: '#c0', container: 1 });
  });
  it('reports nothing for a fieldset with a legend, a named group, or a group named from outside', () => {
    expect(
      summary(
        question((page) => {
          page.begin('fs', 'group', 'Do you have a car?');
          page.legend('Do you have a car?');
          page.radios('car', ['Yes', 'No']);
        }),
      ),
    ).toEqual([]);
    expect(
      summary(
        question((page) => {
          page.text('Toppings');
          page.begin('g', 'group', 'Toppings');
          page.checkboxes(['Cheese', 'Ham']);
        }),
      ),
    ).toEqual([]);
    // A hint of its own inside a fieldset that holds the set and nothing else.
    expect(
      summary(
        question((page) => {
          page.begin('fs', 'group', 'Size');
          page.legend('Size');
          page.text('Choose one.');
          page.radios('size', ['Small', 'Large']);
        }),
      ),
    ).toEqual([]);
  });
  it('still reports a set with a text of its own inside a group that holds much else, or inside a group without a name', () => {
    const larger = question((page) => {
      page.begin('fs', 'group', 'Your order');
      page.legend('Your order');
      page.control('field', 'Name');
      page.control('field', 'Email');
      page.gap(24);
      page.begin('gift');
      page.text('Gift receipt?');
      page.radios('gift', ['Yes', 'No']);
    });
    expect(report(larger).candidates[0]).toMatchObject({ status: 'likely', selector: '#gift', flags: ['radios', 'inLargerGroup'] });
    // One other control is still the same group ("Other: ___").
    const one = question((page) => {
      page.begin('fs', 'group', 'Colour');
      page.legend('Colour');
      page.text('Pick one');
      page.radios('colour', ['Red', 'Blue']);
      page.control('field', 'Other');
    });
    expect(summary(one)).toEqual([]);
    const unnamed = question((page) => {
      page.begin('fs', 'group', '');
      page.text('Language');
      page.radios('lang', ['English', 'French']);
    });
    expect(report(unnamed).candidates[0]).toMatchObject({ status: 'likely', selector: '#fs', flags: ['radios', 'unnamedGroup'] });
  });
  it('reports nothing when the question is in the name of every option, and nothing when it is their description', () => {
    expect(
      summary(
        question((page) => {
          page.text('Seat');
          page.control('radio', 'Seat Window', { setKey: 'n:0:0:seat' }, 'Window');
          page.control('radio', 'Seat Aisle', { setKey: 'n:0:0:seat' }, 'Aisle');
        }),
      ),
    ).toEqual([]);
    expect(
      summary(
        question((page) => {
          page.text('Preferred time', { free: false, describes: true });
          page.radios('time', ['Morning', 'Evening']);
        }),
      ),
    ).toEqual([]);
  });
  it('is advisory under a heading or a button that opens the set, for switches, and for names that stand on their own', () => {
    const under = (over: Partial<GroupingBlock>, names = ['Standard', 'Express']): Page =>
      question((page) => {
        page.begin('q');
        page.text('Shipping', over);
        page.radios('ship', names);
      });
    expect(report(under({ heading: 3 })).candidates[0]).toMatchObject({ status: 'advisory', rule: UNGROUPED_CONTROLS_RULE, adjudicate: false, flags: ['radios', 'headingLabel'] });
    expect(report(under({ disclosure: true, contexts: ['button'] })).candidates[0]).toMatchObject({ status: 'advisory', flags: ['radios', 'disclosureLabel'] });
    expect(report(under({}, ['Standard delivery in five days', 'Express delivery the next day'])).candidates[0]).toMatchObject({
      status: 'advisory',
      adjudicate: false,
      flags: ['radios', 'selfExplanatory'],
    });
    const switches = question((page) => {
      page.begin('q');
      page.text('Connections');
      page.checkboxes(['Wi-Fi', 'Bluetooth'], { switch: true, role: 'switch' });
    });
    expect(report(switches).candidates[0]).toMatchObject({ status: 'advisory', flags: ['checkboxes', 'switches'] });
  });
  it('takes the status under a heading from the configuration, and never makes it a fail', () => {
    const page = (): Page =>
      question((own) => {
        own.text('Shipping', { heading: 2 });
        own.radios('ship', ['Standard', 'Express']);
      });
    expect(report(page(), { headingLabelStatus: 'likely' }).candidates[0]!.status).toBe('likely');
    expect(report(page(), { headingLabelStatus: 'fail' as never }).candidates[0]!.status).toBe('likely');
    expect(report(page(), { headingLabelStatus: 'nonsense' as never }).candidates[0]!.status).toBe('advisory');
    expect(resolveConfig({ grouping: { headingLabelStatus: 'fail' as never } }).grouping.headingLabelStatus).toBe('likely');
    // Also when the configuration did not go through resolveConfig.
    expect(groupingReport(page().survey(), { ...config, headingLabelStatus: 'fail' as never }).candidates[0]!.status).toBe('likely');
  });
  it('holds a set back as info when the text is far, long, or closer to the control before it', () => {
    const far = question((page) => {
      page.begin('q');
      page.text('Do you smoke?');
      page.gap(60);
      page.radios('s', ['Yes', 'No']);
    });
    expect(report(far).candidates[0]).toMatchObject({ status: 'info', rule: GROUP_CANDIDATE_RULE, reasons: ['labelFar'], adjudicate: true });
    const long = question((page) => {
      page.text('x'.repeat(161));
      page.radios('s', ['Yes', 'No']);
    });
    expect(report(long).candidates[0]).toMatchObject({ status: 'info', reasons: ['labelLong'], adjudicate: true });
    expect(report(long, { labelMaxChars: 161 }).candidates[0]).toMatchObject({ status: 'likely' });
    const hint = question((page) => {
      page.control('field', 'Email', {}, null);
      page.gap(6);
      page.text('Minimum 8 characters');
      page.gap(24);
      page.checkboxes(['Orders', 'Offers']);
    });
    expect(report(hint).candidates[0]).toMatchObject({ status: 'info', reasons: ['labelNearerPrevious'], adjudicate: true });
  });
  it('holds a set back under a sentence of prose, and passes over code and punctuation', () => {
    const prose = question((page) => {
      page.text('Add the disabled attribute and the labels are styled to match.');
      page.radios('d', ['Disabled radio', 'Checked radio']);
    });
    expect(report(prose).candidates[0]).toMatchObject({ status: 'info', reasons: ['labelSentence'], adjudicate: true });
    // A question is no sentence of prose.
    const asked = question((page) => {
      page.text('Would you like a receipt with your order?');
      page.radios('d', ['Yes', 'No']);
    });
    expect(report(asked).candidates[0]).toMatchObject({ status: 'likely' });
    // Code shown before the controls is passed over; a colon on its own does not even count as passed over.
    const code = question((page) => {
      page.begin('q');
      page.text('Colour');
      page.text('<input type="radio">', { contexts: ['code'] });
      page.text('<input type="radio">', { contexts: ['code'] });
      for (let index = 0; index < 4; index++) page.text(':');
      page.gap(-144);
      page.radios('c', ['Red', 'Blue']);
    });
    expect(report(code).candidates[0]).toMatchObject({ status: 'likely', label: 'Colour' });
  });
  it('holds a set back when a container that holds it has the words of the text as its name, and a model is not asked', () => {
    const region = question((page) => {
      page.begin('region', 'region', 'Notifications');
      page.text('Notifications');
      page.checkboxes(['Email', 'Push']);
    });
    expect(report(region).candidates[0]).toMatchObject({ status: 'info', reasons: ['labelNamesContainer'], adjudicate: false });
  });
  it('finds no label across another control, across the label of one, or past more than two hints', () => {
    expect(
      summary(
        question((page) => {
          page.text('Password');
          page.control('field', 'Password', {}, null);
          page.checkboxes(['Remember me', 'Send updates']);
        }),
      ),
    ).toEqual([]);
    expect(
      summary(
        question((page) => {
          page.text('Country', { free: false, otherLabel: true });
          page.radios('x', ['Yes', 'No']);
        }),
      ),
    ).toEqual([]);
    const hints = (count: number): Page =>
      question((page) => {
        page.text('Question?');
        for (let index = 0; index < count; index++) page.text('A hint.', { free: false, describes: true });
        page.gap(-24 * count);
        page.radios('x', ['Yes', 'No']);
      });
    expect(summary(hints(2))).toHaveLength(1);
    expect(summary(hints(3))).toEqual([]);
    // Text hidden from assistive technology, and the text of a link, are no labels.
    expect(
      summary(
        question((page) => {
          page.text('Hidden', { contexts: ['ariaHidden'] });
          page.text('Clear all', { contexts: ['link'] });
          page.gap(-48);
          page.radios('x', ['Yes', 'No']);
        }),
      ),
    ).toEqual([]);
  });
  it('cuts checkboxes that follow each other into sets where a text starts a new one', () => {
    const page = question((own) => {
      own.begin('a');
      own.text('How should we contact you?');
      own.checkboxes(['Email', 'SMS', 'Post']);
      own.end();
      own.gap(24);
      own.begin('b');
      own.text('Topics');
      own.checkboxes(['News', 'Offers']);
    });
    expect(summary(page)).toEqual([`likely ${UNASSOCIATED_LABEL_RULE} #a`, `likely ${UNASSOCIATED_LABEL_RULE} #b`]);
  });
  it('leaves out one control alone, controls in table cells and controls of a composite widget, and counts them', () => {
    const page = question((own) => {
      own.text('Terms');
      own.checkboxes(['I agree']);
      own.text('How satisfied are you?');
      own.radios('m1', ['Poor', 'Good'], { cell: 40 });
      own.text('Alignment');
      own.control('radio', 'Left', { inWidget: true });
      own.control('radio', 'Right', { inWidget: true });
    });
    const result = report(page);
    expect(result.candidates).toEqual([]);
    expect(result).toMatchObject({ sets: 0, controlsInTables: 2, controlsInWidgets: 2 });
  });
  it('reports nothing above info, and asks no model, when the accessibility tree was not read in full', () => {
    const [candidate] = report(plain(), {}, { axComplete: false }).candidates;
    expect(candidate).toMatchObject({ status: 'info', rule: GROUP_CANDIDATE_RULE, adjudicate: false });
    expect(candidate!.flags).toContain('axIncomplete');
  });
  it('keeps the id of a set when its status changes', () => {
    const near = report(plain()).candidates[0]!;
    const far = report(
      question((page) => {
        page.begin('q');
        page.text('Do you have a car?');
        page.gap(80);
        page.radios('car', ['Yes', 'No']);
      }),
    ).candidates[0]!;
    expect([near.status, far.status]).toEqual(['likely', 'info']);
    expect(far.findingId).toBe(near.findingId);
    expect(far.rule).not.toBe(near.rule);
  });
});

describe('fields side by side', () => {
  const form = (build: (page: Page) => void): Page => {
    const page = new Page();
    page.begin('form');
    build(page);
    return page;
  };
  it('is likely when two parts have one name', () => {
    const page = form((own) => {
      own.begin('row');
      own.row(['Sort code', 'Sort code']);
    });
    expect(report(page).candidates[0]).toMatchObject({ status: 'likely', rule: SPLIT_FIELD_RULE, selector: '#row', flags: ['fields', 'duplicateNames'], adjudicate: false });
  });
  it('leaves two fields alone that each have a visible label with the same words', () => {
    const page = form((own) => {
      own.row(['Input Label', 'Input Label'], {}, [true, true]);
    });
    expect(summary(page)).toEqual([]);
  });
  it('is likely when a part has no name and a label stands for the row', () => {
    const tied = form((own) => {
      own.gap(24);
      own.begin('row');
      own.row(['Date of birth', '', ''], {}, [true]);
    });
    expect(report(tied).candidates[0]).toMatchObject({ status: 'likely', flags: ['fields', 'unnamedPart'] });
    const text = form((own) => {
      own.begin('row');
      own.text('Card security');
      own.row(['', '']);
    });
    expect(report(text).candidates[0]).toMatchObject({ status: 'likely', selector: '#row', label: 'Card security', flags: ['fields', 'unnamedPart'] });
  });
  it('is likely when a part is named like the text over the row', () => {
    const page = form((own) => {
      own.text('Expiry date');
      own.row(['Expiry date', 'Year']);
    });
    expect(report(page).candidates[0]).toMatchObject({ status: 'likely', flags: ['fields', 'namedAsWhole'] });
  });
  it('reports nothing for fields without names and without any label: that is for a rule engine', () => {
    const page = form((own) => {
      own.row(['', 'Search']);
    });
    expect(summary(page)).toEqual([]);
  });
  it('is advisory when each part has a name and a plain text stands over the row, and nothing in a named group', () => {
    const free = form((own) => {
      own.begin('row');
      own.text('Date of arrival');
      own.row(['Day', 'Month', 'Year']);
    });
    expect(report(free).candidates[0]).toMatchObject({ status: 'advisory', rule: UNGROUPED_CONTROLS_RULE, selector: '#row', flags: ['fields'] });
    const grouped = form((own) => {
      own.begin('fs', 'group', 'Date of issue');
      own.legend('Date of issue');
      own.row(['Day', 'Month', 'Year']);
    });
    expect(summary(grouped)).toEqual([]);
    const heading = form((own) => {
      own.text('Date of arrival', { heading: 2 });
      own.row(['Day', 'Month', 'Year']);
    });
    expect(summary(heading)).toEqual([]);
  });
  it('takes fields too far apart, in different cells or too many in a row for fields of their own', () => {
    const apart = form((own) => {
      own.control('field', 'Bank code', { box: { x: 0, y: 0, width: 60, height: 28 } }, null);
      own.control('field', 'Bank code', { box: { x: 100, y: 0, width: 60, height: 28 } }, null);
    });
    expect(summary(apart)).toEqual([]);
    const cells = form((own) => {
      own.control('field', 'Quantity', { box: { x: 0, y: 0, width: 60, height: 28 }, cell: 5 }, null);
      own.control('field', 'Quantity', { box: { x: 68, y: 0, width: 60, height: 28 }, cell: 6 }, null);
    });
    expect(summary(cells)).toEqual([]);
    const many = form((own) => {
      own.row(['A', 'A', 'A', 'A', 'A', 'A', 'A']);
    });
    expect(summary(many)).toEqual([]);
  });
});

describe('sections with the same field names', () => {
  const sections = (build: (page: Page) => void): Page => {
    const page = new Page();
    page.begin('form');
    build(page);
    return page;
  };
  const address = (page: Page, id: string, title: string, over: Partial<GroupingBlock> = {}, names = ['Street', 'City']): void => {
    page.text(title, over);
    page.begin(id);
    for (const name of names) page.control('field', name);
    page.end();
    page.gap(24);
  };
  it('reports the second of two sections whose fields have the same names, as likely', () => {
    const page = sections((own) => {
      address(own, 'billing', 'Billing address');
      address(own, 'delivery', 'Delivery address');
    });
    const [candidate] = report(page).candidates;
    expect(candidate).toMatchObject({ status: 'likely', rule: DUPLICATE_NAMES_RULE, selector: '#delivery', names: ['City', 'Street'], adjudicate: false });
    expect(candidate!.values).toMatchObject({ sections: 2, sharedNames: 2, firstSection: '#c0' });
  });
  it('holds sections back as info when the fields are in no form', () => {
    const page = sections((own) => {
      own.form = -1;
      address(own, 'one', 'Form grid');
      address(own, 'two', 'Gutters');
    });
    const [candidate] = report(page).candidates;
    expect(candidate).toMatchObject({ status: 'info', rule: GROUP_CANDIDATE_RULE, selector: '#two', adjudicate: false });
    expect(candidate!.flags).toContain('noForm');
  });
  it('is advisory when each section stands under a heading', () => {
    const page = sections((own) => {
      address(own, 'billing', 'Billing address', { heading: 2 });
      address(own, 'delivery', 'Delivery address', { heading: 2 });
    });
    expect(report(page).candidates[0]).toMatchObject({ status: 'advisory', flags: ['fields', 'headingLabel'] });
  });
  it('reports nothing when named groups, descriptions or the names themselves tell the sections apart', () => {
    const grouped = sections((own) => {
      for (const title of ['Billing address', 'Delivery address']) {
        own.begin(title, 'group', title);
        own.legend(title);
        own.control('field', 'Street');
        own.control('field', 'City');
        own.end();
      }
    });
    expect(summary(grouped)).toEqual([]);
    const described = sections((own) => {
      for (const title of ['Billing', 'Delivery']) {
        own.text(title, { free: false, describes: true });
        own.control('field', 'Street', { description: title });
        own.control('field', 'City', { description: title });
      }
    });
    expect(summary(described)).toEqual([]);
    const distinct = sections((own) => {
      address(own, 'billing', 'Billing address', {}, ['Billing street', 'Billing city']);
      address(own, 'delivery', 'Delivery address', {}, ['Delivery street', 'Delivery city']);
    });
    expect(summary(distinct)).toEqual([]);
  });
  it('needs two names in common, one form, and fields outside tables', () => {
    const one = sections((own) => {
      address(own, 'a', 'Email', {}, ['Email']);
      address(own, 'b', 'Confirm', {}, ['Email']);
    });
    expect(summary(one)).toEqual([]);
    expect(summary(one, { duplicateMinShared: 1 })).toHaveLength(1);
    const forms = sections((own) => {
      address(own, 'login', 'Sign in', {}, ['Email', 'Password']);
      own.form = 1;
      address(own, 'register', 'Create an account', {}, ['Email', 'Password']);
    });
    expect(summary(forms)).toEqual([]);
    const table = sections((own) => {
      for (const cell of [10, 20]) {
        own.control('field', 'First name', { cell }, null);
        own.control('field', 'Last name', { cell: cell + 1 }, null);
      }
    });
    expect(summary(table)).toEqual([]);
  });
  it('says a row of parts once, with its sections, when the names of two dates are the same', () => {
    const page = sections((own) => {
      own.text('From');
      own.begin('from');
      own.row(['Day', 'Month', 'Year']);
      own.end();
      own.text('To');
      own.begin('to');
      own.row(['Day', 'Month', 'Year']);
    });
    expect(summary(page)).toEqual([`likely ${DUPLICATE_NAMES_RULE} #to`]);
  });
});

describe('the report as a whole', () => {
  const many = (count: number): Page => {
    const page = new Page();
    page.begin('form');
    for (let index = 0; index < count; index++) {
      page.begin(`q${index}`);
      page.text(`Question ${index}?`);
      page.radios(`q${index}`, ['Yes', 'No']);
      page.end();
      page.gap(24);
    }
    return page;
  };
  it('is the same twice, lists likely findings first and in document order, and is bounded', () => {
    const page = many(6);
    const survey = page.survey();
    expect(groupingReport(survey, config)).toEqual(groupingReport(survey, config));
    const bounded = groupingReport(survey, { ...config, maxCandidates: 4 });
    expect(bounded.candidates.map((candidate) => candidate.selector)).toEqual(['#q0', '#q1', '#q2', '#q3']);
    expect(bounded.omitted).toBe(2);
    expect(bounded.sets).toBe(6);
  });
  it('never gives a fail, whatever is configured', () => {
    const statuses = new Set<string>();
    for (const headingLabelStatus of ['fail', 'likely', 'advisory', 'info', undefined]) {
      const page = many(2);
      page.text('Shipping', { heading: 2 });
      page.radios('ship', ['Standard', 'Express']);
      page.row(['Sort code', 'Sort code']);
      for (const candidate of report(page, { headingLabelStatus: headingLabelStatus as never }).candidates) statuses.add(candidate.status);
    }
    expect([...statuses].sort()).toEqual(['advisory', 'likely']);
  });
  it('gives each finding an id of its own', () => {
    const ids = report(many(5)).candidates.map((candidate) => candidate.findingId);
    expect(new Set(ids).size).toBe(5);
  });
});
