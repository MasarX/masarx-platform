BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

-- Seed workflow context so outbound_calls inserts satisfy engine guards.
SELECT set_config('app.workflow_run_id', 'dddd0ad0-0000-0000-0000-0000000000ad', true);
INSERT INTO workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  'bbbb0ad0-0000-0000-0000-0000000000ad',
  'pgtap_alert_dispatch',
  'Fixture workflow for alert dispatch tests',
  1,
  'active',
  'global'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_template_steps (
  id,
  workflow_template_id,
  sequence_order,
  operation_name,
  transition_condition,
  handler_key,
  handler_version,
  enabled
)
VALUES (
  'cccc0ad0-0000-0000-0000-0000000000ad',
  'bbbb0ad0-0000-0000-0000-0000000000ad',
  1,
  'workflow_control',
  'always',
  'workflow_control',
  'v1',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
)
VALUES (
  'dddd0ad0-0000-0000-0000-0000000000ad',
  'bbbb0ad0-0000-0000-0000-0000000000ad',
  1,
  'test',
  'pending',
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_run_steps (
  id,
  workflow_run_id,
  workflow_template_step_id,
  sequence_order,
  step_status,
  operation_name,
  handler_key,
  handler_version,
  max_retries,
  enqueued_at,
  created_at,
  updated_at
)
VALUES (
  'eeee0ad0-0000-0000-0000-0000000000ad',
  'dddd0ad0-0000-0000-0000-0000000000ad',
  'cccc0ad0-0000-0000-0000-0000000000ad',
  1,
  'pending',
  'workflow_control',
  'workflow_control',
  'v1',
  1,
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_step_id', 'eeee0ad0-0000-0000-0000-0000000000ad', true);
SELECT set_config('platform.workflow_engine', '1', true);
SELECT set_config('platform.workflow_run_step_id', 'eeee0ad0-0000-0000-0000-0000000000ad', true);

-- Create an alert_rule + alert_trigger and dispatch it via WhatsApp (enqueue-only).
CREATE TEMP TABLE pgtap_alert_dispatch_ctx (
  trigger_id UUID,
  result JSONB
);

WITH onboarding_source AS (
  SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true)
), org AS (
  INSERT INTO organizations (id, name, slug)
  SELECT
    gen_random_uuid(),
    'pgTAP Alert Dispatch Org',
    'pgtap-alert-dispatch-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
  FROM onboarding_source
  RETURNING id
), clear_onboarding_source AS (
  SELECT set_config('app.organization_onboarding_source', '', true)
  FROM org
), client AS (
  INSERT INTO clients (id, organization_id, name, slug, status)
  SELECT
    gen_random_uuid(),
    org.id,
    'pgTAP Alert Dispatch Client',
    'pgtap-alert-dispatch-client-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
    'active'
  FROM org, clear_onboarding_source
  RETURNING id, organization_id
), sender AS (
  INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
  SELECT
    gen_random_uuid(),
    client.id,
    'pgTAP Alert Dispatch Sender',
    'pgTAP Alert Sender',
    TRUE,
    'active'
  FROM client
  RETURNING id, client_id
), tenant_bootstrap AS (
  SELECT public.bootstrap_tenant_onboarding_v1(
    org.id,
    'pgtap:alert-dispatch-workers-fixture-bootstrap'
  )
  FROM org, sender
), prov AS (
  INSERT INTO providers (organization_id, name, provider_type, enabled, metadata)
  SELECT
    org.id,
    'dialog360_whatsapp',
    'comms',
    TRUE,
    jsonb_build_object('base_url', 'https://example.whatsapp.test')
  FROM org, tenant_bootstrap
  ON CONFLICT (organization_id, name, provider_type) DO UPDATE
    SET enabled = EXCLUDED.enabled,
        metadata = EXCLUDED.metadata,
        updated_at = now()
  RETURNING id
), tenant_compliance_policy AS (
  -- Keep policy tenant-scoped for this fixture to avoid shared-global race/drift.
  SELECT public.upsert_settings_value_v1(
    'whatsapp_compliance_policy',
    'tenant',
    org.id,
    jsonb_build_object(
      'version', 1,
      'enforce_text_session', FALSE,
      'session_window_seconds', 86400,
      'allow_webhook_session_evidence', TRUE,
      'allow_freeform_outside_session_sources', jsonb_build_array('dispatch_alert_trigger')
    ),
    1,
    'pgtap alert_dispatch_workers tenant compliance fixture'
  ) AS settings_id
  FROM org, tenant_bootstrap
), provider_defaults_payload AS (
  SELECT jsonb_build_object(
    'messaging_product', 'whatsapp',
    'whatsapp', jsonb_build_object(
      'messages_path', 'messages',
      'api_key_header', 'X-PGTAP-API-KEY',
      'headers_template', jsonb_build_object(
        'Content-Type', 'application/json'
      ),
      'text_body_template', jsonb_build_object(
        'messaging_product', '{{messaging_product}}',
        'to', '{{recipient}}',
        'type', 'text',
        'text', jsonb_build_object(
          'body', '{{message_text}}'
        )
      )
    )
  ) AS value
), provider_defaults_version AS (
  INSERT INTO settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    version,
    value,
    created_at
  )
  SELECT
    gen_random_uuid(),
    'provider_defaults',
    'resource',
    prov.id,
    1,
    provider_defaults_payload.value,
    now()
  FROM prov, provider_defaults_payload
  RETURNING id, scope_id, value
), provider_defaults_settings AS (
  INSERT INTO settings (
    id,
    category,
    scope_type,
    scope_id,
    settings_version_id,
    cached_value,
    last_updated
  )
  SELECT
    gen_random_uuid(),
    'provider_defaults',
    'resource',
    scope_id,
    id,
    value,
    now()
  FROM provider_defaults_version
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
    SET settings_version_id = EXCLUDED.settings_version_id,
        cached_value = EXCLUDED.cached_value,
        last_updated = now()
  RETURNING id
), auth AS (
  -- Keep fixture auth inline (no vault dependency) to avoid environment-specific flakes.
  INSERT INTO provider_auth_configs (id, provider_id, auth_type, credentials_vault_id, credentials, expires_at)
  SELECT
    gen_random_uuid(),
    prov.id,
    'api_key',
    NULL,
    jsonb_build_object('api_key', 'EXAMPLE_PASSWORD'),
    NULL
  FROM prov
  JOIN provider_defaults_settings ON TRUE
  RETURNING id
), rule AS (
  INSERT INTO alert_rules (
    id,
    organization_id,
    rule_name,
    enabled,
    priority,
    trigger_source,
    trigger_conditions,
    throttle_window_minutes,
    alert_channels,
    message_variables,
    created_at,
    updated_at
  )
  SELECT
    gen_random_uuid(),
    org.id,
    'pgtap_alert_dispatch_' || replace(gen_random_uuid()::text, '-', ''),
    TRUE,
    1,
    'decision_log',
    jsonb_build_object('decision_category', 'noop'),
    5,
    jsonb_build_array('comms_whatsapp'),
    jsonb_build_object(
      'dispatch', jsonb_build_object(
        'auth_config_id', (SELECT id FROM auth),
        'recipients', jsonb_build_array('555199999999')
      )
    ),
    now(),
    now()
  FROM org
  RETURNING id, organization_id
), trig AS (
  INSERT INTO alert_triggers (
    id,
    alert_rule_id,
    organization_id,
    resource_type,
    resource_id,
    severity,
    message,
    context,
    notified_at,
    timestamp
  )
  SELECT
    gen_random_uuid(),
    rule.id,
    rule.organization_id,
    'unit_test',
    gen_random_uuid(),
    'warning',
    'pgtap alert dispatch test',
    '{}'::jsonb,
    NULL,
    now()
  FROM rule
  RETURNING id
)
INSERT INTO pgtap_alert_dispatch_ctx (trigger_id, result)
SELECT trig.id, public.dispatch_alert_trigger(trig.id)
FROM trig;

SELECT ok(
  (SELECT result->>'status' FROM pgtap_alert_dispatch_ctx LIMIT 1) = 'dispatched',
  'dispatch_alert_trigger enqueues WhatsApp outbound_calls and marks trigger notified'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM outbound_calls oc
    WHERE oc.correlation_id = (SELECT trigger_id FROM pgtap_alert_dispatch_ctx LIMIT 1)
      AND oc.call_type = 'comms_whatsapp'
  ),
  'dispatch_alert_trigger creates comms_whatsapp outbound_calls row'
);

SELECT is(
  (
    SELECT oc.body->'text'->>'body'
    FROM outbound_calls oc
    WHERE oc.correlation_id = (SELECT trigger_id FROM pgtap_alert_dispatch_ctx LIMIT 1)
      AND oc.call_type = 'comms_whatsapp'
    ORDER BY oc.created_at DESC
    LIMIT 1
  ),
  'pgtap alert dispatch test',
  'alert message is enqueued as WhatsApp body'
);

SELECT finish();

ROLLBACK;
