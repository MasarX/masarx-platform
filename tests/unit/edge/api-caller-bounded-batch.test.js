const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../../..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/202608161600_b3_api_caller_bounded_batch_v1.sql'),
  'utf8',
);
const edgeSource = fs.readFileSync(
  path.join(root, 'supabase/functions/api-caller/index.ts'),
  'utf8',
);

const functionSection = (name, nextName) => {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  const end = nextName
    ? migration.indexOf(`CREATE OR REPLACE FUNCTION public.${nextName}`, start + 1)
    : migration.indexOf('CREATE OR REPLACE FUNCTION api.', start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end);
};

describe('api-caller bounded batch lease ownership contract', () => {
  test('claims exactly one immediately executable ID with a fresh opaque ownership token', () => {
    const claim = functionSection(
      'claim_pending_edge_job_ids_v1',
      'claim_edge_job_by_id_v1',
    );

    expect(claim).toContain('RETURNS TABLE (job_id UUID, lease_token UUID)');
    expect(claim).toContain('v_limit CONSTANT INT := 1');
    expect(claim).toContain("v_lease_interval CONSTANT INTERVAL := interval '12 minutes'");
    expect(claim).toContain('LIMIT v_limit');
    expect(claim).toContain('FOR UPDATE SKIP LOCKED');
    expect(claim).toContain('v_lease_token := gen_random_uuid()');
    expect(claim).toContain('edge_lease_token = v_lease_token');
    expect(claim).not.toContain('get_job_call_spec(');
    expect(claim).not.toContain('dispatch JSONB');
  });

  test('direct job claims use the same fresh token fence and 12-minute lease', () => {
    const claim = functionSection(
      'claim_edge_job_by_id_v1',
      'get_claimed_edge_job_call_spec_v1',
    );

    expect(claim).toContain('RETURNS TABLE (job_id UUID, lease_token UUID)');
    expect(claim).toContain('v_lease_token UUID := gen_random_uuid()');
    expect(claim).toContain("lease_expires_at = now() + interval '12 minutes'");
    expect(claim).toContain("AND oc.status IN ('pending_edge', 'failed')");
    expect(claim).toContain('edge_lease_token = v_lease_token');
    expect(claim).toContain('RETURNING oc.id, oc.edge_lease_token INTO job_id, lease_token');
  });

  test('spec resolution is compare-and-swap fenced by token, status, and unexpired lease', () => {
    const spec = functionSection(
      'get_claimed_edge_job_call_spec_v1',
      'renew_claimed_edge_job_lease_v1',
    );

    expect(spec).toContain('p_lease_token UUID');
    expect(spec).toContain("AND oc.status = 'in_progress_edge'");
    expect(spec).toContain('AND oc.edge_lease_token = p_lease_token');
    expect(spec).toContain('AND oc.lease_expires_at > now()');
    expect(spec).toContain('FOR UPDATE');
    expect(spec).toContain('v_spec := public.get_job_call_spec(p_job_id)');
    expect(spec).toContain("status = 'permanently_failed'");
    expect(spec).toContain('edge_lease_token = NULL');
  });

  test('lease renewal covers the 600-second request cap plus bounded overhead', () => {
    const renewal = functionSection(
      'renew_claimed_edge_job_lease_v1',
      'mark_claimed_edge_job_success_v1',
    );

    expect(renewal).toContain("SET lease_expires_at = now() + interval '12 minutes'");
    expect(renewal).toContain('AND oc.edge_lease_token = p_lease_token');
    expect(renewal).toContain('AND oc.lease_expires_at > now()');
    expect(renewal).toContain("RAISE EXCEPTION 'renew_claimed_edge_job_lease_v1: active lease");
  });

  test.each([
    ['success', 'mark_outbound_call_success'],
    ['failure', 'mark_outbound_call_failure'],
  ])('rejects stale-token %s completion before invoking the legacy finalizer', (kind, legacy) => {
    const next = kind === 'success'
      ? 'mark_claimed_edge_job_failure_v1'
      : null;
    const finalize = functionSection(`mark_claimed_edge_job_${kind}_v1`, next);
    const fenceOffset = finalize.indexOf('AND oc.edge_lease_token = p_lease_token');
    const expiryOffset = finalize.indexOf('AND oc.lease_expires_at > now()');
    const lockOffset = finalize.indexOf('FOR UPDATE');
    const notFoundOffset = finalize.indexOf('IF NOT FOUND THEN');
    const legacyOffset = finalize.indexOf(`PERFORM public.${legacy}`);

    expect(fenceOffset).toBeGreaterThanOrEqual(0);
    expect(expiryOffset).toBeGreaterThan(fenceOffset);
    expect(lockOffset).toBeGreaterThan(expiryOffset);
    expect(notFoundOffset).toBeGreaterThan(lockOffset);
    expect(legacyOffset).toBeGreaterThan(notFoundOffset);
  });

  test('requeue and legacy status transitions clear the old token before any reclaim', () => {
    const trigger = functionSection(
      'clear_stale_edge_lease_token_v1',
      'claim_pending_edge_job_ids_v1',
    );

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS edge_lease_token UUID');
    expect(trigger).toContain('NEW.status IS DISTINCT FROM OLD.status');
    expect(trigger).toContain(
      'OLD.lease_expires_at IS NOT NULL AND NEW.lease_expires_at IS NULL',
    );
    expect(trigger).toContain('NEW.edge_lease_token IS NOT DISTINCT FROM OLD.edge_lease_token');
    expect(trigger).toContain('NEW.edge_lease_token := NULL');
    expect(migration).toContain('CREATE TRIGGER outbound_calls_clear_stale_edge_lease_token_v1');
    expect(migration).toContain('v_lease_token := gen_random_uuid()');
  });

  test('preserves legacy RPCs and restricts every new public and api contract', () => {
    expect(migration).not.toContain(
      'CREATE OR REPLACE FUNCTION public.claim_pending_edge_jobs(',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION api.claim_pending_edge_job_ids_v1',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION api.mark_claimed_edge_job_success_v1',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION api.mark_claimed_edge_job_failure_v1',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION api.resolve_effective_outbound_egress_policy_v1',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION api.log_api_call_event',
    );
    expect(migration).toContain("ARRAY['anon', 'authenticated']");
    expect(migration).toContain("ARRAY['service_role', 'edge_api_caller_role']");
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.clear_stale_edge_lease_token_v1() FROM PUBLIC',
    );
    expect(migration).toContain("'public.mark_outbound_call_failure_v2(UUID, INT, JSONB, JSONB, TEXT, TEXT, UUID)'");
    expect(migration).toContain("EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_signature)");
    expect(migration).toContain("EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', v_signature, v_role)");
    expect(migration).toContain("EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_signature, v_role)");
  });

  test('every runtime RPC has an api wrapper and an intended exact ACL entry', () => {
    const runtimeRpcNames = Array.from(edgeSource.matchAll(/client\.rpc\("([^"]+)"/g))
      .map((match) => match[1]);
    const uniqueRuntimeRpcNames = Array.from(new Set(runtimeRpcNames)).sort();
    const expectedRuntimeRpcNames = [
      'claim_edge_job_by_id_v1',
      'claim_pending_edge_job_ids_v1',
      'get_claimed_edge_job_call_spec_v1',
      'mark_claimed_edge_job_failure_v1',
      'mark_claimed_edge_job_success_v1',
      'renew_claimed_edge_job_lease_v1',
      'resolve_effective_outbound_egress_policy_v1',
    ];

    expect(uniqueRuntimeRpcNames).toEqual(expectedRuntimeRpcNames);
    for (const rpcName of uniqueRuntimeRpcNames) {
      expect(migration).toContain(`CREATE OR REPLACE FUNCTION api.${rpcName}`);
      expect(migration).toMatch(new RegExp(`'api\\.${rpcName}\\([^']*\\)'`));
    }
  });

  test('only fenced finalizers write leased Edge terminal audits', () => {
    const migrationDir = path.join(root, 'supabase/migrations');
    const matches = fs.readdirSync(migrationDir)
      .filter((name) => name.endsWith('_renderer_calls_via_edge.sql'));
    expect(matches).toHaveLength(1);
    const transport = fs.readFileSync(path.join(migrationDir, matches[0]), 'utf8');
    const auditWriters = [...transport.matchAll(/^CREATE (?:OR REPLACE )?FUNCTION (?:public|api)\.(\w+)\([\s\S]+?\bAS (\$\w*\$)([\s\S]+?)^\2;/gim)]
      .filter(([, , , body]) => body.includes('PERFORM public.log_api_call_event('));
    expect(auditWriters.map(([, name]) => name)).toEqual([
      'mark_claimed_edge_job_success_v1',
      'mark_claimed_edge_job_failure_v1',
      'run_outbound_worker',
      'dispatch_outbound_call_inline',
    ]);
    for (const [, name, , body] of auditWriters.slice(0, 2)) {
      expect(body).toMatch(/oc\.id = p_job_id[\s\S]+oc\.status = 'in_progress_edge'[\s\S]+oc\.edge_lease_token = p_lease_token[\s\S]+oc\.lease_expires_at > now\(\)[\s\S]+FOR UPDATE;[\s\S]+IF NOT FOUND THEN\s+RAISE EXCEPTION[\s\S]+PERFORM public\.log_api_call_event\(/);
      expect(body.match(/PERFORM public\.log_api_call_event\(/g)).toHaveLength(1);
      expect(body.indexOf('PERFORM public.log_api_call_event('))
        .toBeLessThan(body.indexOf(`PERFORM public.mark_outbound_call_${name.includes('_success_') ? 'success' : 'failure'}(`));
    }
  });

  test('direct runtime path has no legacy unfenced mutation or spec fallback', () => {
    const directStart = edgeSource.indexOf('const executeJob = async');
    const directEnd = edgeSource.indexOf('const executeClaimedJobById = async', directStart);
    const direct = edgeSource.slice(directStart, directEnd);

    expect(direct).toContain('client.rpc("claim_edge_job_by_id_v1"');
    expect(direct).toContain('executeClaimedJobById(jobId, claim.lease_token, override)');
    expect(direct).not.toContain('mark_outbound_call_in_progress');
    expect(direct).not.toContain('get_job_call_spec');
    expect(edgeSource).not.toContain('client.rpc("mark_outbound_call_success"');
    expect(edgeSource).not.toContain('client.rpc("mark_outbound_call_failure"');
  });

  test('the effective outbound handoff and the legacy claimant use only the lease contract', () => {
    const directory = path.join(root, 'supabase/migrations');
    const names = fs.readdirSync(directory).filter(name => name.endsWith('_fence_outbound_worker_handoff.sql'));
    expect(names).toHaveLength(1);
    const effective = fs.readFileSync(path.join(directory, names[0]), 'utf8');
    const bodies = new Map([...effective.matchAll(
      /^CREATE OR REPLACE FUNCTION public\.(\w+)\([\s\S]*?\bAS (\$\w*\$)([\s\S]*?)^\2;/gm,
    )].map(([, name, , body]) => [name, body]));
    for (const name of ['run_outbound_worker', 'dispatch_outbound_call_inline']) {
      const body = bodies.get(name);
      expect(body).toContain('public.handoff_outbound_call_to_edge_v1(');
      expect(body).toContain('public.check_async_response(');
      expect(body).not.toMatch(/public\.(?:call_api(?:_wait)?|dispatch_api_request_v1)\(/);
    }
    const handoff = bodies.get('handoff_outbound_call_to_edge_v1');
    expect(handoff).toMatch(/'headers', public\.sql_transport_headers_v1\(p_headers\)[\s\S]+SET status = 'pending_edge'/);
    expect(effective).toMatch(/claim_pending_edge_job_ids_v1\(p_batch INT DEFAULT 1\)\s+RETURNS TABLE \(job_id UUID, lease_token UUID\)/);
    expect(bodies.get('claim_pending_edge_job_ids_v1')).toMatch(/edge_lease_token = v_lease_token[\s\S]+lease_token := v_lease_token;/);
    expect(bodies.get('claim_pending_edge_jobs')).toMatch(/BEGIN[\s\S]+\bRETURN;\s*END;\s*$/);
    expect(bodies.get('claim_pending_edge_jobs')).not.toMatch(/outbound_calls|RETURN (?:NEXT|QUERY)/);
    for (const schema of ['public', 'api']) {
      expect(effective).toMatch(new RegExp(
        `REVOKE EXECUTE ON FUNCTION ${schema}\\.log_api_call_event\\([^)]*\\)\\s+FROM edge_api_caller_role;`,
      ));
    }
  });

  test('runtime claims one, executes one, then claims the next without preclaiming', () => {
    const batchStart = edgeSource.indexOf('const processBatch = async');
    const batchEnd = edgeSource.indexOf('\nDeno.serve(', batchStart);
    const batch = edgeSource.slice(batchStart, batchEnd);
    const claimOffset = batch.indexOf('client.rpc("claim_pending_edge_job_ids_v1"');
    const executeOffset = batch.indexOf(
      'await executeClaimedJobById(job.job_id, job.lease_token)',
    );

    expect(batch).toContain('if (concurrency !== 1)');
    expect(batch).toContain('for (let index = 0; index < Math.min(batch, MAX_BATCH_SIZE); index += 1)');
    expect(batch).toContain('p_batch: 1');
    expect(batch).toContain('if (!data || data.length === 0) break');
    expect(claimOffset).toBeGreaterThanOrEqual(0);
    expect(executeOffset).toBeGreaterThan(claimOffset);
    expect(batch).not.toContain('mapWithConcurrency');
  });

  test('runtime renews and finalizes only with its token while responses remain compact', () => {
    expect(edgeSource).toContain('client.rpc("renew_claimed_edge_job_lease_v1"');
    expect(edgeSource).toContain('p_lease_token: leaseToken');
    expect(edgeSource.match(/await renewClaimedLease\(client, jobId, leaseToken\)/g)).toHaveLength(2);
    expect(edgeSource).toContain('client.rpc("mark_claimed_edge_job_success_v1"');
    expect(edgeSource).toContain('client.rpc("mark_claimed_edge_job_failure_v1"');
    expect(edgeSource).toContain('return buildCompactBatchResponse(results)');
    expect(edgeSource).not.toContain('job.dispatch');
    expect(edgeSource).not.toContain('lease_token: job.lease_token');
  });
});
