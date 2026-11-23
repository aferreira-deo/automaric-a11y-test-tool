import { describe, expect, it } from 'vitest';
import { defaultConfig, resolveConfig } from '../config.js';
import { runChecks } from '../run.js';
import type { Box, ListBlock, ListElement, ListGroup, ListGroupItem, ListMarker, ListSurvey, Snapshot, TextStyle } from '../types.js';
import { classifyLineStart, listReport, regularLayout, stackedLines } from './lists.js';

const config = defaultConfig.lists;
const BODY: TextStyle = { family: 'arial', size: 16, weight: 400, color: '#1a1a1a', transform: 'none', italic: false };
const BOLD: TextStyle = { ...BODY, weight: 700 };

/** A page as a tree: elements with children, and leaves that hold one block of text (one string per line). */
interface Sketch {
  id?: string;
  lines?: string[];
  marker?: ListMarker;
  children?: Sketch[];
  over?: Partial<ListBlock>;
  /** Left edge and top of the block, when it is not simply stacked under the one before. */
  at?: { x: number; y: number; width?: number };
}

function surveyOf(root: Sketch, more: Partial<ListSurvey> = {}): ListSurvey {
  const blocks: ListBlock[] = [];
  const containers: Record<string, string> = {};
  let ord = 0;
  let row = 0;
  /** The chain of each block as pairs that are still being filled in: the last positions are known at the end. */
  const chains: [number, [number, number][]][] = [];
  const walk = (node: Sketch, ancestors: [number, number][]): [number, number] => {
    const own: [number, number] = [ord++, 0];
    const index = blocks.length;
    if (node.id) containers[String(own[0])] = `#${node.id}`;
    if (node.lines) {
      const x = node.at?.x ?? 32;
      const y = node.at?.y ?? row * 24;
      row += node.lines.length;
      const width = node.at?.width ?? 300;
      const line = (at: number): Box => ({ x, y: y + at * 24, width, height: 20 });
      const text = node.lines.join(' ');
      blocks.push({
        selector: node.id ? `#${node.id}` : `div:nth-of-type(${index + 1})`,
        frame: '',
        tag: 'div',
        text,
        chars: text.replace(/\s/g, '').length,
        words: text.split(/\s+/).filter(Boolean).length,
        box: { x, y, width, height: node.lines.length * 24 - 4 },
        lines: node.lines.length,
        firstLine: line(0),
        style: BODY,
        contexts: [],
        inList: false,
        heading: false,
        rtl: false,
        chain: [],
        segments: node.lines.map((start, at) => ({ start, box: line(at), end: start.slice(-config.lineEndChars), ...(node.marker ? { marker: node.marker } : {}) })),
        ...node.over,
      });
    }
    for (const child of node.children ?? []) walk(child, [own, ...ancestors]);
    own[1] = ord - 1;
    if (node.lines) chains.push([index, [own, ...ancestors]]);
    return own;
  };
  walk(root, []);
  for (const [index, pairs] of chains) blocks[index]!.chain = pairs.flat();
  return { blocks, totalBlocks: blocks.length, groups: [], totalGroups: 0, parents: 0, totalParents: 0, lists: [], totalLists: 0, exposedLists: 0, axComplete: true, containers, captures: {}, ...more };
}

const leaf = (text: string, over: Partial<Sketch> = {}): Sketch => ({ lines: [text], ...over });
const listOf = (id: string, texts: string[], over: Partial<Sketch> = {}): Sketch => ({ id, children: texts.map((text) => leaf(text, over)) });
const page = (...children: Sketch[]): Sketch => ({ children: [leaf('A paragraph of plain text before everything else.'), ...children, leaf('A paragraph of plain text after everything else.')] });
const report = (root: Sketch, more: Partial<ListSurvey> = {}, input = config) => listReport(surveyOf(root, more), input);
/** For sketches that give their own segments (`over.segments`): the box of each line is where the sketch stacked its block. */
const placed = (survey: ListSurvey): ListSurvey => {
  for (const block of survey.blocks) if (block.segments.length === 1) block.segments[0]!.box = block.firstLine;
  return survey;
};
const summary = (root: Sketch, more: Partial<ListSurvey> = {}, input = config) =>
  report(root, more, input).candidates.map((candidate) => `${candidate.status} ${candidate.rule.replace('lists/', '')} ${candidate.selector} [${candidate.flags.join(',')}]`);

describe('classifyLineStart', () => {
  const kind = (text: string): string => {
    const mark = classifyLineStart(text, config);
    return mark ? `${mark.class}${mark.weak ? ' weak' : ''}` : 'none';
  };
  it('reads bullets, whatever the script of the text', () => {
    for (const text of ['• flour', '◦ flour', '▪ flour', '■ flour', '→ flour', '✓ flour', '✔ done', '★ flour', '・小麦粉', '※ 注意', '● الطحين']) {
      expect(kind(text), text).toBe('bullet');
    }
  });
  it('reads hyphens, dashes and asterisks as weak bullets', () => {
    for (const text of ['- flour', '– farine', '* flour', '· flour', '> flour', '» farine', '› farine']) expect(kind(text), text).toBe('bullet weak');
  });
  it('leaves the em dash of a dialogue, and symbols that are not bullets, alone', () => {
    for (const text of ['— Vous partez ?', '― Bonjour', '« Bonjour »', '# title', '@name hello', '$ 20', '© 2026 Company', '+ 33 1 23 45', '| Home', '/ Shop']) {
      expect(kind(text), text).toBe('none');
    }
  });
  it('does not take a figure after a hyphen for an item', () => {
    for (const text of ['- 20 %', '- 3,50 €', '-20%', '- 15', '* 4.5']) expect(kind(text), text).toBe('none');
    expect(kind('- 2 œufs frais')).toBe('bullet weak');
  });
  it('reads numbers, letters and numerals with what closes them', () => {
    for (const text of ['1. one', '2) two', '(3) three', '10. ten', '1.2. sub', '4/ four', '1° premier', '١. الطحين', '१. एक', 'a) one', '(b) two', 'C. three', 'ii. two', '(IV) four', '一、小麦粉', '①小麦粉', '❷ two']) {
      expect(kind(text), text).toBe('number');
    }
  });
  it('needs something to close a number, and text after it', () => {
    for (const text of ['1 one', '2026 was a busy year', '12:30 lunch', '3.5 kg of flour', '1.', 'a)', '12.05.2026', 'AB. two letters', 'www.example.org']) {
      expect(kind(text), text).toBe('none');
    }
  });
  it('takes a bullet or a number alone in its box when text follows on its line', () => {
    expect(classifyLineStart('•', config, true)?.class).toBe('bullet');
    expect(classifyLineStart('1.', config, true)?.class).toBe('number');
    expect(classifyLineStart('No', config, true)).toBeNull();
  });
});

