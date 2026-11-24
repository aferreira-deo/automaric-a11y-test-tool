import { createMemoryCache } from '@a11y-vision/adjudicators';
import type { Adjudicator, MemoryCache } from '@a11y-vision/adjudicators';
import { resolveConfig } from '@a11y-vision/core';
import type { Config, Finding, Png, ScanResult } from '@a11y-vision/core';
import { PANEL_PORT } from './background-core.js';
import type { PanelMessage } from './background-core.js';
import type { ChromeApi, Port } from './chrome-api.js';
import { extensionConfig } from './config.js';
import { createDebuggerSession } from './debugger-session.js';
import type { DebuggerSession } from './debugger-session.js';
import { DecisionSession, DecisionStore, pageStorageKey } from './decisions.js';
import type { Decision } from './decisions.js';
import { exportFile } from './export.js';
import type { ExportKind } from './export.js';
import { hideHighlight, showHighlight } from './highlight.js';
import { applyStaticText, decisionText, renderChecks, renderGroups, updateDecision } from './render.js';
import type { RenderContext } from './render.js';
import { runScan, ScanStopped } from './scan.js';
import type { ScanCounts, ScanPhase, StopKind } from './scan.js';
import { applyPermissionChange, buildAdjudicator, checkEndpoint, CHECKS, endpointPermissionChange, safeMessage, SettingsStore } from './settings.js';
import type { Settings } from './settings.js';
import { countStatuses, groupFindings, selectedChecks } from './state.js';
import type { GroupBy, ShowFilter } from './state.js';
import { format, strings } from './strings.js';
import type { StringKey } from './strings.js';
import { ticketedTab } from './target.js';

/**
 * The side panel: holds what was scanned and decided, and wires the form, the queue and the
 * settings to it. Everything runs here, in an extension page: the debugger session, the checks,
 * the requests to a model and the exports. The page under test runs none of this code and
 * cannot reach it.
 */

declare const chrome: ChromeApi;

const VERDICT_CACHE_KEY = 'verdict-cache';
const PHASE_TEXT: Record<ScanPhase, StringKey> = {
  attaching: 'phaseAttaching',
  reading: 'phaseReading',
  restoring: 'phaseRestoring',
  evaluating: 'phaseEvaluating',
  judging: 'phaseJudging',
};
const STOP_TEXT: Record<StopKind, StringKey> = {
  user: 'stoppedUser',
  'panel-closed': 'stoppedUser',
  input: 'stoppedInput',
  'pointer-over-page': 'stoppedPointer',
  hidden: 'stoppedHidden',
  navigation: 'stoppedNavigation',
  'tab-closed': 'stoppedTabClosed',
  'detached-by-user': 'stoppedDetachedByUser',
  detached: 'stoppedDetached',
  'cannot-attach': 'cannotAttach',
};

const doc = document;
const byId = <T extends HTMLElement = HTMLElement>(id: string): T => doc.getElementById(id) as T;

const settingsStore = new SettingsStore(chrome.storage.local, extensionConfig);
const decisionStore = new DecisionStore(chrome.storage.local, extensionConfig.storage);

let settings: Settings;

/**
 * The scan this panel has under way, from the activation of the button on. It is claimed there,
 * before anything is awaited: whatever is activated next finds it, and no second scan can start
 * beside it.
 * - `starting`: settings are read and checked; the page has not been touched. Another activation
 *   of the button in that moment is not a wish to stop (a double click, a key that repeats)
 *   and does nothing.
 * - `running`: from the moment the debugger is about to be attached. The button says Stop, and stops.
 */
interface RunningScan {
  controller: AbortController;
  phase: 'starting' | 'running';
  /** The tab the service worker was told about, to be told again when it is let go. */
  attaching: number | null;
}
let scan: RunningScan | null = null;

