/* global self, fetch */
// Service worker of the probing safety fixtures: it sends a write when a page posts it an address over a channel.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  const port = event.ports && event.ports[0];
  if (port) port.onmessage = (message) => fetch(message.data, { method: 'POST', body: 'sw' });
});