describe('layout', () => {
  const box = (x: number, y: number, width = 100, height = 40): Box => ({ x, y, width, height });
  it('takes a row, a column and a grid with even gaps for a series', () => {
    expect(regularLayout([box(0, 0), box(120, 0), box(240, 0)], config)).toEqual({ rows: 1, columns: 3 });
    expect(regularLayout([box(0, 0), box(0, 60), box(0, 120)], config)).toEqual({ rows: 3, columns: 1 });
    expect(regularLayout([box(0, 0), box(120, 0), box(240, 0), box(0, 60), box(120, 60)], config)).toEqual({ rows: 2, columns: 3 });
  });
  it('takes a row of boxes of different widths that wraps, as a tag cloud does', () => {
    expect(regularLayout([box(0, 0, 50), box(58, 0, 90), box(156, 0, 30), box(0, 48, 70), box(78, 48, 40)], config)).toEqual({ rows: 2, columns: 3 });
  });
  it('refuses uneven gaps, overlapping boxes and rows that start at different edges', () => {
    expect(regularLayout([box(0, 0), box(140, 0), box(420, 0)], config)).toBeNull();
    expect(regularLayout([box(0, 0), box(0, 60), box(0, 200)], config)).toBeNull();
    expect(regularLayout([box(0, 0), box(50, 0), box(100, 0)], config)).toBeNull();
    expect(regularLayout([box(0, 0), box(120, 0), box(37, 60), box(157, 60)], config)).toBeNull();
    expect(regularLayout([box(0, 0), box(40, 60), box(90, 120)], config)).toBeNull();
  });
  it('accepts a column of boxes that are centred, and gaps within the tolerance', () => {
    expect(regularLayout([box(50, 0, 100), box(25, 60, 150), box(60, 120, 80)], config)).toEqual({ rows: 3, columns: 1 });
    expect(regularLayout([box(0, 0), box(120, 0), box(243, 0)], config)).toEqual({ rows: 1, columns: 3 });
  });
  it('wants lines of a list under each other, starting at one edge', () => {
    expect(stackedLines([box(0, 0), box(0, 30)], false, config)).toBe(true);
    expect(stackedLines([box(0, 0), box(120, 0), box(240, 0)], false, config)).toBe(false);
    expect(stackedLines([box(0, 0), box(40, 30)], false, config)).toBe(false);
    // Right to left: the lines end at one edge on the left and start at one on the right.
    expect(stackedLines([box(100, 0, 200), box(200, 30, 100)], true, config)).toBe(true);
    expect(stackedLines([box(100, 0, 200), box(200, 30, 100)], false, config)).toBe(false);
  });
});

