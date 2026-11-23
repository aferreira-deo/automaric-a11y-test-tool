import { describe, expect, it } from 'vitest';
import { PANEL_TICKET_PREFIX, ticketedTab } from './target.js';
import { fakeStorage } from './test-support.js';

describe('the tab a panel in a window of its own works on', () => {
  it('is the one the extension itself left a ticket for, and the ticket is used up', async () => {
    const session = fakeStorage({ [`${PANEL_TICKET_PREFIX}0123456789abcdef`]: 42 });
    expect(await ticketedTab('?ticket=0123456789abcdef', session)).toBe(42);
    expect(session.items).toEqual({});
    // The same address opened again names nothing.
    expect(await ticketedTab('?ticket=0123456789abcdef', session)).toBeNull();
  });

  it('is never taken from the address alone: a link cannot point the panel at a tab', async () => {
    const session = fakeStorage({ [`${PANEL_TICKET_PREFIX}0123456789abcdef`]: 42 });
    for (const search of ['', '?tabId=42', '?ticket=42', '?ticket=', '?ticket=fedcba9876543210', '?ticket=0123456789abcdef%2F..', '?ticket=__proto__']) {
      expect(await ticketedTab(search, session), search).toBeNull();
    }
    expect(Object.keys(session.items)).toHaveLength(1);
  });

  it('is none without session storage, or when what is stored is not the id of a tab', async () => {
    expect(await ticketedTab('?ticket=0123456789abcdef', undefined)).toBeNull();
    for (const value of ['42', 4.5, -1, null, { tabId: 42 }]) {
      expect(await ticketedTab('?ticket=0123456789abcdef', fakeStorage({ [`${PANEL_TICKET_PREFIX}0123456789abcdef`]: value }))).toBeNull();
    }
    const failing = { get: () => Promise.reject(new Error('no')), set: () => Promise.resolve(), remove: () => Promise.resolve() };
    expect(await ticketedTab('?ticket=0123456789abcdef', failing)).toBeNull();
  });
});
