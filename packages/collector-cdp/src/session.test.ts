import { describe, expect, it } from 'vitest';
import { collectSnapshot, CollectionStoppedError } from './index.js';
import { gateSession, stopReason } from './session.js';
import type { CdpSession } from './session.js';

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
}

/** A session whose commands are answered by hand. */
function manualSession(): { cdp: CdpSession; sent: string[]; pending: Pending[] } {
  const sent: string[] = [];
  const pending: Pending[] = [];
  return {
    sent,
    pending,
    cdp: {
      send: (method) =>
        new Promise((resolve) => {
          sent.push(method);
          pending.push({ method, resolve });
        }),
      on: () => undefined,
      off: () => undefined,
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('gateSession', () => {
  it('is the session itself when nothing can stop the collection', () => {
    const { cdp } = manualSession();
    expect(gateSession(cdp, undefined).session).toBe(cdp);
  });

  it('rejects a command that is waiting when the signal fires, with the reason of the signal', async () => {
    const { cdp } = manualSession();
    const stop = new AbortController();
    const gate = gateSession(cdp, stop.signal);
    const waiting = gate.session.send('Page.captureScreenshot');
    const reason = new Error('the user stopped it');
    stop.abort(reason);
    await expect(waiting).rejects.toBe(reason);
  });

  it('sends nothing more once the signal has fired, until it is released', async () => {
    const { cdp, sent, pending } = manualSession();
    const stop = new AbortController();
    const gate = gateSession(cdp, stop.signal);
    stop.abort();
    // Without a reason of its own the signal carries an AbortError.
    await expect(gate.session.send('Input.dispatchKeyEvent')).rejects.toMatchObject({ name: 'AbortError' });
    expect(sent).toEqual([]);
    await gate.release(1000);
    const restoring = gate.session.send('Emulation.clearDeviceMetricsOverride');
    expect(sent).toEqual(['Emulation.clearDeviceMetricsOverride']);
    pending[0]!.resolve({});
    await expect(restoring).resolves.toEqual({});
  });

  it('waits for the commands under way before it lets the restoring through', async () => {
    const { cdp, pending } = manualSession();
    const stop = new AbortController();
    const gate = gateSession(cdp, stop.signal);
    const capture = gate.session.send('Page.captureScreenshot');
    stop.abort();
    await expect(capture).rejects.toMatchObject({ name: 'AbortError' });
    let released = false;
    const release = gate.release(60000).then(() => {
      released = true;
    });
    await tick();
    expect(released).toBe(false);
    // Chrome answers the capture, to nobody: now the page can be put back.
    pending[0]!.resolve({ data: '' });
    await release;
    expect(released).toBe(true);
  });

  it('does not wait for ever for an answer that never comes', async () => {
    const { cdp } = manualSession();
    const stop = new AbortController();
    const gate = gateSession(cdp, stop.signal);
    gate.session.send('Page.captureScreenshot').catch(() => undefined);
    stop.abort();
    await gate.release(5);
    expect(true).toBe(true);
  });

  it('does not wait when the collection ran to its end', async () => {
    const { cdp } = manualSession();
    const gate = gateSession(cdp, new AbortController().signal);
    void gate.session.send('Runtime.evaluate');
    await gate.release(60000);
  });

  it('turns a reason that is not an error into one', () => {
    const stop = new AbortController();
    stop.abort('a string');
    expect(stopReason(stop.signal)).toBeInstanceOf(CollectionStoppedError);
  });
});

describe('collectSnapshot with a signal', () => {
  it('does not touch the page when the signal has already fired', async () => {
    const { cdp, sent } = manualSession();
    const stop = new AbortController();
    const reason = new Error('stopped before it began');
    stop.abort(reason);
    await expect(collectSnapshot(cdp, {} as never, { signal: stop.signal })).rejects.toBe(reason);
    expect(sent).toEqual([]);
  });
});