/** What the last scan gave, the decisions about it, and what it was a scan of. */
interface Scanned {
  result: ScanResult;
  crops: Record<string, Png>;
  config: Config;
  decisions: DecisionSession;
  document: { tabId: number; loaderId: string };
}
let scanned: Scanned | null = null;
let show: ShowFilter = 'all';
const cropUrls = new Map<string, string>();
let highlighted: { session: DebuggerSession; button: HTMLButtonElement; timer: ReturnType<typeof setTimeout> } | null = null;
/** A highlight is being switched on or off: one at a time, and a scan waits for it. */
let highlightBusy = false;
let highlightWork: Promise<void> = Promise.resolve();
/** Runs when a note has not been typed in for a moment, to write it to storage. */
let noteTimer: ReturnType<typeof setTimeout> | undefined;
/** The tab this page was opened for by the extension itself, when it is not a side panel (see `target.ts`). */
let ticketed: number | null = null;
/** The tab the line "Page to scan" was last written for. */
let shownTarget: number | null = null;

/** The port to the service worker, opened again when the worker had gone to sleep and closed it. */
let port: Port | null = null;
function tell(message: PanelMessage): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!port) {
        const opened = chrome.runtime.connect({ name: PANEL_PORT });
        opened.onDisconnect.addListener(() => {
          if (port === opened) port = null;
        });
        port = opened;
      }
      port.postMessage(message);
      return;
    } catch {
      port = null;
    }
  }
}

function setText(id: string, text: string): void {
  byId(id).textContent = text;
}

