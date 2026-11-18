const fs = require('fs');
const path = require('path');

describe('F823 permanent provider failure wait contract', () => {
  const terminal = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20260910002000_wait_shipment_provider_terminal_v1.sql'), 'utf8');
  test('uses canonical request/run linkage and permanent-only status', () => {
    expect(terminal).toContain('outbound.id = request.outbound_call_id');
    expect(terminal).toContain('request.workflow_run_id = p_run.id');
    expect(terminal).toContain('p_step.workflow_run_id = p_run.id');
    expect(terminal).toContain("outbound.status = 'permanently_failed'");
    expect(terminal).not.toContain("outbound.status = 'failed'");
  });
  test('preserves success precedence, timeout and pinned definer search path', () => {
    for (const marker of ["'shipment_found', TRUE", 'INTO v_provider_failure', 'IF v_elapsed_seconds >=']) expect(terminal.indexOf(marker)).toBeGreaterThanOrEqual(0);
    expect(terminal.indexOf("'shipment_found', TRUE")).toBeLessThan(terminal.indexOf('INTO v_provider_failure'));
    expect(terminal.indexOf('INTO v_provider_failure')).toBeLessThan(terminal.indexOf('IF v_elapsed_seconds >='));
    expect(terminal).toContain("v_response.last_error := 'shipment_wait_timeout'");
    expect(terminal).toContain('SET search_path = public, workflow_handlers, extensions, pg_temp');
  });
  test('provider failure output excludes raw response and credentials', () => {
    const failure = terminal.slice(terminal.indexOf('IF FOUND THEN', terminal.indexOf('INTO v_provider_failure')),terminal.indexOf('IF v_elapsed_seconds >='));
    expect(failure.length).toBeGreaterThan(0);
    expect(failure).toContain("'response_status_code', v_provider_failure.response_status_code");
    expect(failure).not.toMatch(/response_body|response_headers|error_message|auth_token/);
  });
});

describe('API Gateway workflow replay and secret hygiene reconstruction', () => {
  const migration = fs.readFileSync(
    path.join(
      process.cwd(),
      'supabase',
      'migrations',
      '202608161520_b3_api_gateway_workflow_replay_secret_hygiene_v1.sql',
    ),
    'utf8',
  );
  const edge = fs.readFileSync(
    path.join(process.cwd(), 'supabase', 'functions', 'api-gateway', 'index.ts'),
    'utf8',
  );
  const pgtap = fs.readFileSync(
    path.join(
      process.cwd(),
      'supabase',
      'tests',
      'pgtap',
      '0zz_api_gateway_workflow_replay_secret_hygiene_v1.sql',
    ),
    'utf8',
  );

  test('collapses historical workflow defaults into one deterministic three-step template', () => {
    expect(migration).toContain("'api_gateway_shipment_create_default_v1'");
    expect(migration).toContain("'materialize_addresses'");
    expect(migration).toContain("'dispatch_create'");
    expect(migration).toContain("'wait_for_shipment'");
    expect(migration).toContain("'decision_log_event', 'api_gateway.wait_for_shipment'");
    expect(migration).toContain('public.progress_workflow_run(p_workflow_run_id');
    expect(migration).not.toContain('pg_get_functiondef');
  });

  test('keeps replay lineage inbound and strips secret-bearing provider egress fields', () => {
    expect(migration).toContain("'x-masarx-replay-of'");
    expect(migration).toContain('api_gateway_strip_body_field_auth_v1');
    expect(migration).toContain('trg_api_gateway_outbound_secret_guard_v1');
    expect(migration).toContain('trg_api_gateway_workflow_secret_guard_v1');
    expect(migration).toContain("ARRAY['payload', 'transformed_payload']::TEXT[]");
    expect(migration).toContain("'{api_gateway,request_body}'");
  });

  test('dispatches accepted workflow requests only through linked narrow RPCs', () => {
    expect(edge).toContain('/rest/v1/rpc/progress_api_gateway_request_workflow_v1');
    expect(edge).toContain('/rest/v1/rpc/get_api_gateway_edge_dispatch_jobs_v1');
    expect(edge).toContain('if (workflowRunId && apiGatewayRequestId)');
    expect(edge).toContain('edgeRuntime.waitUntil(task)');
    expect(migration).toContain('request.workflow_run_id IS NOT NULL');
    expect(migration).toContain("outbound.status = 'pending_edge'");
    expect(migration).toContain('v_linked_workflow_id IS DISTINCT FROM p_workflow_run_id');
  });

  test('ships focused database fixture coverage for grants, defaults, replay, and secret guards', () => {
    expect(pgtap).toContain('SELECT plan(28)');
    expect(pgtap).toContain('trg_api_gateway_outbound_secret_guard_v1');
    expect(pgtap).toContain('trg_api_gateway_workflow_secret_guard_v1');
    expect(pgtap).toMatch(/x-masarx-replay-of/i);
    expect(pgtap).toContain('edge_api_gateway_role');
    expect(pgtap).toContain('enabled shipment.create routes cannot disable workflow mode');
  });
});
