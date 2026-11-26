import { createImage, encodePng, resolveConfig } from '@a11y-vision/core';
import { describe, expect, it } from 'vitest';
import type { PageEnvironment, World } from './environment.js';
import { captureScale, withStablePage } from './page.js';
import type { CdpSession } from './session.js';

const white = { r: 255, g: 255, b: 255 };
const capture = (width: number, height: number) => encodePng(createImage(width, height, white));
const clip = { x: 10, y: 20, width: 100, height: 50 };

describe('captureScale', () => {
  it('confirms the expected scale', () => {
    expect(captureScale(capture(200, 100), clip, 2, 1)).toBe(2);
  });
  it('allows for the rounding of clip edges to device pixels', () => {
    expect(captureScale(capture(151, 75), { ...clip, width: 100.4 }, 1.5, 1)).toBe(1.5);
  });
  it('reports the real scale of a capture that ignored the device scale factor', () => {
    // What a Playwright context with deviceScaleFactor 2 gave before the override was always sent.
    expect(captureScale(capture(100, 50), clip, 2, 1)).toBe(1);
    expect(captureScale(capture(300, 150), clip, 2, 1)).toBe(3);
  });
  it('refuses a capture whose size fits no scale', () => {
    expect(() => captureScale(capture(200, 50), clip, 2, 1)).toThrow(/fits no scale/);
  });
});