/** The tab to scan: the active tab of this window, or the one this page was opened for. Never one named in an address. */
async function targetTab(): Promise<number | null> {
  if (ticketed !== null) return ticketed;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function showTarget(): Promise<void> {
  const tabId = await targetTab().catch(() => null);
  shownTarget = tabId;
  const tab = tabId === null ? undefined : await chrome.tabs.get(tabId).catch(() => undefined);
  // The title and the address are there only when Chrome gave access to the tab (activeTab).
  // That access ends when the tab goes to another site: the line then names no page.
  const page = tab?.title || tab?.url || '';
  setText('target', page === '' ? strings.targetUnknown : format(strings.targetKnown, { page }));
}

function showModelNotice(): void {
  const notice = byId('model-notice');
  const endpoint = settings.model.enabled ? checkEndpoint(settings.model, extensionConfig.endpoint) : null;
  notice.hidden = !endpoint?.ok;
  notice.textContent = endpoint?.ok ? format(endpoint.local ? strings.modelOnLocal : strings.modelOnRemote, { model: settings.model.model, host: endpoint.host }) : '';
}

function setScanning(active: boolean): void {
  const button = byId<HTMLButtonElement>('scan');
  button.textContent = active ? strings.stopButton : strings.scanButton;
  byId('results').setAttribute('aria-busy', String(active));
  for (const input of byId('checks').querySelectorAll('input')) input.disabled = active;
}

function clearCrops(): void {
  for (const url of cropUrls.values()) URL.revokeObjectURL(url);
  cropUrls.clear();
}

function renderContext(): RenderContext {
  return {
    doc,
    strings,
    cropUrl(id) {
      const known = cropUrls.get(id);
      if (known) return known;
      const png = scanned?.crops[id];
      if (!png) return undefined;
      const url = URL.createObjectURL(new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
      cropUrls.set(id, url);
      return url;
    },
    maxNoteChars: extensionConfig.storage.maxNoteChars,
    handlers: {
      onDecision: (finding, decision) => decide(finding, { decision }, 'now'),
      onNoteInput: (finding, note) => decide(finding, { note }, 'later'),
      onNote: (finding, note) => decide(finding, { note }, 'now'),
      onHighlight,
    },
  };
}

/** Draws the queue again and gives the number of findings it shows. */
function renderQueue(): number {
  if (!scanned) return 0;
  // The buttons are made anew: a highlight that one of them had switched on goes with it.
  void clearHighlight(false);
  const groups = groupFindings(scanned.result.findings, scanned.decisions.page, settings.groupBy, show);
  renderGroups(byId('findings'), groups, renderContext());
  return groups.reduce((sum, group) => sum + group.items.length, 0);
}

function findingNode(finding: Finding): HTMLElement | undefined {
  return [...byId('findings').querySelectorAll<HTMLElement>('article.finding')].find((node) => node.dataset['findingId'] === finding.id);
}

/**
 * Writes the decisions that changed to storage, now. `announce` is said in the live region once
 * they are there; null says nothing (a note saved while it is typed: an announcement after
 * every pause would talk over the typing). A failure is always said.
 */
function saveDecisions(announce: string | null): void {
  if (noteTimer !== undefined) clearTimeout(noteTimer);
  noteTimer = undefined;
  const session = scanned?.decisions;
  if (!session) return;
  session.save().then(
    () => {
      if (announce !== null && scanned?.decisions === session) setText('action-status', announce);
    },
    (error: unknown) => setText('action-status', format(strings.decisionFailed, { detail: error instanceof Error ? error.message : '' })),
  );
}

/**
 * A decision or a note. What the panel holds changes here and now, before anything is awaited,
 * so that what comes next builds on it. `later`: storage is written once nothing more was typed
 * for `notes.saveDebounceMs`. Only the decision controls of the card are brought up to date; the
 * note field is never touched, so focus and the caret stay where they are.
 */
function decide(finding: Finding, change: { decision?: Decision | null; note?: string }, save: 'now' | 'later'): void {
  if (!scanned) return;
  const entry = scanned.decisions.set(finding, change, new Date());
  const node = findingNode(finding);
  if (node) updateDecision(node, entry, strings);
  if (save === 'later') {
    if (noteTimer !== undefined) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => saveDecisions(null), extensionConfig.notes.saveDebounceMs);
    return;
  }
  saveDecisions(change.decision !== undefined ? format(strings.decisionSaved, { state: decisionText(entry?.decision, strings) }) : strings.noteSaved);
}

async function clearHighlight(announce: boolean): Promise<void> {
  const current = highlighted;
  if (!current) return;
  highlighted = null;
  clearTimeout(current.timer);
  current.button.setAttribute('aria-pressed', 'false');
  await hideHighlight(current.session);
  await current.session.detach();
  tell({ type: 'released', tabId: current.session.tabId });
  if (announce) setText('action-status', strings.highlightOff);
}

function onHighlight(finding: Finding, button: HTMLButtonElement): void {
  // One at a time: a second attach to the tab would fail, and its clean-up would let go of the first.
  if (highlightBusy) return;
  highlightBusy = true;
  highlightWork = toggleHighlight(finding, button)
    .catch(() => undefined)
    .finally(() => {
      highlightBusy = false;
    });
}

async function toggleHighlight(finding: Finding, button: HTMLButtonElement): Promise<void> {
  const same = highlighted?.button === button;
  await clearHighlight(same);
  if (same || scan || !scanned) return;
  // The tab that was scanned, not the one in front now: a finding is about that page.
  const target = scanned.document;
  const { tabId } = target;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    setText('action-status', strings.highlightTabGone);
    return;
  }
  // Nothing can be shown on a tab that is behind another.
  if (tab.active === false) {
    setText('action-status', strings.highlightTabHidden);
    return;
  }
  const session = createDebuggerSession(chrome.debugger, tabId, { protocolVersion: extensionConfig.debugger.protocolVersion });
  tell({ type: 'attaching', tabId });
  let shown: Awaited<ReturnType<typeof showHighlight>>;
  try {
    await session.attach();
    shown = await showHighlight(session, finding, extensionConfig.highlight, target);
  } catch (error) {
    await session.detach();
    tell({ type: 'released', tabId });
    setText('action-status', format(strings.highlightFailed, { detail: error instanceof Error ? error.message : '' }));
    return;
  }
  if (shown !== 'shown') {
    await session.detach();
    tell({ type: 'released', tabId });
    setText('action-status', shown === 'missing' ? strings.highlightMissing : strings.highlightPageChanged);
    return;
  }
  button.setAttribute('aria-pressed', 'true');
  highlighted = { session, button, timer: setTimeout(() => void clearHighlight(true), extensionConfig.highlight.timeoutMs) };
  // The bar's Cancel, or the tab closing: the overlay went with the session.
  session.onDetached(() => {
    if (highlighted?.session !== session) return;
    clearTimeout(highlighted.timer);
    highlighted = null;
    button.setAttribute('aria-pressed', 'false');
    setText('action-status', strings.highlightOff);
  });
  setText('action-status', strings.highlightOn);
}

