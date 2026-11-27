const { randomBytes, X509Certificate } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { buildSupabaseProjectUrl } = require('../../../scripts/ops/workspace/preview-project');

const projectRef = 'a'.repeat(20);

function sweepEnv() {
  const certificate = new X509Certificate(readFileSync(join(__dirname, '../../../config/dev/sweep-recipient.crt')));
  return {
    GITHUB_ACTIONS: 'true', DEPLOY_ENV: 'dev', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'MasarX/masarx-platform',
    SUPABASE_PROJECT_REF: projectRef, NEXT_PUBLIC_SUPABASE_URL: buildSupabaseProjectUrl(projectRef),
    SUPABASE_ACCESS_TOKEN: randomBytes(24).toString('hex'),
    SWEEP_RECIPIENT_SHA256: certificate.fingerprint256, RUNNER_TEMP: tmpdir(),
  };
}

test('sweep reports only the Auth config HTTP status and stops before provisioning', async () => {
  const { provisionSweep } = await import('../../../scripts/deploy/dev-sweep-users.mjs');
  const response = new Response('private provider response', { status: 403 });
  const request = jest.spyOn(global, 'fetch').mockResolvedValue(response);
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(provisionSweep(sweepEnv())).rejects.toBeDefined();
    expect(request).toHaveBeenCalledTimes(1);
    expect(response.bodyUsed).toBe(false);
    expect(log.mock.calls.every(([line]) => line.startsWith('::add-mask::'))).toBe(true);
    expect(error.mock.calls).toEqual([['auth_config_http_status=403']]);
  } finally {
    request.mockRestore();
    log.mockRestore();
    error.mockRestore();
  }
});

// A synthetic row value; it stands in for personal data that must never reach the log.
const rowValue = `row-${randomBytes(6).toString('hex')}`;
const status = ['fixture_write_http_status=400'];

test.each([
  ['a body that is not JSON', `<html>${rowValue}</html>`, status],
  ['a JSON body without a SQLSTATE', { message: `rejected ${rowValue}` }, status],
  ['a wrapped unique violation with a DETAIL line',
    { message: `Failed to run sql query: ERROR:  23505: duplicate key value violates unique constraint "clients_organization_id_slug_key"\nDETAIL:  Key (organization_id, slug)=(${rowValue}) already exists.` },
    [...status, 'fixture_write_sqlstate=23505 constraint=clients_organization_id_slug_key']],
  ['a not-null violation',
    { message: `ERROR:  23502: null value in column "name" of relation "clients" violates not-null constraint\nDETAIL:  Failing row contains (${rowValue}).` },
    [...status, 'fixture_write_sqlstate=23502 column=name']],
  ['a missing column', { message: 'ERROR:  42703: column "slug" does not exist' },
    [...status, 'fixture_write_sqlstate=42703 column=slug']],
  ['hostile identifier fields', { code: '23505', constraint: `bad ${rowValue}`, column: `slug\n${rowValue}`, message: rowValue },
    [...status, 'fixture_write_sqlstate=23505']],
  ['a hostile code', { code: `23505\n${rowValue}`, message: rowValue }, status],
])('sweep reports only the fixture write status and SQLSTATE for %s', async (_case, body, expected) => {
  const { provisionSweep } = await import('../../../scripts/deploy/dev-sweep-users.mjs');
  const claims = Buffer.from(JSON.stringify({ role: 'service_role', ref: projectRef })).toString('base64url');
  const serviceKey = `e30.${claims}.${randomBytes(16).toString('base64url')}`;
  const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  const request = jest.spyOn(global, 'fetch').mockImplementation(async url => {
    if (url.endsWith('/config/auth')) return json({ external_email_enabled: true });
    if (url.endsWith('/api-keys?reveal=true')) return json([{ name: 'service_role', api_key: serviceKey }]);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 400 });
  });
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(provisionSweep(sweepEnv())).rejects.toBeDefined();
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2][0]).toMatch(/\/database\/query$/);
    expect(error.mock.calls).toEqual(expected.map(line => [line]));
    expect(JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toContain(rowValue);
  } finally {
    request.mockRestore();
    log.mockRestore();
    error.mockRestore();
  }
});

test('sweep reports the status and SQLSTATE of a read query under its own label', async () => {
  const { randomUUID } = require('node:crypto');
  const { provisionSweep } = await import('../../../scripts/deploy/dev-sweep-users.mjs');
  const claims = Buffer.from(JSON.stringify({ role: 'service_role', ref: projectRef })).toString('base64url');
  const serviceKey = `e30.${claims}.${randomBytes(16).toString('base64url')}`;
  const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  let queries = 0;
  const request = jest.spyOn(global, 'fetch').mockImplementation(async url => {
    if (url.endsWith('/config/auth')) return json({ external_email_enabled: true });
    if (url.endsWith('/api-keys?reveal=true')) return json([{ name: 'service_role', api_key: serviceKey }]);
    // The fixture write succeeds; the first role's identity read is refused.
    if (++queries === 1) return json([{ organization_id: randomUUID(), sender_id: randomUUID() }]);
    return new Response(JSON.stringify({ message: `ERROR:  42501: permission denied ${rowValue}` }), { status: 400 });
  });
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(provisionSweep(sweepEnv())).rejects.toBeDefined();
    expect(request).toHaveBeenCalledTimes(4);
    expect(error.mock.calls).toEqual([['identity_read_http_status=400'], ['identity_read_sqlstate=42501']]);
    expect(JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toContain(rowValue);
  } finally {
    request.mockRestore();
    log.mockRestore();
    error.mockRestore();
  }
});
