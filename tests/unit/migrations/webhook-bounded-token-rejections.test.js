const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../../..');
const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20260905211000_webhook_bounded_token_rejections_v1.sql'), 'utf8');
const previous = fs.readFileSync(path.join(root, 'supabase/migrations/20260905210000_webhook_canonical_identity_v1.sql'), 'utf8');
const coreStart = 'CREATE OR REPLACE FUNCTION public.workflow_intake_webhook_core_v1(';
const coreOf = text => text.slice(text.indexOf(coreStart), text.indexOf('$function$;', text.indexOf(coreStart)) + '$function$;'.length);
const helper = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.record_webhook_token_rejection_bounded_v1('), sql.indexOf(coreStart));

describe('bounded source-token rejection logging source contract (not DB execution)', () => {
  test('reuses root-only settings with category auto-seed before policy seed', () => {
    const trigger = fs.readFileSync(path.join(root, 'supabase/migrations/202512301100_schema_registry_category_autoseed.sql'), 'utf8');
    expect(trigger).toMatch(/INSERT INTO public.settings_category_registry/);
    expect(trigger).toMatch(/BEFORE INSERT OR UPDATE OF category/);
    expect(sql.indexOf('INSERT INTO public.schema_registry')).toBeLessThan(sql.indexOf('UPDATE public.settings_category_registry'));
    expect(sql).toContain('allowed_scopes = jsonb_build_array(public.get_root_scope_type_key_v1())');
    expect(sql).toContain('"max_records":60,"window_seconds":60,"max_token_bytes":4096');
    expect(sql).toContain('ON CONFLICT (category, version) DO NOTHING');
    expect(sql).toContain("public.get_root_scope_type_key_v1(), NULL) IS NULL");
  });

  test('validates policy and bounds before nonwaiting admission and additional lineage work', () => {
    const ordered = ["'missing_identity'", "'snapshot_isolation'", "'policy_missing'", "'policy_disabled'",
      "'policy_invalid'", 'octet_length(p_token)', 'pg_try_advisory_xact_lock(', 'SELECT COUNT(*)',
      'LIMIT v_max_records', "'budget_exhausted'", 'RETURN public.record_intake_auth_rejection_v1('];
    for (let i = 1; i < ordered.length; i += 1) expect(helper.indexOf(ordered[i])).toBeGreaterThan(helper.indexOf(ordered[i - 1]));
    expect(helper).toContain("current_setting('transaction_isolation') <> 'read committed'");
    expect(helper).toContain("WHERE service = 'webhook_receiver'");
    expect(helper).toContain('ORDER BY occurred_at DESC');
    expect(helper).toContain('occurred_at >= v_now - make_interval(secs => v_window_seconds)');
    expect(helper).not.toMatch(/pg_advisory_xact_lock\(/);
    expect(helper).not.toMatch(/WHERE credential_kind|INSERT INTO public.intake_auth_rejections/);
    expect(helper).toContain('WHEN invalid_text_representation OR numeric_value_out_of_range');
    for (const key of ['max_records', 'window_seconds', 'max_token_bytes']) {
      const guard = "jsonb_typeof(v_schema#>'{properties," + key + ",maximum}') IS DISTINCT FROM 'number'";
      expect(helper).toContain(guard);
      expect(helper.indexOf(guard)).toBeLessThan(helper.indexOf('v_max_records := '));
    }
  });

  test('private helper accepts only core-resolved source and sanitized fixed context', () => {
    expect(helper).toContain('FROM PUBLIC, anon, authenticated, service_role, edge_webhook_role, edge_api_gateway_role');
    expect(helper).not.toMatch(/\bGRANT\b/);
    expect(helper).toContain("'source_id', p_resolved_source_id");
    expect(helper).toContain("'correlation_id', p_correlation_id");
    expect(helper.match(/public\.record_intake_auth_rejection_v1\(/g)).toHaveLength(1);
    expect(helper).not.toMatch(/p_headers|p_payload|'organization_id'|'client_id'|'sender_id'|'path'|'query'|SQLERRM/);
    expect(helper).toContain("'reason', 'recorder_unavailable'");
    expect(sql).not.toMatch(/CREATE (?:TABLE|INDEX)|CREATE OR REPLACE FUNCTION api\./);
  });

  test('core delta is exactly one unauthorized-source recorder call and safe outcome projection', () => {
    const core = coreOf(sql);
    const restored = core
      .replace("  v_auth_rejection_logging JSONB;\n", '')
      .replace("    v_auth_rejection_logging := public.record_webhook_token_rejection_bounded_v1(\n      p_token, v_source.id, v_correlation_id\n    );\n", '')
      .replace("      'auth_rejection_logging', jsonb_strip_nulls(jsonb_build_object(\n        'status', v_auth_rejection_logging->>'status',\n        'reason', v_auth_rejection_logging->>'reason'\n      )),\n", '');
    expect(restored).toBe(coreOf(previous));
    expect(core.match(/public\.record_webhook_token_rejection_bounded_v1\(/g)).toHaveLength(1);
    expect(core.indexOf('FROM get_webhook_source_by_token(p_token)')).toBeLessThan(core.indexOf('v_auth_rejection_logging :='));
    expect(core.match(/RETURN (?:jsonb_strip_nulls\()?jsonb_build_object\(\s*'correlation_id', v_correlation_id,/g)).toHaveLength(7);
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.mirror_webhook_hmac_auth_rejection_v1');
  });

  test('Edge does not add a rejection RPC or retain the broken dead helper', () => {
    const edge = fs.readFileSync(path.join(root, 'supabase/functions/webhook-receiver/index.ts'), 'utf8');
    expect(edge).not.toMatch(/recordIntakeAuthRejection|record_intake_auth_rejection|redactIntakeSecretText|redactForwardedSecretHeaders/);
    expect(edge).toContain('rejection_log_status: data?.auth_rejection_logging?.status ?? null');
    expect(edge).toContain('rejection_log_reason: data?.auth_rejection_logging?.reason ?? null');
  });

  test('concurrency regressions require an explicit database and rollback every bounded connection', () => {
    const source = fs.readFileSync(path.join(root, 'tests/integration/ack/bounded-token-rejections.test.js'), 'utf8');
    expect(source).toContain('R08_DATABASE_REQUIRED');
    expect(source).not.toMatch(/describe\.skip|test\.skip|postgres(?:ql)?:\/\//);
    expect(source).toContain('max: 2, connectionTimeoutMillis: 5000');
    expect(source).toContain("SET LOCAL statement_timeout = '5s'");
    expect(source).toContain("SET LOCAL lock_timeout = '500ms'");
    expect(source).toContain("SET LOCAL idle_in_transaction_session_timeout = '45s'");
    expect(source.indexOf('await pool.connect()')).toBeLessThan(source.indexOf("'BEGIN ISOLATION LEVEL '"));
    expect(source).toContain('for (const state of states.reverse())');
    expect(source).toContain("text: 'ROLLBACK', query_timeout: 5000");
    expect(source).toContain('state.client.release(Boolean(cleanupError))');
    expect(source).not.toMatch(/['"]COMMIT['"]|\bDELETE FROM\b|\bTRUNCATE\b/);
    expect(source).toContain('assertRolledBack');
    expect(source).toContain('toEqual(originalPolicy)');
  });

  test('prepared database cases cover the actual lock, snapshot isolation and clock expiry seams', () => {
    const source = fs.readFileSync(path.join(root, 'tests/integration/ack/bounded-token-rejections.test.js'), 'utf8');
    expect(source.match(/\n  test\(/g)).toHaveLength(3);
    expect(source).toContain("['READ COMMITTED', 'READ COMMITTED']");
    expect(source).toContain("['READ COMMITTED', 'REPEATABLE READ']");
    expect(source).toContain("const LOCK_KEY = 'masarx.webhook-token-rejection-log'");
    expect(sql).toContain("hashtextextended('masarx.webhook-token-rejection-log', 0)");
    expect(source).toContain("reason: 'budget_busy'");
    expect(source).toContain("reason: 'snapshot_isolation'");
    expect(source).toContain("reason: 'budget_exhausted'");
    expect(source).toContain('expect(held.rows[0].acquired).toBe(false)');
    expect(source).toContain('expect(invisible.rows[0].count).toBe(0)');
    expect(source).toContain('pg_sleep_until($1::timestamptz');
    expect(source).toContain('clock_timestamp() > $1::timestamptz');
    expect(source).toContain("status: 'recorded', correlation_id: admittedId");
  });

  test('prepared disposable regressions cover API scope, budget and suppression without skips', () => {
    const test = fs.readFileSync(path.join(root, 'supabase/tests/pgtap/0zz_webhook_bounded_token_rejections_v1.sql'), 'utf8');
    for (const marker of ['SET LOCAL ROLE edge_webhook_role;', 'api.workflow_intake_webhook(', 'unknown stays unscoped',
      'disabled source derives organization', 'rotated token derives original source', 'budget_exhausted',
      'policy_disabled', 'token_size', 'recorder_unavailable', 'ROLLBACK;']) expect(test).toContain(marker);
    expect(test).not.toMatch(/\b(?:skip|todo)\(/i);
  });

  test('missing-template repair targets exactly one current core block and preserves all other bytes', () => {
    const repair = fs.readFileSync(path.join(root, 'supabase/migrations/20260907230000_webhook_missing_template_configured_error_v1.sql'), 'utf8');
    const oldBlock = repair.match(/v_old TEXT := \$old\$([\s\S]*?)\$old\$;/)?.[1];
    const newBlock = repair.match(/v_new TEXT := \$new\$([\s\S]*?)\$new\$;/)?.[1];
    expect(oldBlock).toBeTruthy();
    expect(newBlock).toBeTruthy();
    const core = coreOf(sql);
    expect(core.split(oldBlock)).toHaveLength(2);
    const offset = core.indexOf(oldBlock);
    const repaired = core.replace(oldBlock, newBlock);
    expect(repaired.slice(0, offset)).toBe(core.slice(0, offset));
    expect(repaired.slice(offset + newBlock.length)).toBe(core.slice(offset + oldBlock.length));
    expect(repair).toContain("pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)");
    expect(repair).toContain("(length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old)");
    expect(repair).toContain("RAISE EXCEPTION 'Unexpected workflow_intake_webhook_core_v1 missing-template definition shape'");
    expect(repair).toContain('EXECUTE replace(v_def, v_old, v_new);');
    expect(repair).not.toMatch(/CREATE OR REPLACE FUNCTION|\b(?:GRANT|REVOKE)\b|WHEN OTHERS/i);
    expect(repair.match(/\bEXECUTE\b/g)).toHaveLength(1);
    expect(newBlock).not.toContain('77770000-0000-0000-0000-000000770001');
    expect(newBlock).toContain("COALESCE(NULLIF(v_defaults->>'error_status', '')::INT, 500)");
    expect(newBlock).toContain("'response_reason', 'missing_entry_template'");
    expect(newBlock).toContain("'correlation_id', v_correlation_id");
    const ordered = [
      "IF p_token IS NULL OR btrim(p_token) = '' THEN",
      'FROM get_webhook_source_by_token(p_token)',
      'IF v_source.id IS NULL OR v_source.enabled IS NOT TRUE THEN',
      'public.record_webhook_token_rejection_bounded_v1(',
      'FROM resolve_webhook_ingest_policy(p_webhook_source_id := v_source.id)',
      "'error', 'Webhook ingest policy not configured'",
      'IF v_entry_template_id IS NULL THEN',
      "v_hmac_config := v_policy_body->'validation'->'hmac'",
    ];
    for (const marker of ordered) expect(repaired.indexOf(marker)).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < ordered.length; i += 1) expect(repaired.indexOf(ordered[i])).toBeGreaterThan(repaired.indexOf(ordered[i - 1]));
    expect(repaired.match(/RETURN (?:jsonb_strip_nulls\()?jsonb_build_object\(\s*'correlation_id', v_correlation_id,/g)).toHaveLength(8);
  });
});