function download(kind: ExportKind): void {
  if (!scanned) return;
  const file = exportFile(kind, scanned.result, scanned.crops, scanned.decisions.page, scanned.config);
  const url = URL.createObjectURL(new Blob([file.text], { type: file.type }));
  const link = byId<HTMLAnchorElement>('download');
  link.href = url;
  link.download = file.name;
  link.click();
  // The download has started by the time the timer runs; the URL is of no use after that.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  setText('action-status', format(strings.exported, { name: file.name }));
}

async function loadCache(config: Config): Promise<MemoryCache> {
  const stored = (await chrome.storage.local.get(VERDICT_CACHE_KEY).catch((): Record<string, unknown> => ({})))[VERDICT_CACHE_KEY];
  return createMemoryCache({ maxEntries: config.adjudication.cacheMaxEntries, maxRationaleChars: config.adjudication.maxRationaleChars, from: stored });
}

/**
 * One scan from the activation of the button to its end, whatever the end is. Called only when
 * no scan is under way, and claims the place at once. What it cleans up at the end is its own:
 * the tab it told the service worker about, and the place if it still holds it. The count of
 * ended scans is on the page for whoever drives it.
 */
async function startScan(): Promise<void> {
  const mine: RunningScan = { controller: new AbortController(), phase: 'starting', attaching: null };
  scan = mine;
  try {
    await scanOnce(mine);
  } finally {
    if (mine.attaching !== null) tell({ type: 'released', tabId: mine.attaching });
    if (scan === mine) {
      scan = null;
      setScanning(false);
    }
    const root = doc.documentElement;
    root.dataset['scans'] = String(Number(root.dataset['scans'] ?? 0) + 1);
  }
}

