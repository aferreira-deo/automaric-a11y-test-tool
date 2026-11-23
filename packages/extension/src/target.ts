import type { StorageArea } from './chrome-api.js';

/**
 * Which tab a panel works on when it is not a side panel.
 *
 * The side panel works on the active tab of its window, and that is the only way a user has to
 * point it at a tab. The browser tests cannot open a side panel (it takes a click on the
 * browser's own UI), so they open the same page in a window of its own, where "the active tab
 * of this window" is the panel itself. They need to say which tab is meant.
 *
 * They do not say it in the address. An address can be written by anyone: a link, a bookmark,
 * a page that navigates. Instead the address carries a ticket, a random name, and the tab is
 * what the extension's own storage holds under that name: `chrome.storage.session`, which is
 * kept in memory, is gone when the browser closes, and can be written by the extension's own
 * contexts only (its service worker, its pages), not by a web page and not by a content script.
 * A ticket is used once. An address without a ticket the extension itself issued names nothing,
 * and the panel then works on the active tab, as the side panel does.
 */

export const PANEL_TICKET_PREFIX = 'panel-ticket:';
const TICKET = /^[A-Za-z0-9]{16,64}$/;

/** The tab the ticket in `search` (`location.search`) stands for, or null. The ticket is removed. */
export async function ticketedTab(search: string, session: StorageArea | undefined): Promise<number | null> {
  const ticket = new URLSearchParams(search).get('ticket');
  if (!session || ticket === null || !TICKET.test(ticket)) return null;
  const key = `${PANEL_TICKET_PREFIX}${ticket}`;
  try {
    const stored = await session.get(key);
    if (!Object.hasOwn(stored, key)) return null;
    await session.remove(key);
    const tabId = stored[key];
    return typeof tabId === 'number' && Number.isInteger(tabId) && tabId >= 0 ? tabId : null;
  } catch {
    return null;
  }
}
