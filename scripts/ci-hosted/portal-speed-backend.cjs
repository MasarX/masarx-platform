'use strict';
const { createServer } = require('node:http');

// The anonymous tracking page only reads the public form configuration.
createServer((request, response) => {
  if (request.url === '/healthz' && request.method === 'GET') {
    response.writeHead(200).end();
    return;
  }
  response.setHeader('content-type', 'application/json');
  if (request.url === '/rest/v1/rpc/public_tracking_config_v1' && request.method === 'POST') {
    response.end(JSON.stringify({ resource_key: 'shipments', filter_key: 'tracking_number' }));
    return;
  }
  response.writeHead(404).end(JSON.stringify({ message: 'Unexpected Portal speed fixture request' }));
}).listen(54321, '127.0.0.1');
