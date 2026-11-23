import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contrastRatio, createImage, defaultConfig, encodePng } from '@a11y-vision/core';
import type { Finding, ScanResult } from '@a11y-vision/core';
import { describe, expect, it } from 'vitest';
import { extensionConfig } from './config.js';
import { emptyPageDecisions, withDecision } from './decisions.js';
import { exportFile, exportName, toExtensionJson } from './export.js';
import { applyStaticText, renderChecks, renderFinding, renderGroups, updateDecision } from './render.js';
import type { RenderContext } from './render.js';
import { API_KEY_STORAGE_KEY } from './settings.js';
import { countStatuses, groupFindings, selectedChecks, statusOf } from './state.js';
import { en, format, strings } from './strings.js';
import { FakeElement, fakeDocument } from './test-support.js';

const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
const now = new Date('2026-01-02T03:04:05.000Z');

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: '00aa11bb22cc33dd',
    check: 'focus-indicator',
    rule: 'focus-indicator/no-visible-change',
    status: 'fail',
    wcag: { sc: '2.4.7', level: 'AA' },
    selector: '#save',
    frame: '',
    signature: 'button||1234',
    box: { x: 10.4, y: 20.6, width: 100, height: 40 },
    evidence: { crops: ['focus-indicator/abc-focused.png'], colors: { indicator: '#ff00aa' }, ratios: { best: 1.5 }, flags: ['authorModified'], values: { text: 'Save' } },
    message: 'Nothing changes when the button takes focus.',
    help: 'A visible focus indicator is required.',
    ...over,
  };
}

const hostile = finding({
  id: 'ffee',
  check: 'headings',
  rule: 'headings/unmarked-heading',
  status: 'likely',
  selector: `#x"><img src=x onerror=alert(1)>`,
  frame: HOSTILE,
  message: HOSTILE,
  help: HOSTILE,
  evidence: { crops: [], colors: { text: 'url(javascript:alert(1))' }, ratios: {}, flags: [HOSTILE], values: { text: HOSTILE, [HOSTILE]: 1 } },
  ai: { provider: HOSTILE, model: HOSTILE, promptVersion: '1', votes: ['yes', 'yes'], verdict: 'yes', confidence: 'high', rationale: HOSTILE, statusBefore: 'info', inputs: 'text', fromCache: false },
});

function result(findings: Finding[]): ScanResult {
  return { tool: { name: 'a11y-vision', version: '0.0.0' }, url: 'https://example.test/shop/cart?step=2', timestamp: now.toISOString(), environment: { url: 'https://example.test/shop/cart?step=2', devicePixelRatio: 2, viewport: { width: 800, height: 600 }, colorScheme: 'light' }, findings };
}

