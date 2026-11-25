/* global self, fetch */
// Shared worker of the probing safety fixtures: it sends a write when a page posts it an address.
self.onconnect = (event) => {
  const port = event.ports[0];
  port.onmessage = (message) => fetch(message.data, { method: 'POST', body: 'shared' });
  port.start();
};