describe('lines with bullets or numbers', () => {
  it('reports sibling blocks that each start with a bullet, on the element that holds them', () => {
    expect(summary(page(listOf('list', ['• one', '• two', '• three'])))).toEqual(['likely glyph-list #list [bullet]']);
  });
  it('reports lines of one block separated by line breaks, on the block', () => {
    expect(summary(page({ id: 'p', lines: ['1. one', '2. two', '3. three'] }))).toEqual(['likely glyph-list #p [number,lineBreaks]']);
  });
  it('needs two lines, and three when the bullets are hyphens', () => {
    expect(summary(page(listOf('list', ['• one', 'two'])))).toEqual([]);
    expect(summary(page(listOf('list', ['- one', '- two'])))).toEqual(['info glyph-list-candidate #list [bullet,fewWeakItems]']);
    expect(summary(page(listOf('list', ['- one', '- two', '- three'])))).toEqual(['likely glyph-list #list [bullet]']);
  });
  it('wants numbers that follow each other, from the start of their sequence', () => {
    expect(summary(page(listOf('list', ['3. Rue des Lilas', '17. Rue des Lilas', '42. Rue des Lilas'])))).toEqual([]);
    expect(summary(page(listOf('list', ['12. Mai 2026', '13. Mai 2026', '14. Mai 2026'])))).toEqual(['info glyph-list-candidate #list [number,startsMidSequence,sameWordAfterNumber]']);
    expect(summary(page(listOf('list', ['9. nine', '10. ten', '11. eleven'])))).toEqual(['info glyph-list-candidate #list [number,startsMidSequence]']);
    expect(summary(page(listOf('list', ['1. one', '2. two', '4. four', '5. five'])))[0]).toBe('likely glyph-list #list [number]');
  });
  it('does not mix two ways of numbering in one sequence', () => {
    expect(summary(page(listOf('list', ['1. one', '2) two'])))).toEqual([]);
    expect(summary(page(listOf('list', ['(a) one', 'b) two'])))).toEqual([]);
  });
  it('reads "i." as a roman numeral or as a letter, as the lines after it say', () => {
    const roman = report(page(listOf('list', ['i. one', 'ii. two', 'iii. three']))).candidates[0]!;
    expect(roman.status).toBe('likely');
    expect(roman.values['sequence']).toBe('i. … iii.');
    const letters = report(page(listOf('list', ['h. eight', 'i. nine', 'j. ten']))).candidates[0]!;
    expect(letters.flags).toContain('startsMidSequence');
  });
  it('holds back two lines that open with a letter and a full stop, as initials do', () => {
    expect(summary(page(listOf('list', ['A. Lovelace', 'B. Liskov'])))).toEqual(['info glyph-list-candidate #list [number,fewLetterItems,initialsAndNames]']);
    expect(summary(page(listOf('list', ['a) one', 'b) two'])))).toEqual(['likely glyph-list #list [number]']);
  });
  it('holds back lines that open with different symbols used once each', () => {
    expect(summary(page(listOf('list', ['☎ 04 72 10 30 30', '✉ contact@example.org'])))).toEqual(['info glyph-list-candidate #list [bullet,fewSymbolItems,mixedGlyphs]']);
    expect(summary(page(listOf('list', ['• one', '◦ sub one', '◦ sub two', '• two'])))).toEqual(['likely glyph-list #list [bullet]']);
  });
  it('holds back numbered blocks that each head further text', () => {
    const step = (title: string): Sketch => ({ children: [leaf(title), leaf('A paragraph that says what to do at this step, in a sentence or two.')] });
    expect(summary(page({ id: 'steps', children: [step('1. Register'), step('2. Confirm'), step('3. Sign in')] }))).toEqual([
      'info glyph-list-candidate #steps [number,itemsHeadText]',
    ]);
    const feature = (title: string): Sketch => ({ children: [leaf(title), leaf('A sentence about it.')] });
    expect(summary(page({ id: 'features', children: [feature('✓ Fast'), feature('✓ Private'), feature('✓ Open')] }))).toEqual(['likely glyph-list #features [bullet]']);
    expect(summary(page({ id: 'features', children: [feature('• Fast'), feature('• Private')] }))).toEqual(['likely glyph-list #features [bullet]']);
    // An icon before the title of each panel: the panels are not the items of a list.
    const icon: ListMarker = { kind: 'shape', text: '', key: 'shape|12x12' };
    const panel = (title: string): Sketch => ({ children: [leaf(title, { marker: icon }), leaf('First line of the panel.'), leaf('Second line of the panel.')] });
    expect(summary(page({ id: 'sidebar', children: [panel('Most read'), panel('Most shared'), panel('Most recent')] }))).toEqual(['info glyph-list-candidate #sidebar [shape,itemsHeadText]']);
  });
  it('takes markers that are not characters: generated content, images, shapes, list-item markers', () => {
    const marked = (marker: ListMarker): string[] => summary(page(listOf('list', ['one', 'two', 'three'], { marker })));
    expect(marked({ kind: 'pseudo-text', text: '•', key: '•|arial' })).toEqual(['likely glyph-list #list [bullet,pseudoElement]']);
    expect(marked({ kind: 'pseudo-text', text: '–', key: '–|arial' })).toEqual(['likely glyph-list #list [bullet,pseudoElement]']);
    expect(marked({ kind: 'pseudo-text', text: '', key: 'x|icons' })).toEqual(['likely glyph-list #list [image,pseudoElement]']);
    expect(marked({ kind: 'pseudo-counter', text: '', key: 'counter(step) ". "' })).toEqual(['likely glyph-list #list [counter,pseudoElement]']);
    expect(marked({ kind: 'pseudo-shape', text: '', key: '6x6|rgb(0, 0, 0)' })).toEqual(['likely glyph-list #list [shape,pseudoElement]']);
    expect(marked({ kind: 'image', text: '', key: 'img|8x8|bullet.png' })).toEqual(['likely glyph-list #list [image]']);
    expect(marked({ kind: 'shape', text: '', key: 'shape|6x6' })).toEqual(['likely glyph-list #list [shape]']);
    expect(marked({ kind: 'list-item', text: '', key: 'disc|none' })).toEqual(['likely glyph-list #list [listItemMarker]']);
  });
  it('holds back two lines with the same image or shape before each', () => {
    const pair = (marker: ListMarker): string[] => summary(page(listOf('list', ['Edit this page', 'Create a page'], { marker })));
    expect(pair({ kind: 'image', text: '', key: 'svg|16x16|pencil' })).toEqual(['info glyph-list-candidate #list [image,fewGraphicItems]']);
    expect(pair({ kind: 'pseudo-shape', text: '', key: '6x6' })).toEqual(['info glyph-list-candidate #list [shape,pseudoElement,fewGraphicItems]']);
    // Characters, counters and list-item markers are bullets by nature: two are enough.
    expect(pair({ kind: 'pseudo-text', text: '•', key: '•' })).toEqual(['likely glyph-list #list [bullet,pseudoElement]']);
    expect(pair({ kind: 'list-item', text: '', key: 'disc' })).toEqual(['likely glyph-list #list [listItemMarker]']);
  });
  it('takes generated text that is no bullet for what it is: a word, a quotation mark', () => {
    for (const text of ['New', '“', 'Q:', '|', '/']) {
      expect(summary(page(listOf('list', ['one', 'two'], { marker: { kind: 'pseudo-text', text, key: text } }))), text).toEqual([]);
    }
  });
  it('wants the same image before every line', () => {
    const icon = (key: string): ListMarker => ({ kind: 'image', text: '', key });
    const root = page({ id: 'menu', children: [leaf('Profile', { marker: icon('a') }), leaf('Orders', { marker: icon('b') }), leaf('Settings', { marker: icon('c') })] });
    expect(summary(root)).toEqual([]);
  });
  it('does not report what has list semantics, is a heading, or is hidden from assistive technology', () => {
    expect(summary(page(listOf('list', ['• one', '• two'], { over: { inList: true } })))).toEqual([]);
    expect(summary(page(listOf('list', ['1. Scope', '2. Method'], { over: { heading: true } })))).toEqual([]);
    for (const context of ['ariaHidden', 'code', 'button', 'label', 'term'] as const) {
      expect(summary(page(listOf('list', ['• one', '• two'], { over: { contexts: [context] } }))), context).toEqual([]);
    }
  });
  it('does not take lines in different cells of a table for items, and does take lines inside one cell', () => {
    expect(summary(page(listOf('rows', ['1. Lyon', '2. Paris', '3. Lille'], { over: { contexts: ['tableCell'] } })))).toEqual([]);
    expect(summary(page({ id: 'cell', lines: ['• one', '• two'], over: { contexts: ['tableCell'] } }))).toEqual(['likely glyph-list #cell [bullet,lineBreaks]']);
  });
  it('is advisory inside navigation', () => {
    expect(summary(page(listOf('nav', ['› Delivery', '› Returns', '› Contact'], { over: { contexts: ['link', 'navigation'] } })))).toEqual([
      'advisory glyph-list #nav [bullet,navigation]',
    ]);
  });
  it('does not take bullets side by side on one line for a list: they are separators', () => {
    const row = { id: 'row', children: ['• one', '• two', '• three'].map((text, index) => leaf(text, { at: { x: 32 + index * 120, y: 400 } })) };
    expect(summary(page(row))).toEqual([]);
  });
  it('wants the lines to start at one edge', () => {
    const ragged = { id: 'ragged', children: ['• one', '• two'].map((text, index) => leaf(text, { at: { x: 32 + index * 90, y: 400 + index * 24 } })) };
    expect(summary(page(ragged))).toEqual([]);
  });
  it('only takes a line that is the first text of its item, with nothing else between two items', () => {
    const badge = (text: string): Sketch => ({ children: [leaf('New'), leaf(text)] });
    expect(summary(page({ id: 'cards', children: [badge('• one'), badge('• two')] }))).toEqual([]);
    expect(summary(page({ id: 'mixed', children: [leaf('• one'), leaf('Plain text between'), leaf('• two')] }))).toEqual([]);
  });
  it('names a second series under one element after its first line', () => {
    const root = page({ id: 'both', children: [leaf('• one'), leaf('• two'), leaf('Plain text between'), leaf('• three', { id: 'third' }), leaf('• four')] });
    expect(summary(root)).toEqual(['likely glyph-list #both [bullet]', 'likely glyph-list #third [bullet]']);
  });
  it('names the element that holds the items only once the survey has its selector', () => {
    const survey = surveyOf(page(listOf('list', ['• one', '• two'])));
    survey.containers = {};
    const first = listReport(survey, config).candidates[0]!;
    expect(first.container).not.toBeNull();
    survey.containers[String(first.container)] = '#list';
    const second = listReport(survey, config).candidates[0]!;
    expect(second).toMatchObject({ selector: '#list', container: null, key: first.key });
  });
  it('gives the same id to a series whatever its status', () => {
    const info = report(page(listOf('list', ['- one', '- two']))).candidates[0]!;
    const likely = report(page(listOf('list', ['- one', '- two', '- three']))).candidates[0]!;
    expect([info.status, likely.status]).toEqual(['info', 'likely']);
    expect(info.rule).not.toBe(likely.rule);
    expect(info.findingId).toBe(likely.findingId);
  });
  it('takes a bullet in a box of its own before the text of each item', () => {
    const item = (text: string, row: number): Sketch => ({
      children: [leaf('•', { at: { x: 32, y: 400 + row * 24 } }), leaf(text, { at: { x: 60, y: 400 + row * 24 } })],
    });
    expect(summary(page({ id: 'flex', children: [item('one', 0), item('two', 1)] }))).toEqual(['likely glyph-list #flex [bullet]']);
  });
});

