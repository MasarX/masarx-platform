// Plan: PLAN-202511-testing-hardening-e2e-provenance / Step: S06
// Exact deployed api-caller proof. Enabled only by the explicit Edge E2E + proof-lane contract.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { createWorkflowContext } = require('../helpers/tenant-utils');

loadEnv();

function isDeployedProofEnabled(env = process.env) {
  return env.RUN_EDGE_E2E === 'true'
    && String(env.API_CALLER_GUARDED_EGRESS_PROOF_LANE || '').trim().length > 0;
}

const runIfDeployedProof = isDeployedProofEnabled() ? describe : describe.skip;
const INVOKE_JWT =
  process.env.EDGE_TASK_TOKEN ||
  process.env.API_CALLER_SHARED_SECRET ||
  process.env.API_CALLER_DB_JWT ||
  process.env.EDGE_DB_JWT ||
  '';
const RECEIPT_CONTRACT = 'masarx.deployed-api-caller-guarded-egress.v1';
const COMPONENT_AUTHORITY = 'unsigned_component_only';

jest.setTimeout(45_000);

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`[api-caller-e2e] Missing required proof input: ${name}`);
  return value;
}

function requiredFullSha(name) {
  const value = required(name).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(`[api-caller-e2e] Invalid proof input: ${name} must be a full 40-hex SHA`);
  }
  return value;
}

function requiredDenialCode(name) {
  const value = required(name);
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(value)) {
    throw new Error(`[api-caller-e2e] Invalid proof input: ${name}`);
  }
  return value;
}

