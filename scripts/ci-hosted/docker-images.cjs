'use strict';
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
function pinnedReference(image, pins) {
  const normalized = String(image).replace(/^public\.ecr\.aws\//, '').split('@')[0].split(':')[0]
    .replace(/^(?:docker\/)?library\/kong$/, 'supabase/kong');
  const pin = pins.find(row => row.image === normalized || row.runtimeId === image || `public.ecr.aws/${row.image}@${row.digest}` === image);
  if (!pin || !/^sha256:[a-f0-9]{64}$/.test(pin.digest)) throw new Error('Image is outside the reviewed digest set');
  return `public.ecr.aws/${pin.image}@${pin.digest}`;
}
function rewrite(method, url, body, pins) {
  if (/\/images\/create(?:\?|$)/.test(url)) throw new Error('CLI image pulls are forbidden; images must already be pulled by digest');
  const inspect = /^(.*\/images\/)(.+)(\/json(?:\?.*)?)$/.exec(url);
  if (method === 'GET' && inspect && !decodeURIComponent(inspect[2]).startsWith('sha256:')) {
    url = inspect[1] + encodeURIComponent(pinnedReference(decodeURIComponent(inspect[2]), pins)) + inspect[3];
  }
  if (method === 'POST' && /\/containers\/create(?:\?|$)/.test(url)) {
    const config = JSON.parse(body.toString('utf8'));
    config.Image = pinnedReference(config.Image, pins);
    body = Buffer.from(JSON.stringify(config));
  }
  return { url, body };
}
function start(pins, socketPath) {
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; if (length > 8 * 1024 * 1024) throw new Error('Docker request exceeds bound'); chunks.push(chunk); }
      const result = rewrite(request.method, request.url, Buffer.concat(chunks), pins);
      const headers = { ...request.headers };
      delete headers['transfer-encoding']; headers['content-length'] = result.body.length;
      const upstream = http.request({ socketPath, method: request.method, path: result.url, headers }, incoming => {
        response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
      });
      upstream.on('error', () => { response.writeHead(502); response.end(); });
      upstream.end(result.body);
    } catch { response.writeHead(403); response.end('Docker image policy denied request'); }
  });
  server.on('upgrade', (request, client, head) => {
    if (!/^\/v[0-9.]+\/(exec\/[^/]+\/start|containers\/[^/]+\/attach)(?:\?|$)/.test(request.url)) return client.destroy();
    const upstream = net.createConnection(socketPath, () => {
      const headers = request.rawHeaders.reduce((text, value, index, all) => index % 2 ? text : text + `${value}: ${all[index + 1]}\r\n`, '');
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${headers}\r\n`); upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
  });
  server.listen(0, '127.0.0.1', () => process.send?.({ port: server.address().port }));
  process.on('disconnect', () => process.exit(0));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
if (require.main === module) start(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), process.argv[3]);
module.exports = { rewrite, pinnedReference };
