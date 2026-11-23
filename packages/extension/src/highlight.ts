import type { CdpSession } from '@a11y-vision/collector-cdp';
import type { Finding } from '@a11y-vision/core';
import type { ExtensionConfig } from './config.js';

const HIGHLIGHT_WORLD = 'a11y-vision-highlight';
/** What joins the parts of a selector that crosses shadow roots, and the frames of a frame path: as the collector writes them. */
const JOIN = ' >>> ';

/**
 * Runs in an isolated world of the page. Finds the element a finding names: through the
 * same-origin iframes of `frame`, then through the open shadow roots of `selector`, and scrolls
 * it to the middle of the viewport (the enclosing frames with it). Null when it is not there
 * any more, or not where the selector says.
 */
function locate(frame: string, selector: string, join: string): Element | null {
  const step = (root: Document | ShadowRoot, part: string): Element | null => {
    try {
      return root.querySelector(part);
    } catch {
      // Not a selector this document takes.
      return null;
    }
  };
  /** Follows the parts from `root`: after each one but the last, into the shadow root or the document of what it named. */
  const walk = (root: Document | ShadowRoot, parts: string[], intoLast: boolean): Element | Document | ShadowRoot | null => {
    let scope: Document | ShadowRoot = root;
    for (let index = 0; index < parts.length; index++) {
      const found = step(scope, parts[index]!);
      if (!found) return null;
      if (index === parts.length - 1 && !intoLast) return found;
      if (found instanceof HTMLIFrameElement || found.localName === 'iframe' || found.localName === 'frame') {
        const inner = (found as HTMLIFrameElement).contentDocument;
        if (!inner) return null;
        scope = inner;
      } else if (found.shadowRoot) scope = found.shadowRoot;
      else return null;
    }
    return scope;
  };
  const start = frame === '' ? document : walk(document, frame.split(join), true);
  if (!start || !('querySelector' in start) || start instanceof Element) return null;
  const element = walk(start, selector.split(join), false);
  if (!element || !('scrollIntoView' in element)) return null;
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  return element;
}

/**
 * Shows where a finding is: scrolls its element into view and has Chrome draw its overlay over
 * it (the highlight of DevTools). The overlay is drawn by the browser, not put into the page:
 * nothing of the document is changed but its scroll position. It lasts as long as the session.
 *
 * False when the element is no longer there.
 */
export async function showHighlight(cdp: CdpSession, finding: Pick<Finding, 'selector' | 'frame'>, config: ExtensionConfig['highlight']): Promise<boolean> {
  const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
  const { executionContextId } = (await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: HIGHLIGHT_WORLD })) as { executionContextId: number };
  const { result, exceptionDetails } = (await cdp.send('Runtime.evaluate', {
    expression: `(${locate.toString()})(${JSON.stringify(finding.frame)}, ${JSON.stringify(finding.selector)}, ${JSON.stringify(JOIN)})`,
    contextId: executionContextId,
    returnByValue: false,
  })) as { result: { objectId?: string; subtype?: string }; exceptionDetails?: unknown };
  if (exceptionDetails || !result.objectId || result.subtype === 'null') return false;
  // The overlay belongs to the DOM domain: it has to be enabled first.
  await cdp.send('DOM.enable');
  await cdp.send('Overlay.enable');
  await cdp.send('Overlay.highlightNode', {
    objectId: result.objectId,
    highlightConfig: { showInfo: false, borderColor: config.border, contentColor: config.content },
  });
  return true;
}

/** Takes the overlay away. The scroll position stays where the highlight left it. */
export async function hideHighlight(cdp: CdpSession): Promise<void> {
  await cdp.send('Overlay.hideHighlight').catch(() => undefined);
  await cdp.send('Overlay.disable').catch(() => undefined);
  await cdp.send('DOM.disable').catch(() => undefined);
}
