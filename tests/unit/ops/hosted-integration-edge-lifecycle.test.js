const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { captureIntegrationEdge, observeIntegrationEdgeLifecycle } = require('../../../scripts/ci-hosted/stack-diagnostics.cjs');

test('retains Edge exit and network events across unrelated Docker activity', async () => {
  const at = '2026-11-28T15:48:35.107046189Z';
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), exitCode: null, signalCode: null });
  child.kill = jest.fn(() => {
    child.stdout.once('end', () => child.emit('close'));
    child.stdout.end();
    return true;
  });
  const launch = jest.fn(() => child);
  const options = { project: 'synthetic', env: {}, since: at };
  const stopEvents = observeIntegrationEdgeLifecycle({ ...options, launch });
  const write = event => child.stdout.write(`${JSON.stringify(event)}\n`);
  const actor = { ID: 'edge-id', Attributes: { name: 'supabase_edge_runtime_synthetic', exitCode: '135' } };
  write({ Type: 'container', Action: 'start', Actor: actor, time: 1 });
  write({ Type: 'network', Action: 'disconnect', Actor: { Attributes: { container: 'edge-id' } }, time: 2 });
  write({ Type: 'container', Action: 'die', Actor: actor, time: 2 });
  for (let i = 3; i < 300; i++) {
    write({ Type: 'container', Action: 'die', Actor: { Attributes: { name: 'unrelated-container' } }, time: i });
  }
  const execute = jest.fn(async (_command, args) => {
    if (args[0] !== 'logs') return '';
    if (args.at(-1) === actor.Attributes.name) {
      return `${at} Could not initialize cache database 'fixture/path', deleting and retrying... (DatabaseBusy)`;
    }
    return `${at} name resolution failed for /functions/v1/webhook-receiver?request=fixture-value`;
  });
  const report = await captureIntegrationEdge({ ...options, stopEvents, execute });
  expect(report).toMatchObject({
    lifecycleCapture: 'live',
    lifecycle: [
      { service: 'edge', action: 'start', time: 1 },
      { service: 'edge', action: 'disconnect', time: 2 },
      { service: 'edge', action: 'die', time: 2, exitCode: 135 },
    ],
    edgeLogs: [{ at, kind: 'cache_contention' }, { at, kind: 'cache_replacement' }],
    gatewayLogs: [{ at, kind: 'dns_failure' }],
  });
  expect(launch).toHaveBeenCalledWith('docker', expect.arrayContaining(['events', '--since', at]), expect.any(Object));
  expect(execute.mock.calls.some(([, args]) => args[0] === 'events')).toBe(false);
  expect(JSON.stringify(report)).not.toMatch(/fixture\/path|fixture-value|edge-id|unrelated-container/);
  await stopEvents();
  expect(child.kill).toHaveBeenCalledTimes(1);
});
