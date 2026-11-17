BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

-- Verify webhook_ingest_policy.workflow.launch_mode='sync_only' runs the follow-up workflow inline
-- (eliminates cron wait for latency-sensitive reply handlers).

INSERT INTO public.organizations (id, name, slug)
VALUES ('aaaa1000-0000-0000-0000-000000000099', 'Sync Followup Org', 'sync-followup-org')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.mapping_configs (
  id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  notes
)
VALUES (
  'cccc1000-0000-0000-0000-000000000099',
  'webhook_inbound',
  'pgtap-sync-followup::default',
  '{}'::jsonb,
  1,
  'pgTAP sync_only follow-up intake mapping'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.workflow_templates (
  id, name, description, version, status, scope_type, scope_id
)
VALUES (
  'ffff1000-0000-0000-0000-000000000099',
  'pgtap_sync_followup_v1',
  'Follow-up workflow for sync_only wrapper test',
  1,
  'active',
  'tenant',
  'aaaa1000-0000-0000-0000-000000000099'
)
ON CONFLICT (id) DO NOTHING;

-- Single no-op step: handler exists and completes immediately (no external calls).
INSERT INTO public.workflow_template_steps (
  id,
  workflow_template_id,
  sequence_order,
  operation_name,
  operation_settings_category,
  transition_condition,
  handler_key,
  handler_version,
  metadata,
  enabled
)
VALUES (
  'eeee1000-0000-0000-0000-000000000099',
  'ffff1000-0000-0000-0000-000000000099',
  1,
  'workflow_control',
  'workflow',
  'always',
  'workflow_control',
  'v1',
  jsonb_build_object('action', 'complete'),
  TRUE
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.webhook_sources (
  id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled
)
VALUES (
  'bbbb1000-0000-0000-0000-000000000099',
  'aaaa1000-0000-0000-0000-000000000099',
  'pgtap-sync-followup',
  'pgTAP Sync Followup Source',
  'provider',
  'token-pgtap-sync-followup',
  'cccc1000-0000-0000-0000-000000000099',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.settings_versions (
  id,
  category,
  scope_type,
  scope_id,
  version,
  value,
  schema_version,
  change_reason,
  approved_at,
  effective_from
)
VALUES (
  'aaaa2000-0000-0000-0000-000000000099',
  'webhook_ingest_policy',
  'source',
  'bbbb1000-0000-0000-0000-000000000099',
  1,
  jsonb_build_object(
    'version', 1,
    'ack', jsonb_build_object(
      'mode', 'accepted_async',
      'default_headers', jsonb_build_object('cache-control', 'no-store')
    ),
    'workflow', jsonb_build_object(
      'template_id', 'ffff1000-0000-0000-0000-000000000099',
      'launch_mode', 'sync_only'
    )
  ),
  1,
  'pgTAP webhook_ingest_policy sync_only',
  now(),
  now()
)
ON CONFLICT ON CONSTRAINT settings_versions_new_pkey DO NOTHING;

INSERT INTO public.settings (
  id,
  category,
  scope_type,
  scope_id,
  settings_version_id,
  cached_value,
  last_updated
)
VALUES (
  'aaaa3000-0000-0000-0000-000000000099',
  'webhook_ingest_policy',
  'source',
  'bbbb1000-0000-0000-0000-000000000099',
  'aaaa2000-0000-0000-0000-000000000099',
  (
    SELECT value
    FROM public.settings_versions
    WHERE id = 'aaaa2000-0000-0000-0000-000000000099'
    LIMIT 1
  ),
  now()
)
ON CONFLICT (category, scope_type, scope_id) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = now();

CREATE TEMP TABLE pgtap_sync_followup_response AS
SELECT workflow_intake_webhook(
  'token-pgtap-sync-followup',
  jsonb_build_object('content-type', 'application/json'),
  '{"event":{"id":"evt-pgtap-sync-followup","type":"shipment.create"},"example":"value"}',
  jsonb_build_object(
    'event',
    jsonb_build_object(
      'id', 'evt-pgtap-sync-followup',
      'type', 'shipment.create'
    ),
    'example', 'value'
  )
) AS response;

SELECT ok(
  NULLIF(response->>'followup_workflow_run_id', '') IS NOT NULL,
  'followup_workflow_run_id returned'
)
FROM pgtap_sync_followup_response;

SELECT ok(
  COALESCE((response->>'followup_sync')::BOOLEAN, FALSE),
  'follow-up executed inline when launch_mode=sync_only'
)
FROM pgtap_sync_followup_response;

SELECT is(
  (
    SELECT workflow_status
    FROM public.workflow_runs
    WHERE id = (SELECT (response->>'followup_workflow_run_id')::UUID FROM pgtap_sync_followup_response LIMIT 1)
  ),
  'completed',
  'follow-up workflow_run completed inline'
);

SELECT finish();

ROLLBACK;