describe('exports', () => {
  const findings = [finding(), finding({ id: 'second', selector: '#next', signature: 'a||5678', status: 'likely' }), hostile];
  const decisions = withDecision(withDecision(emptyPageDecisions(now), findings[0]!, { decision: 'confirmed', note: 'seen with NVDA' }, extensionConfig.storage, now), { id: 'gone', signature: 'x' }, { decision: 'dismissed', note: '' }, extensionConfig.storage, now);

  it('JSON is the report of the CLI for one page, with the decisions under the extension key', () => {
    const report = toExtensionJson(result(findings), decisions);
    expect(Object.keys(report)).toEqual(['testEngine', 'url', 'timestamp', 'violations', 'incomplete', 'passes', 'inapplicable', 'a11yVision']);
    expect(report.passes).toEqual([]);
    expect(report.violations.map((rule) => rule.id)).toEqual(['focus-indicator/no-visible-change']);
    expect(report.a11yVision.findings).toEqual(findings);
    // Only decisions on findings of this result, in their order; one about a finding that is not there stays out.
    expect(report.a11yVision.review).toEqual({ source: 'extension', decisions: [{ findingId: '00aa11bb22cc33dd', signature: 'button||1234', decision: 'confirmed', note: 'seen with NVDA', at: now.toISOString() }] });
    expect(toExtensionJson(result(findings), null).a11yVision.review.decisions).toEqual([]);
  });

  it('gives each kind a file with a safe name, and nothing of the settings in any of them', () => {
    const crops = { 'focus-indicator/abc-focused.png': encodePng(createImage(2, 2, { r: 255, g: 255, b: 255 })) };
    const json = exportFile('json', result(findings), crops, decisions, defaultConfig);
    expect(json.name).toBe('a11y-vision_example.test_2026-01-02T030405Z.json');
    expect(json.type).toBe('application/json');
    expect(() => JSON.parse(json.text) as unknown).not.toThrow();
    const html = exportFile('html', result(findings), crops, decisions, defaultConfig);
    expect(html.name).toMatch(/\.html$/);
    expect(html.text).toContain('data:image/png;base64,');
    // The reporter escapes: the hostile strings are in the report as text.
    expect(html.text).not.toContain('<script>alert(2)</script>');
    expect(html.text).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
    const sarif = exportFile('sarif', result(findings), crops, decisions, defaultConfig);
    expect(sarif.name).toMatch(/\.sarif$/);
    expect((JSON.parse(sarif.text) as { version: string }).version).toBe('2.1.0');
    for (const file of [json, html, sarif]) {
      expect(file.text).not.toContain(API_KEY_STORAGE_KEY);
      expect(file.text).not.toMatch(/baseUrl|apiKey|allowRemote/);
      expect(file.name).toMatch(/^[A-Za-z0-9._-]+$/);
    }
  });

  it('names a file without what cannot be in a file name', () => {
    expect(exportName({ url: 'not a url', timestamp: 'x/y:z', tool: { name: '../evil', version: '1' } }, 'json')).toBe('..-evil_page_x-yz.json');
    expect(exportName({ url: 'https://[::1]:8080/', timestamp: now.toISOString(), tool: { name: 'a11y-vision', version: '1' } }, 'json')).toBe('a11y-vision_1_2026-01-02T030405Z.json');
  });
});

describe('the queue', () => {
  const findings = [
    finding({ id: 'a', check: 'lists', status: 'advisory' }),
    finding({ id: 'b', check: 'focus-indicator', status: 'info' }),
    finding({ id: 'c', check: 'headings', status: 'likely' }),
    finding({ id: 'd', check: 'focus-indicator', status: 'fail' }),
    finding({ id: 'e', check: 'icon-contrast', status: 'fail' }),
    finding({ id: 'f', check: 'headings', status: 'broken' as Finding['status'] }),
  ];

  it('groups by status, fail first, and by check within', () => {
    const groups = groupFindings(findings, null, 'status', 'all');
    expect(groups.map((group) => [group.key, group.items.map((item) => item.finding.id)])).toEqual([
      ['fail', ['d', 'e']],
      ['likely', ['c']],
      ['advisory', ['a']],
      ['info', ['b', 'f']],
    ]);
  });

  it('groups by check, in the order the checks are listed, and by status within', () => {
    const groups = groupFindings(findings, null, 'check', 'all');
    expect(groups.map((group) => [group.key, group.items.map((item) => item.finding.id)])).toEqual([
      ['focus-indicator', ['d', 'b']],
      ['icon-contrast', ['e']],
      ['headings', ['c', 'f']],
      ['lists', ['a']],
    ]);
  });

  it('shows what was decided, or what was not', () => {
    let page = withDecision(emptyPageDecisions(now), findings[3]!, { decision: 'confirmed', note: '' }, extensionConfig.storage, now);
    page = withDecision(page, findings[4]!, { decision: 'dismissed', note: '' }, extensionConfig.storage, now);
    page = withDecision(page, findings[2]!, { decision: null, note: 'only a note' }, extensionConfig.storage, now);
    const ids = (show: Parameters<typeof groupFindings>[3]): string[] => groupFindings(findings, page, 'status', show).flatMap((group) => group.items.map((item) => item.finding.id));
    expect(ids('confirmed')).toEqual(['d']);
    expect(ids('dismissed')).toEqual(['e']);
    expect(ids('to-review')).toEqual(['c', 'a', 'b', 'f']);
    expect(groupFindings(findings, page, 'status', 'confirmed')[0]!.items[0]!.entry?.decision).toBe('confirmed');
  });

  it('never counts or shows an unknown status as a failure', () => {
    expect(statusOf({ status: 'broken' as Finding['status'] })).toBe('info');
    expect(countStatuses(findings)).toEqual({ fail: 2, likely: 1, advisory: 1, info: 2 });
  });

  it('runs only checks the panel offers', () => {
    expect(selectedChecks(['lists', 'noop', 'focus-indicator', '<script>'])).toEqual(['focus-indicator', 'lists']);
  });
});

