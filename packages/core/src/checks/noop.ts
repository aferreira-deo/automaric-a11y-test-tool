import type { Check } from '../types.js';

/**
 * Harness check: one `info` finding for the document.
 * It exists to exercise the pipeline (collector, runner, reporters, fixture manifests).
 */
export const noopCheck: Check = {
  id: 'noop',
  evaluate(snapshot) {
    const { width, height } = snapshot.environment.viewport;
    return [
      {
        check: 'noop',
        rule: 'noop/page',
        status: 'info',
        wcag: null,
        selector: 'html',
        frame: '',
        box: { x: 0, y: 0, width, height },
        evidence: { crops: [], colors: {}, ratios: {}, flags: [] },
        message: 'Page collected.',
        help: 'Harness check. It reports nothing about accessibility.',
      },
    ];
  },
};
