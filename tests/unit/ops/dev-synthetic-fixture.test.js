const { randomUUID } = require('node:crypto');

jest.mock('pg', () => ({ Client: jest.fn() }));

const { Client } = require('pg');
const { withDevFixture } = require('../../../scripts/deploy/dev-synthetic-fixture.cjs');
const { EXIT } = require('../../../scripts/deploy/dev-label-render-probe.cjs');

const projectRef = 'a'.repeat(20);
const env = {
  GITHUB_ACTIONS: 'true', DEPLOY_ENV: 'dev', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'b'.repeat(40),
  GITHUB_STEP_SUMMARY: 'summary', SUPABASE_PROJECT_REF: projectRef,
  SUPABASE_ACCESS_TOKEN: randomUUID(), SUPABASE_DB_PASSWORD: randomUUID(),
};
const token = claims => ['synthetic', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'synthetic'].join('.');
const adminUsersPath = '/auth/v1/admin/users';

function provider({ loseCreate = false, failDelete = false } = {}) {
  const userId = randomUUID();
  let user;
  let tenantCreated = false;
  let authDeleted = false;
  const db = {
    connect: jest.fn(), end: jest.fn(), on: jest.fn(),
    query: jest.fn(async (sql) => {
      if (sql.startsWith('INSERT INTO public.organizations')) tenantCreated = true;
      if (sql.includes('FOR UPDATE')) return { rowCount: tenantCreated ? 1 : 0 };
      if (sql.startsWith('SELECT id FROM auth.users')) return { rows: [{ id: userId }] };
      if (sql.startsWith('SELECT 1 FROM auth.users')) return { rowCount: authDeleted ? 0 : 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  Client.mockImplementation(() => db);
  const fetch = jest.spyOn(global, 'fetch').mockImplementation(async (url, request) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/api-keys')) return Response.json(['anon', 'service_role'].map(role =>
      ({ name: role, api_key: token({ role, ref: projectRef }) })));
    if (path.endsWith('/config/database/pooler')) {
      return Response.json([{ database_type: 'PRIMARY', db_host: ['synthetic', 'pooler', 'supabase', 'com'].join('.') }]);
    }
    if (path.endsWith('/admin/users') && request.method === 'POST') {
      const { email, app_metadata } = JSON.parse(request.body);
      user = { id: userId, email, app_metadata, role: 'authenticated' };
      if (loseCreate) throw new Error('Synthetic lost response');
      return Response.json({ user }, { status: 201 });
    }
    if (path.endsWith('/token')) {
      return Response.json({ user, access_token: token({ role: 'authenticated', sub: userId }), refresh_token: randomUUID() });
    }
    if (path.endsWith(userId) && request.method === 'DELETE') {
      authDeleted = !failDelete;
      return new Response(null, { status: failDelete ? 503 : 204 });
    }
    throw new Error('Unexpected simulated request');
  });
  const mask = jest.spyOn(console, 'log').mockImplementation(() => {});
  const seedUser = jest.fn();
  const options = { prefix: 'dev-unit-probe', marker: 'dev_unit_probe', exit: EXIT, seedUser };
  return { db, fetch, mask, options, userId };
}

afterEach(() => {
  jest.restoreAllMocks();
  Client.mockReset();
});

test('creates a masked, confirmed synthetic account and verifies cleanup after successful use', async () => {
  const { db, fetch, mask, options, userId } = provider();
  const receipt = await withDevFixture(env, options, async fixture => {
    expect(options.seedUser).toHaveBeenCalledWith(db, expect.objectContaining({ email: fixture.credentials.email }), userId);
    const session = await fixture.signIn();
    expect(session.user.id).toBe(userId);
    return fixture.tracking;
  });

  expect(receipt).toEqual({ result: expect.stringMatching(/^[A-F0-9]{32}$/), error: undefined, cleanupErrors: [], cleaned: true });
  const [[, create], [signInUrl, signIn], [deleteUrl, remove]] = fetch.mock.calls.slice(2);
  const credentials = JSON.parse(signIn.body);
  expect(JSON.parse(create.body)).toEqual({
    ...credentials, email_confirm: true, app_metadata: { dev_unit_probe: credentials.email.split('@')[0] },
  });
  expect(credentials.email).toMatch(/^dev-unit-probe-.*@example\.invalid$/);
  const maskIndex = mask.mock.calls.findIndex(([line]) => line === `::add-mask::${credentials.password}`);
  expect(maskIndex).toBeGreaterThanOrEqual(0);
  expect(mask.mock.invocationCallOrder[maskIndex]).toBeLessThan(fetch.mock.invocationCallOrder[2]);
  expect(new URL(signInUrl).searchParams.get('grant_type')).toBe('password');
  expect(signIn.signal).toBeInstanceOf(AbortSignal);
  expect(new URL(deleteUrl).pathname).toBe(`${adminUsersPath}/${userId}`);
  expect(remove.method).toBe('DELETE');
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM public.organizations'), expect.any(Array));
  expect(db.query).toHaveBeenCalledWith('SELECT 1 FROM auth.users WHERE email = $1', [credentials.email]);
  expect(db.end).toHaveBeenCalledTimes(1);
});

test('cleans up after the fixture consumer fails', async () => {
  const { db, fetch, options } = provider();
  const error = new Error('Synthetic read failed');
  const receipt = await withDevFixture(env, options, async () => { throw error; });
  expect(receipt).toMatchObject({ error, cleanupErrors: [], cleaned: true });
  expect(fetch.mock.calls.at(-1)[1].method).toBe('DELETE');
  expect(db.end).toHaveBeenCalledTimes(1);
});

test('finds and removes only the marked account after a lost create response', async () => {
  const { db, fetch, options, userId } = provider({ loseCreate: true });
  const use = jest.fn();
  const receipt = await withDevFixture(env, options, use);
  const create = JSON.parse(fetch.mock.calls[2][1].body);
  expect(receipt).toMatchObject({ error: { code: EXIT.authCreate }, cleanupErrors: [], cleaned: true });
  expect(use).not.toHaveBeenCalled();
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining('raw_app_meta_data'),
    [create.email, options.marker, create.app_metadata[options.marker]]);
  expect(new URL(fetch.mock.calls.at(-1)[0]).pathname).toBe(`${adminUsersPath}/${userId}`);
  expect(db.query.mock.calls.some(([sql]) => sql.startsWith('DELETE FROM public.'))).toBe(false);
});

test('reports fixed failure codes when the Auth account is still present after cleanup', async () => {
  const { db, options } = provider({ failDelete: true });
  const receipt = await withDevFixture(env, options, async () => 'completed');
  expect(receipt).toMatchObject({ result: 'completed', cleanupErrors: [EXIT.cleanupAuth, EXIT.cleanupVerify], cleaned: false });
  expect(db.end).toHaveBeenCalledTimes(1);
});
