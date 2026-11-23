import { describe, expect, it } from 'vitest';
import { CdpCommandError, createDebuggerSession, DebuggerAttachError, DebuggerDetachedError } from './debugger-session.js';
import { fakeDebugger } from './test-support.js';

const options = { protocolVersion: '1.3' };

describe('the CdpSession over chrome.debugger', () => {
  it('attaches to the one tab with the protocol version, and detaches', async () => {
    const api = fakeDebugger();
    const session = createDebuggerSession(api, 7, options);
    expect(session.attached).toBe(false);
    await session.attach();
    expect(session.attached).toBe(true);
    await session.detach();
    expect(session.attached).toBe(false);
    expect(api.calls).toEqual([
      { name: 'attach', tabId: 7 },
      { name: 'detach', tabId: 7 },
    ]);
    // Listening ends with the session.
    expect(api.onEvent.listeners).toEqual([]);
    expect(api.onDetach.listeners).toEqual([]);
  });

  it('sends a command to its tab and gives the result; a command without a result gives an object', async () => {
    const api = fakeDebugger();
    api.respond = (method) => (method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'F' } } } : undefined);
    const session = createDebuggerSession(api, 7, options);
    await session.attach();
    await expect(session.send('Page.getFrameTree')).resolves.toEqual({ frameTree: { frame: { id: 'F' } } });
    await expect(session.send('DOM.enable', { a: 1 })).resolves.toEqual({});
    expect(api.calls.slice(1)).toEqual([
      { name: 'sendCommand', tabId: 7, method: 'Page.getFrameTree' },
      { name: 'sendCommand', tabId: 7, method: 'DOM.enable', params: { a: 1 } },
    ]);
  });

  it('reports every command it sends', async () => {
    const api = fakeDebugger();
    const seen: string[] = [];
    const session = createDebuggerSession(api, 7, { ...options, onCommand: (method) => seen.push(method) });
    await session.attach();
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown' });
    expect(seen).toEqual(['Input.dispatchKeyEvent']);
  });

  it('turns a protocol error, which chrome.debugger gives as JSON, into an error with its message and code', async () => {
    const api = fakeDebugger();
    api.respond = () => {
      throw new Error('{"code":-32000,"message":"Cannot find context with specified id"}');
    };
    const session = createDebuggerSession(api, 7, options);
    await session.attach();
    const error = await session.send('Runtime.evaluate').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CdpCommandError);
    expect(error).toMatchObject({ message: 'Cannot find context with specified id', code: -32000, method: 'Runtime.evaluate' });
    // The session is still there: one command failed, not the session.
    expect(session.attached).toBe(true);
  });

  it('refuses to send before it is attached and after it is detached', async () => {
    const api = fakeDebugger();
    const session = createDebuggerSession(api, 7, options);
    await expect(session.send('Page.enable')).rejects.toBeInstanceOf(DebuggerDetachedError);
    await session.attach();
    await session.detach();
    await expect(session.send('Page.enable')).rejects.toBeInstanceOf(DebuggerDetachedError);
    expect(api.calls.filter((call) => call.name === 'sendCommand')).toEqual([]);
  });

  it('says why attaching failed, in the words of Chrome', async () => {
    const api = fakeDebugger();
    api.failAttach = 'Cannot access a chrome:// URL';
    const session = createDebuggerSession(api, 7, options);
    const error = await session.attach().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DebuggerAttachError);
    expect((error as Error).message).toBe('Cannot access a chrome:// URL');
    expect(session.attached).toBe(false);
  });

  it('passes on the events of its tab, and not those of another tab or of a child session', async () => {
    const api = fakeDebugger();
    const session = createDebuggerSession(api, 7, options);
    await session.attach();
    const seen: unknown[] = [];
    const handler = (params: unknown): void => void seen.push(params);
    session.on('Page.frameNavigated', handler);
    api.onEvent.fire({ tabId: 7 }, 'Page.frameNavigated', { frame: 1 });
    api.onEvent.fire({ tabId: 8 }, 'Page.frameNavigated', { frame: 2 });
    api.onEvent.fire({ tabId: 7, sessionId: 'child' }, 'Page.frameNavigated', { frame: 3 });
    api.onEvent.fire({ tabId: 7 }, 'Page.loadEventFired', { frame: 4 });
    expect(seen).toEqual([{ frame: 1 }]);
    session.off('Page.frameNavigated', handler);
    api.onEvent.fire({ tabId: 7 }, 'Page.frameNavigated', { frame: 5 });
    expect(seen).toEqual([{ frame: 1 }]);
  });

  it('ends when the user cancels from the bar: waiting commands fail, later ones are not sent, and it says so once', async () => {
    const api = fakeDebugger();
    // Never answered.
    api.sendCommand = (target, method) => {
      api.calls.push({ name: 'sendCommand', tabId: target.tabId, method });
      return new Promise(() => undefined);
    };
    const session = createDebuggerSession(api, 7, options);
    await session.attach();
    const reasons: string[] = [];
    session.onDetached((reason) => reasons.push(reason));
    const waiting = session.send('Page.captureScreenshot');
    api.onDetach.fire({ tabId: 8 }, 'canceled_by_user');
    expect(session.attached).toBe(true);
    api.onDetach.fire({ tabId: 7 }, 'canceled_by_user');
    await expect(waiting).rejects.toMatchObject({ name: 'DebuggerDetachedError', reason: 'canceled_by_user' });
    expect(session.attached).toBe(false);
    await expect(session.send('Runtime.evaluate')).rejects.toMatchObject({ reason: 'canceled_by_user' });
    expect(reasons).toEqual(['canceled_by_user']);
    // Nothing is left to detach, and detaching again is harmless.
    await session.detach();
    expect(api.calls.filter((call) => call.name === 'detach')).toEqual([]);
  });

  it('ends when the tab is closed', async () => {
    const api = fakeDebugger();
    const session = createDebuggerSession(api, 7, options);
    await session.attach();
    const reasons: string[] = [];
    session.onDetached((reason) => reasons.push(reason));
    api.onDetach.fire({ tabId: 7 }, 'target_closed');
    expect(reasons).toEqual(['target_closed']);
  });

  it('takes "not attached" from Chrome as the end of the session, not as a failed command', async () => {
    const api = fakeDebugger();
    api.respond = () => {
      throw new Error('Debugger is not attached to the tab with id: 7.');
    };
    const session = createDebuggerSession(api, 7, options);
    await session.attach();
    const reasons: string[] = [];
    session.onDetached((reason) => reasons.push(reason));
    await expect(session.send('Runtime.evaluate')).rejects.toBeInstanceOf(DebuggerDetachedError);
    expect(reasons).toEqual(['not_attached']);
    expect(session.attached).toBe(false);
  });

  it('a detach that Chrome refuses does not throw', async () => {
    const api = fakeDebugger();
    api.detach = () => Promise.reject(new Error('Debugger is not attached'));
    const session = createDebuggerSession(api, 7, options);
    await session.attach();
    await expect(session.detach()).resolves.toBeUndefined();
  });
});