describe('rendering', () => {
  const decisions: { finding: Finding; decision: unknown }[] = [];
  const context = (doc: Document): RenderContext => ({
    doc,
    strings,
    cropUrl: (id) => (id === 'focus-indicator/abc-focused.png' ? 'blob:chrome-extension://id/1' : undefined),
    maxNoteChars: 2000,
    handlers: { onDecision: (found, decision) => void decisions.push({ finding: found, decision }), onNote: () => undefined, onNoteInput: () => undefined, onHighlight: () => undefined },
  });

  it('shows a finding with its evidence and its controls', () => {
    const doc = fakeDocument();
    const node = renderFinding({ finding: finding(), entry: { decision: 'dismissed', note: 'decorative', at: now.toISOString() } }, context(doc)) as unknown as FakeElement;
    const text = node.textContent;
    for (const part of ['Fail', 'focus-indicator/no-visible-change', '#save', 'Nothing changes when the button takes focus.', 'A visible focus indicator is required.', '2.4.7 (Level AA)', '1.5:1', '#ff00aa', 'authorModified', '100 by 40 at 10, 21', 'Decision: Dismissed', 'Note (optional)']) {
      expect(text).toContain(part);
    }
    const all = node.all();
    const image = all.find((element) => element.tagName === 'img')!;
    expect(image.src).toBe('blob:chrome-extension://id/1');
    expect(image.getAttribute('alt')).toBe('Focused capture of #save');
    expect(all.find((element) => element.tagName === 'textarea')!.value).toBe('decorative');
    expect(all.find((element) => element.className === 'dismiss')!.getAttribute('aria-pressed')).toBe('true');
    expect(all.find((element) => element.className === 'confirm')!.getAttribute('aria-pressed')).toBe('false');
    expect(all.find((element) => element.className === 'swatch')!.style['backgroundColor']).toBe('#ff00aa');
    // The note has a label that points at it.
    const note = all.find((element) => element.tagName === 'textarea')!;
    expect(all.find((element) => element.tagName === 'label')!.getAttribute('for')).toBe(note.id);
    expect(node.getAttribute('aria-labelledby')).toBe(all.find((element) => element.tagName === 'h4')!.id);
  });

  it('ties the controls of a card to its finding: each is described by the title and the selector of its own card', () => {
    const doc = fakeDocument();
    const first = renderFinding({ finding: finding(), entry: undefined }, context(doc)) as unknown as FakeElement;
    const second = renderFinding({ finding: finding({ id: 'second', selector: '#next' }), entry: undefined }, context(doc)) as unknown as FakeElement;
    const described = (node: FakeElement): string[] => {
      const controls = node.all().filter((element) => element.tagName === 'button' || element.tagName === 'textarea');
      expect(controls.map((element) => element.className || element.tagName)).toEqual(['confirm', 'dismiss', 'highlight', 'textarea']);
      const ids = new Set(controls.map((element) => element.getAttribute('aria-describedby')));
      // The four of them point at the same two elements, in the order they are read.
      expect(ids.size).toBe(1);
      return [...ids][0]!.split(' ');
    };
    const textOf = (node: FakeElement, ids: string[]): string => ids.map((id) => node.all().find((element) => element.id === id)!.textContent).join(' ');
    expect(textOf(first, described(first))).toBe('Fail focus-indicator/no-visible-change Selector: #save');
    expect(textOf(second, described(second))).toBe('Fail focus-indicator/no-visible-change Selector: #next');
    // Ids of one card are not those of another.
    expect(described(first).some((id) => described(second).includes(id))).toBe(false);
    // The name stays the visible label: nothing replaces it.
    for (const element of [...first.all(), ...second.all()]) expect(element.getAttribute('aria-label')).toBeNull();
  });

  it('a note is handed over while it is typed and again when its field is left', () => {
    const doc = fakeDocument();
    const typed: string[] = [];
    const left: string[] = [];
    const node = renderFinding({ finding: finding(), entry: undefined }, { ...context(doc), handlers: { ...context(doc).handlers, onNoteInput: (_found, note) => void typed.push(note), onNote: (_found, note) => void left.push(note) } }) as unknown as FakeElement;
    const note = node.all().find((element) => element.tagName === 'textarea')!;
    note.value = 'se';
    note.dispatch('input');
    note.value = 'seen';
    note.dispatch('input');
    note.dispatch('change');
    expect(typed).toEqual(['se', 'seen']);
    expect(left).toEqual(['seen']);
  });

  it('pressing a decision asks for it, and pressing it again takes it back', () => {
    decisions.length = 0;
    const doc = fakeDocument();
    const node = renderFinding({ finding: finding(), entry: undefined }, context(doc)) as unknown as FakeElement;
    const confirm = node.all().find((element) => element.className === 'confirm')!;
    confirm.dispatch('click');
    expect(decisions.at(-1)?.decision).toBe('confirmed');
    updateDecision(node as unknown as HTMLElement, { decision: 'confirmed', note: '', at: now.toISOString() }, strings);
    expect(confirm.getAttribute('aria-pressed')).toBe('true');
    expect(node.textContent).toContain('Decision: Confirmed');
    confirm.dispatch('click');
    expect(decisions.at(-1)?.decision).toBeNull();
    updateDecision(node as unknown as HTMLElement, undefined, strings);
    expect(node.textContent).toContain('Decision: Not decided');
  });

  it('hostile text of a page or of a model stays text: no element is made from it, and nothing is parsed', () => {
    const doc = fakeDocument();
    const container = new FakeElement('div');
    // The fake document throws on innerHTML, outerHTML and insertAdjacentHTML.
    renderGroups(container as unknown as HTMLElement, groupFindings([hostile, finding()], null, 'status', 'all'), context(doc));
    const tags = new Set(doc.created.map((element) => element.tagName));
    expect([...tags].sort()).toEqual(['article', 'button', 'code', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'h3', 'h4', 'img', 'label', 'legend', 'li', 'p', 'section', 'span', 'summary', 'textarea', 'ul']);
    // The one picture is the capture of the other finding.
    expect(doc.created.filter((element) => element.tagName === 'img').map((element) => element.src)).toEqual(['blob:chrome-extension://id/1']);
    // The strings are shown, as they are.
    expect(container.textContent).toContain(HOSTILE);
    expect(container.textContent).toContain('url(javascript:alert(1))');
    // Attribute names are fixed; a value that came from the page is only ever a label or an id.
    const names = new Set(doc.created.flatMap((element) => [...element.attributes.keys()]));
    expect([...names].sort()).toEqual(['alt', 'aria-describedby', 'aria-hidden', 'aria-labelledby', 'aria-pressed', 'data-finding-id', 'data-group', 'data-status', 'for', 'loading', 'maxlength', 'rows', 'type']);
    // What is not a plain hex colour is never used as a colour.
    expect(doc.created.filter((element) => element.className === 'swatch').map((element) => element.style['backgroundColor'])).toEqual(['#ff00aa']);
    // No handler is ever set from a string.
    expect([...names].some((name) => name.startsWith('on'))).toBe(false);
  });

  it('shows values of the wrong type as unknown instead of calling into them', () => {
    const doc = fakeDocument();
    const trap = { toString: () => { throw new Error('toString was called'); } };
    const odd = finding({ selector: trap as unknown as string, message: 7 as unknown as string, evidence: { crops: [trap as unknown as string], colors: { c: trap as unknown as string }, ratios: { r: Number.NaN }, flags: [trap as unknown as string], values: { v: trap as unknown as string } } });
    const node = renderFinding({ finding: odd, entry: undefined }, context(doc)) as unknown as FakeElement;
    expect(node.textContent).toContain('unknown');
    expect(node.textContent).toContain('7');
  });

  it('says so when nothing matches, and lists the checks with their labels', () => {
    const doc = fakeDocument();
    const container = new FakeElement('div');
    renderGroups(container as unknown as HTMLElement, [], context(doc));
    expect(container.textContent).toBe(strings.nothingShown);
    renderChecks(container as unknown as HTMLElement, ['headings', 'lists'], ['lists'], doc, strings);
    const inputs = container.all().filter((element) => element.tagName === 'input');
    expect(inputs.map((input) => [input.getAttribute('value'), input.checked])).toEqual([['headings', false], ['lists', true]]);
    expect(container.all().filter((element) => element.tagName === 'label').map((label) => label.getAttribute('for'))).toEqual(inputs.map((input) => input.id));
  });

  it('fills the static texts by key, and leaves an unknown key alone', () => {
    const known = new FakeElement('p');
    known.dataset['text'] = 'scanButton';
    const unknown = new FakeElement('p');
    unknown.dataset['text'] = 'constructor';
    unknown.textContent = 'as it was';
    applyStaticText({ querySelectorAll: () => [known, unknown] } as unknown as Document, strings);
    expect(known.textContent).toBe('Scan this page');
    expect(unknown.textContent).toBe('as it was');
  });
});

