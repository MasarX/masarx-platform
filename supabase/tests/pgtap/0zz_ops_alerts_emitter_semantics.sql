-- Test: ops_alerts trigger semantics (no alert on 2xx; alert on non-2xx)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

DO $$
DECLARE
  v_org UUID := 'aaaa7777-0000-0000-0000-000000007701';
  v_map UUID := 'bbbb7777-0000-0000-0000-000000007701';
  v_src UUID := 'cccc7777-0000-0000-0000-000000007701';
  v_inbox UUID := 'dddd7777-0000-0000-0000-000000007701';
  v_corr UUID := 'eeee7777-0000-0000-0000-000000007701';
BEGIN
  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'Ops Alerts Semantics Org', 'ops-alerts-semantics-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (v_map, 'webhook_inbound', 'pgtap::ops_alerts_semantics', '{}'::jsonb, 1, 'pgtap ops alerts semantics')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO webhook_sources (
    id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled
  )
  VALUES (
    v_src, v_org, 'pgtap-ops-alerts-semantics', 'PGTAP Ops Alerts Source', 'provider', 'pgtap-token', v_map, TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO webhook_inbox (
    id, webhook_source_id, provider_type, raw_payload, correlation_id,
    organization_id, processing_status, policy_scope_type, policy_scope_id, policy_settings_id, policy_version, created_at
  )
  VALUES (
    v_inbox, v_src, 'provider', '{}'::jsonb, v_corr,
    v_org, 'received', 'global', NULL, NULL, 1, now()
  )
  ON CONFLICT (id) DO NOTHING;
END$$;

-- 1) 2xx response should NOT emit ops_alerts
INSERT INTO decision_log (
  id,
  organization_id,
  decision_category,
  resource_type,
  resource_id,
  decision_point,
  decision_outcome,
  decision_inputs,
  performed_by_system,
  correlation_id,
  "timestamp"
)
VALUES (
  '11117777-0000-0000-0000-000000007701'::uuid,
  'aaaa7777-0000-0000-0000-000000007701'::uuid,
  'http_response_emitted',
  'webhook_inbox',
  'dddd7777-0000-0000-0000-000000007701'::uuid,
  'http_response',
  'response_sent',
  jsonb_build_object('status', 200, 'headers', '{}'::jsonb, 'body', '{}'::jsonb),
  'pgtap',
  'eeee7777-0000-0000-0000-000000007701'::uuid,
  now()
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM ops_alerts
    WHERE decision_log_id = '11117777-0000-0000-0000-000000007701'::uuid
  ),
  'ops_alerts not emitted for 2xx webhook response'
);

-- 2) non-2xx response SHOULD emit ops_alerts
INSERT INTO decision_log (
  id,
  organization_id,
  decision_category,
  resource_type,
  resource_id,
  decision_point,
  decision_outcome,
  decision_inputs,
  performed_by_system,
  correlation_id,
  "timestamp"
)
VALUES (
  '22227777-0000-0000-0000-000000007701'::uuid,
  'aaaa7777-0000-0000-0000-000000007701'::uuid,
  'http_response_emitted',
  'webhook_inbox',
  'dddd7777-0000-0000-0000-000000007701'::uuid,
  'http_response',
  'response_sent',
  jsonb_build_object('status', 500, 'headers', '{}'::jsonb, 'body', '{}'::jsonb),
  'pgtap',
  'eeee7777-0000-0000-0000-000000007701'::uuid,
  now()
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM ops_alerts
    WHERE decision_log_id = '22227777-0000-0000-0000-000000007701'::uuid
  ),
  'ops_alerts emitted for non-2xx webhook response'
);

SELECT finish();

ROLLBACK;
