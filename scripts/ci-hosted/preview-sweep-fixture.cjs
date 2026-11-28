'use strict';

const { createServer } = require('node:http');
const { createHmac, randomBytes, randomUUID } = require('node:crypto');
const { writeFile } = require('node:fs/promises');
const roles = require('../../config/dev/sweep-roles.json');

const loopback = [127, 0, 0, 1].join('.');
const ports = { console: 3001, portal: 3002, 'console-v2': 5175, fixture: 54321, proxy: 3334 };
const origin = port => 'http://' + loopback + ':' + port;
const appOrigins = ['console', 'console-v2', 'portal'].map(app => origin(ports[app]));
const readCapability = 'shipments.read';
const registry = {
  resources: [{
    key: 'shipments', relation: 'shipments', capability_read: readCapability,
    label: 'Shipments', label_ar: 'الشحنات', id_column: 'id',
    columns: [{ key: 'id', label: 'Reference', label_ar: 'المرجع' }],
  }],
};
const emptyList = { items: [], total: 0, total_strategy: 'exact', total_is_estimate: false };
const shipmentsNavigation = {
  id: 'operate', label: 'Operate', label_ar: 'التشغيل',
  items: [{ id: 'shipments', label: 'Shipments', label_ar: 'الشحنات', href: '/resources/shipments' }],
};
const journeyNavigation = [
  { id: 'operations', label: 'Operations', items: [
    { id: 'route-plans', label: 'Route plans', href: '/resources/route_plans', resource: 'route_plans', capability: 'route_plans.read' },
  ] },
  { id: 'finance', label: 'Finance', items: [
    { id: 'finance-settlements', label: 'Settlements', href: '/finance/settlements', capability: 'settlements.read' },
  ] },
];

async function startFixture(credentials = {}) {
  const sessions = new Map();
  const signingKey = randomBytes(32);
  const tenantId = randomUUID();
  const senderId = randomUUID();

  async function handle(request, response) {
    const reply = (status, data) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    if (appOrigins.includes(request.headers.origin)) {
      response.setHeader('access-control-allow-origin', request.headers.origin);
      response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      response.setHeader('access-control-allow-headers', request.headers['access-control-request-headers'] || 'authorization');
    }
    if (request.method === 'OPTIONS') return reply(204);
    if (request.method === 'POST' && request.url === '/auth/v1/token?grant_type=password') {
      const { email, password } = await readBody(request);
      const role = Object.keys(credentials).find(key =>
        credentials[key].email === email && credentials[key].password === password);
      if (!role) return reply(400, { message: 'Synthetic credentials required' });
      const account = session(role, 'journey', email);
      account.release();
      return reply(200, account.session);
    }
    const entry = sessions.get(request.headers.authorization);
    if (!entry) return reply(401, { message: 'Synthetic session required' });
    if (request.url === '/auth/v1/user' && request.method === 'GET') return reply(200, entry.session.user);
    const rpc = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(request.url)?.[1];
    if (request.method !== 'POST' || !rpc) return reply(404, { message: 'Unknown fixture route' });
    const { identity, state, pending } = entry;
    switch (rpc) {
      case 'ui_me_v1': return reply(200, identity);
      case 'ui_navigation_v1': return reply(200, { sections: state === 'journey'
        ? journeyNavigation : [shipmentsNavigation] });
      case 'ui_read_registry_v1': return state === 'error'
        ? reply(400, { code: 'P0001', message: 'Synthetic read failure' })
        : reply(200, state === 'journey' ? { resources: [{
          key: 'route_plans', relation: 'route_plans', label: 'Route plans',
          capability_read: 'route_plans.read', id_column: 'id', columns: [],
        }] } : registry);
      case 'ui_command_registry_v1': return reply(200, { commands: [] });
      case 'ui_resource_metrics_v1': return reply(200, { total: 0, columns: {} });
      case 'list_lookup_values_catalog_json_v1':
      case 'ui_filter_operators_v1':
      case 'ui_settings_preview_v1':
      case 'ui_table_views_v1': return reply(200, {});
      case 'list_lookup_values_v1': return reply(200, []);
      case 'ui_dashboard_config_v1':
        if (state === 'journey') return reply(200, {});
        break;
      case 'ui_dashboard_metrics_v1':
        if (state === 'journey') return reply(200, { metrics: [{ resource: 'route_plans', total: 0 }] });
        break;
      case 'pickup_requests_list_v1':
      case 'pickup_waves_list_v1':
        if (state === 'journey' && identity.user.user_type === 'dispatcher') return reply(200, []);
        break;
      case 'ui_list_resource_v1': {
        const { p_resource: resource } = await readBody(request);
        if (resource !== 'shipments') return reply(200, emptyList);
        if (!identity.capabilities.includes(readCapability)) {
          return reply(403, { code: '42501', message: 'Missing required capability: shipments.read' });
        }
        await pending.promise;
        return reply(200, emptyList);
      }
    }
    return reply(404, { code: 'PGRST202', message: 'Synthetic RPC unavailable' });
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise((ready, reject) => server.once('error', reject).listen(ports.fixture, loopback, ready));

  function session(role, state, email) {
    const { required, optional, scope } = roles[role];
    const user = { id: randomUUID(), aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {},
      ...(email && { email }) };
    const expiresAt = Math.floor(Date.now() / 1000) + 1800;
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const jwtBody = [
      encode({ alg: 'HS256', typ: 'JWT' }),
      encode({ sub: user.id, aud: user.aud, role: user.role, exp: expiresAt }),
    ].join('.');
    const session = {
      access_token: jwtBody + '.' + createHmac('sha256', signingKey).update(jwtBody).digest('base64url'),
      refresh_token: randomBytes(24).toString('hex'),
      expires_at: expiresAt, expires_in: 1800, token_type: 'bearer', user,
    };
    const identity = {
      user: { id: user.id, user_type: role, status: 'active' },
      org: { id: tenantId },
      access_scope: { scope_type: scope, scope_id: scope === 'sender' ? senderId : null },
      capabilities: [...required, ...optional],
    };
    const pending = Promise.withResolvers();
    const authorization = 'Bearer ' + session.access_token;
    sessions.set(authorization, { session, identity, state, pending });
    return { session, release: pending.resolve, dispose: () => {
      pending.resolve();
      sessions.delete(authorization);
    } };
  }

  return {
    session,
    close: () => {
      server.closeAllConnections();
      return new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    },
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

if (require.main === module) {
  const credentials = Object.fromEntries(Object.keys(roles).map(role => [role, {
    email: `${randomUUID()}@example.invalid`, password: randomBytes(24).toString('hex'),
  }]));
  writeFile(process.env.E2E_SWEEP_CREDENTIALS_FILE, JSON.stringify(credentials), { mode: 0o600, flag: 'wx' })
    .then(() => startFixture(credentials))
    .catch(() => { console.error('Console journey fixture setup failed'); process.exitCode = 1; });
}

module.exports = { loopback, ports, origin, appOrigins, startFixture };
