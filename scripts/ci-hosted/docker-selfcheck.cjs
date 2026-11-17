'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createGuard } = require('./docker-images.cjs');

async function checkTransport() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-selfcheck-'));
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\docker-selfcheck-${process.pid}` : path.join(temp, 'docker.sock');
  const policyFile = path.join(temp, 'policy.json');
  const pins = [{ image: 'supabase/synthetic', digest: `sha256:${'b'.repeat(64)}` }];
  const id = 'a'.repeat(64);
  const container = `/v1.48/containers/${id}`;
  const sockets = new Set(); const requests = [];
  let waitResponse; let attached; let logResponse; let started = false;
  const rejectedPayload = [];
  const frame = Buffer.from([1, 0, 0, 0, 0, 0, 0, 3, 65, 0, 66]);
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(request.url);
    if (request.url === '/v1.48/containers/create') {
      assert.equal(JSON.parse(Buffer.concat(chunks)).Image, `public.ecr.aws/${pins[0].image}@${pins[0].digest}`);
      response.writeHead(201); response.end(JSON.stringify({ Id: id }));
    } else if (request.url === `${container}/wait?condition=removed`) {
      waitResponse = response;
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders();
    } else if (request.url === `${container}/start`) {
      assert.ok(waitResponse, 'Docker acknowledges wait before start'); started = true;
      response.writeHead(204); response.end();
      waitResponse.end('{"StatusCode":0}'); attached.end(frame);
    } else if (request.url === `${container}/logs?follow=1`) {
      logResponse = response;
      response.writeHead(200); response.flushHeaders(); response.write(frame);
    } else { response.writeHead(404); response.end(); }
  });
  upstream.on('upgrade', (request, socket, head) => {
    requests.push(request.url);
    if (request.url.includes('/exec/bogus/start')) {
      let body = head;
      const reply = () => {
        rejectedPayload.push(body.subarray(2));
        const message = 'synthetic refused';
        const status = request.url.includes('status=200') ? 200 : 404;
        socket.write(`HTTP/1.1 ${status} Refused\r\nConnection: keep-alive\r\nContent-Type: application/json\r\nContent-Length: ${message.length}\r\n\r\n${message}`);
        socket.on('data', data => rejectedPayload.push(data));
      };
      if (body.length >= 2) reply();
      else {
        const receive = data => {
          body = Buffer.concat([body, data]);
          if (body.length >= 2) { socket.off('data', receive); reply(); }
        };
        socket.on('data', receive);
      }
      return;
    }
    assert.equal(head.length, 0, 'Upgraded payload must wait for the response');
    attached = socket;
    const legacy = request.url.includes('legacy=1');
    socket.write(legacy ? 'HTTP/1.1 200 OK\r\nContent-Type: application/vnd.docker.raw-stream\r\n\r\n'
      : 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    socket.write(frame);
    if (head.length) socket.write(head);
    socket.on('data', data => socket.write(data));
  });
  const guard = createGuard(pins, socketPath, policyFile);
  for (const server of [upstream, guard]) server.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  });
  const listen = async (server, ...args) => { server.listen(...args); await once(server, 'listening'); };
  const clients = new Set();
  const request = (method, url, body = '') => new Promise((resolve, reject) => {
    const outgoing = http.request({ host: '127.0.0.1', port: guard.address().port, method, path: url, agent: false,
      headers: { 'Content-Length': Buffer.byteLength(body) }, signal: AbortSignal.timeout(3000) });
    clients.add(outgoing);
    const timer = setTimeout(() => outgoing.destroy(new Error(`Docker response headers timed out: ${url}`)), 1500);
    outgoing.on('error', reject);
    outgoing.on('close', () => { clearTimeout(timer); clients.delete(outgoing); });
    outgoing.on('response', incoming => {
      clearTimeout(timer);
      const chunks = [];
      let firstChunk;
      const first = new Promise(complete => { firstChunk = complete; });
      const done = new Promise((complete, fail) => {
        incoming.on('data', chunk => { chunks.push(chunk); firstChunk(); });
        incoming.on('end', () => complete(Buffer.concat(chunks)));
        incoming.on('error', fail);
      });
      resolve({ incoming, done, first });
    });
    outgoing.end(body);
  });
  const attach = legacy => new Promise((resolve, reject) => {
    const net = require('node:net');
    const socket = net.createConnection({ host: '127.0.0.1', port: guard.address().port });
    clients.add(socket);
    const timer = setTimeout(() => socket.destroy(new Error('Docker attach timed out')), 1500);
    const chunks = [];
    socket.on('error', reject);
    socket.on('close', () => { clearTimeout(timer); clients.delete(socket); });
    socket.on('data', chunk => {
      chunks.push(chunk);
      const data = Buffer.concat(chunks); const end = data.indexOf('\r\n\r\n');
      if (end !== -1 && data.length >= end + 4 + frame.length * 2) {
        clearTimeout(timer);
        assert.match(data.subarray(0, end).toString(), legacy ? /^HTTP\/1.1 200/ : /^HTTP\/1.1 101/);
        assert.deepEqual(data.subarray(end + 4, end + 4 + frame.length * 2), Buffer.concat([frame, frame]));
        resolve(socket);
      }
    });
    socket.on('connect', () => socket.write(Buffer.concat([Buffer.from(`POST ${container}/attach?stream=1${legacy ? '&legacy=1' : ''} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`), frame])));
  });
  try {
    await listen(upstream, socketPath); await listen(guard, 0, '127.0.0.1');
    const created = await request('POST', '/v1.48/containers/create', JSON.stringify({ Image: 'supabase/synthetic:local' }));
    assert.equal(created.incoming.statusCode, 201); assert.equal(JSON.parse(await created.done).Id, id);
    await attach(false);
    const waiting = await request('POST', `${container}/wait?condition=removed`);
    assert.equal(started, false);
    const pending = JSON.parse(fs.readFileSync(policyFile, 'utf8')).requests.find(row => row.path.endsWith('/wait'));
    assert.equal(pending.status, 200); assert.equal(pending.endedAt, undefined);
    const start = await request('POST', `${container}/start`);
    assert.equal(start.incoming.statusCode, 204); await start.done;
    assert.equal(JSON.parse(await waiting.done).StatusCode, 0);
    const legacy = await attach(true); legacy.end();
    const logs = await request('GET', `${container}/logs?follow=1`);
    await logs.first;
    assert.equal(logs.incoming.complete, false, 'logs arrive before the response ends');
    logResponse.end(frame); assert.deepEqual(await logs.done, Buffer.concat([frame, frame]));
    const denied = await request('POST', '/v1.48/containers/create', '{"Image":"unreviewed/image:latest"}');
    assert.equal(denied.incoming.statusCode, 403); await denied.done;
    const pull = await request('POST', '/v1.48/images/create?fromImage=supabase/synthetic');
    assert.equal(pull.incoming.statusCode, 403); await pull.done;
    const mutations = [
      ['POST', '/build'], ['POST', '/build/prune'], ['POST', '/images/load'],
      ['POST', '/images/create?fromSrc=https%3A%2F%2Fexample.invalid%2Fsynthetic.tar'], ['POST', '/commit'],
      ['POST', '/images/synthetic/tag'], ['POST', '/images/synthetic/push'], ['POST', '/images/prune'],
      ['DELETE', '/images/synthetic'], ['POST', '/plugins/pull'], ['POST', '/plugins/create'],
      ['POST', '/images/%63reate?fromImage=synthetic'], ['POST', '/images/%6coad'], ['POST', '/%62uild'],
      ['POST', '/unused/../images/load'],
    ];
    for (const [method, url] of mutations) {
      const refused = await request(method, `/v1.48${url}`);
      assert.equal(refused.incoming.statusCode, 403, url); await refused.done;
    }
    const ambiguous = [
      '{"Image":"supabase/synthetic:local","image":"unreviewed/image:latest"}',
      '{"image":"unreviewed/image:latest","Image":"supabase/synthetic:local"}',
      '{"Image":"supabase/synthetic:local","IMAGE":"supabase/synthetic:local"}',
    ];
    for (const body of ambiguous) {
      const refused = await request('POST', '/v1.48/containers/%63reate', body);
      assert.equal(refused.incoming.statusCode, 403); await refused.done;
    }
    assert.equal(requests.filter(url => url === '/v1.48/containers/create').length, 1);
    assert.equal(requests.some(url => url.includes('/images/create')), false);
    const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
    assert.equal(policy.denied, 2 + mutations.length + ambiguous.length);
    assert.equal(policy.requests.every((row, index) => row.sequence === index + 1 && row.durationMs >= 0 && row.startedAt), true);
    assert.equal(JSON.stringify(policy.requests).includes(id), false);
    const lifecycle = policy.requests.filter(row => row.path.startsWith(`/v1.48/containers/${id.slice(0, 12)}/`));
    assert.deepEqual(lifecycle.map(row => row.path.split('/').at(-1)), ['attach', 'wait', 'start', 'attach', 'logs']);
    assert.deepEqual(lifecycle.map(row => row.status), [101, 200, 204, 200, 200]);
    assert.deepEqual(lifecycle.map(row => row.upgraded), [true, false, false, false, false]);
    assert.ok(lifecycle.find(row => row.path.endsWith('/wait')).endedAt);
    for (const status of [404, 200]) {
      const response = await new Promise((resolve, reject) => {
        const socket = require('node:net').createConnection({ host: '127.0.0.1', port: guard.address().port });
        clients.add(socket); const chunks = [];
        const timer = setTimeout(() => socket.destroy(new Error('Refused upgrade did not close')), 1500);
        socket.on('error', reject); socket.on('data', chunk => chunks.push(chunk));
        socket.on('close', () => { clearTimeout(timer); clients.delete(socket); resolve(Buffer.concat(chunks).toString()); });
        socket.on('connect', () => socket.write(`POST /v1.48/exec/bogus/start?status=${status} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 2\r\n\r\n{}POST /v1.48/images/create?fromImage=synthetic HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n`));
      });
      assert.equal(response.startsWith(`HTTP/1.1 ${status}`) && response.includes('synthetic refused'), true);
    }
    assert.equal(Buffer.concat(rejectedPayload).length, 0, 'Rejected upgrades must not relay pipelined requests');
    console.log('PASS: Docker 101/raw-200 attach, wait headers, refused upgrades, image mutation and ambiguous Image refusal');
  } finally {
    const closed = [...sockets].map(socket => once(socket, 'close'));
    for (const client of clients) client.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all(closed);
    await Promise.all([upstream, guard].map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
if (require.main === module) checkTransport().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { checkTransport };