describe('names and values', () => {
  it('reports lines that each read name, colon, value', () => {
    expect(summary(page({ id: 'p', lines: ['Weight: 1.2 kg', 'Width: 34 cm', 'Height: 21 cm'] }))).toEqual(['advisory key-value #p [colonLines,lineBreaks]']);
    expect(summary(page(listOf('specs', ['Poids : 1,2 kg', 'Largeur : 34 cm', 'Hauteur : 21 cm'])))).toEqual(['advisory key-value #specs [colonLines]']);
    expect(summary(page(listOf('specs', ['重量：1.2 kg', '幅：34 cm', '高さ：21 cm'])))).toEqual(['advisory key-value #specs [colonLines]']);
  });
  it('needs three of them, a short name, and white space after the colon', () => {
    expect(summary(page({ id: 'p', lines: ['Weight: 1.2 kg', 'Width: 34 cm'] }))).toEqual([]);
    expect(summary(page({ id: 'p', lines: ['09:00 Doors open', '09:30 Welcome', '10:00 First talk'] }))).toEqual([]);
    expect(summary(page({ id: 'p', lines: ['There is one thing to remember here: the office is closed.', 'There is another: no telephone.', 'And a last one: appointments.'] }))).toEqual([]);
  });
  const pair = (name: string, value: string, row: number, over: Partial<ListBlock> = {}): Sketch[] => [
    leaf(name, { at: { x: 32, y: 500 + row * 24, width: 120 }, over: { style: BOLD, ...over } }),
    leaf(value, { at: { x: 200, y: 500 + row * 24 } }),
  ];
  it('reports a name and a value side by side, row after row, in two styles', () => {
    const root = page({ id: 'pairs', children: [...pair('Reference', 'FR-2026-00418', 0), ...pair('Amount', '248,00 €', 1), ...pair('Status', 'Paid', 2)] });
    expect(summary(root)).toEqual(['advisory key-value #pairs [sideBySide]']);
  });
  it('does not when the two have one style and no colon, when there are two rows, or when the names are links', () => {
    const plain = { style: BODY };
    expect(summary(page({ id: 'pairs', children: [...pair('Lyon', 'Paris', 0, plain), ...pair('Lille', 'Nice', 1, plain), ...pair('Brest', 'Metz', 2, plain)] }))).toEqual([]);
    expect(summary(page({ id: 'pairs', children: [...pair('Reference', 'FR-1', 0), ...pair('Amount', '248 €', 1)] }))).toEqual([]);
    const link = { contexts: ['link' as const] };
    expect(summary(page({ id: 'pairs', children: [...pair('Inbox', '3', 0, link), ...pair('Sent', '12', 1, link), ...pair('Spam', '4', 2, link)] }))).toEqual([]);
  });
  it('takes names that end with a colon whatever their style', () => {
    const plain = { style: BODY };
    const root = page({ id: 'pairs', children: [...pair('Reference:', 'FR-1', 0, plain), ...pair('Amount:', '248 €', 1, plain), ...pair('Status:', 'Paid', 2, plain)] });
    expect(summary(root)).toEqual(['advisory key-value #pairs [sideBySide]']);
  });
});