function exactPrivateTargetDenialCode(message, targetUrl, configuredCode) {
  const expected = `Egress policy violation: non-public IP target blocked (${new URL(targetUrl).hostname})`;
  if (String(message || '') !== expected) {
    throw new Error('[api-caller-e2e] Private-target denial contract mismatch');
  }
  return configuredCode;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function writeReceipt(receiptPath, receipt) {
  if (!receiptPath) return;
  const target = path.resolve(receiptPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

function buildComponentReceipt({
  candidateSha,
  activeDeploymentSha,
  publicProbeUrl,
  expectedPublicIp,
  policyDeniedCode,
  checks,
  generatedAt = new Date().toISOString(),
}) {
  if (!/^[a-f0-9]{40}$/.test(String(candidateSha || '')) || candidateSha !== activeDeploymentSha) {
    throw new Error('[api-caller-e2e] Candidate SHA is invalid or stale for the active deployment');
  }
  const failureCount = checks.filter((check) => check.status !== 'passed').length;
  const receipt = {
    schema_version: RECEIPT_CONTRACT,
    authority: COMPONENT_AUTHORITY,
    requires_external_signature: true,
    status: failureCount ? 'failed' : 'passed',
    candidate_sha: candidateSha,
    generated_at: generatedAt,
    public_probe_origin_sha256: sha256(new URL(publicProbeUrl).origin),
    expected_public_ip_sha256: sha256(expectedPublicIp),
    denial_code_sha256: sha256(policyDeniedCode),
    check_count: checks.length,
    failure_count: failureCount,
    checks,
  };
  receipt.receipt_sha256 = sha256(JSON.stringify(receipt));
  return receipt;
}

describe('API Caller deployed receipt component contract', () => {
  const candidateSha = '0123456789abcdef0123456789abcdef01234567';

  test('selects deployed proof only for an explicit non-empty proof lane', () => {
    expect(isDeployedProofEnabled({ RUN_EDGE_E2E: 'true' })).toBe(false);
    expect(isDeployedProofEnabled({
      RUN_EDGE_E2E: 'true',
      API_CALLER_GUARDED_EGRESS_PROOF_LANE: '   ',
    })).toBe(false);
    expect(isDeployedProofEnabled({
      RUN_EDGE_E2E: 'false',
      API_CALLER_GUARDED_EGRESS_PROOF_LANE: 'db-dev',
    })).toBe(false);
    expect(isDeployedProofEnabled({
      RUN_EDGE_E2E: 'true',
      API_CALLER_GUARDED_EGRESS_PROOF_LANE: 'db-dev',
    })).toBe(true);
  });

  test('emits only an exact-SHA unsigned component with hash-only network evidence', () => {
    const receipt = buildComponentReceipt({
      candidateSha,
      activeDeploymentSha: candidateSha,
      publicProbeUrl: 'https://probe.example.test/egress',
      expectedPublicIp: '8.8.8.8',
      policyDeniedCode: 'NON_PUBLIC_DESTINATION_DENIED',
      checks: [{
        id: 'controlled_public_probe',
        status: 'passed',
        evidence: { observed_egress_ip_sha256: sha256('8.8.8.8') },
      }],
      generatedAt: '2026-07-20T00:00:00.000Z',
    });
    expect(receipt).toMatchObject({
      authority: 'unsigned_component_only',
      requires_external_signature: true,
      candidate_sha: candidateSha,
      status: 'passed',
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain('probe.example.test');
    expect(serialized).not.toContain('8.8.8.8');
    expect(serialized).not.toContain('NON_PUBLIC_DESTINATION_DENIED');
  });

  test.each([
    ['', candidateSha],
    ['short', 'short'],
    [candidateSha, 'fedcba9876543210fedcba9876543210fedcba98'],
  ])('fails closed on missing, invalid, or stale candidate identity %#', (candidate, active) => {
    expect(() => buildComponentReceipt({
      candidateSha: candidate,
      activeDeploymentSha: active,
      publicProbeUrl: 'https://probe.example.test/egress',
      expectedPublicIp: '8.8.8.8',
      policyDeniedCode: 'NON_PUBLIC_DESTINATION_DENIED',
      checks: [],
    })).toThrow(/invalid or stale/);
  });

  test('maps only the exact live private-target denial to the configured code', () => {
    const target = 'https://127.0.0.1:1/proof';
    expect(exactPrivateTargetDenialCode(
      'Egress policy violation: non-public IP target blocked (127.0.0.1)',
      target,
      'NON_PUBLIC_DESTINATION_DENIED',
    )).toBe('NON_PUBLIC_DESTINATION_DENIED');
    expect(() => exactPrivateTargetDenialCode(
      'some free-form denial text',
      target,
      'NON_PUBLIC_DESTINATION_DENIED',
    )).toThrow(/contract mismatch/);
  });
});

runIfDeployedProof('API Caller guarded egress deployed proof', () => {
  let pool;
  let proofSetupComplete = false;
  let supabaseUrl;
  let authToken;
  let anonKey;
  let publicProbeUrl;
  let expectedPublicIp;
  let candidateSha;
  let activeDeploymentSha;
  let policyDeniedCode;
  let receiptPath;
  const proofChecks = new Map([
    ['private_target_denial', { id: 'private_target_denial', status: 'not_run' }],
    ['controlled_public_probe', { id: 'controlled_public_probe', status: 'not_run' }],
  ]);
  const cleanupTargets = [];

  beforeAll(() => {
    const databaseUrl = required('DATABASE_URL');
    supabaseUrl = required('SUPABASE_URL').replace(/\/$/, '');
    authToken = String(INVOKE_JWT || '').trim();
    if (!authToken) throw new Error('[api-caller-e2e] Missing required proof input: API caller invoke JWT');
    anonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();
    publicProbeUrl = required('API_CALLER_GUARDED_EGRESS_PUBLIC_PROBE_URL');
    expectedPublicIp = required('API_CALLER_GUARDED_EGRESS_EXPECTED_PUBLIC_IP');
    candidateSha = requiredFullSha('API_CALLER_GUARDED_EGRESS_PROOF_SHA');
    activeDeploymentSha = requiredFullSha('API_CALLER_DEPLOYED_EGRESS_ACTIVE_SHA');
    if (candidateSha !== activeDeploymentSha) {
      throw new Error('[api-caller-e2e] Candidate SHA is stale for the active deployment');
    }
    policyDeniedCode = requiredDenialCode('API_CALLER_GUARDED_EGRESS_POLICY_DENIED_CODE');
    receiptPath = required('API_CALLER_DEPLOYED_EGRESS_PROOF_RECEIPT_PATH');
    pool = new Pool({ connectionString: databaseUrl });
    proofSetupComplete = true;
  });

  afterAll(async () => {
    // Preserve the primary beforeAll configuration error. No resources or valid
    // receipt identity exist until setup completes.
    if (!proofSetupComplete) return;
    const cleanupErrors = [];
    if (pool) {
      for (const target of cleanupTargets.reverse()) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('DELETE FROM public.api_call_log WHERE url = $1', [target.url]);
          await client.query('DELETE FROM public.outbound_calls WHERE id = $1::uuid', [target.jobId]);
          await client.query('DELETE FROM public.workflow_runs WHERE id = $1::uuid', [target.runId]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          cleanupErrors.push(target.jobId);
        } finally {
          client.release();
        }
      }
      await pool.end();
    }
    const checks = Array.from(proofChecks.values());
    if (cleanupErrors.length) {
      checks.push({ id: 'exact_test_cleanup', status: 'failed', failure_class: 'cleanup_failed' });
    } else {
      checks.push({ id: 'exact_test_cleanup', status: 'passed', evidence: { target_count: cleanupTargets.length } });
    }
    const receipt = buildComponentReceipt({
      candidateSha,
      activeDeploymentSha,
      publicProbeUrl,
      expectedPublicIp,
      policyDeniedCode,
      checks,
    });
    writeReceipt(receiptPath, receipt);
    if (cleanupErrors.length) throw new Error('[api-caller-e2e] Exact proof cleanup failed');
  });

  async function createCommittedJob(url) {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      const { rows: targetRows } = await client.query(
        `SELECT id, organization_id
           FROM public.clients
          WHERE status = 'active'
          ORDER BY created_at
          LIMIT 1`,
      );
      if (!targetRows.length) throw new Error('[api-caller-e2e] No active client exists for proof scope');
      const target = targetRows[0];
      const workflow = await createWorkflowContext(client, {
        templateName: 'legacy_outbound_job_wrapper_v1',
        scopeType: 'tenant',
        scopeId: target.organization_id,
        context: {
          organization_id: target.organization_id,
          managed_by: 'integration_plugin',
          proof: RECEIPT_CONTRACT,
        },
        local: true,
      });
      const jobId = crypto.randomUUID();
      await client.query(
        `INSERT INTO public.outbound_calls (
           id, call_type, target_type, target_id,
           method, url, headers, body,
           status, priority, retry_count, max_retries,
           scheduled_at, created_at, workflow_run_step_id,
           context
         ) VALUES (
           $1::uuid, 'client_webhook', 'client', $2::uuid,
           'GET', $3, '{}'::jsonb, '{}'::jsonb,
           'pending_edge', 1000, 0, 1,
           now(), now(), $4::uuid,
           $5::jsonb
         )`,
        [
          jobId,
          target.id,
          url,
          workflow.stepId,
          JSON.stringify({
            organization_id: target.organization_id,
            managed_by: 'integration_plugin',
            proof: RECEIPT_CONTRACT,
          }),
        ],
      );
      await client.query('COMMIT');
      transactionOpen = false;
      const cleanupTarget = { jobId, runId: workflow.runId, url };
      cleanupTargets.push(cleanupTarget);
      const { rows: policyRows } = await client.query(
        `SELECT public.resolve_effective_outbound_egress_policy_v1($1::uuid) AS policy`,
        [jobId],
      );
      const effective = policyRows[0]?.policy || {};
      const effectiveTransport = String(effective?.managed_by || '').toLowerCase() === 'integration_plugin'
        ? 'guarded_proxy'
        : String(effective?.policy?.transport_mode || '').toLowerCase();
      if (effectiveTransport !== 'guarded_proxy') {
        throw new Error('[api-caller-e2e] Effective outbound policy did not select guarded_proxy');
      }
      return { ...cleanupTarget, effectiveTransport };
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function invokeJob(jobId) {
    return fetch(`${supabaseUrl}/functions/v1/api-caller`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${authToken}`,
        ...(anonKey ? { apikey: anonKey } : {}),
      },
      body: JSON.stringify({ job_id: jobId }),
    });
  }

  test('rejects a private target before transport with exact terminal evidence', async () => {
    const privateUrl = `https://127.0.0.1:1/${crypto.randomUUID()}`;
    const { jobId, effectiveTransport } = await createCommittedJob(privateUrl);
    expect(effectiveTransport).toBe('guarded_proxy');
    const response = await invokeJob(jobId);
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({ job_id: jobId, success: false });
    expect(body?.result?.status).toBe(0);
    expect(body?.result?.completed).toBe(false);
    const denialCode = exactPrivateTargetDenialCode(body?.result?.error, privateUrl, policyDeniedCode);

    const { rows } = await pool.query(
      `SELECT status, response_status_code, retry_count, error_message
         FROM public.outbound_calls
        WHERE id = $1::uuid`,
      [jobId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('permanently_failed');
    expect(rows[0].response_status_code).toBe(0);
    expect(rows[0].retry_count).toBe(1);
    expect(exactPrivateTargetDenialCode(rows[0].error_message, privateUrl, policyDeniedCode)).toBe(denialCode);
    proofChecks.set('private_target_denial', {
      id: 'private_target_denial',
      status: 'passed',
      evidence: {
        http_status: 502,
        job_status: 'permanently_failed',
        transport_status: 0,
        denial_code_sha256: sha256(denialCode),
        denied_target_origin_sha256: sha256(new URL(privateUrl).origin),
      },
    });
  });

  test('routes the controlled public probe through deployed api-caller and records the fixed egress IP', async () => {
    const separator = publicProbeUrl.includes('?') ? '&' : '?';
    const proofUrl = `${publicProbeUrl}${separator}proof_id=${encodeURIComponent(crypto.randomUUID())}`;
    const { jobId, effectiveTransport } = await createCommittedJob(proofUrl);
    expect(effectiveTransport).toBe('guarded_proxy');
    const response = await invokeJob(jobId);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ job_id: jobId, success: true });
    expect(body?.result?.status).toBe(200);
    expect(body?.result?.completed).toBe(true);
    expect(body?.result?.body?.egress_ip).toBe(expectedPublicIp);

    const { rows } = await pool.query(
      `SELECT status, response_status_code, response_body
         FROM public.outbound_calls
        WHERE id = $1::uuid`,
      [jobId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('completed');
    expect(rows[0].response_status_code).toBe(200);
    expect(rows[0].response_body?.egress_ip).toBe(expectedPublicIp);
    proofChecks.set('controlled_public_probe', {
      id: 'controlled_public_probe',
      status: 'passed',
      evidence: {
        http_status: 200,
        job_status: 'completed',
        observed_egress_ip_sha256: sha256(expectedPublicIp),
      },
    });
  });
});
