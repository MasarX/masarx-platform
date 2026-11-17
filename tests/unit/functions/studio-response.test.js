describe('final Studio response projection', () => {
  let projectStudioPayload;
  beforeAll(async () => {
    ({ projectStudioPayload } = await import('../../../supabase/functions/integration-plugin-studio/studio-response.mjs'));
  });
  test('awaits the shared projection and returns only its canonical result without mutating inference input', async () => {
    const original = { ok: true, normalized_contract: { token: 'synthetic-raw' }, correlation_id: 'synthetic-correlation' };
    const projected = { ...original, normalized_contract: { token: 'REDACTED' } };
    let complete;
    const client = { rpc: jest.fn(() => new Promise((resolve) => { complete = resolve; })) };
    const pending = projectStudioPayload(client, original);
    expect(client.rpc).toHaveBeenCalledWith('integration_plugin_redact_projection_v1', { p_value: original });
    expect(original.normalized_contract.token).toBe('synthetic-raw');
    complete({ data: projected, error: null });
    await expect(pending).resolves.toBe(projected);
    expect(original.normalized_contract.token).toBe('synthetic-raw');
  });
  test.each([null, [], 'bad', 42])('fails closed on malformed projection %j', async (data) => {
    const client = { rpc: jest.fn().mockResolvedValue({ data, error: null }) };
    await expect(projectStudioPayload(client, { token: 'synthetic-raw' })).rejects.toThrow('Studio response projection failed');
  });
  test.each(['returned error','rejected request'])('does not echo raw input or upstream details on %s', async (kind) => {
    const rpc = kind === 'returned error'
      ? jest.fn().mockResolvedValue({ data: { token: 'synthetic-raw' }, error: { message: 'synthetic-secret-error' } })
      : jest.fn().mockRejectedValue(new Error('synthetic-secret-error'));
    await expect(projectStudioPayload({ rpc }, { token: 'synthetic-raw' })).rejects.toEqual(new Error('Studio response projection failed'));
  });
});