describe('siblings of one shape', () => {
  const item = (index: number, over: Partial<ListGroupItem> = {}, box?: Box): ListGroupItem => ({
    box: box ?? { x: 32 + index * 220, y: 900, width: 200, height: 120 },
    ord: 1000 + index * 10,
    end: 1009 + index * 10,
    blocks: 2,
    chars: 40,
    links: 0,
    linkChars: 0,
    buttonChars: 0,
    controls: 0,
    graphics: 1,
    lists: 0,
    heading: 'none',
    text: `Item ${index + 1}`,
    ...over,
  });
  const group = (over: Partial<ListGroupItem> = {}, more: Partial<ListGroup> = {}, count = 3): ListGroup => ({
    selector: '#group',
    frame: '',
    ord: 999,
    end: 999 + count * 10,
    count,
    looseChars: 0,
    items: Array.from({ length: count }, (_, index) => item(index, over)),
    navigation: false,
    target: 0,
    ...more,
  });
  const run = (groups: ListGroup[], input = config) => summary(page(), { groups, totalGroups: groups.length }, input);
  const link = { blocks: 1, links: 1, linkChars: 40, graphics: 0 };

  it('reports cards and groups of links as advisory', () => {
    expect(run([group()])).toEqual(['advisory repeated-structure #group [cards]']);
    expect(run([group(link)])).toEqual(['advisory repeated-structure #group [links]']);
    expect(run([group(link, { navigation: true })])).toEqual(['advisory repeated-structure #group [links,navigation]']);
  });
  it('leaves links alone when their parent holds more text than separators: links inside a sentence', () => {
    expect(run([group(link, { looseChars: 6 })])).toEqual(['advisory repeated-structure #group [links]']);
    expect(run([group(link, { looseChars: 40 })])).toEqual([]);
  });
  it('needs three items, text in each, and no form field, list or table in any', () => {
    expect(run([group({}, {}, 2)])).toEqual([]);
    expect(run([group({ chars: 0 })])).toEqual([]);
    expect(run([group({ controls: 1 })])).toEqual([]);
    expect(run([group({ lists: 1 })])).toEqual([]);
  });
  it('leaves out plain blocks of text, prose in sections, rows of buttons and blocks that are groups of links', () => {
    expect(run([group({ blocks: 1, graphics: 0 })])).toEqual([]);
    expect(run([group({ chars: 900 })])).toEqual([]);
    expect(run([group({ buttonChars: 40, blocks: 1, graphics: 0 })])).toEqual([]);
    expect(run([group({ links: 4, linkChars: 40 })])).toEqual([]);
  });
  it('leaves out blocks under each other that each have a heading of their own, unless the headings are links', () => {
    const column = (heading: ListGroupItem['heading']): ListGroup => {
      const sections = group({ heading });
      sections.items.forEach((entry, index) => (entry.box = { x: 32, y: 900 + index * 140, width: 600, height: 120 }));
      return sections;
    };
    expect(run([column('plain')])).toEqual([]);
    expect(run([column('link')])).toEqual(['advisory repeated-structure #group [cards]']);
    expect(run([column('none')])).toEqual(['advisory repeated-structure #group [cards]']);
    // Side by side they are cards, with or without headings.
    expect(run([group({ heading: 'plain' })])).toEqual(['advisory repeated-structure #group [cards]']);
  });
  it('wants the boxes in line with even gaps', () => {
    const ragged = group();
    ragged.items[2]!.box = { x: 700, y: 930, width: 200, height: 120 };
    expect(run([ragged])).toEqual([]);
  });
  it('reports the outer series only when one is inside an item of another', () => {
    const outer = group();
    const inner = group(link, { selector: '#tags', ord: 1003, end: 1008 });
    expect(run([outer, inner])).toEqual(['advisory repeated-structure #group [cards]']);
  });
  it('does not report again what is reported for its bullets', () => {
    const root = page(listOf('list', ['• one', '• two', '• three']));
    const survey = surveyOf(root);
    const first = survey.blocks[1]!.chain[0]!;
    const last = survey.blocks[3]!.chain[1]!;
    const around = group({}, { ord: first - 1, end: last });
    around.items.forEach((entry, index) => {
      entry.ord = survey.blocks[index + 1]!.chain[0]!;
      entry.end = survey.blocks[index + 1]!.chain[1]!;
    });
    expect(listReport({ ...survey, groups: [around], totalGroups: 1 }, config).candidates.map((candidate) => candidate.kind)).toEqual(['glyph']);
  });
  it('reports cards as likely only when the configuration asks for it, and never as fail', () => {
    expect(run([group()], { ...config, cardListStatus: 'likely' })).toEqual(['likely repeated-structure #group [cards]']);
    expect(run([group(link)], { ...config, cardListStatus: 'likely' })).toEqual(['advisory repeated-structure #group [links]']);
    expect(run([group()], { ...config, cardListStatus: 'fail' as never })).toEqual(['likely repeated-structure #group [cards]']);
    expect(run([group()], { ...config, cardListStatus: 'nonsense' as never })).toEqual(['advisory repeated-structure #group [cards]']);
  });
});

describe('lists of interest', () => {
  const element = (over: Partial<ListElement> = {}): ListElement => ({
    kind: 'presentational',
    selector: '#ul',
    frame: '',
    tag: 'ul',
    box: { x: 32, y: 1200, width: 300, height: 72 },
    ord: 2000,
    items: 3,
    markers: 3,
    markersInside: false,
    target: 0,
    ...over,
  });
  const run = (lists: ListElement[], input = config) => summary(page(), { lists, totalLists: lists.length }, input);
  it('reports a list with a removed role whose items show markers', () => {
    expect(run([element()])).toEqual(['likely presentational-list #ul []']);
    expect(run([element({ markersInside: true })])).toEqual(['likely presentational-list #ul [markersInside]']);
    expect(run([element({ markers: 1 })])).toEqual([]);
  });
  it('lists real lists without markers as an inventory', () => {
    expect(run([element({ kind: 'unstyled', markers: 0 })])).toEqual(['info list-style-none #ul []']);
  });
});

