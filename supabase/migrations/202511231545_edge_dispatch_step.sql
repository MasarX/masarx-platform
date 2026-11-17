-- Migration: Add immediate dispatch Step 2 for communications_inbound_v1 via edge api-caller
-- Purpose: Strict workflow-only immediate execution of outbound_calls by calling the edge
--          function with { job_id: $.context.last_outbound_call_id }.

BEGIN;

WITH edge_provider AS (
  SELECT id FROM providers WHERE name='edge_api_caller' LIMIT 1
),
org_any AS (
  SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1
),
ensure_provider AS (
  INSERT INTO providers (
    organization_id, name, provider_type, priority_rank, metadata
  )
  SELECT org_any.id, 'edge_api_caller', 'comms', 100, '{}'::jsonb
  FROM org_any
  WHERE NOT EXISTS (SELECT 1 FROM edge_provider) AND org_any.id IS NOT NULL
  RETURNING id
),
provider_row AS (
  SELECT id FROM edge_provider
  UNION ALL
  SELECT id FROM ensure_provider
  LIMIT 1
),
endpoint AS (
  SELECT (cached_value->>'endpoint_url') AS url
  FROM settings
  WHERE category='edge_dispatch_policy' AND scope_type='global' AND scope_id IS NULL
  ORDER BY last_updated DESC
  LIMIT 1
),
secret AS (
  SELECT (credentials->>'shared_secret') AS token
  FROM provider_auth_configs
  WHERE provider_id = (SELECT id FROM provider_row)
  ORDER BY created_at DESC
  LIMIT 1
),
ver AS (
  SELECT id
  FROM settings_versions
  WHERE category='provider_defaults' AND scope_type='resource' AND scope_id=(SELECT id FROM provider_row)
    AND effective_until IS NULL
  ORDER BY version DESC
  LIMIT 1
),
newv AS (
  INSERT INTO settings_versions (category, scope_type, scope_id, version, value, schema_version, change_reason, approved_at, effective_from)
  SELECT 'provider_defaults','resource',(SELECT id FROM provider_row),1,
         jsonb_build_object(
           'endpoint_url', (SELECT url FROM endpoint),
           'edge_bearer', concat('Bearer ', (SELECT token FROM secret))
         ),
         1,'seed edge provider defaults', now(), now()
  WHERE NOT EXISTS (SELECT 1 FROM ver)
    AND (SELECT url FROM endpoint) IS NOT NULL
    AND (SELECT token FROM secret) IS NOT NULL
  RETURNING id
),
defaults_upsert AS (
  -- Upsert provider_defaults for edge provider so mappings can read headers/body values at runtime
  INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  SELECT 'provider_defaults','resource',(SELECT id FROM provider_row),
         COALESCE((SELECT id FROM ver),(SELECT id FROM newv)),
         jsonb_build_object(
           'endpoint_url', (SELECT url FROM endpoint),
           'edge_bearer', concat('Bearer ', (SELECT token FROM secret))
         ),
         now()
  WHERE COALESCE((SELECT id FROM ver),(SELECT id FROM newv)) IS NOT NULL AND (SELECT url FROM endpoint) IS NOT NULL AND (SELECT token FROM secret) IS NOT NULL
  ON CONFLICT (category, scope_type, scope_id)
  DO UPDATE SET settings_version_id=EXCLUDED.settings_version_id, cached_value=EXCLUDED.cached_value, last_updated=now()
  WHERE (SELECT url FROM endpoint) IS NOT NULL AND (SELECT token FROM secret) IS NOT NULL
  RETURNING 1
),
map AS (
  INSERT INTO mapping_configs (mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (
    'provider_response',
    'edge_api_caller::dispatch_single_v1',
    $${
      "headers": {
        "Authorization": "$.provider_defaults.edge_bearer"
      },
      "body": {
        "job_id": "$.context.last_outbound_call_id"
      }
    }$$::jsonb,
    1,
    'Edge api-caller dispatch (single job)'
  )
  ON CONFLICT (mapping_type, mapping_key)
  DO UPDATE SET mapping_config=EXCLUDED.mapping_config, mapping_version=EXCLUDED.mapping_version, notes=EXCLUDED.notes, updated_at=now()
  RETURNING id
),
op AS (
  INSERT INTO operation_templates (
    provider_id,
    operation_name,
    method,
    url_template,
    headers_template,
    body_template,
    request_mappings,
    mapping_config_id,
    timeout_seconds,
    idempotency_key_template,
    call_type,
    handler_key,
    handler_version
  )
  SELECT
    (SELECT id FROM provider_row),
    'edge_api_dispatch_single_v1',
    'POST',
    (SELECT url FROM endpoint),
    jsonb_build_object('content-type','application/json'),
    '{}'::jsonb,
    $${}$$::jsonb,
    (SELECT id FROM map),
    30,
    NULL,
    'provider_api',
    'outbound_http',
    'v1'
  WHERE (SELECT url FROM endpoint) IS NOT NULL
  ON CONFLICT (provider_id, operation_name)
  DO UPDATE SET url_template=EXCLUDED.url_template, headers_template=EXCLUDED.headers_template, request_mappings=EXCLUDED.request_mappings,
                mapping_config_id=EXCLUDED.mapping_config_id, timeout_seconds=EXCLUDED.timeout_seconds, updated_at=now()
  WHERE (SELECT url FROM endpoint) IS NOT NULL
  RETURNING id
)
INSERT INTO workflow_template_steps (
  workflow_template_id,
  sequence_order,
  operation_name,
  operation_settings_category,
  transition_condition,
  condition_jsonlogic,
  next_operation_name,
  next_operation_priority,
  next_operation_delay_seconds,
  manual_action_required,
  metadata,
  enabled,
  handler_key,
  handler_version
)
SELECT
  wt.id,
  2,
  'edge_dispatch_single',
  NULL,
  'always',
  NULL,
  NULL,
  NULL,
  NULL,
  FALSE,
  jsonb_build_object(
    'operation_template_id', (SELECT id FROM op),
    'expects_provider_defaults', true
  ),
  TRUE,
  'outbound_http',
  'v1'
FROM workflow_templates wt
WHERE wt.name='communications_inbound_v1'
  AND NOT EXISTS (
    SELECT 1 FROM workflow_template_steps s
    WHERE s.workflow_template_id = wt.id AND s.sequence_order = 2
  );

COMMIT;


