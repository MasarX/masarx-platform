-- pgTAP: Settings provenance table + FK + trigger linkage for webhook decisions
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

-- 1) Table exists
SELECT ok(
  to_regclass('public.settings_resolution_log') IS NOT NULL,
  'settings_resolution_log table exists'
);

-- 2) HASH partition p0 exists and RANGE subpartition present
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_inherits i
    JOIN pg_class c_parent ON c_parent.oid = i.inhparent
    JOIN pg_class c_child ON c_child.oid = i.inhrelid
    WHERE c_parent.relname = 'settings_resolution_log'
  ),
  'settings_resolution_log has HASH partition(s)'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_inherits i1
    JOIN pg_class c_p0 ON c_p0.oid = i1.inhrelid
    JOIN pg_inherits i2 ON i2.inhparent = i1.inhrelid
    WHERE c_p0.relname = 'settings_resolution_log_p0'
  ),
  'settings_resolution_log_p0 has RANGE partitions'
);

-- 3) RLS enabled
SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='settings_resolution_log'),
  'RLS enabled on settings_resolution_log'
);

-- 4) Soft link only (FK omitted due to partitioning); skip FK assertion

-- 5/6/7) Trigger linkage: insert webhook inbox + decision_log -> provenance row is created and linked
DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_source UUID := gen_random_uuid();
  v_mapping UUID := gen_random_uuid();
  v_settings UUID := gen_random_uuid();
  v_context UUID;
  v_webhook UUID := gen_random_uuid();
  v_decision UUID;
  v_prov UUID;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'postgres')::text, true);
  EXECUTE 'SET LOCAL ROLE postgres';

  -- Minimal org
  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'Prov Org', 'prov-org')
  ON CONFLICT DO NOTHING;

  -- Minimal mapping + source
  INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version)
  VALUES (v_mapping, 'webhook_inbound', 'prov::default', '{}'::jsonb, 1)
  ON CONFLICT DO NOTHING;

  INSERT INTO webhook_sources (id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled)
  VALUES (v_source, v_org, 'prov-source', 'Prov Source', 'provider', 'tok-prov', v_mapping, TRUE)
  ON CONFLICT DO NOTHING;

  INSERT INTO request_contexts (id, entry_point)
  VALUES (gen_random_uuid(), 'webhook')
  RETURNING id INTO v_context;

  INSERT INTO webhook_inbox (
    id, webhook_source_id, organization_id, provider_type,
    policy_settings_id, policy_scope_type, policy_scope_id, policy_version,
    processing_status, raw_payload, headers, correlation_id
  ) VALUES (
    v_webhook, v_source, v_org, 'provider',
    NULL, 'source', v_source, 1,
    'in_progress', '{}'::jsonb, '{}'::jsonb, v_context
  ) ON CONFLICT DO NOTHING;

  v_decision := log_decision(
    p_organization_id := v_org,
    p_decision_category := 'http_response_emitted',
    p_resource_type := 'webhook_inbox',
    p_resource_id := v_webhook,
    p_decision_point := 'workflow_intake_response',
    p_decision_outcome := 'response_sent',
    p_performed_by_system := 'workflow_engine',
    p_correlation_id := NULL,
    p_decision_inputs := jsonb_build_object('status', 200, 'headers', jsonb_build_object('content-type','application/json')),
    p_decision_reason := 'pgTAP provenance linkage test'
  );

  PERFORM ok(v_decision IS NOT NULL, 'log_decision returned an id');

  SELECT settings_resolution_id INTO v_prov
  FROM decision_log WHERE id = v_decision;

  PERFORM ok(v_prov IS NOT NULL, 'decision_log row linked to settings_resolution_log');

  PERFORM ok(
    EXISTS (
      SELECT 1 FROM settings_resolution_log
      WHERE id = v_prov AND category = 'webhook_ingest_policy'
    ),
    'settings_resolution_log row exists for webhook decision'
  );
END;
$$ LANGUAGE plpgsql;

SELECT finish();

ROLLBACK;
