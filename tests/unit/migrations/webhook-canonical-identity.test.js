const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../../..');
const migrationPath = path.join(repoRoot, 'supabase/migrations/20260905210000_webhook_canonical_identity_v1.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');
const functionBlock = name => {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(');
  if (start < 0) throw new Error('Missing function: ' + name);
  const body = sql.slice(start);
  const tag = body.match(/AS (\$[a-z_]*\$)/)[1];
  return body.slice(0, body.indexOf(tag + ';', body.indexOf('AS ' + tag) + tag.length + 3) + tag.length + 1);
};

describe('webhook canonical identity append-only repair', () => {
  const core = functionBlock('workflow_intake_webhook_core_v1');
  const helper = functionBlock('insert_webhook_inbox_record');
  const mirror = functionBlock('mirror_webhook_hmac_auth_rejection_v1');

  test('exposes canonical identity on every one of the seven current core outcomes', () => {
    const returns = [...core.matchAll(/RETURN (?:jsonb_strip_nulls\()?jsonb_build_object\(\s*'correlation_id', v_correlation_id,/g)];
    expect(returns).toHaveLength(7);
    expect(core.match(/\bRETURN\b/g)).toHaveLength(7);
  });

  test('adopts only the current source inbox identity before replay context, decision and response', () => {
    const replay = core.slice(core.indexOf('IF v_idempotency_key IS NOT NULL THEN\n    SELECT'),
      core.indexOf("  v_hmac_config := v_policy_body->'validation'->'hmac';"));
    expect(replay).toContain('JOIN public.webhook_inbox wi');
    expect(replay).toContain('ON wi.id = ah.webhook_inbox_id');
    expect(replay).toContain('AND wi.webhook_source_id = v_source.id');
    expect(replay).toContain('WHERE ah.webhook_source_id = v_source.id');
    expect(replay).toContain('AND ah.idempotency_key = v_idempotency_key');
    const adopt = replay.indexOf('v_correlation_id := v_existing_ack.correlation_id;');
    const seed = replay.indexOf("set_config('request.correlation_id', v_correlation_id::TEXT, TRUE)");
    const decision = replay.indexOf('PERFORM log_decision(');
    const response = replay.indexOf('RETURN jsonb_build_object(');
    expect(adopt).toBeGreaterThan(0);
    expect(seed).toBeGreaterThan(adopt);
    expect(decision).toBeGreaterThan(seed);
    expect(response).toBeGreaterThan(decision);
    expect(replay).toContain("'replayed', TRUE");
    expect(replay).toContain("'body', COALESCE(v_existing_ack.ack_body, jsonb_build_object())");
  });

  test('retains current validation, sanitized persistence and workflow call order', () => {
    const source = core.indexOf('FROM get_webhook_source_by_token(p_token)');
    const enabled = core.indexOf('v_source.enabled IS NOT TRUE');
    const intent = core.indexOf('public.resolve_webhook_shipment_intent_v1(');
    const replay = core.indexOf('FROM public.webhook_ack_history ah');
    const hmac = core.indexOf("hmac(coalesce(p_raw_body, '')::bytea");
    const redaction = core.indexOf('public.redact_webhook_persisted_headers_v1(');
    const inbox = core.indexOf('PERFORM insert_webhook_inbox_record(');
    const workflow = core.indexOf('v_workflow_run_id := start_workflow_run(');
    expect(source).toBeGreaterThan(0);
    for (const [before, after] of [[source, enabled], [enabled, intent], [intent, replay], [replay, hmac], [hmac, redaction], [redaction, inbox], [inbox, workflow]]) {
      expect(after).toBeGreaterThan(before);
    }
    expect(core).toContain("v_provided_signature TEXT := v_headers->>v_signature_header;");
    expect(core).not.toMatch(/INSERT INTO (?:public\.)?shipments\b/i);
  });

  test('external identity is a null-aware payload ladder, independent from request trace and idempotency', () => {
    expect(helper).toMatch(/provider_type,\s*external_id,\s*raw_payload,/);
    expect(helper).toMatch(/COALESCE\(\s*NULLIF\(p_raw_payload#>>'\{event,id\}', ''\),\s*NULLIF\(p_raw_payload->>'external_id', ''\),\s*NULLIF\(p_raw_payload->>'id', ''\)\s*\)/);
    expect(helper.indexOf("set_config('request.correlation_id', p_correlation_id::text, true)"))
      .toBeLessThan(helper.indexOf('INSERT INTO webhook_inbox'));
    expect(helper).toContain('        p_correlation_id,\n        p_idempotency_key');
  });

  test('replay cannot duplicate HMAC rejection evidence and current grants/wrappers are untouched', () => {
    expect(mirror).toContain("OR NEW.decision_inputs->>'replayed' = 'true'");
    expect(mirror).toContain("OR v_validation->>'status' IS DISTINCT FROM 'failed'");
    expect(mirror).toContain('NEW.correlation_id IS DISTINCT FROM v_inbox.correlation_id');
    expect(mirror.match(/PERFORM public\.record_intake_auth_rejection_v1\(/g)).toHaveLength(1);
    for (const body of [core, helper, mirror]) {
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toContain('SET search_path TO public, extensions, pg_temp');
    }
    expect(sql).not.toMatch(/\b(?:GRANT|REVOKE)\b/);
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION api.');
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.workflow_intake_webhook(');
    expect(sql).not.toMatch(/DROP (?:TABLE|VIEW|FUNCTION)/i);
  });

  test('disposable regressions execute the API and persisted replay/decision/identity contracts without skip branches', () => {
    const test = fs.readFileSync(path.join(repoRoot, 'supabase/tests/pgtap/0zz_webhook_canonical_identity_v1.sql'), 'utf8');
    expect(test).toContain('SET LOCAL ROLE edge_webhook_role;');
    expect(test).toContain('api.workflow_intake_webhook(');
    expect(test).toContain('dl.correlation_id IS DISTINCT FROM wi.correlation_id');
    expect(test).toContain('same idempotency key in a different source/organization');
    expect(test).toContain('failed replay does not mirror a second HMAC rejection');
    expect(test).toContain("'numeric-event'");
    expect(test).toContain('ROLLBACK;');
    expect(test).not.toMatch(/\b(?:skip|todo)\(/i);
  });
});

describe('webhook shipment-create source binding', () => {
  const repaired = fs.readFileSync(path.join(repoRoot,
    'supabase/migrations/20260910003000_webhook_shipment_create_source_binding_v1.sql'), 'utf8');

  test('checks canonical create binding after authentication and replay but before reservation', () => {
    const replay = repaired.indexOf('FROM public.webhook_ack_history ah');
    const hmac = repaired.indexOf("v_ack_reason := 'HMAC signature mismatch';");
    const binding = repaired.indexOf("IF v_ack_outcome <> 'ack_failed' AND v_canonical_intent = 'shipment.create'");
    const redaction = repaired.indexOf('public.redact_webhook_persisted_headers_v1(');
    const inbox = repaired.indexOf('PERFORM insert_webhook_inbox_record(');
    const reservation = repaired.indexOf('IF v_should_plan THEN');
    for (const marker of [replay, hmac, binding, redaction, inbox, reservation]) expect(marker).toBeGreaterThan(0);
    for (const [before, after] of [[replay, hmac], [hmac, binding], [binding, redaction], [redaction, inbox], [inbox, reservation]]) {
      expect(after).toBeGreaterThan(before);
    }
    const guard = repaired.slice(binding, redaction);
    expect(guard).toContain('JOIN public.clients c ON c.id = s.client_id');
    expect(guard).toContain('s.id = v_source.sender_id');
    expect(guard).toContain('c.id = v_source.client_id');
    expect(guard).toContain('c.organization_id = v_source.organization_id');
    expect(guard).toContain("COALESCE(s.status, 'active') = 'active'");
    expect(guard).toContain("COALESCE(c.status, 'active') = 'active'");
    expect(guard).not.toMatch(/v_payload|p_payload/);
    expect(guard).toContain("v_ack_outcome := 'ack_failed';");
    expect(guard).toContain("v_ack_reason := 'webhook_source_missing_sender_client';");
    expect(guard).toContain('v_should_plan := FALSE;');
    expect(guard).not.toMatch(/\bRETURN\b/);
  });

  test('changes only the reviewed binding block in the complete preceding core', () => {
    const previous = fs.readFileSync(path.join(repoRoot,
      'supabase/migrations/20260905211000_webhook_bounded_token_rejections_v1.sql'), 'utf8');
    const coreStart = 'CREATE OR REPLACE FUNCTION public.workflow_intake_webhook_core_v1(';
    const previousCore = previous.slice(previous.indexOf(coreStart), previous.lastIndexOf('COMMIT;')).trim();
    const currentCore = repaired.slice(repaired.indexOf(coreStart), repaired.lastIndexOf('COMMIT;')).trim();
    const start = currentCore.indexOf('  -- Shipment creation requires server-owned sender/client lineage.');
    const end = currentCore.indexOf('  v_persisted_headers := public.redact_webhook_persisted_headers_v1(', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(currentCore.slice(0, start) + currentCore.slice(end)).toBe(previousCore);
  });

  test('keeps failed ACK persistence, final envelope, and workflow refusal without widening access', () => {
    expect(repaired).toContain("CASE WHEN v_ack_outcome = 'ack_failed' THEN 'failed' ELSE v_processing_status END");
    expect(repaired).toContain("v_ack_body := jsonb_build_object('error', COALESCE(v_ack_reason, 'Webhook acknowledgement failed'));");
    expect(repaired).toContain("IF v_ack_outcome <> 'ack_failed' AND v_entry_template_id IS NOT NULL THEN");
    expect(repaired).toContain("'validation_results', v_validation");
    expect(repaired).toContain('p_correlation_id := v_correlation_id');
    expect(repaired).toContain('SET search_path TO public, extensions, pg_temp');
    expect(repaired).not.toMatch(/\b(?:GRANT|REVOKE|DROP)\b/);
    expect(repaired).not.toMatch(/INSERT INTO (?:public\.)?shipments\b/i);
    expect(repaired).not.toContain('CREATE OR REPLACE FUNCTION public.workflow_intake_webhook(');
  });
});