describe('withStablePage, putting the page back', () => {
  const original: PageEnvironment = { url: 'https://example.test/', devicePixelRatio: 1, viewport: { width: 800, height: 600 }, colorScheme: 'light', reducedMotion: false, mediaType: 'screen' };
  const RESTORE = ['agent.cleanup', 'Accessibility.disable', 'CSS.disable', 'DOM.disable', 'Emulation.setFocusEmulationEnabled', 'Emulation.setEmulatedMedia', 'Emulation.clearDeviceMetricsOverride'];

  /** A page that answers until `stuck` says it no longer does; `answer()` then answers everything that waits. */
  function stage(stuck: () => boolean) {
    const sent: string[] = [];
    const waiting: (() => void)[] = [];
    const reply = <T>(value: T): Promise<T> => (stuck() ? new Promise((resolve) => waiting.push(() => resolve(value))) : Promise.resolve(value));
    const cdp: CdpSession = {
      send(method) {
        sent.push(method);
        return reply({});
      },
      on: () => undefined,
      off: () => undefined,
    };
    const world: World = {
      contextId: 1,
      evaluate(expression) {
        sent.push(expression.endsWith('.cleanup()') ? 'agent.cleanup' : 'agent');
        return reply({ result: { value: 1 } });
      },
    };
    const answer = (): void => {
      for (const next of waiting.splice(0)) next();
    };
    return { sent, cdp, world, answer };
  }

  it('after a stop, does not wait for a page that no longer answers: every step is sent, one wait is spent, and the caller is told', async () => {
    let stuck = false;
    let incomplete = 0;
    const { sent, cdp, world } = stage(() => stuck);
    const started = Date.now();
    const running = withStablePage(
      cdp,
      world,
      original,
      resolveConfig({}),
      {},
      () => {
        stuck = true;
        return Promise.reject(new Error('stopped'));
      },
      { stepTimeoutMs: () => 40, onIncomplete: () => incomplete++ },
    );
    await expect(running).rejects.toThrow('stopped');
    // One limit, not one for each of the seven steps.
    expect(Date.now() - started).toBeLessThan(200);
    expect(sent.slice(-RESTORE.length)).toEqual(RESTORE);
    expect(incomplete).toBe(1);
  });

  it('after a stop, a page that answers is put back step by step and nothing is reported', async () => {
    let incomplete = 0;
    const { sent, cdp, world } = stage(() => false);
    await expect(withStablePage(cdp, world, original, resolveConfig({}), {}, () => Promise.reject(new Error('stopped')), { stepTimeoutMs: () => 40, onIncomplete: () => incomplete++ })).rejects.toThrow('stopped');
    expect(sent.slice(-RESTORE.length)).toEqual(RESTORE);
    expect(incomplete).toBe(0);
  });

  it('without a limit, waits for each step as long as it takes: a collection that ran to its end is put back in full', async () => {
    let stuck = false;
    const { sent, cdp, world, answer } = stage(() => stuck);
    let done = false;
    const running = withStablePage(cdp, world, original, resolveConfig({}), {}, () => {
      stuck = true;
      return Promise.resolve('read');
    }).then((value) => {
      done = true;
      return value;
    });
    for (let step = 0; step < RESTORE.length; step++) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      // One step at a time: the next is not sent before the last was answered.
      expect(done).toBe(false);
      expect(sent.at(-1)).toBe(RESTORE[step]);
      answer();
    }
    await expect(running).resolves.toBe('read');
  });

  it('with emulation reapply, sets the metrics read before the collection again before the scroll positions are put back, and does not clear them', async () => {
    const sent: { method: string; params?: unknown }[] = [];
    const metrics = { width: 393, height: 727, deviceScaleFactor: 2.75, mobile: true, screenWidth: 393, screenHeight: 851, pageScale: 1 };
    const cdp: CdpSession = {
      send(method, params) {
        sent.push({ method, params });
        return Promise.resolve({});
      },
      on: () => undefined,
      off: () => undefined,
    };
    const world: World = {
      contextId: 1,
      evaluate(expression) {
        sent.push({ method: expression.endsWith('.cleanup()') ? 'agent.cleanup' : expression.includes('visualViewport') ? 'read.metrics' : 'agent' });
        return Promise.resolve({ result: { value: expression.includes('visualViewport') ? metrics : 1 } });
      },
    };
    await withStablePage(cdp, world, { ...original, viewport: { width: 1116, height: 2065 } }, resolveConfig({}), {}, () => Promise.resolve(), { emulation: 'reapply' });
    const methods = sent.map((entry) => entry.method);
    // Read first, before the stable override of the collection.
    expect(methods.indexOf('read.metrics')).toBeLessThan(methods.indexOf('Emulation.setDeviceMetricsOverride'));
    const last = sent.filter((entry) => entry.method === 'Emulation.setDeviceMetricsOverride').at(-1);
    expect(last?.params).toEqual({ width: 393, height: 727, deviceScaleFactor: 2.75, mobile: true, screenWidth: 393, screenHeight: 851 });
    expect(methods.lastIndexOf('Emulation.setDeviceMetricsOverride')).toBeLessThan(methods.indexOf('agent.cleanup'));
    expect(methods).toContain('Emulation.setPageScaleFactor');
    expect(methods).not.toContain('Emulation.clearDeviceMetricsOverride');
  });

  it('with reapplyEmulation, clears its own override once, hands the emulation back to the caller before the scroll positions are put back, and leaves nothing of its own', async () => {
    const sent: string[] = [];
    const cdp: CdpSession = {
      send(method) {
        sent.push(method);
        return Promise.resolve({});
      },
      on: () => undefined,
      off: () => undefined,
    };
    const world: World = {
      contextId: 1,
      evaluate(expression) {
        sent.push(expression.endsWith('.cleanup()') ? 'agent.cleanup' : 'agent');
        return Promise.resolve({ result: { value: 1 } });
      },
    };
    await withStablePage(cdp, world, original, resolveConfig({}), {}, (page) => {
      page.onRestore(() => page.restoreMetrics().then(() => sent.push('collector.scrolls')));
      return Promise.resolve();
    }, {
      emulation: 'reapply',
      reapplyEmulation: () => {
        sent.push('caller.emulation');
        return Promise.resolve();
      },
    });
    expect(sent.filter((method) => method === 'Emulation.clearDeviceMetricsOverride')).toHaveLength(1);
    expect(sent.filter((method) => method === 'caller.emulation')).toHaveLength(1);
    const clear = sent.indexOf('Emulation.clearDeviceMetricsOverride');
    expect(sent.indexOf('caller.emulation')).toBe(clear + 1);
    expect(sent.indexOf('collector.scrolls')).toBeGreaterThan(clear);
    expect(sent.indexOf('agent.cleanup')).toBeGreaterThan(clear);
    // Nothing of this session's metrics is set once the caller's emulation is back.
    expect(sent.lastIndexOf('Emulation.setDeviceMetricsOverride')).toBeLessThan(clear);
  });
});
