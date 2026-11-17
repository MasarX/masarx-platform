-- Test Suite: Decision provenance trigger on http_response_emitted

BEGIN;

SET LOCAL search_path TO public, extensions, pgtap, pg_temp;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

-- Fixture: organization, inbound mapping, source, inbox
DO $$
DECLARE
  v_org UUID := 'aaaa6666-0000-0000-0000-000000006601';
  v_map UUID := 'bbbb6666-0000-0000-0000-000000006601';
  v_src UUID := 'cccc6666-0000-0000-0000-000000006601';
  v_inbox UUID := 'dddd6666-0000-0000-0000-000000006601';
  v_corr UUID := 'eeee6666-0000-0000-0000-000000006601';
BEGIN
  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'Provenance Org', 'provenance-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (v_map, 'webhook_inbound', 'pgtap::provenance', '{}'::jsonb, 1, 'pgtap provenance test')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO webhook_sources (
    id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled
  ) VALUES (
    v_src, v_org, 'pgtap-provenance', 'PGTAP Provenance Source', 'provider', 'pgtap-token', v_map, TRUE
  ) ON CONFLICT (id) DO NOTHING;

  -- Minimal inbox row with policy metadata for provenance trigger
  INSERT INTO webhook_inbox (
    id, webhook_source_id, provider_type, raw_payload, correlation_id,
    organization_id, policy_scope_type, policy_scope_id, policy_settings_id, policy_version
  ) VALUES (
    v_inbox, v_src, 'provider', '{}'::jsonb, v_corr,
    v_org, 'global', NULL, NULL, 1
  ) ON CONFLICT (id) DO NOTHING;
END$$;

-- Insert decision using a timestamp that maps to an existing monthly partition
CREATE TEMP TABLE tmp_dl(id UUID);
WITH ins AS (
  INSERT INTO decision_log (
    organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, "timestamp"
  ) VALUES (
    'aaaa6666-0000-0000-0000-000000006601',
    'http_response_emitted',
    'webhook_inbox',
    'dddd6666-0000-0000-0000-000000006601',
    'http_response',
    'response_sent',
    jsonb_build_object('status', 202, 'headers', jsonb_build_object('content-type','application/json')),
    'pgtap',
    TIMESTAMPTZ '2025-10-15 00:00:00+00'
  ) RETURNING id
)
INSERT INTO tmp_dl(id) SELECT id FROM ins;

-- 1) Trigger sets settings_resolution_id on insert
SELECT ok(
  (
    SELECT settings_resolution_id IS NOT NULL
    FROM decision_log
    WHERE id = (SELECT id FROM tmp_dl LIMIT 1)
  ),
  'decision_log.settings_resolution_id set via trigger'
);

-- 2) settings_resolution_id points to an existing provenance row
SELECT ok(
  (
    SELECT EXISTS (
      SELECT 1
      FROM settings_resolution_log
      WHERE id = (
        SELECT settings_resolution_id
        FROM decision_log
        WHERE id = (SELECT id FROM tmp_dl LIMIT 1)
      )
    )
  ),
  'settings_resolution_log row exists for decision'
);

SELECT * FROM finish();

ROLLBACK;

