const { verifyStartup } = require('../../../scripts/qa/verify-dev-edge-startup.cjs');
const { functions } = require('../../../config/edge/functions.json');
const { functionsForDeploy } = require('../../../scripts/edge/functions-registry');

const ref = 'a'.repeat(20);
const jwt = role => ['header', Buffer.from(JSON.stringify({ role, ref })).toString('base64url'), 'signature'].join('.');

test('checks every enabled DEV function with a read-only request and uses the anon JWT only where required', async () => {
  const probe = jest.fn(async () => new Response(null, { status: 404 }));
  const results = await verifyStartup(ref, jwt('anon'), probe);
  const enabled = functionsForDeploy(functions, 'dev');
  expect(results.map(result => result.name)).toEqual(enabled.map(entry => entry.name));
  expect(probe.mock.calls).toHaveLength(enabled.length);
  for (const [index, { name, auth_mode }] of enabled.entries()) {
    const [url, request] = probe.mock.calls[index];
    expect(url).toBe(`https://${ref}.supabase.co/functions/v1/${name}`);
    expect(request).toMatchObject({ method: 'OPTIONS', redirect: 'error' });
    expect(request.headers).toEqual(auth_mode === 'supabase_jwt' ? { authorization: `Bearer ${jwt('anon')}` } : {});
  }
  expect(results.every(result => !result.passed)).toBe(true);
});

test.each([
  [204, true, false, true],
  [204, false, false, false],
  [204, true, true, false],
  [503, true, false, false],
])('requires the handler response (status %i, runtime %s, platform error %s) with result %s', async (status, runtime, platformError, passed) => {
  const probe = async () => new Response(null, {
    status,
    headers: {
      ...(runtime && { 'x-deno-execution-id': '00000000-0000-4000-8000-000000000000' }),
      ...(platformError && { 'sb-error-code': 'BOOT_ERROR' }),
    },
  });
  const results = await verifyStartup(ref, jwt('anon'), probe);
  expect(results.find(result => result.name === 'label-renderer')).toMatchObject({ status, executed: runtime, passed });
});

test('rejects a privileged JWT before making any requests', async () => {
  const probe = jest.fn();
  await expect(verifyStartup(ref, jwt('service_role'), probe)).rejects.toThrow('A DEV legacy anon JWT is required');
  expect(probe).not.toHaveBeenCalled();
});
