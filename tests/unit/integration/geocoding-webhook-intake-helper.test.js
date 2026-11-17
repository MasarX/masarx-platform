const { fetchOutboundByRun, cleanupGeocodingTestFixture } = require('../../integration/helpers/geocodingWebhookIntake');

test.each([
  ['sender-only', '00000000-0000-0000-0000-000000000001', null],
  ['client-only', null, '00000000-0000-0000-0000-000000000002'],
  ['neither', null, null],
])('cleanup binds only supplied ownership IDs: %s', async (_name, senderId, clientId) => {
  const source = { id: '00000000-0000-0000-0000-000000000003', sender_id: senderId, client_id: clientId };
  const client = {
    query: jest.fn(async (sql) => ({ rows: sql.includes('FROM webhook_sources ws') ? [source] : [] })),
  };
  await cleanupGeocodingTestFixture(client, 'geocoding-owned-null-regression');
  const deletions = client.query.mock.calls.filter(([sql]) => sql.includes('DELETE FROM geocoding_attempts'));
  if (!senderId && !clientId) {
    expect(deletions).toHaveLength(0);
  } else {
    expect(deletions).toHaveLength(1);
    expect(deletions[0][0]).toContain('WHERE sender_id = $1::uuid');
    expect(deletions[0][0]).toContain('OR client_id = $2::uuid');
    expect(deletions[0][0]).not.toContain('IS NOT DISTINCT FROM');
    expect(deletions[0][1]).toEqual([senderId, clientId]);
  }
});

describe('geocodingWebhookIntake fetchOutboundByRun', () => {
  test('returns first outbound row when present on initial query', async () => {
    const expected = { id: 'outbound-1', call_type: 'provider_api' };
    const client = {
      query: jest.fn().mockResolvedValueOnce({ rows: [expected] }),
    };

    const result = await fetchOutboundByRun(client, '00000000-0000-0000-0000-000000000001');

    expect(result).toEqual(expected);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][0]).toContain('FROM outbound_calls');
  });

  test('retries and progresses workflow until outbound call is available', async () => {
    const expected = { id: 'outbound-2' };
    const client = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ progress_workflow_run: true }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ progress_workflow_run: true }] })
        .mockResolvedValueOnce({ rows: [expected] }),
    };

    const result = await fetchOutboundByRun(client, '00000000-0000-0000-0000-000000000002', {
      attempts: 3,
      progress: true,
      delayMs: 0,
    });

    expect(result).toEqual(expected);
    expect(client.query).toHaveBeenCalledTimes(5);
    expect(client.query.mock.calls[1][0]).toContain('progress_workflow_run');
    expect(client.query.mock.calls[3][0]).toContain('progress_workflow_run');
  });

  test('returns null after bounded retries and does not progress after last attempt', async () => {
    const client = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ progress_workflow_run: true }] })
        .mockResolvedValueOnce({ rows: [] }),
    };

    const result = await fetchOutboundByRun(client, '00000000-0000-0000-0000-000000000003', {
      attempts: 2,
      progress: true,
      delayMs: 0,
    });

    expect(result).toBeNull();
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls[1][0]).toContain('progress_workflow_run');
    expect(client.query.mock.calls[2][0]).toContain('FROM outbound_calls');
  });
});
