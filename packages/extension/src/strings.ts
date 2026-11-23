/**
 * Every text the panel shows, in one place, so that it can be translated: a translation is
 * another object of this shape. English only for now.
 *
 * Wording: the tool assists a tester. Nothing here says that a page passes, conforms or is
 * accessible; an empty list of findings is described as what it is.
 *
 * `{name}` in a text is replaced by `format`.
 */
export const en = {
  title: 'a11y-vision',
  intro: 'Checks for WCAG 2.2 A and AA items that rule engines do not cover. It assists a tester and makes no statement about conformance.',

  scanHeading: 'Scan',
  checksLegend: 'Checks to run',
  checkFocus: 'Focus indicator (2.4.7, 1.4.11, 2.4.11)',
  checkIcons: 'Icons and control boundaries (1.4.11)',
  checkHeadings: 'Headings (1.3.1)',
  checkLists: 'Lists (1.3.1)',
  checkGrouping: 'Grouping of form controls (1.3.1)',
  scanButton: 'Scan this page',
  stopButton: 'Stop the scan',
  scanNote:
    'A scan attaches the Chrome debugger to the tab, and Chrome shows a bar saying that this extension is debugging the browser. While it runs the page is resized, scrolled and walked with the Tab key; afterwards it is put back and the debugger is detached. Do not use the page until the scan is over, and keep the pointer off it.',
  targetKnown: 'Page to scan: {page}',
  targetUnknown: 'Page to scan: the active tab of this window.',
  noChecks: 'Choose at least one check.',
  noTab: 'There is no tab to scan in this window.',

  phaseAttaching: 'Attaching the debugger to the tab.',
  phaseReading: 'Reading the page. Do not use it until this is over.',
  phaseRestoring: 'Putting the page back and detaching the debugger.',
  phaseEvaluating: 'Evaluating what was read.',
  phaseJudging: 'Asking the model about the candidates. The page is no longer involved.',
  counts: '{tabs} Tab presses, {captures} captures so far.',
  scanDone: 'Scan finished: {total} findings. {fail} fail, {likely} likely, {advisory} advisory, {info} info.',
  scanDoneNone: 'Scan finished. The checks that ran reported nothing. That is not a statement that the page conforms: the checks cover a few criteria only.',
  judgingStopped: 'Asking the model was stopped. The findings are those of deterministic code alone.',
  modelStats: 'Model: {judged} candidates judged now, {cached} read from the cache, {calls} requests.',
  navigatedFrom: 'The page went on from {from} while it was read; what is shown is the page it ended on.',

  stoppedUser: 'The scan was stopped. The page was put back and nothing is reported.',
  stoppedInput: 'The scan was stopped because the page was used while it was being read (a click, a key, the wheel or the pointer moving over it). The page was put back and nothing is reported. Scan again and leave the page alone until it is over.',
  stoppedPointer: 'The scan was stopped because the pointer is over the page: what is under it is drawn in its hover state, and that would be measured. Move the pointer off the page, onto this panel for instance, and scan again.',
  stoppedHidden: 'The scan was stopped because the tab was hidden. A hidden tab is not drawn, so nothing can be captured. The page was put back. Keep the tab in front and scan again.',
  stoppedNavigation: 'The scan was stopped because the tab went to another page while it was being read. Nothing is reported. Scan again once the page has settled.',
  stoppedTabClosed: 'The scan was stopped because the tab was closed.',
  stoppedDetachedByUser:
    'The scan was stopped because debugging was cancelled from the bar of Chrome. Nothing is reported. The page could not be put back through the debugger: reload it to be sure it is as it was (animations may still be switched off and it may be scrolled).',
  stoppedDetached: 'The scan was stopped because the debugger was detached from the tab. Nothing is reported. Reload the page to be sure it is as it was.',
  cannotAttach: 'The debugger could not be attached to this tab, so it cannot be scanned. Chrome said: {detail} Pages of Chrome itself, of the Chrome Web Store and of other extensions cannot be debugged.',
  scanFailed: 'The scan failed: {detail}',
  modelConfigError: 'The model settings cannot be used, so the scan was not started: {detail}',

  resultsHeading: 'Findings',
  resultsFor: 'Scanned {url} at {time}.',
  groupByLabel: 'Group by',
  groupByStatus: 'Status',
  groupByCheck: 'Check',
  showLabel: 'Show',
  showAll: 'All findings',
  showToReview: 'Not decided yet',
  showConfirmed: 'Confirmed',
  showDismissed: 'Dismissed',
  nothingShown: 'No finding matches what is selected under "Show".',
  groupCount: '{title} ({count})',

  statusFail: 'Fail',
  statusLikely: 'Likely',
  statusAdvisory: 'Advisory',
  statusInfo: 'Info',
  noteFail: 'Measured or structurally certain.',
  noteLikely: 'Needs confirmation by a tester.',
  noteAdvisory: 'Best practice, not a failure.',
  noteInfo: 'Inventory of what was found and measured.',

  findingTitle: '{status}: {rule}',
  modelSaid: 'Model: {verdict}',
  selectorLabel: 'Selector',
  frameLabel: 'Frame',
  criterionLabel: 'Success criterion',
  criterionValue: '{sc} (Level {level})',
  criterionNone: 'None',
  ruleLabel: 'Rule',
  detailsSummary: 'Measured values and details',
  measuredRatio: 'Measured {role}',
  ratioValue: '{ratio}:1',
  colourLabel: 'Colour: {role}',
  flagsLabel: 'Flags',
  boxLabel: 'Box (CSS px)',
  boxValue: '{width} by {height} at {x}, {y}',
  yes: 'yes',
  no: 'no',
  unknown: 'unknown',
  findingIdLabel: 'Finding id',
  modelLabel: 'Model',
  modelValue: '{model} ({provider}), prompt {prompt}',
  modelVerdictLabel: 'Model verdict',
  modelVerdictValue: '{verdict}, {confidence} confidence, from {inputs}',
  modelInputsText: 'the text alone',
  modelInputsImage: 'the text and the capture',
  modelFromCache: ', read from the cache (no model was asked in this scan)',
  modelVotesLabel: 'Model votes',
  modelProblemsLabel: 'Model calls failed',
  modelRationaleLabel: 'Model rationale',
  modelStatusBeforeLabel: 'Status without the model',

  cropFocused: 'Focused',
  cropUnfocused: 'Not focused',
  cropAtRest: 'At rest',
  cropInContext: 'In context',
  cropCapture: 'Capture',
  cropAlt: '{label} capture of {selector}',

  decisionLegend: 'Your decision',
  decisionNone: 'Not decided',
  decisionConfirmed: 'Confirmed',
  decisionDismissed: 'Dismissed',
  decisionState: 'Decision: {state}',
  confirmButton: 'Confirm',
  dismissButton: 'Dismiss',
  noteLabel: 'Note (optional)',
  decisionSaved: 'Decision saved: {state}.',
  noteSaved: 'Note saved.',
  decisionFailed: 'The decision could not be saved: {detail}',
  highlightButton: 'Show on the page',
  highlightOn: 'The element is highlighted on the page and scrolled into view. Chrome shows its debugging bar while the highlight is there; it goes away by itself.',
  highlightOff: 'The highlight was removed.',
  highlightMissing: 'The element is no longer on the page where the finding places it. Nothing was highlighted.',
  highlightFailed: 'The element could not be highlighted: {detail}',

  exportHeading: 'Export',
  exportJson: 'Download JSON',
  exportHtml: 'Download HTML report',
  exportSarif: 'Download SARIF',
  exportNote: 'The JSON carries your decisions and notes. The HTML report embeds the captures. No export contains the model settings or the key.',
  exported: 'Downloaded {name}.',

  settingsHeading: 'Model (optional)',
  settingsSummary: 'Settings of the model that judges candidates',
  settingsIntro:
    'Off by default, and every check works without it. When it is on, a model is asked about heading, list and group candidates. For each candidate, text of the page and a capture of it are sent to the endpoint below, from this extension and never from the page. A verdict of a model never makes a finding a fail.',
  modelEnable: 'Ask a model',
  baseUrlLabel: 'Base URL of an OpenAI-compatible endpoint, up to /v1',
  baseUrlHint: 'On this machine: http://localhost:<port>/v1 or http://127.0.0.1:<port>/v1.',
  modelNameLabel: 'Model name',
  apiKeyLabel: 'API key (leave empty for an endpoint that takes none)',
  apiKeyHint: 'Kept in the storage of this extension on this machine, not synced, not encrypted by the extension. It is sent to the endpoint above and nowhere else.',
  apiKeyStored: 'A key is stored. Leave the field empty to keep it.',
  apiKeyNone: 'No key is stored.',
  apiKeyRemove: 'Remove the stored key',
  apiKeyRemoved: 'The stored key was removed.',
  allowRemoteLabel: 'Allow an endpoint that is not on this machine (https only). Page text and captures then leave this machine.',
  sendImagesLabel: 'Send captures (switch off for a model without vision)',
  saveSettings: 'Save model settings',
  settingsSaved: 'Model settings saved.',
  settingsSavedOff: 'Model settings saved. No model is asked.',
  permissionGranted: 'Chrome gave this extension access to {pattern}.',
  permissionDenied:
    'Access to {pattern} was not given. Requests will only work if the endpoint itself allows requests from this extension (CORS).',
  permissionPending: 'Chrome is asking whether this extension may access {pattern}.',
  modelOnLocal: 'A model is asked: text and captures of the page go to the model {model} on {host} (this machine).',
  modelOnRemote: 'A model is asked: text and captures of the page go to the model {model} on {host}, which is NOT this machine.',
  endpointMissing: 'Give the base URL of the endpoint. None is assumed.',
  modelMissing: 'Give the name of the model. None is assumed.',
  endpointInvalid: 'The base URL is not a valid URL.',
  endpointScheme: 'The base URL has to start with http:// or https://.',
  endpointCredentials: 'The base URL must not carry a user name or a password. Put the key in the key field.',
  endpointQuery: 'The base URL must not have a query string or a fragment.',
  endpointRemoteNotAllowed: 'This endpoint is not on this machine. Page text and captures would be sent there, so it has to be allowed explicitly with the checkbox below.',
  endpointRemoteHttp: 'An endpoint that is not on this machine has to be an https URL: over plain http the page text, the captures and the key would travel unencrypted.',
} as const;

export type StringKey = keyof typeof en;
export type Strings = Record<StringKey, string>;

/** The texts in use. A translation replaces this object. */
export const strings: Strings = en;

/** `text` with each `{name}` replaced by the value of that name; a name without a value stays as it is. */
export function format(text: string, values: Record<string, string | number> = {}): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
}
