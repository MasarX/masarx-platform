const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../integration/api-gateway-ingest.test.js'), 'utf8');
const start = source.indexOf('async function executeGatewayFetch(');
const end = source.indexOf('async function waitForGatewayRequest(', start);
function load(fetch) {
  const signal = {};
  const timeout = jest.fn(() => signal);
  const execute = vm.runInNewContext(source.slice(start, end) + '\nexecuteGatewayFetch', {
    fetch, AbortSignal: { timeout }, SUPABASE_URL:'https://fixture.invalid',
    OUTER_AUTH_VALUE:'fixture-auth',process:{env:{}},
  });
  return {execute,signal,timeout};
}
function loadDispatch(pool, sleep = jest.fn().mockResolvedValue(undefined)) {
  const helperStart = source.indexOf('const GATEWAY_DISPATCH_SETUP_OPERATIONS');
  const helperEnd = source.indexOf('async function materializeGatewayResponse(', helperStart);
  expect(helperStart).toBeGreaterThan(0);
  expect(helperEnd).toBeGreaterThan(helperStart);
  return vm.runInNewContext(
    source.slice(helperStart, helperEnd) + '\ncompleteGatewayDispatch',
    { pool, sleep, Error, Set, console: { warn: jest.fn() } },
  );
}
function receipt(overrides = {}) {
  return {
    request_id: 'request-1', workflow_run_id: 'workflow-1', outbound_call_id: null,
    workflow_status: 'in_progress', operation_name: 'materialize_addresses',
    step_status: 'pending', step_ready: true, ...overrides,
  };
}
test('workflow ingress observability selects its exact decision and lineage', () => {
  expect(source).toContain("AND metadata->>'decision_point' = 'api_gateway_workflow_enqueued'");
  expect(source).toContain("expect(observabilityRows[0].status).toBe('enqueued')");
  expect(source).toContain('decision_inputs?.workflow_run_id).toBe(requestRow.workflow_run_id)');
  expect(source).toContain('decision_inputs?.path).toBe(fixture.routePath)');
});

