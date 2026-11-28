const { captureIntegrationEdge } = require('../../../scripts/ci-hosted/stack-diagnostics.cjs');

test('captures Edge lifecycle and renderer gateway errors without publishing container or request data', async () => {
  const at = '2026-11-28T14:15:48.384691900Z';
  const edge = 'supabase_edge_runtime_synthetic';
  const gateway = 'supabase_kong_synthetic';
  const privateText = 'synthetic-content-that-must-stay-out';
  const execute = jest.fn(async (command, args) => {
    expect(command).toBe('docker');
    const container = args.at(-1);
    if (args[0] === 'inspect') return JSON.stringify({
      id: container === edge ? 'edge-id' : 'gateway-id',
      state: { OOMKilled: container === edge, StartedAt: at, Error: privateText },
      restarts: 1,
      networks: { [privateText]: { EndpointID: 'endpoint', NetworkID: 'shared', IPAddress: privateText } },
    });
    if (args[0] === 'events') return [
      { Type: 'container', Action: 'die', Actor: { ID: 'edge-id', Attributes: { name: edge, exitCode: '137' } }, time: 1 },
      { Type: 'network', Action: 'disconnect', Actor: { Attributes: { container: 'edge-id', name: privateText } }, time: 2 },
      { Type: 'container', Action: 'oom', Actor: { Attributes: { name: 'unrelated-container' } }, time: 3 },
    ].map(row => JSON.stringify(row)).join('\n');
    if (container === edge) return `${at} worker creation failed: ${privateText}`;
    return `${at} name resolution failed for /functions/v1/label-renderer?request=${privateText}\n`
      + `${at} upstream timed out for /functions/v1/unrelated`;
  });

  const result = await captureIntegrationEdge({ project: 'synthetic', env: {}, since: at, execute });
  expect(result).toMatchObject({
    edge: { oomKilled: true, restarts: 1, startedAt: at, networkCount: 1 },
    sharedNetwork: true,
    lifecycle: [
      { service: 'edge', action: 'die', time: 1, exitCode: 137 },
      { service: 'edge', action: 'disconnect', time: 2 },
    ],
    edgeLogs: [{ at, kind: 'worker_boot' }],
    gatewayLogs: [{ at, kind: 'dns_failure' }],
  });
  expect(execute).toHaveBeenCalledWith('docker', expect.arrayContaining(['logs', '--timestamps', edge]),
    expect.objectContaining({ includeStderr: true, printQuietFailure: false }));
  expect(JSON.stringify(result)).not.toContain(privateText);
});