describe('the source of the extension', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const sources = readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'test-support.ts');

  it('never parses a string as markup or as code, and never logs', () => {
    expect(sources.length).toBeGreaterThan(10);
    for (const name of sources) {
      const code = readFileSync(`${dir}${name}`, 'utf8')
        // Comments say what is not done.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, name).not.toMatch(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|\beval\(|new Function\(|setAttribute\(\s*['"]on/);
      expect(code, name).not.toMatch(/console\.(log|info|debug|warn|error)/);
      expect(code, name).not.toMatch(/storage\.sync|\.sync\b/);
    }
  });

  it('asks for the permissions it needs and no other, and loads nothing from elsewhere', () => {
    const manifest = JSON.parse(readFileSync(`${dir}../static/manifest.json`, 'utf8')) as Record<string, unknown>;
    expect(manifest['manifest_version']).toBe(3);
    expect(manifest['permissions']).toEqual(['debugger', 'sidePanel', 'storage', 'activeTab']);
    expect(manifest['host_permissions']).toBeUndefined();
    expect(manifest['content_scripts']).toBeUndefined();
    expect(manifest['web_accessible_resources']).toBeUndefined();
    expect(manifest['externally_connectable']).toBeUndefined();
    // Plain http can only ever be asked for on this machine.
    expect(manifest['optional_host_permissions']).toEqual(['http://localhost/*', 'http://*.localhost/*', 'http://127.0.0.1/*', 'https://*/*']);
    const csp = (manifest['content_security_policy'] as { extension_pages: string }).extension_pages;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-eval|unsafe-inline|wasm-unsafe-eval/);
    expect(csp).toMatch(/connect-src http:\/\/localhost:\* http:\/\/\*\.localhost:\* http:\/\/127\.0\.0\.1:\* https:;/);
    const html = readFileSync(`${dir}../static/panel.html`, 'utf8');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\son\w+=|style=/);
    expect([...html.matchAll(/<script[^>]*>/g)].map((match) => match[0])).toEqual(['<script type="module" src="panel.js">']);
  });
});