describe('lines that open like items and are not', () => {
  const kind = (text: string): string => {
    const mark = classifyLineStart(text, config);
    return mark ? `${mark.class}${mark.weak ? ' weak' : ''}` : 'none';
  };
  const flagsOf = (root: Sketch): string => {
    const candidates = report(root).candidates;
    return candidates.length === 1 ? `${candidates[0]!.status} [${candidates[0]!.flags.join(',')}]` : `${candidates.length} candidates`;
  };
  it('does not take the first of several symbols for a bullet', () => {
    for (const text of ['★★★★★ Excellent product', '★★☆☆☆ Disappointing', '★ ★ ★ Good', '→→ next', '•• two dots', '- - - cut here', '* * * break']) {
      expect(kind(text), text).toBe('none');
    }
    expect(kind('★ Excellent product')).toBe('bullet');
  });
  it('takes a number and the sign of a unit after a hyphen for a figure, and not a unit written in letters', () => {
    for (const text of ['- 3 °C at dawn', '- 12 °C on the summit', '- 5 ° de moins', '- 20 % on everything', '- 3,50 € par mois', '- $5 off']) expect(kind(text), text).toBe('none');
    for (const text of ['- 200 g de farine', '- 2 œufs frais', '- 3 km to the station', '- Bake at 180 °C for 20 minutes']) expect(kind(text), text).toBe('bullet weak');
  });
  it('holds back lines after a dash that end as sentences do: a dialogue', () => {
    expect(flagsOf(page(listOf('list', ['– Tu viens demain ?', '– Non, je ne peux pas, je travaille.', '– Dommage, on t’attendait.'])))).toBe('info [bullet,weakSentences]');
    expect(flagsOf(page({ id: 'p', lines: ['- Where were you last night?', '- At home, as always.', '- Nobody saw you there.'] }))).toBe('info [bullet,lineBreaks,weakSentences]');
    expect(flagsOf(page(listOf('list', ['– 「明日来る？」', '– 行けません。', '– 残念です。'])))).toBe('info [bullet,weakSentences]');
    // One sentence among phrases is enough: precision first.
    expect(flagsOf(page(listOf('list', ['- bread', '- butter', '- And then he left.'])))).toBe('info [bullet,weakSentences]');
  });
  it('takes lines after a dash for items when they are phrases, or the parts of an enumeration', () => {
    expect(flagsOf(page(listOf('list', ['– Farine complète', '– Levure fraîche', '– Sel fin'])))).toBe('likely [bullet]');
    expect(flagsOf(page({ id: 'p', lines: ['– le nom du demandeur ;', '– son adresse ;', '– la date de la demande.'] }))).toBe('likely [bullet,lineBreaks]');
    expect(flagsOf(page(listOf('list', ['* one,', '* two,', '* three'])))).toBe('likely [bullet]');
  });
  it('reads the end of a line from what the page gave, not from the start that was kept', () => {
    const long = (text: string, end: string): Sketch => ({ lines: [text], over: { segments: [{ start: text, end, box: { x: 32, y: 0, width: 300, height: 20 } }] } });
    const root = page({ id: 'list', children: [long('- A line that goes on', 'ever?'), long('- A second line that goes on', 'on.'), long('- A third line that goes on', 'on.')] });
    expect(listReport(placed(surveyOf(root)), config).candidates.map((candidate) => candidate.flags)).toEqual([['bullet', 'weakSentences']]);
  });
  it('holds back lines that open with the angle of a quoted reply, however many', () => {
    expect(flagsOf(page({ id: 'p', lines: ['> I think we should ship on Friday', '> because the customer is waiting', '> and the tests are green'] }))).toBe('info [bullet,lineBreaks,quotePrefix]');
    expect(flagsOf(page(listOf('list', ['> one', '> two'])))).toBe('info [bullet,fewWeakItems,quotePrefix]');
    // The angle quotation marks that open links in French are not that angle.
    expect(flagsOf(page(listOf('list', ['› Livraison', '› Retours', '› Contact'])))).toBe('likely [bullet]');
  });
  it('wants three lines when the bullet is an arrow, a pictogram or an emoji', () => {
    expect(flagsOf(page(listOf('list', ['⚠️ Your trial ends in 3 days.', '⚠️ Your last payment failed.'])))).toBe('info [bullet,fewSymbolItems]');
    expect(flagsOf(page(listOf('list', ['→ Learn more', '→ Contact us'])))).toBe('info [bullet,fewSymbolItems]');
    expect(flagsOf(page(listOf('list', ['✓ Fast', '✓ Private'])))).toBe('info [bullet,fewSymbolItems]');
    expect(flagsOf(page(listOf('list', ['🎉 One', '🎉 Two'])))).toBe('info [bullet,fewSymbolItems]');
    expect(flagsOf(page(listOf('list', ['✓ Fast', '✓ Private', '✓ Open'])))).toBe('likely [bullet]');
    expect(flagsOf(page(listOf('list', ['→ Bring a document', '→ Bring a photo', '→ Come early'])))).toBe('likely [bullet]');
    // Dots and squares are bullets and nothing else: two are enough.
    expect(flagsOf(page(listOf('list', ['■ one', '■ two'])))).toBe('likely [bullet]');
    const arrow: ListMarker = { kind: 'pseudo-text', text: '→', key: '→|arial' };
    expect(flagsOf(page(listOf('list', ['Learn more', 'Contact us'], { marker: arrow })))).toBe('info [bullet,pseudoElement,fewSymbolItems]');
  });
  it('holds back lines that open with such a symbol and are each a link or something clicked', () => {
    const cta = ['→ Learn more about pricing', '→ Contact our sales team', '→ Read the documentation'];
    expect(flagsOf(page(listOf('list', cta, { over: { contexts: ['link'] } })))).toBe('info [bullet,itemsAreControls]');
    expect(flagsOf(page(listOf('list', ['▶ Shipping', '▶ Payment', '▶ Warranty'], { over: { clickable: true } })))).toBe('info [bullet,itemsAreControls]');
    expect(flagsOf(page(listOf('list', ['▶ Shipping', '▶ Payment', '▶ Warranty'])))).toBe('likely [bullet]');
    // A plain bullet before each link is a list of links.
    expect(flagsOf(page(listOf('list', ['• Annual report', '• Minutes', '• Press releases'], { over: { contexts: ['link'] } })))).toBe('likely [bullet]');
    // A link that heads further text is more than a control.
    const teaser = (title: string): Sketch => ({ children: [leaf(title, { over: { contexts: ['link'] } }), leaf('A sentence about it.')] });
    expect(flagsOf(page({ id: 'list', children: cta.map(teaser) }))).toBe('likely [bullet]');
  });
  it('holds back bullets in different colours: the swatches of a legend', () => {
    const entry = (text: string, startColor: string): Sketch => ({ lines: [text], over: { segments: [{ start: text, startColor, box: { x: 32, y: 0, width: 300, height: 20 } }] } });
    const legend = (colours: string[]): ListSurvey => {
      return placed(surveyOf(page({ id: 'legend', children: colours.map((colour, index) => entry(`■ Series ${index + 1}`, colour)) })));
    };
    expect(listReport(legend(['#b00020', '#0033a0']), config).candidates.map((candidate) => candidate.flags)).toEqual([['bullet', 'colouredMarkers']]);
    expect(listReport(legend(['#1a1a1a', '#1a1a1a']), config).candidates.map((candidate) => candidate.status)).toEqual(['likely']);
  });
  it('holds back numbered lines that all go on with the same word: dates, ranks', () => {
    expect(flagsOf(page(listOf('list', ['1. Mai Tag der Arbeit', '2. Mai Betriebsversammlung', '3. Mai Sommerfest'])))).toBe('info [number,sameWordAfterNumber]');
    expect(flagsOf(page(listOf('list', ['1. Platz: Lyon', '2. Platz: Paris'])))).toBe('info [number,sameWordAfterNumber]');
    expect(flagsOf(page(listOf('list', ['1. Mix the flour', '2. Add the yeast', '3. Knead'])))).toBe('likely [number]');
    // "1)" is not how an ordinal is written.
    expect(flagsOf(page(listOf('list', ['1) Add flour', '2) Add yeast'])))).toBe('likely [number]');
  });
  it('holds back capital letters before one capitalised word each: initials and names', () => {
    expect(flagsOf(page(listOf('list', ['A. Martin, Université de Lyon', 'B. Nguyen, Université de Nantes', 'C. Okafor, Université de Lille'])))).toBe('info [number,initialsAndNames]');
    expect(flagsOf(page(listOf('list', ['A. Martin', 'B. Nguyen', 'C. Okafor'])))).toBe('info [number,initialsAndNames]');
    expect(flagsOf(page(listOf('list', ['A. Scope of the regulation', 'B. Definitions and terms', 'C. Entry into force'])))).toBe('likely [number]');
    expect(flagsOf(page(listOf('list', ['a. Paper', 'b. Glass', 'c. Metal'])))).toBe('likely [number]');
    expect(flagsOf(page(listOf('list', ['A) Martin', 'B) Nguyen', 'C) Okafor'])))).toBe('likely [number]');
  });
  it('reads kana and hangul in the order of their sequences, and numbers in square brackets', () => {
    expect(flagsOf(page(listOf('list', ['あ) 最初の項目', 'い) 二番目の項目', 'う) 三番目の項目'])))).toBe('likely [number]');
    expect(flagsOf(page(listOf('list', ['ア) 最初の項目', 'イ) 二番目の項目', 'ウ) 三番目の項目'])))).toBe('likely [number]');
    expect(flagsOf(page(listOf('list', ['イ) 最初の項目', 'ロ) 二番目の項目', 'ハ) 三番目の項目'])))).toBe('likely [number]');
    expect(flagsOf(page(listOf('list', ['い) 最初の項目', 'ろ) 二番目の項目', 'は) 三番目の項目'])))).toBe('likely [number]');
    expect(flagsOf(page(listOf('list', ['가. 첫째 항목', '나. 둘째 항목', '다. 셋째 항목'])))).toBe('likely [number]');
    // Not in sequence, and from the middle of one.
    expect(summary(page(listOf('list', ['あ) 一', 'う) 二'])))).toEqual([]);
    expect(flagsOf(page(listOf('list', ['か) 一', 'き) 二', 'く) 三'])))).toBe('info [number,startsMidSequence]');
    expect(flagsOf(page(listOf('list', ['[1] Smith, J. (2020). On lists.', '[2] Doe, A. (2021). On headings.', '[3] Roe, B. (2022). On groups.'])))).toBe('likely [number]');
  });
  it('takes marks in cells of their own in a flat grid, the text of each item in the next cell', () => {
    const cells = (texts: string[], mark: string): Sketch[] =>
      texts.flatMap((text, row) => [leaf(mark, { at: { x: 32, y: 400 + row * 24, width: 16 } }), leaf(text, { at: { x: 60, y: 400 + row * 24 } })]);
    expect(flagsOf(page({ id: 'grid', children: cells(['Unlimited projects', 'Priority support', 'Single sign-on'], '✓') }))).toBe('likely [bullet]');
    const numbered = report(page({ id: 'grid', children: ['One', 'Two'].flatMap((text, row) => [leaf(`${row + 1}.`, { at: { x: 32, y: 400 + row * 24, width: 16 } }), leaf(text, { at: { x: 60, y: 400 + row * 24 } })]) })).candidates;
    expect(numbered.map((candidate) => `${candidate.status} [${candidate.flags.join(',')}] ${candidate.items}`)).toEqual(['likely [number] 2']);
    // Marks side by side on one row are the cells of a comparison, not items.
    const row = { id: 'row', children: [leaf('SSO', { at: { x: 32, y: 400 } }), leaf('✓', { at: { x: 400, y: 400, width: 16 } }), leaf('✓', { at: { x: 500, y: 400, width: 16 } }), leaf('–', { at: { x: 600, y: 400, width: 16 } })] };
    expect(summary(page(row))).toEqual([]);
  });
  it('takes the size of a box that holds a mark alone from the configuration', () => {
    const item = (row: number): Sketch => ({ children: [leaf('(iii)', { at: { x: 32, y: 400 + row * 24 } }), leaf('text', { at: { x: 80, y: 400 + row * 24 } })] });
    const root = page({ id: 'flex', children: [{ children: [leaf('(ii)', { at: { x: 32, y: 376 } }), leaf('text', { at: { x: 80, y: 376 } })] }, item(0)] });
    expect(summary(root)).toEqual([]);
    expect(summary(root, {}, { ...config, loneMarkerMaxChars: 5 })).toEqual(['info glyph-list-candidate #flex [number,startsMidSequence]']);
  });
});

