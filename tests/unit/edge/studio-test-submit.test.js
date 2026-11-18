const actor = '00000000-0000-4000-8000-000000000001';
const source = '00000000-0000-4000-8000-000000000002';
const event = '00000000-0000-4000-8000-000000000003';
describe('Studio private test submission', () => {
  let submitStudioTest;
  beforeAll(async () => ({ submitStudioTest } = await import('../../../supabase/functions/integration-plugin-studio/studio-test-submit.mjs')));
  afterEach(() => jest.restoreAllMocks());
  function fixture() {
    const material = { data: { source_id: source, headers: { 'x-webhook-token': 'private-token' } } };
    return { body: { source_id: source, actor_id: 'forged', payload: { event: { id: event } } }, bearer: 'user-bearer',
      userClient: { auth: { getUser: jest.fn().mockResolvedValue({ data: { user: { id: actor } } }) } },
      serviceClient: { rpc: jest.fn(() => ({ then: resolve => resolve(material) })) },
      functionsBaseUrl: 'http://rvzwwjlztwwisjthghnipgjr.example.invalid:54321/functions/v1/', fetchImpl: jest.fn().mockResolvedValue({ ok: true, status: 202, body: { cancel: jest.fn() } }) };
  }
  test('uses verified actor, preserves exact signed body, exposes only pending safe readback keys', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const f = fixture(); const result = await submitStudioTest(f);
    expect(f.userClient.auth.getUser).toHaveBeenCalledWith('user-bearer');
    expect(f.serviceClient.rpc).toHaveBeenCalledWith('integration_studio_test_material_v1', {
      p_actor_id: actor, p_source_id: source, p_raw_body: JSON.stringify(f.body.payload),
    });
    expect(f.fetchImpl.mock.calls[0][1].body).toBe(JSON.stringify(f.body.payload));
    expect(f.fetchImpl.mock.calls[0][0].href).toBe('http://rvzwwjlztwwisjthghnipgjr.example.invalid:54321/functions/v1/webhook-receiver');
    expect(f.fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(20000);
    expect(f.fetchImpl.mock.calls[0][1].redirect).toBe('error');
    expect(result).toEqual({ accepted: true, pending: true, http_status: 202, source_id: source, external_id: event });
    expect(JSON.stringify(result)).not.toMatch(/private-token|user-bearer|forged/);
  });
  test.each(['ftp://host/functions/v1', 'http://user@host/functions/v1', 'http://host/rest/v1',
    'http://host/functions/v1?secret=value', 'http://host/functions/v1#fragment'])('rejects invalid functions base %s', async functionsBaseUrl => {
    const f = fixture(); f.functionsBaseUrl = functionsBaseUrl;
    await expect(submitStudioTest(f)).rejects.toThrow('studio.test.ingress_configuration_invalid');
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  test('unverified actor never reaches material resolver', async () => {
    const f = fixture(); f.userClient.auth.getUser.mockResolvedValue({ error: new Error('secret') });
    await expect(submitStudioTest(f)).rejects.toThrow('studio.test.authentication_required');
    expect(f.serviceClient.rpc).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  test.each(['foreign', 'denied', 'not-test-enabled', 'stale-token'])('material denial %s never dispatches or leaks error', async reason => {
    const f = fixture(); f.serviceClient.rpc.mockResolvedValue({ error: new Error(reason + ' private-token') });
    await expect(submitStudioTest(f)).rejects.toThrow('studio.test.source_unavailable');
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  test('ambiguous transport is not retried or declared failed intake', async () => {
    const f = fixture(); f.fetchImpl.mockRejectedValue(new Error('private URL/token'));
    await expect(submitStudioTest(f)).rejects.toThrow('studio.test.transport_outcome_unknown');
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });
});