describe('strings', () => {
  it('fills the names it is given and leaves the others', () => {
    expect(format('{a} and {b} and {a}', { a: 1 })).toBe('1 and {b} and 1');
    expect(format('{toString}')).toBe('{toString}');
  });

  it('never say that a page passes, conforms or is accessible', () => {
    for (const [key, text] of Object.entries(en)) {
      expect(text, key).not.toMatch(/\bpass(es|ed|ing)?\b|\bcompliant\b|\bcompliance\b|is accessible|\bcertif/i);
      // "conform" only where a text says what the tool does not state.
      if (/conform/i.test(text)) expect(text, key).toMatch(/no statement about conformance|not a statement that the page conforms/);
    }
  });

  it('every static text of the page has a string', () => {
    const html = readFileSync(fileURLToPath(new URL('../static/panel.html', import.meta.url)), 'utf8');
    const keys = [...html.matchAll(/data-text="([^"]+)"/g)].map((match) => match[1]!);
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) expect(Object.hasOwn(en, key), key).toBe(true);
  });
});

describe('the colours of the panel', () => {
  const css = readFileSync(fileURLToPath(new URL('../static/panel.css', import.meta.url)), 'utf8');
  const palette = (block: string): Record<string, { r: number; g: number; b: number }> =>
    Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*#([0-9a-f]{6});/g)].map((match) => [match[1]!, { r: parseInt(match[2]!.slice(0, 2), 16), g: parseInt(match[2]!.slice(2, 4), 16), b: parseInt(match[2]!.slice(4, 6), 16) }]));
  const light = palette(css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')));
  const dark = palette(css.slice(css.indexOf('@media (prefers-color-scheme: dark)'), css.indexOf('@media (prefers-reduced-motion')));

  for (const [name, colours] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    it(`${name}: text is at least 4.5:1 on the backgrounds it is put on, boundaries and the focus ring at least 3:1`, () => {
      expect(Object.keys(colours).sort()).toEqual(['accent', 'advisory', 'bg', 'fail', 'fg', 'info', 'likely', 'line', 'muted', 'on-accent', 'soft']);
      const ratio = (a: string, b: string): number => contrastRatio(colours[a]!, colours[b]!);
      // Text on the page, and on the tinted background of a notice.
      for (const text of ['fg', 'muted', 'fail', 'likely', 'advisory', 'info', 'accent']) expect(ratio(text, 'bg'), `${text} on bg`).toBeGreaterThanOrEqual(4.5);
      for (const text of ['fg', 'muted']) expect(ratio(text, 'soft'), `${text} on soft`).toBeGreaterThanOrEqual(4.5);
      // The primary button, and a pressed button (the two colours swapped).
      expect(ratio('on-accent', 'accent')).toBeGreaterThanOrEqual(4.5);
      expect(ratio('bg', 'fg')).toBeGreaterThanOrEqual(4.5);
      // Borders of controls and of findings, and the focus ring, against the page.
      for (const boundary of ['line', 'accent', 'fail', 'likely', 'advisory', 'info']) expect(ratio(boundary, 'bg'), `${boundary} against bg`).toBeGreaterThanOrEqual(3);
    });
  }

  it('nothing is animated, and reduced motion is honoured should that change', () => {
    expect(css.replace(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/, '')).not.toMatch(/animation|transition|@keyframes/);
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('color-scheme: light dark');
    expect(css).toMatch(/:focus-visible \{\s*outline: 3px solid var\(--accent\)/);
  });
});