async function scanOnce(mine: RunningScan): Promise<void> {
  const { signal } = mine.controller;
  setText('error', '');
  setText('status', '');
  setText('counts', '');
  const checks = selectedChecks([...byId('checks').querySelectorAll<HTMLInputElement>('input:checked')].map((input) => input.value));
  if (checks.length === 0) {
    setText('error', strings.noChecks);
    return;
  }
  settings = { ...settings, checks };
  await settingsStore.save(settings).catch(() => undefined);
  const tabId = await targetTab().catch(() => null);
  if (tabId === null) {
    setText('error', strings.noTab);
    return;
  }
  // Before anything is done to the page: settings of a model that cannot be used stop the scan here.
  const { model } = settings;
  const endpoint = model.enabled ? checkEndpoint(model, extensionConfig.endpoint) : null;
  if (endpoint && !endpoint.ok) {
    setText('error', format(strings.modelConfigError, { detail: strings[endpoint.problem] }));
    return;
  }
  const apiKey = model.enabled ? await settingsStore.readKey() : '';
  let adjudicator: Adjudicator | null;
  let config: Config;
  try {
    const built = buildAdjudicator(model, apiKey, (input, init) => fetch(input, init));
    adjudicator = built.adjudicator;
    // Nothing is activated from the extension: see `extensionConfig.openDecisions.probe`.
    config = resolveConfig({ checks, adjudication: built.config, nameRoleValue: { probe: extensionConfig.openDecisions.probe } });
  } catch (error) {
    setText('error', format(strings.modelConfigError, { detail: safeMessage(error, apiKey) }));
    return;
  }
  // The tab is free of this panel's own highlight before the scan attaches to it.
  await highlightWork;
  await clearHighlight(false);
  // What was decided about the last scan and is not in storage yet goes there now.
  if (scanned?.decisions.unsaved) saveDecisions(null);
  const cache = adjudicator ? await loadCache(config) : undefined;
  // The panel is going away: nothing is started.
  if (signal.aborted) return;

  mine.phase = 'running';
  setScanning(true);
  let lastCounts = 0;
  mine.attaching = tabId;
  tell({ type: 'attaching', tabId });
  try {
    const outcome = await runScan({
      api: chrome,
      tabId,
      config,
      extension: extensionConfig,
      adjudicator,
      ...(cache ? { cache } : {}),
      signal,
      onPhase: (phase: ScanPhase) => setText('status', strings[PHASE_TEXT[phase]]),
      onCounts(counts: ScanCounts) {
        const now = Date.now();
        if (now - lastCounts < extensionConfig.progress.refreshMs) return;
        lastCounts = now;
        setText('counts', format(strings.counts, { tabs: counts.tabPresses, captures: counts.captures }));
      },
    });
    const key = pageStorageKey(outcome.result.url, config);
    const decisions = new DecisionSession(decisionStore, key, await decisionStore.load(key, new Date()), extensionConfig.storage);
    clearCrops();
    scanned = { result: outcome.result, crops: outcome.crops, config, decisions, document: outcome.document };
    if (cache?.dirty) await chrome.storage.local.set({ [VERDICT_CACHE_KEY]: cache.toJSON() }).catch(() => undefined);

    const counts = countStatuses(outcome.result.findings);
    const total = outcome.result.findings.length;
    const summary = total === 0 ? strings.scanDoneNone : format(strings.scanDone, { total, ...counts });
    const notes: string[] = [];
    if (outcome.result.environment.navigatedFrom) notes.push(format(strings.navigatedFrom, { from: outcome.result.environment.navigatedFrom }));
    if (outcome.judgingStopped) notes.push(strings.judgingStopped);
    if (outcome.adjudication) notes.push(format(strings.modelStats, { judged: outcome.adjudication.judged, cached: outcome.adjudication.cached, calls: outcome.adjudication.calls }));
    const note = byId('results-note');
    note.hidden = notes.length === 0;
    note.textContent = notes.join(' ');
    setText('results-for', format(strings.resultsFor, { url: outcome.result.url, time: outcome.result.timestamp }));
    setText('summary', summary);
    setText('action-status', '');
    byId('results').hidden = false;
    renderQueue();
    setText('status', summary);
    setText('counts', '');
    byId('results-heading').focus();
  } catch (error) {
    setText('status', '');
    setText('counts', '');
    if (error instanceof ScanStopped) setText('error', error.restoreIncomplete ? strings.stoppedNotRestored : format(strings[STOP_TEXT[error.kind]], { detail: error.detail }));
    else setText('error', format(strings.scanFailed, { detail: safeMessage(error, apiKey) }));
  }
}

function fillSettingsForm(hasKey: boolean): void {
  byId<HTMLInputElement>('model-enabled').checked = settings.model.enabled;
  byId<HTMLInputElement>('base-url').value = settings.model.baseUrl;
  byId<HTMLInputElement>('model-name').value = settings.model.model;
  byId<HTMLInputElement>('allow-remote').checked = settings.model.allowRemote;
  byId<HTMLInputElement>('send-images').checked = settings.model.sendImages;
  byId<HTMLInputElement>('api-key').value = '';
  setText('api-key-state', hasKey ? strings.apiKeyStored : strings.apiKeyNone);
  byId('remove-key').hidden = !hasKey;
  byId<HTMLSelectElement>('group-by').value = settings.groupBy;
}

