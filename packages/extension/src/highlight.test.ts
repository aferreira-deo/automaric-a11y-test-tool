import type { CdpSession } from '@a11y-vision/collector-cdp';
import { describe, expect, it } from 'vitest';
import { extensionConfig } from './config.js';
import { showHighlight } from './highlight.js';

/** A tab that shows the document `loaderId`, in which the element of a finding is there or not. */
function tab(loaderId: string, found = true) {
  const sent: { method: string; params?: Record<string, unknown> }[] = [];
  const cdp: CdpSession = {
    send(method, params) {
      sent.push({ method, ...(params ? { params } : {}) });
      if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'F', loaderId } } });
      if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 7 });
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: found ? { objectId: 'node-1' } : { subtype: 'null' } });
      return Promise.resolve({});
    },
    on: () => undefined,
    off: () => undefined,
  };
  return { cdp, sent, methods: () => sent.map((call) => call.method) };
}

const finding = { selector: '#none-button', frame: '' };

describe('showHighlight', () => {
  it('highlights the element in the document that was scanned', async () => {
    const { cdp, sent, methods } = tab('L1');
    expect(await showHighlight(cdp, finding, extensionConfig.highlight, { loaderId: 'L1' })).toBe('shown');
    expect(methods()).toEqual(['Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate', 'DOM.enable', 'Overlay.enable', 'Overlay.highlightNode']);
    expect(sent.at(-1)?.params?.['objectId']).toBe('node-1');
    // Looked for in a world of its own, not in the page's.
    expect(sent[2]?.params?.['contextId']).toBe(7);
  });

  it('refuses when the tab shows another document, before anything is looked for or scrolled in it', async () => {
    // The other document has an element the selector names: it is not the one the finding is about.
    const { cdp, methods } = tab('L2');
    expect(await showHighlight(cdp, finding, extensionConfig.highlight, { loaderId: 'L1' })).toBe('other-document');
    expect(methods()).toEqual(['Page.getFrameTree']);
  });

  it('says when the element is no longer where the finding places it', async () => {
    const { cdp, methods } = tab('L1', false);
    expect(await showHighlight(cdp, finding, extensionConfig.highlight, { loaderId: 'L1' })).toBe('missing');
    expect(methods()).not.toContain('Overlay.highlightNode');
  });
});
