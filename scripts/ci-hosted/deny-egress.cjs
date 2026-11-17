'use strict';
const http = require('node:http');
// Chromium and Playwright's request fixture use this proxy for non-loopback destinations.
// Tests may fulfill synthetic third-party routes before they reach the proxy.
function handleRequest(request, response) {
  const health = request.url === '/healthz';
  response.writeHead(health ? 200 : 403, { 'content-type': 'text/plain' });
  response.end(health ? 'ok' : 'External network denied');
}
function handleConnect(_request, socket) {
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
}
if (require.main === module) {
  const server = http.createServer(handleRequest);
  server.on('connect', handleConnect);
  server.listen(3334, '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
module.exports = { handleRequest, handleConnect };
