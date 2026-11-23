/**
 * Every limit and switch of the extension that is not a setting of a check. The checks, the
 * collector and the adjudicator layer keep theirs in the configuration of `@a11y-vision/core`.
 */
export interface ExtensionConfig {
  /**
   * OPEN DECISIONS of the owner (section 10 of the brief), each kept to one value here so that it
   * can be changed in one place. None of them is decided: these are the conservative defaults.
   */
  openDecisions: {
    /**
     * 10.4: `required` is the only mode there is. The page is read through `chrome.debugger`
     * (real Tab presses, the yellow bar while attached). A mode without it would be a second
     * collector of lower confidence; nothing here builds one.
     */
    debuggerMode: 'required';
    /** 10.5: no framework. State (`state.ts`) and rendering (`render.ts`) are apart, so that one can be adopted. */
    uiFramework: 'none';
    /** 10.6: an endpoint that is not on this machine is refused unless the user allows it, as in the CLI. */
    allowRemoteByDefault: false;
  };
  debugger: {
    /** Version of the DevTools protocol asked for when attaching. */
    protocolVersion: string;
    /**
     * Chrome's bar ("... started debugging this browser") comes up a moment after the debugger is
     * attached and takes room above the page (measured in Chromium 153: 56 CSS px, 130 to 160 ms
     * after attaching). The page is read once the size of its viewport has not changed for this
     * long, so that every scan sees the same viewport, the one with the bar.
     */
    viewportSettleMs: number;
    /** How often the size is asked while waiting for that. */
    viewportPollMs: number;
    /** The wait is given up after this long, and the page is read as it is. */
    viewportSettleTimeoutMs: number;
  };
  interference: {
    /** How often the page is asked whether the user touched it, in milliseconds. */
    pollMs: number;
    /** Stop when the tab goes to another document. Off: the collector reads the new document once, as the CLI does. */
    stopOnNavigation: boolean;
    /** Stop on a click, a key other than Tab, a turn of the wheel or a move of the pointer in the page. */
    stopOnUserInput: boolean;
    /** Stop when the pointer rests over the page: what is under it is then drawn in its hover state. */
    stopOnPointerOverPage: boolean;
    /** Stop when the tab is hidden: a hidden tab is not painted, and captures of it never come. */
    stopOnHidden: boolean;
    /** After a stop, how long the commands Chrome is still working on are waited for before the page is put back. */
    inFlightTimeoutMs: number;
    /**
     * After a stop, how long a step of putting the page back is waited for. A page that does not
     * answer (a dialog of its own is open, its main thread is busy) costs this once; the
     * debugger is then detached, which ends the emulation, and the panel says to reload.
     */
    restoreStepTimeoutMs: number;
  };
  panelClosed: {
    /**
     * When a panel goes away while attached, the service worker asks the page to undo what the
     * scan did inside it (focus, scroll positions, the style sheet) before it detaches. It
     * goes on after this long whether the page answered or not.
     */
    restoreTimeoutMs: number;
    /**
     * It then waits, before it detaches, until the viewport has kept its size and scale for this
     * long: a capture the panel had asked for may still be under way, and detaching in the
     * middle of one leaves the page with the viewport of the capture (see `viewport.ts`).
     */
    viewportSettleMs: number;
    viewportPollMs: number;
    /** That wait is given up after this long (a capture of a hidden tab never ends), and the debugger is detached. */
    viewportSettleTimeoutMs: number;
  };
  notes: {
    /** A note is written to storage this long after the last key, and at once when its field is left. */
    saveDebounceMs: number;
  };
  endpoint: {
    /**
     * The hosts a model endpoint may have over plain http: the only source of that list. The
     * settings check refuses any other, and `static/manifest.json` has to say the same in its
     * `connect-src` and its `optional_host_permissions` (a unit test compares them).
     * `*.name` is every name under `name`. Over https any host is reachable.
     *
     * Why not every loopback address: a host in a content security policy is letters, digits
     * and hyphens (CSP 3, section 2.3.1, `host-char`), so `[::1]` cannot be written there, and
     * of the IP addresses only 127.0.0.1 ever matches (same section).
     */
    httpHosts: readonly string[];
  };
  highlight: {
    /** The highlight is removed, and the debugger detached, after this long. */
    timeoutMs: number;
    /** Colours of the overlay, as CDP takes them. */
    border: { r: number; g: number; b: number; a: number };
    content: { r: number; g: number; b: number; a: number };
  };
  storage: {
    /** Pages whose decisions are kept; beyond that the ones not touched for longest are dropped. */
    maxPages: number;
    /** Decisions kept for one page; beyond that the oldest are dropped. */
    maxDecisionsPerPage: number;
    /** A note longer than this is cut. */
    maxNoteChars: number;
  };
  settings: {
    maxUrlChars: number;
    maxModelChars: number;
    maxKeyChars: number;
  };
  progress: {
    /** The counts of the collection are shown at most this often, in milliseconds. */
    refreshMs: number;
  };
}

export const extensionConfig: ExtensionConfig = {
  openDecisions: {
    debuggerMode: 'required',
    uiFramework: 'none',
    allowRemoteByDefault: false,
  },
  debugger: { protocolVersion: '1.3', viewportSettleMs: 400, viewportPollMs: 50, viewportSettleTimeoutMs: 3000 },
  interference: {
    pollMs: 250,
    stopOnNavigation: true,
    stopOnUserInput: true,
    stopOnPointerOverPage: true,
    stopOnHidden: true,
    inFlightTimeoutMs: 3000,
    restoreStepTimeoutMs: 2000,
  },
  panelClosed: { restoreTimeoutMs: 2000, viewportSettleMs: 400, viewportPollMs: 50, viewportSettleTimeoutMs: 3000 },
  notes: { saveDebounceMs: 600 },
  endpoint: { httpHosts: ['localhost', '*.localhost', '127.0.0.1'] },
  highlight: {
    timeoutMs: 8000,
    border: { r: 199, g: 0, b: 199, a: 1 },
    content: { r: 199, g: 0, b: 199, a: 0.25 },
  },
  storage: {
    maxPages: 300,
    maxDecisionsPerPage: 2000,
    maxNoteChars: 2000,
  },
  settings: {
    maxUrlChars: 2000,
    maxModelChars: 200,
    maxKeyChars: 4000,
  },
  progress: { refreshMs: 500 },
};