describe('several series on one element', () => {
  const both = page({ id: 'p', lines: ['• apples', '• pears', '• plums', 'and then the steps', '1. wash', '2. peel', '3. eat'] });
  it('reports two series of lines in one block, each under an id of its own', () => {
    const result = report(both);
    expect(result.candidates.map((candidate) => `${candidate.status} ${candidate.selector} [${candidate.flags.join(',')}] ${candidate.items}`)).toEqual([
      'likely #p [bullet,lineBreaks] 3',
      'likely #p [number,lineBreaks] 3',
    ]);
    expect(result.merged).toBe(0);
    const [first, second] = result.candidates;
    expect(first!.findingId).not.toBe(second!.findingId);
    expect(first!.key).not.toBe(second!.key);
    // The first keeps the id it has when it is alone; both are the same on a second run.
    const alone = report(page({ id: 'p', lines: ['• apples', '• pears', '• plums', 'and then the steps'] })).candidates[0]!;
    expect(first!.findingId).toBe(alone.findingId);
    expect(report(both).candidates.map((candidate) => candidate.findingId)).toEqual([first!.findingId, second!.findingId]);
  });
  it('gives every finding of the check an id of its own', () => {
    const snapshot: Snapshot = {
      environment: { url: 'http://example.test/', devicePixelRatio: 2, viewport: { width: 1280, height: 720 }, colorScheme: 'light' },
      lists: surveyOf(both),
      nodes: [],
      axTree: [],
      screenshots: { tiles: [], clips: {} },
    };
    const findings = runChecks(snapshot, resolveConfig({ checks: ['lists'] }));
    expect(findings.filter((finding) => finding.selector === '#p').map((finding) => finding.status)).toEqual(['likely', 'likely']);
    expect(new Set(findings.map((finding) => finding.id)).size).toBe(findings.length);
  });
  it('keeps the finding of the highest status when two have one rule and one selector, and counts the other', () => {
    // Two elements with one id: the page is wrong, and the report still has one finding per id.
    const root = page(listOf('twin', ['- one', '- two']), leaf('Plain text between.'), listOf('twin', ['• one', '• two']));
    const result = report(root);
    expect(result.candidates.map((candidate) => `${candidate.status} ${candidate.selector} [${candidate.flags.join(',')}]`)).toEqual(['likely #twin [bullet]']);
    expect(result.merged).toBe(1);
  });
});