test('one deadline covers POST and body without replay', async () => {
  const failure = new Error('body deadline');
  const text = jest.fn().mockRejectedValue(failure);
  const fetch = jest.fn().mockResolvedValue({status:202,text});
  const {execute,signal,timeout}=load(fetch);
  await expect(execute('token',{}, {upstreamPath:'/api/owned'})).rejects.toBe(failure);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1].signal).toBe(signal);
  expect(timeout).toHaveBeenCalledWith(30000);
  expect(text).toHaveBeenCalledTimes(1);
});
test('ambiguous POST failure is never replayed', async () => {
  const failure = new Error('fetch failed');
  const fetch=jest.fn().mockRejectedValue(failure);
  await expect(load(fetch).execute('token',{}, {upstreamPath:'/api/owned'})).rejects.toBe(failure);
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('503 rejects without reading or exposing upstream body', async () => {
  const text=jest.fn().mockResolvedValue('private body');
  const fetch=jest.fn().mockResolvedValue({status:503,text});
  await expect(load(fetch).execute('token',{}, {upstreamPath:'/api/owned'})).rejects.toThrow('Gateway runtime unavailable: HTTP 503');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(text).not.toHaveBeenCalled();
  expect(source).not.toContain('Skipping assertions');
});
test('owned route binds insertion and all callers; duplicate readback excludes first ID', () => {
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  expect(source.match(/upstreamPath: fixture\.routePath/g)).toHaveLength(4);
  expect(source).toContain('JSON.stringify(policy), fixture.routePath]');
  expect(source).toContain('expect(requestRow.path).toBe(fixture.routePath)');
  expect(source).not.toMatch(/DELETE FROM api_routes\s+WHERE method/);
  expect(source).toContain('DELETE FROM api_routes WHERE id = $1::uuid');
  expect(source).toContain('AND ($3::uuid IS NULL OR id <> $3::uuid)');
  expect(source).toContain('waitForGatewayRequest(fixture, clientReferenceNumber, 15000, firstRequest.id)');
  expect(source).toContain('workflow_run_id');
  expect(source).not.toContain('if (rows[0]?.outbound_call_id) return rows[0]');
  expect(source).not.toContain('attempt < 20');
  const cleanupStart = source.indexOf('async function cleanupGatewayArtifacts(');
  const cleanupEnd = source.indexOf('async function cleanupGatewayFixture(', cleanupStart);
  const cleanupSource = source.slice(cleanupStart, cleanupEnd);
  const actionDelete = cleanupSource.indexOf('DELETE FROM shipment_actions');
  const shipmentDelete = cleanupSource.indexOf('DELETE FROM shipments');
  expect(cleanupStart).toBeGreaterThan(0);
  expect(cleanupEnd).toBeGreaterThan(cleanupStart);
  expect(cleanupSource).toMatch(/DELETE FROM shipment_actions\s+WHERE client_id = \$1::uuid\s+AND shipment_id IN \(\s+SELECT id\s+FROM shipments\s+WHERE client_id = \$1::uuid\s+\)/);
  expect(actionDelete).toBeGreaterThanOrEqual(0);
  expect(shipmentDelete).toBeGreaterThan(actionDelete);
});
test('accepted async fallback advances only owned setup steps, including waiting steps that are due', async () => {
  const query = jest.fn()
    .mockResolvedValueOnce({ rows: [receipt({ workflow_status: 'waiting', step_ready: true })] })
    .mockResolvedValueOnce({ rows: [{ result: {
      status: 'completed', items_processed: 1, error_occurred: false,
      progress: { status: 'completed', step_id: 'step-1' },
    } }] })
    .mockResolvedValueOnce({ rows: [receipt({ operation_name: 'dispatch_create' })] })
    .mockResolvedValueOnce({ rows: [{ result: {
      status: 'completed', items_processed: 1, error_occurred: false,
      progress: { status: 'completed', step_id: 'step-2' },
    } }] })
    .mockResolvedValueOnce({ rows: [receipt({ outbound_call_id: 'outbound-1', operation_name: 'wait_for_shipment' })] });
  const result = await loadDispatch({ query })({ sourceId: 'source-1' }, { id: 'request-1' });
  expect(result.outbound_call_id).toBe('outbound-1');
  expect(query).toHaveBeenCalledTimes(5);
  expect(query.mock.calls.filter(([sql]) => sql.includes('run_workflow_engine_worker_step_v1'))).toHaveLength(2);
  expect(query.mock.calls.filter(([sql]) => sql.includes('run_workflow_engine_worker_step_v1')).map(([, args]) => args)).toEqual([
    ['workflow-1'], ['workflow-1'],
  ]);
});
test('accepted async fallback retries one exact owned contention and accepts concurrent outbound progress', async () => {
  const sleep = jest.fn().mockResolvedValue(undefined);
  const worker = {
    status: 'idle', items_processed: 0, error_occurred: false,
    progress: {},
  };
  const query = jest.fn()
    .mockResolvedValueOnce({ rows: [receipt()] })
    .mockResolvedValueOnce({ rows: [{ result: worker }] })
    .mockResolvedValueOnce({ rows: [receipt()] })
    .mockResolvedValueOnce({ rows: [receipt({ outbound_call_id: 'outbound-concurrent' })] });
  const result = await loadDispatch({ query }, sleep)({ sourceId: 'source-1' }, { id: 'request-1' });
  expect(result.outbound_call_id).toBe('outbound-concurrent');
  expect(sleep).toHaveBeenCalledTimes(1);
  expect(sleep).toHaveBeenCalledWith(100);
  expect(query.mock.calls.filter(([sql]) => sql.includes('run_workflow_engine_worker_step_v1'))).toHaveLength(1);
});
test('accepted async fallback fails unchanged contention after one retry with safe worker diagnostics', async () => {
  const sleep = jest.fn().mockResolvedValue(undefined);
  const worker = {
    status: 'idle', items_processed: 0, error_occurred: false,
    progress: { status: 'pending', private_error: 'private-provider-secret' },
  };
  const query = jest.fn()
    .mockResolvedValueOnce({ rows: [receipt()] })
    .mockResolvedValueOnce({ rows: [{ result: worker }] })
    .mockResolvedValueOnce({ rows: [receipt()] })
    .mockResolvedValueOnce({ rows: [receipt()] })
    .mockResolvedValueOnce({ rows: [{ result: worker }] })
    .mockResolvedValueOnce({ rows: [receipt()] });
  let failure;
  try {
    await loadDispatch({ query }, sleep)({ sourceId: 'source-1' }, { id: 'request-1' });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    message: 'gateway_workflow_no_dispatch_progress',
    receipt: {
      code: 'gateway_workflow_no_dispatch_progress',
      worker_status: 'idle',
      worker_items_processed: 0,
      worker_progress_status: 'pending',
      worker_has_step: false,
    },
  });
  expect(sleep).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(failure)).not.toContain('private-provider-secret');
});
test.each([
  ['waiting but not due', receipt({ workflow_status: 'waiting', step_ready: false }), 'gateway_workflow_not_ready'],
  ['foreign next step', receipt({ operation_name: 'unrelated_operation' }), 'gateway_workflow_no_dispatch_progress'],
])('accepted async fallback fails safely for %s', async (_label, current, code) => {
  const query = jest.fn().mockResolvedValueOnce({ rows: [current] });
  await expect(loadDispatch({ query })({ sourceId: 'source-1' }, { id: 'request-1' })).rejects.toMatchObject({
    message: code,
    receipt: { code, request_id: 'request-1', workflow_run_id: 'workflow-1' },
  });
  expect(query).toHaveBeenCalledTimes(1);
});
test('accepted async fallback does not expose worker errors', async () => {
  const query = jest.fn()
    .mockResolvedValueOnce({ rows: [receipt()] })
    .mockResolvedValueOnce({ rows: [{ result: {
      status: 'completed', items_processed: 0, error_occurred: false,
      progress: { status: 'failed', error: 'private-provider-secret' },
    } }] });
  let failure;
  try {
    await loadDispatch({ query })({ sourceId: 'source-1' }, { id: 'request-1' });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    message: 'gateway_workflow_progress_failed',
    receipt: { code: 'gateway_workflow_progress_failed', operation_name: 'materialize_addresses' },
  });
  expect(JSON.stringify(failure)).not.toContain('private-provider-secret');
});
