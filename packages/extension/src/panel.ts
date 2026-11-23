import { AdjudicationConfigError, createMemoryCache } from '@a11y-vision/adjudicators';
import type { Adjudicator, MemoryCache } from '@a11y-vision/adjudicators';
import { resolveConfig } from '@a11y-vision/core';
import type { Config, Finding, Png, ScanResult } from '@a11y-vision/core';
import { PANEL_PORT } from './background-core.js';
import type { PanelMessage } from './background-core.js';
import type { ChromeApi, Port } from './chrome-api.js';
import { extensionConfig } from './config.js';
import { createDebuggerSession } from './debugger-session.js';
import type { DebuggerSession } from './debugger-session.js';
import { DecisionStore, decisionFor, pageStorageKey, withDecision } from './decisions.js';
import type { Decision, PageDecisions } from './decisions.js';
import { exportFile } from './export.js';
import type { ExportKind } from './export.js';
import { hideHighlight, showHighlight } from './highlight.js';
import { applyStaticText, decisionText, renderChecks, renderGroups, updateDecision } from './render.js';
import type { RenderContext } from './render.js';
import { runScan, ScanStopped } from './scan.js';
import type { ScanCounts, ScanPhase, StopKind } from './scan.js';
import { buildAdjudicator, checkEndpoint, CHECKS, safeMessage, SettingsStore } from './settings.js';
import type { Settings } from './settings.js';
import { countStatuses, groupFindings, selectedChecks } from './state.js';
import type { GroupBy, ShowFilter } from './state.js';
import { format, strings } from './strings.js';
import type { StringKey } from './strings.js';

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
let scanning: AbortController | null = null;
let scanned: { result: ScanResult; crops: Record<string, Png>; config: Config } | null = null;
let decisions: PageDecisions | null = null;
let decisionsKey = '';
let show: ShowFilter = 'all';
const cropUrls = new Map<string, string>();
let highlighted: { session: DebuggerSession; button: HTMLButtonElement; timer: ReturnType<typeof setTimeout> } | null = null;

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

/** The tab to work on: the one named in the address of this page (the panel opened as a window, for tests), else the active tab of this window. */
async function targetTab(): Promise<number | null> {
  const named = new URLSearchParams(location.search).get('tabId');
  if (named !== null && /^\d+$/.test(named)) return Number(named);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function showTarget(): Promise<void> {
  const tabId = await targetTab().catch(() => null);
  const tab = tabId === null ? undefined : await chrome.tabs.get(tabId).catch(() => undefined);
  // The title and the address are there only when Chrome gave access to the tab (activeTab).
  const page = tab?.title || tab?.url || '';
  setText('target', page === '' ? strings.targetUnknown : format(strings.targetKnown, { page }));
}

function showModelNotice(): void {
  const notice = byId('model-notice');
  const endpoint = settings.model.enabled ? checkEndpoint(settings.model) : null;
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
    handlers: { onDecision: (finding, decision) => void decide(finding, { decision }), onNote: (finding, note) => void decide(finding, { note }), onHighlight: (finding, button) => void toggleHighlight(finding, button) },
  };
}

function renderQueue(): void {
  if (!scanned) return;
  renderGroups(byId('findings'), groupFindings(scanned.result.findings, decisions, settings.groupBy, show), renderContext());
}

function findingNode(finding: Finding): HTMLElement | undefined {
  return [...byId('findings').querySelectorAll<HTMLElement>('article.finding')].find((node) => node.dataset['findingId'] === finding.id);
}