describe('names and values that are not', () => {
  it('does not take the speakers of a chat for names: they come back', () => {
    expect(summary(page(listOf('chat', ['Alice: are you coming to the meeting?', 'Bob: yes, five minutes.', 'Alice: ok, room 4.', 'Bob: on my way.'])))).toEqual([]);
    expect(summary(page({ id: 'p', lines: ['Tel: 01 23 45 67 89', 'Tel: 01 23 45 67 90', 'Fax: 01 23 45 67 91'] }))).toEqual([]);
  });
  it('does not take a name and a verb for a name: more words than a name has', () => {
    const feed = ['Marsha Labat posted a video: Building Better Dashboards', 'Elston Muffett joined your webinar: Intro to TypeScript', 'Leigha Gorce left a long comment: This is so helpful'];
    expect(summary(page(listOf('feed', feed)))).toEqual([]);
    expect(summary(page(listOf('sheet', ['Date of issue: 12 March', 'Numéro de sécurité sociale : 1 84', 'Place of birth: Lyon'])))).toEqual(['advisory key-value #sheet [colonLines]']);
  });
  it('wants the names set in one style, the same on every line', () => {
    const line = (text: string, keyStyle: string): Sketch => ({ lines: [text], over: { segments: [{ start: text, keyStyle, box: { x: 32, y: 0, width: 300, height: 20 } }] } });
    const sheet = (styles: string[]): string[] => {
      const survey = placed(surveyOf(page({ id: 'sheet', children: ['Anna commented: yes', 'Karim replied: no', 'Lea wrote: maybe'].map((text, index) => line(text, styles[index]!)) })));
      return listReport(survey, config).candidates.map((candidate) => candidate.rule);
    };
    expect(sheet(['bold', 'bold', 'bold'])).toEqual(['lists/key-value']);
    expect(sheet(['bold\nplain', 'bold\nplain', 'bold\nplain'])).toEqual([]);
    expect(sheet(['bold', 'plain', 'bold'])).toEqual([]);
  });
  it('wants the names of pairs side by side to differ', () => {
    const pair = (name: string, value: string, row: number): Sketch[] => [
      leaf(name, { at: { x: 32, y: 500 + row * 24, width: 120 }, over: { style: BOLD } }),
      leaf(value, { at: { x: 200, y: 500 + row * 24 } }),
    ];
    expect(summary(page({ id: 'pairs', children: [...pair('Amélie', 'Has anyone seen the minutes?', 0), ...pair('Karim', 'In the shared folder.', 1), ...pair('Amélie', 'Found them.', 2)] }))).toEqual([]);
  });
});

describe('limits and invariants', () => {
  const many = (count: number): Sketch => page(...Array.from({ length: count }, (_, index) => listOf(`list-${index}`, ['• one', '• two'])));
  it('reports at most maxCandidates findings and says how many were left out', () => {
    const result = report(many(12), {}, { ...config, maxCandidates: 5 });
    expect(result.candidates).toHaveLength(5);
    expect(result.omitted).toBe(7);
    expect(result.candidates.map((candidate) => candidate.selector)).toEqual(['#list-0', '#list-1', '#list-2', '#list-3', '#list-4']);
  });
  it('keeps the inventory of lists without markers under its own limit', () => {
    const lists = Array.from({ length: 6 }, (_, index): ListElement => ({
      kind: 'unstyled', selector: `#ul-${index}`, frame: '', tag: 'ul', box: { x: 0, y: index * 50, width: 100, height: 40 }, ord: 3000 + index, items: 2, markers: 0, markersInside: false, target: index,
    }));
    const result = report(many(2), { lists, totalLists: 6 }, { ...config, maxUnstyledLists: 4 });
    expect(result.candidates.filter((candidate) => candidate.kind === 'unstyled')).toHaveLength(4);
    expect(result.omittedUnstyled).toBe(2);
    expect(result.candidates.filter((candidate) => candidate.kind === 'glyph')).toHaveLength(2);
  });
  it('puts likely first, then advisory, then info, each in document order', () => {
    const root = page(listOf('weak', ['- one', '- two']), listOf('nav', ['› one', '› two', '› three'], { over: { contexts: ['navigation'] } }), listOf('strong', ['• one', '• two']));
    expect(report(root).candidates.map((candidate) => candidate.selector)).toEqual(['#strong', '#nav', '#weak']);
  });
  it('reports nothing above info when the accessibility tree could not be read', () => {
    const root = page(listOf('list', ['• one', '• two']), { id: 'p', lines: ['Weight: 1 kg', 'Width: 3 cm', 'Height: 2 cm'] });
    const result = report(root, { axComplete: false, lists: [{ kind: 'presentational', selector: '#ul', frame: '', tag: 'ul', box: { x: 0, y: 0, width: 10, height: 10 }, ord: 5000, items: 2, markers: 2, markersInside: false, target: 0 }], totalLists: 1 });
    expect(result.candidates).toHaveLength(3);
    for (const candidate of result.candidates) {
      expect(candidate.status).toBe('info');
      expect(candidate.flags).toContain('axIncomplete');
      expect(candidate.adjudicate).toBe(false);
    }
  });
  it('is the same on two runs, and never a fail', () => {
    const root = many(4);
    const survey = surveyOf(root);
    expect(listReport(survey, config)).toEqual(listReport(survey, config));
    const snapshot: Snapshot = {
      environment: { url: 'http://example.test/', devicePixelRatio: 2, viewport: { width: 1280, height: 720 }, colorScheme: 'light' },
      lists: survey,
      nodes: [],
      axTree: [],
      screenshots: { tiles: [], clips: {} },
    };
    const findings = runChecks(snapshot, resolveConfig({ checks: ['lists'], lists: { cardListStatus: 'fail' as never } }));
    expect(findings.length).toBe(5);
    expect(findings.some((finding) => finding.status === 'fail')).toBe(false);
    expect(new Set(findings.map((finding) => finding.id)).size).toBe(findings.length);
    expect(findings.find((finding) => finding.rule === 'lists/survey')?.evidence.values).toMatchObject({ glyphLists: 4, likely: 4 });
  });
  it('turns a configured fail into likely when the configuration is resolved', () => {
    expect(resolveConfig({ lists: { cardListStatus: 'fail' as never } }).lists.cardListStatus).toBe('likely');
    expect(resolveConfig({ lists: { cardListStatus: 'info' as never } }).lists.cardListStatus).toBe('advisory');
    expect(resolveConfig({ adjudication: { listDisagreeStatus: 'fail' as never } }).adjudication.listDisagreeStatus).toBe('likely');
  });
});
