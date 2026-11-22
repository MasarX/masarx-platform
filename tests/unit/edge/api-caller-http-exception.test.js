let egress;
let invocation;

beforeAll(async () => {
  [egress, invocation] = await Promise.all([
    import('../../../supabase/functions/api-caller/egress.mjs'),
    import('../../../supabase/functions/api-caller/invocation.mjs'),
  ]);
});

const policy = {
  allowedMethods: ['GET'],
  transportMode: 'guarded_proxy',
  followRedirects: true,
  maxRedirects: 2,
};
const approvedHost = 'approved.example.test';

const execute = (options) => egress.executeBoundedEgress({
  url: 'http://approved.example.test/data',
  method: 'GET',
  timeoutMs: 1000,
  policy,
  resolveDns: async (_host, recordType) => recordType === 'A' ? [[8, 8, 8, 8].join('.')] : [],
  ...options,
});

test('only the server-resolved URL spec supplies the HTTP exception', () => {
  const jobId = 'f8ce3064-473b-4a0c-af78-2f57b202aca0';
  expect(() => invocation.validateInvocationPayload({ job_id: jobId, http_allowed_host: approvedHost }))
    .toThrow('http_allowed_host is server-resolved');
  expect(invocation.mergeServerDispatch({}, { http_allowed_host: approvedHost }).http_allowed_host).toBeUndefined();
  expect(invocation.mergeServerDispatch({ http_allowed_host: approvedHost }).http_allowed_host).toBe(approvedHost);
});

test('the guarded transport sends HTTP only to the approved hostname', async () => {
  const guardedFetch = jest.fn().mockResolvedValue(new Response(null, { status: 204 }));
  await expect(execute({ guardedFetch })).rejects.toThrow('only https');
  expect(guardedFetch).not.toHaveBeenCalled();
  await expect(execute({ guardedFetch, httpAllowedHost: approvedHost })).resolves.toMatchObject({ status: 204 });
  expect(guardedFetch).toHaveBeenCalledTimes(1);
});

test('the HTTP exception keeps DNS checks and cannot follow a redirect to another HTTP hostname', async () => {
  const guardedFetch = jest.fn().mockResolvedValue(new Response(null, {
    status: 302,
    headers: { location: 'http://other.example.test/data' },
  }));
  await expect(execute({
    guardedFetch,
    httpAllowedHost: approvedHost,
    resolveDns: async (_host, recordType) => recordType === 'A' ? [[10, 0, 0, 1].join('.')] : [],
  })).rejects.toThrow('non-public address');
  expect(guardedFetch).not.toHaveBeenCalled();
  await expect(execute({ guardedFetch, httpAllowedHost: approvedHost })).rejects.toThrow('only https');
  expect(guardedFetch).toHaveBeenCalledTimes(1);
});
