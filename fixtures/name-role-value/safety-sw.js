/* global self, fetch, BroadcastChannel */
// Service worker of the probing safety fixture: it sends a write when the page talks to it.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
const write = (session, name) => fetch(`/_nrv/write/${session}/${name}`, { method: 'POST', body: 'x' });
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.session) write(data.session, 'sw-message');
});
const channel = new BroadcastChannel('nrv-safety');
channel.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.session) write(data.session, 'sw-broadcast');
});
