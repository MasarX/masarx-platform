'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { sanitize } = require('./diagnostics.cjs');
function pinnedReference(image, pins) {
  if (typeof image !== 'string' || image.length > 1024) throw new Error('Malformed Docker image');
  const slash = image.indexOf('/');
  const host = slash === -1 ? '' : image.slice(0, slash);
  const name = host === 'ghcr.io' || host === 'public.ecr.aws' ? image.slice(slash + 1) : image;
  const normalized = name.split('@')[0].split(':')[0]
    .replace(/^postgrest\/postgrest$/, 'supabase/postgrest')
    .replace(/^(?:docker\/)?library\/kong$/, 'supabase/kong');
  const pin = pins.find(row => row.image === normalized || row.runtimeId === image);
  const digest = image.includes('@') ? image.slice(image.indexOf('@') + 1) : undefined;
  if (!pin || !/^sha256:[a-f0-9]{64}$/.test(pin.digest) || (digest && digest !== pin.digest)
    || (pin.runtimeId && (!/^sha256:[a-f0-9]{64}$/.test(pin.runtimeId) || pin.runtimeId !== pin.image_id))) throw Object.assign(new Error('Image is outside the reviewed digest set'), { image });
  // The reviewed index's verified amd64 config ID binds both registries to the same content.
  return pin.runtimeId || `public.ecr.aws/${pin.image}@${pin.digest}`;
}
function dockerPath(url) {
  if (typeof url !== 'string' || url.length > 8192) throw new Error('Docker request exceeds bound');
  if (!url.startsWith('/') || url.startsWith('//')) throw new Error('Malformed Docker path');
  const decoded = decodeURIComponent(url.split('?')[0]);
  if (/[\0\\]/.test(decoded)) throw new Error('Malformed Docker path');
  return path.posix.normalize(decoded).replace(/^\/v[0-9.]+(?=\/)/, '');
}
function inspectedImage(route) {
  const parts = route.split('/');
  return parts[1] === 'images' && parts.length > 3 && parts.at(-1) === 'json' ? parts.slice(2, -1).join('/') : null;
}
function hasAmbiguousKey(config, canonical) {
  // Docker decodes keys with Unicode case folding, so compare ASCII keys only.
  return Object.keys(config).some(key => key !== canonical && (/[^\x00-\x7f]/.test(key) || key.toLowerCase() === canonical.toLowerCase()));
}
function rewrite(method, url, body, pins, initContainer) {
  const route = dockerPath(url);
  if (route === '/images/create') throw new Error('CLI image pulls are forbidden; images must already be pulled by digest');
  if (!['GET', 'HEAD'].includes(method) && /^\/(?:build|commit|images|plugins)(?:\/|$)/.test(route)) {
    throw new Error('Docker image-mutating endpoints are forbidden');
  }
  const inspect = inspectedImage(route);
  if (method === 'GET' && inspect && !inspect.startsWith('sha256:')) {
    const prefix = /^\/v[0-9.]+(?=\/)/.exec(url)?.[0] || '';
    url = `${prefix}/images/${encodeURIComponent(pinnedReference(inspect, pins))}/json${url.includes('?') ? url.slice(url.indexOf('?')) : ''}`;
  }
  if (method === 'POST' && route === '/containers/create') {
    const config = JSON.parse(body.toString('utf8'));
    if (Object.keys(config).filter(key => key.toLowerCase() === 'image').length !== 1) throw new Error('Ambiguous Docker Image key');
    config.Image = pinnedReference(config.Image, pins);
    if (initContainer && new URL(url, 'http://localhost').searchParams.get('name') === initContainer) {
      const database = pins.find(pin => pin.role === 'database');
      if (!database || config.Image !== pinnedReference(database.image, pins)) throw new Error('Docker init requires the reviewed database image');
      const { HostConfig } = config;
      if (!HostConfig || typeof HostConfig !== 'object' || Array.isArray(HostConfig)
        || hasAmbiguousKey(config, 'HostConfig') || hasAmbiguousKey(HostConfig, 'Init')) {
        throw new Error('Invalid Docker HostConfig for database init');
      }
      // Docker's init reaps abandoned healthcheck processes before Postgres can see their exits.
      HostConfig.Init = true;
    }
    body = Buffer.from(JSON.stringify(config));
  }
  return { url, body };
}
function policyDecision(error, method, url) {
  const reasons = ['CLI image pulls are forbidden; images must already be pulled by digest', 'Image is outside the reviewed digest set', 'Docker request exceeds bound',
    'Docker image-mutating endpoints are forbidden', 'Ambiguous Docker Image key',
    'Docker init requires the reviewed database image', 'Invalid Docker HostConfig for database init'];
  return { decision: error ? 'denied' : 'allowed',
    operation: /\/images\/create/.test(url) ? 'image-pull' : /\/images\//.test(url) ? 'image-inspect' : method === 'POST' && /\/containers\/create/.test(url) ? 'container-create' : 'request',
    reason: error ? (reasons.includes(error.message) ? error.message : 'Malformed Docker policy request') : 'Reviewed digest policy satisfied',
    ...(error?.message === 'Image is outside the reviewed digest set' ? { image: error.image } : {}) };
}
function imageRequest(method, url, body, pins) {
  try {
    let image; let operation;
    const route = dockerPath(url);
    const inspect = inspectedImage(route);
    if (route === '/images/create') {
      const query = new URL(url, 'http://localhost').searchParams;
      image = query.get('fromImage') || '';
      const tag = query.get('tag');
      if (tag) image += `${tag.startsWith('sha256:') ? '@' : ':'}${tag}`;
      operation = 'image-pull';
    } else if (method === 'GET' && inspect) { image = inspect; operation = 'image-inspect'; }
    else if (method === 'POST' && route === '/containers/create') {
      try { image = JSON.parse(body.toString('utf8')).Image; } catch { return null; }
      operation = 'container-create';
    } else return null;
    if (typeof image !== 'string' || image.length > 1024) return null;
    let reference;
    try { reference = pinnedReference(image, pins); } catch {}
    return { operation, image: sanitize(image.replace(/(sha256:[a-f0-9]{12})[a-f0-9]+/g, '$1')),
      reviewed: Boolean(reference), ...(reference ? { reference: reference.replace(/(sha256:[a-f0-9]{12})[a-f0-9]+/g, '$1') } : {}) };
  } catch { return null; }
}
function createGuard(pins, socketPath, policyFile, initContainer) {
  const policy = { decision: 'enforcing', allowed: 0, denied: 0, denials: [], imageRequests: [], requests: [] };
  const persist = () => {
    for (const request of policy.requests) if (!request.endedAt) request.durationMs = Date.now() - Date.parse(request.startedAt);
    if (policyFile) fs.writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600 });
  };
  const update = (trace, fields, ended = false) => {
    Object.assign(trace, fields);
    if (ended && !trace.endedAt) {
      trace.endedAt = new Date().toISOString();
      trace.durationMs = Date.parse(trace.endedAt) - Date.parse(trace.startedAt);
    }
    persist();
  };
  const record = (error, method, url, body) => {
    const decision = policyDecision(error, method, url);
    policy[decision.decision]++;
    if (error) { policy.decision = 'denied'; policy.denials.push(decision); policy.denials = policy.denials.slice(-10); }
    const image = imageRequest(method, url, body, pins);
    if (image) {
      const seen = policy.imageRequests.find(row => row.operation === image.operation && row.image === image.image);
      if (seen) { seen.count++; seen.denied += Number(Boolean(error)); }
      else policy.imageRequests.push({ ...image, count: 1, denied: Number(Boolean(error)) });
    }
    const trace = { sequence: policy.requests.length + 1, method,
      path: sanitize(url.split('?')[0].slice(0, 1024).replace(/(\/(?:containers|exec)\/)([a-f0-9]{13,64})(?=\/|$)/g, (_, prefix, id) => prefix + id.slice(0, 12))),
      startedAt: new Date().toISOString(), status: null, durationMs: 0, upgraded: false };
    policy.requests.push(trace); policy.lastRequest = trace; persist();
    return trace;
  };
  persist();
  const server = http.createServer(async (request, response) => {
    let body = Buffer.alloc(0);
    try {
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; if (length > 8 * 1024 * 1024) throw new Error('Docker request exceeds bound'); chunks.push(chunk); }
      body = Buffer.concat(chunks);
      const result = rewrite(request.method, request.url, body, pins, initContainer);
      const trace = record(null, request.method, request.url, body);
      const headers = { ...request.headers };
      delete headers['transfer-encoding']; headers['content-length'] = result.body.length;
      const upstream = http.request({ socketPath, method: request.method, path: result.url, headers }, incoming => {
        update(trace, { status: incoming.statusCode });
        response.writeHead(incoming.statusCode, incoming.headers);
        // Docker acknowledges /wait headers before its client can issue /start.
        response.flushHeaders(); incoming.pipe(response);
        incoming.on('error', () => response.destroy());
      });
      response.on('close', () => { upstream.destroy(); update(trace, {}, true); });
      upstream.on('error', () => { if (!response.headersSent) { update(trace, { status: 502 }); response.writeHead(502); } response.end(); });
      upstream.end(result.body);
    } catch (error) {
      const trace = record(error, request.method, request.url, body); update(trace, { status: 403 }, true);
      response.writeHead(403); response.end('Docker image policy denied request');
    }
  });
  server.on('upgrade', (request, client, head) => {
    let route;
    try { route = dockerPath(request.url); } catch { return client.destroy(); }
    if (request.method !== 'POST' || !/^\/(exec\/[^/]+\/start|containers\/[^/]+\/attach)$/.test(route)) return client.destroy();
    const length = request.headers['content-length'] || '0';
    if (request.headers['transfer-encoding'] || !/^\d+$/.test(length) || Number(length) > 8 * 1024 * 1024) return client.destroy();
    client.pause();
    const trace = record(null, request.method, request.url, head);
    const upstream = http.request({ socketPath, method: request.method, path: request.url, headers: request.headers, agent: false });
    let tunnel; let remaining = Number(length); let pending = Buffer.alloc(0);
    const sendHeaders = incoming => {
      let headers = '';
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        if (!['connection', 'content-length', 'transfer-encoding'].includes(incoming.rawHeaders[i].toLowerCase())) {
          headers += `${incoming.rawHeaders[i]}: ${incoming.rawHeaders[i + 1]}\r\n`;
        }
      }
      client.write(`HTTP/1.1 ${incoming.statusCode} ${incoming.statusMessage}\r\n${headers}Connection: ${incoming.statusCode === 101 ? 'Upgrade' : 'close'}\r\n\r\n`);
      update(trace, { status: incoming.statusCode, upgraded: incoming.statusCode === 101 });
    };
    const connect = socket => {
      tunnel = socket;
      if (pending.length) socket.write(pending);
      client.pipe(socket); client.resume();
      socket.on('error', () => client.destroy());
    };
    upstream.on('upgrade', (incoming, socket, upstreamHead) => {
      sendHeaders(incoming);
      if (upstreamHead.length) client.write(upstreamHead);
      socket.pipe(client); connect(socket);
    });
    upstream.on('response', incoming => {
      client.pause(); client.off('data', requestBody);
      sendHeaders(incoming);
      incoming.on('error', () => client.destroy());
      incoming.pipe(client);
      if (incoming.statusCode === 200 && /^application\/vnd\.docker\.(raw|multiplexed)-stream(?:;|$)/i.test(incoming.headers['content-type'] || '')) connect(incoming.socket);
    });
    client.on('close', () => { upstream.destroy(); tunnel?.destroy(); update(trace, {}, true); });
    upstream.on('error', () => client.destroy()); client.on('error', () => { upstream.destroy(); tunnel?.destroy(); });
    // Send only the declared HTTP body before acceptance; hold all upgraded/pipelined bytes.
    function requestBody(chunk) {
      const size = Math.min(remaining, chunk.length);
      if (size) upstream.write(chunk.subarray(0, size));
      remaining -= size;
      if (chunk.length > size) pending = Buffer.concat([pending, chunk.subarray(size)]);
      if (!remaining) { client.pause(); client.off('data', requestBody); upstream.end(); }
    };
    requestBody(head);
    if (remaining) { client.on('data', requestBody); client.resume(); }
  });
  return server;
}
function start(pins, socketPath, policyFile, initContainer) {
  const server = createGuard(pins, socketPath, policyFile, initContainer);
  server.listen(0, '127.0.0.1', () => process.send?.({ port: server.address().port }));
  process.on('disconnect', () => process.exit(0));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
if (require.main === module) start(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), ...process.argv.slice(3));
module.exports = { rewrite, pinnedReference, policyDecision, imageRequest, createGuard };