async function saveSettings(): Promise<void> {
  setText('settings-error', '');
  setText('settings-status', '');
  setText('permission-status', '');
  const model = {
    enabled: byId<HTMLInputElement>('model-enabled').checked,
    baseUrl: byId<HTMLInputElement>('base-url').value.trim().slice(0, extensionConfig.settings.maxUrlChars),
    model: byId<HTMLInputElement>('model-name').value.trim().slice(0, extensionConfig.settings.maxModelChars),
    allowRemote: byId<HTMLInputElement>('allow-remote').checked,
    sendImages: byId<HTMLInputElement>('send-images').checked,
  };
  const endpoint = model.enabled ? checkEndpoint(model, extensionConfig.endpoint) : null;
  if (endpoint && !endpoint.ok) {
    setText('settings-error', strings[endpoint.problem]);
    byId('base-url').focus();
    return;
  }
  // The host permission follows the endpoint: asked for the origin in use, inside the click that
  // saves, as Chrome requires, and given up for the origin that was in use before when that is
  // another one or the model is switched off. The answers are not waited for: the settings are
  // saved either way, and the line below says how it went.
  const change = endpointPermissionChange(settings.model, model, extensionConfig.endpoint);
  const { granted, removed } = applyPermissionChange(chrome.permissions, change);
  const said = (key: 'permissionGranted' | 'permissionDenied' | 'permissionPending' | 'permissionRemoved', pattern: string | null): void => setText('permission-status', format(strings[key], { pattern: pattern ?? '' }));
  if (granted) {
    said('permissionPending', change.request);
    void granted.then((given) => said(given ? 'permissionGranted' : 'permissionDenied', change.request));
  } else if (removed) {
    void removed.then((gone) => {
      if (gone) said('permissionRemoved', change.remove);
    });
  }
  const key = byId<HTMLInputElement>('api-key').value;
  if (key.trim() !== '') await settingsStore.setKey(key);
  settings = { ...settings, model };
  await settingsStore.save(settings);
  fillSettingsForm(await settingsStore.hasKey());
  showModelNotice();
  setText('settings-status', model.enabled ? strings.settingsSaved : strings.settingsSavedOff);
}

async function init(): Promise<void> {
  applyStaticText(doc, strings);
  doc.title = strings.title;
  settings = await settingsStore.load();
  ticketed = await ticketedTab(location.search, chrome.storage.session);
  renderChecks(byId('checks'), CHECKS, settings.checks, doc, strings);
  fillSettingsForm(await settingsStore.hasKey());
  showModelNotice();
  void showTarget();
  // Kept current: another tab comes to the front, or the tab in front goes to another page or
  // gets its title. Both events come without a permission of their own.
  chrome.tabs.onActivated.addListener(() => void showTarget());
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (tabId === shownTarget && (change.status !== undefined || change.title !== undefined || change.url !== undefined)) void showTarget();
  });

  byId('scan-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!scan) void startScan();
    else if (scan.phase === 'running') scan.controller.abort(new ScanStopped('user'));
  });
  byId<HTMLSelectElement>('group-by').addEventListener('change', (event) => {
    settings = { ...settings, groupBy: ((event.target as HTMLSelectElement).value === 'check' ? 'check' : 'status') satisfies GroupBy };
    void settingsStore.save(settings).catch(() => undefined);
    renderQueue();
  });
  byId<HTMLSelectElement>('show').addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value;
    show = value === 'to-review' || value === 'confirmed' || value === 'dismissed' ? value : 'all';
    if (!scanned) return;
    // Said in the live region of the queue: what the list now holds is not seen by everyone.
    setText('action-status', format(strings.filterShown, { shown: renderQueue(), total: scanned.result.findings.length }));
  });
  byId('export-json').addEventListener('click', () => download('json'));
  byId('export-html').addEventListener('click', () => download('html'));
  byId('export-sarif').addEventListener('click', () => download('sarif'));
  byId('settings-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void saveSettings().catch((error: unknown) => setText('settings-error', error instanceof Error ? error.message : ''));
  });
  byId('remove-key').addEventListener('click', () => {
    void settingsStore.clearKey().then(() => {
      fillSettingsForm(false);
      setText('settings-status', strings.apiKeyRemoved);
      byId('api-key').focus();
    });
  });
  // The panel is going away: stop, and hand what is not saved to storage while there is time.
  // The service worker has the page put back and detaches whatever is left when the port closes.
  addEventListener('pagehide', () => {
    scan?.controller.abort(new ScanStopped('panel-closed'));
    void clearHighlight(false);
    if (scanned?.decisions.unsaved) saveDecisions(null);
  });
  doc.documentElement.dataset['ready'] = 'true';
}

void init();
