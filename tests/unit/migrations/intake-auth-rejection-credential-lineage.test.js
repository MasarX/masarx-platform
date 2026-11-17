const fs = require('fs');
const path = require('path');

describe('intake auth rejection and credential lineage migration', () => {
  const migrationPath = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '202608161440_b3_intake_auth_rejection_credential_lineage_v1.sql',
  );
  const pgtapPath = path.join(
    process.cwd(),
    'supabase',
    'tests',
    'pgtap',
    '0zz_intake_auth_rejection_credential_lineage_v1.sql',
  );

  let sql;
  let pgtap;

  beforeAll(() => {
    sql = fs.readFileSync(migrationPath, 'utf8');
    pgtap = fs.readFileSync(pgtapPath, 'utf8');
  });

  test('installs immutable append-only ledgers with scoped RLS', () => {
    expect(sql).toMatch(/CREATE TABLE public\.intake_auth_rejections\s*\(/);
    expect(sql).toMatch(/CREATE TABLE public\.webhook_source_token_history\s*\(/);
    expect(sql).toContain('intake_auth_rejections_immutable_trg');
    expect(sql).toContain('webhook_source_token_history_immutable_trg');
    expect(sql).toContain('intake_auth_append_only_immutable_v1');
    expect(sql).toContain('ALTER TABLE public.intake_auth_rejections ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE public.webhook_source_token_history ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain("public.user_capability_eval_v1('api_gateway.read')");
    expect(sql).toContain("public.user_capability_eval_v1('webhooks.read')");
    expect(sql).toContain('public.current_user_scope_type()');
    expect(sql).toContain('GRANT SELECT ON TABLE public.webhook_source_token_history TO service_role');
    expect(sql).toContain(
      'objectives:allow POLICY_MISSING Justification: credential history is service-role-only',
    );
    expect(sql).toContain(
      'REVOKE ALL ON TABLE public.webhook_source_token_history FROM PUBLIC, anon, authenticated',
    );
  });

  test('keeps source-token rotation and retirement as centralized append-only lineage', () => {
    const repair = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations',
      '20260909120000_webhook_token_lineage_trigger_input_v1.sql'), 'utf8');
    expect(repair).toContain('AFTER UPDATE OF auth_token, auth_token_hash, enabled, managed_metadata ON public.webhook_sources');
    expect(repair).toContain('EXECUTE FUNCTION public.capture_webhook_source_token_lineage_v1()');
    expect(repair).toContain('DROP TRIGGER webhook_sources_capture_token_lineage_trg ON public.webhook_sources');
    expect(repair).not.toMatch(/CREATE OR REPLACE FUNCTION|GRANT|DISABLE TRIGGER/i);
    const native = fs.readFileSync(path.join(process.cwd(), 'supabase/tests/pgtap/0zz_webhook_bounded_token_rejections_v1.sql'), 'utf8');
    for (const label of ['plaintext rotation captures exactly one history row', 'unchanged watched columns do not duplicate history',
      'direct hash rotation retains its predecessor', 'enabled retirement retains revoked reason',
      'metadata archive and disable retains archived reason']) expect(native).toContain(label);
    expect(sql).toContain('capture_webhook_source_token_lineage_v1');
    expect(sql).toMatch(/AFTER UPDATE OF auth_token_hash, enabled, managed_metadata ON public\.webhook_sources/);
    expect(sql).toContain("WHEN lower(COALESCE(NEW.managed_metadata->>'lifecycle', '')) = 'archived' THEN 'archived'");
    expect(sql).toContain("ELSE 'revoked'");
    expect(sql).toContain("v_reason := 'rotated'");
    expect(sql).toContain('resolve_retired_webhook_source_by_token_v1');
    expect(sql).toContain('extensions.crypt(p_token, h.retired_auth_token_hash)');

    const rotateBody = sql.match(
      /CREATE OR REPLACE FUNCTION public\.ui_rotate_webhook_source_token_v1[\s\S]*?\$function\$;/,
    )?.[0];
    expect(rotateBody).toBeTruthy();
    expect(rotateBody).toContain('UPDATE public.webhook_sources');
    expect(rotateBody).not.toContain('INSERT INTO public.webhook_source_token_history');
    expect(sql).not.toMatch(/ON CONFLICT\s*\(source_id, retired_auth_token_hash\)\s*DO UPDATE/i);
  });

  test('registers the existing rotation decision without widening write contracts', () => {
    const repair = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations',
      '20260909121000_webhook_rotation_decision_category_v1.sql'), 'utf8');
    expect(repair).toContain("WHERE category = 'decision_category'");
    expect(repair).toContain("'webhooks.rotate_source_token'");
    expect(repair).toContain('ON CONFLICT (lookup_definition_id, value) DO UPDATE');
    expect(repair).toContain("SET status = 'active', retired_at = NULL");
    expect(repair).toContain('effective_from = NULL, effective_until = NULL');
    expect(repair).toContain("RAISE EXCEPTION 'Webhook rotation decision category contract is incomplete'");
    expect(repair).not.toMatch(/CREATE OR REPLACE FUNCTION|GRANT|DISABLE TRIGGER|INSERT INTO public\.lookup_column_contracts/i);
  });

  test('records redacted failure lineage for all required credential states', () => {
    expect(sql).toContain('redact_intake_auth_secret_text');
    expect(sql).toContain('redact_intake_auth_secret_json');
    expect(sql).toContain("encode(digest(v_token, 'sha256'), 'hex')");
    expect(sql).toContain("'missing_source_token'");
    expect(sql).toContain("'unresolved_source_token'");
    expect(sql).toContain("'active_webhook_source_token'");
    expect(sql).toContain("'revoked_webhook_source_token'");
    expect(sql).toContain("'archived_webhook_source_token'");
    expect(sql).toContain("'retired_webhook_source_token'");
    expect(sql).toContain("'hmac_signature_missing'");
    expect(sql).toContain("'hmac_auth_config_missing'");
    expect(sql).toContain("'hmac_credential_expired'");
    expect(sql).toContain("'hmac_credential_unavailable'");
    expect(sql).toContain("'hmac_signature_mismatch'");
    expect(sql).toContain("'hmac_validation_failed'");
    expect(sql).toContain("WHEN v_failure_code = 'hmac_credential_unavailable' THEN 'unavailable'");
    expect(sql).toContain("'retired_token_history_id'");
    expect(sql).toContain("'token_history_id'");
  });

  test('mirrors HMAC evidence only from actual terminal inbox decisions', () => {
    expect(sql).toContain('mirror_webhook_hmac_auth_rejection_v1');
    expect(sql).toContain("NEW.resource_type IS DISTINCT FROM 'webhook_inbox'");
    expect(sql).toContain("NEW.decision_category IS DISTINCT FROM 'http_response_emitted'");
    expect(sql).toContain("v_validation->>'status' IS DISTINCT FROM 'failed'");
    expect(sql).toMatch(/FROM public\.webhook_inbox wi[\s\S]*?WHERE wi\.id = NEW\.resource_id/);
    expect(sql).toContain('has no canonical webhook inbox row');
    expect(sql).toContain('NEW.correlation_id IS DISTINCT FROM v_inbox.correlation_id');
    expect(sql).toContain("'edge_stage', 'workflow_intake_webhook_core_v1'");
    expect(sql).toContain('decision_log_mirror_webhook_hmac_auth_rejection_trg');

    const forbiddenOperationalInsert =
      /INSERT\s+INTO\s+public\.(api_gateway_requests|webhook_inbox|outbound_calls|workflow_runs|workflow_run_steps|shipments)\b/i;
    expect(sql).not.toMatch(forbiddenOperationalInsert);
    expect(sql).not.toMatch(/pg_get_functiondef\s*\(/i);
    expect(sql).not.toMatch(/replace\s*\(\s*v_def/i);
    expect(sql).not.toMatch(/EXECUTE\s+v_def/i);
  });

  test('exposes only security-invoker and least-privilege API surfaces', () => {
    expect(sql).toMatch(
      /CREATE VIEW public\.v_intake_auth_rejection_directory\s+WITH \(security_invoker = true\)/,
    );
    expect(sql).toContain('CREATE OR REPLACE FUNCTION api.record_intake_auth_rejection_v1');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION api.ui_rotate_webhook_source_token_v1');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION api.record_intake_auth_rejection_v1(JSONB) TO service_role');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION api.ui_rotate_webhook_source_token_v1(JSONB) TO authenticated, service_role');
    expect(sql).toContain('edge_webhook_role');
    expect(sql).toContain('edge_api_gateway_role');
    expect(sql).toContain("'api_gateway_auth_rejections'");
    expect(sql).toContain("'webhook_auth_rejections'");
    expect(sql).toContain('public.upsert_settings_value_v1');
    expect(sql).not.toMatch(/UPDATE\s+public\.settings_versions/i);
  });

  test('ships focused pgTAP coverage for redaction, immutability, and no-fabrication', () => {
    expect(pgtap).toContain("has_table('public', 'intake_auth_rejections'");
    expect(pgtap).toContain("has_table('public', 'webhook_source_token_history'");
    expect(pgtap).toMatch(/has_trigger\(\s*'public',\s*'intake_auth_rejections'/);
    expect(pgtap).toMatch(/has_trigger\(\s*'public',\s*'webhook_source_token_history'/);
    expect(pgtap).toContain('plain-secret-token-never-persist');
    expect(pgtap).toContain('hmac_signature_mismatch');
    expect(pgtap).toContain('hmac_credential_expired');
    expect(pgtap).toContain('hmac_credential_unavailable');
    expect(pgtap).toContain('UPDATE public.intake_auth_rejections');
    expect(pgtap).toContain('DELETE FROM public.intake_auth_rejections');
    expect(pgtap).toContain('intake_auth_rejections is append-only and immutable');
    expect(pgtap).toContain('api_gateway_requests');
    expect(pgtap).toContain('webhook_inbox');
    expect(pgtap).toContain('outbound_calls');
    expect(pgtap).toContain('workflow_runs');
    expect(pgtap).toContain('shipments');
  });
});