async function decide(finding: Finding, change: { decision?: Decision | null; note?: string }): Promise<void> {
  if (!scanned) return;
  const now = new Date();
  const current = decisionFor(decisions, finding);
  const next = { decision: change.decision !== undefined ? change.decision : (current?.decision ?? null), note: change.note ?? current?.note ?? '' };
  const page = withDecision(decisions ?? (await decisionStore.load(decisionsKey, now)), finding, next, extensionConfig.storage, now);
  try {
    await decisionStore.save(decisionsKey, page);
  } catch (error) {
    setText('action-status', format(strings.decisionFailed, { detail: error instanceof Error ? error.message : '' }));
    return;
  }
  decisions = page;
  const node = findingNode(finding);
  if (node) updateDecision(node, decisionFor(page, finding), strings);
  setText('action-status', change.decision !== undefined ? format(strings.decisionSaved, { state: decisionText(next.decision, strings) }) : strings.noteSaved);
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

async function toggleHighlight(finding: Finding, button: HTMLButtonElement): Promise<void> {
  const same = highlighted?.button === button;
  await clearHighlight(same);
  if (same || scanning) return;
  const tabId = await targetTab().catch(() => null);
  if (tabId === null) {
    setText('action-status', strings.noTab);
    return;
  }
  const session = createDebuggerSession(chrome.debugger, tabId, { protocolVersion: extensionConfig.debugger.protocolVersion });
  tell({ type: 'attaching', tabId });
  try {
    await session.attach();
    if (!(await showHighlight(session, finding, extensionConfig.highlight))) {
      await session.detach();
      tell({ type: 'released', tabId });
      setText('action-status', strings.highlightMissing);
      return;
    }
  } catch (error) {
    await session.detach();
    tell({ type: 'released', tabId });
    setText('action-status', format(strings.highlightFailed, { detail: error instanceof Error ? error.message : '' }));
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
  const file = exportFile(kind, scanned.result, scanned.crops, decisions, scanned.config);
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

/** One scan from the click to its end, whatever the end is. The count of ended scans is on the page for whoever drives it. */
async function startScan(): Promise<void> {
  try {
    await scanOnce();
  } finally {
    const root = doc.documentElement;
    root.dataset['scans'] = String(Number(root.dataset['scans'] ?? 0) + 1);
  }
}

async function scanOnce(): Promise<void> {
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
  const apiKey = settings.model.enabled ? await settingsStore.readKey() : '';
  let adjudicator: Adjudicator | null;
  let config: Config;
  try {
    const built = buildAdjudicator(settings.model, apiKey, (input, init) => fetch(input, init));
    adjudicator = built.adjudicator;
    config = resolveConfig({ checks, adjudication: built.config });
  } catch (error) {
    setText('error', format(strings.modelConfigError, { detail: error instanceof AdjudicationConfigError ? safeMessage(error, apiKey) : safeMessage(error, apiKey) }));
    return;
  }
  await clearHighlight(false);

  const controller = new AbortController();
  scanning = controller;
  setScanning(true);
  let lastCounts = 0;
  const cache = adjudicator ? await loadCache(config) : undefined;
  tell({ type: 'attaching', tabId });
  try {
    const outcome = await runScan({
      api: chrome,
      tabId,
      config,
      extension: extensionConfig,
      adjudicator,
      ...(cache ? { cache } : {}),
      signal: controller.signal,
      onPhase: (phase: ScanPhase) => setText('status', strings[PHASE_TEXT[phase]]),
      onCounts(counts: ScanCounts) {
        const now = Date.now();
        if (now - lastCounts < extensionConfig.progress.refreshMs) return;
        lastCounts = now;
        setText('counts', format(strings.counts, { tabs: counts.tabPresses, captures: counts.captures }));
      },
    });
    clearCrops();
    scanned = { result: outcome.result, crops: outcome.crops, config };
    decisionsKey = pageStorageKey(outcome.result.url, config);
    decisions = await decisionStore.load(decisionsKey, new Date());
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
    if (error instanceof ScanStopped) setText('error', format(strings[STOP_TEXT[error.kind]], { detail: error.detail }));
    else setText('error', format(strings.scanFailed, { detail: safeMessage(error, apiKey) }));
  } finally {
    tell({ type: 'released', tabId });
    scanning = null;
    setScanning(false);
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
  const endpoint = model.enabled ? checkEndpoint(model) : null;
  if (endpoint && !endpoint.ok) {
    setText('settings-error', strings[endpoint.problem]);
    byId('base-url').focus();
    return;
  }
  // Asked for inside the click that saves, as Chrome requires, and for this origin only. The
  // answer is not waited for: the settings are saved either way, and the line below says how it went.
  if (endpoint?.ok) {
    const origins = [endpoint.pattern];
    const { pattern } = endpoint;
    setText('permission-status', format(strings.permissionPending, { pattern }));
    chrome.permissions
      .contains({ origins })
      .then((has) => has || chrome.permissions.request({ origins }))
      .then(
        (granted) => setText('permission-status', format(granted ? strings.permissionGranted : strings.permissionDenied, { pattern })),
        () => setText('permission-status', format(strings.permissionDenied, { pattern })),
      );
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
  renderChecks(byId('checks'), CHECKS, settings.checks, doc, strings);
  fillSettingsForm(await settingsStore.hasKey());
  showModelNotice();
  void showTarget();
  chrome.tabs.onActivated.addListener(() => void showTarget());

  byId('scan-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (scanning) scanning.abort(new ScanStopped('user'));
    else void startScan();
  });
  byId<HTMLSelectElement>('group-by').addEventListener('change', (event) => {
    settings = { ...settings, groupBy: ((event.target as HTMLSelectElement).value === 'check' ? 'check' : 'status') satisfies GroupBy };
    void settingsStore.save(settings).catch(() => undefined);
    renderQueue();
  });
  byId<HTMLSelectElement>('show').addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value;
    show = value === 'to-review' || value === 'confirmed' || value === 'dismissed' ? value : 'all';
    renderQueue();
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
  // The panel is going away: stop, so that the page is put back while the session is still there.
  // The service worker detaches whatever is left when the port closes.
  addEventListener('pagehide', () => {
    scanning?.abort(new ScanStopped('panel-closed'));
    void clearHighlight(false);
  });
  doc.documentElement.dataset['ready'] = 'true';
}

void init();
