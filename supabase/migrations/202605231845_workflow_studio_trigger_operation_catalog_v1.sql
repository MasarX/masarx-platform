-- Console V2 Workflow Studio requires row-driven trigger operation choices for
-- blank template first-step creation. Keep the trigger contract in lookup and
-- operation catalog rows instead of hardcoding frontend fallbacks.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605231845_workflow_studio_trigger_operation_catalog_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH desired(value, metadata) AS (
  VALUES
    ('trigger',   '{"is_trigger":true,"requires_error_path":false}'::jsonb),
    ('transform', '{"is_trigger":false,"requires_error_path":false}'::jsonb),
    ('guard',     '{"is_trigger":false,"requires_error_path":true}'::jsonb),
    ('action',    '{"is_trigger":false,"requires_error_path":false,"is_default":true}'::jsonb),
    ('error',     '{"is_trigger":false,"requires_error_path":false}'::jsonb),
    ('manual',    '{"is_trigger":false,"requires_error_path":false}'::jsonb)
)
UPDATE public.lookup_values AS lv
   SET metadata = COALESCE(lv.metadata, '{}'::jsonb) || desired.metadata,
       updated_at = now()
  FROM public.lookup_definitions AS ld,
       desired
 WHERE ld.id = lv.lookup_definition_id
   AND ld.category = 'workflow_step_kind'
   AND lv.value = desired.value;

WITH operation_rows(
  id,
  operation_name,
  description,
  output_schema
) AS (
  VALUES
    (
      '99990000-0000-0000-0000-000000460201'::uuid,
      'webhook.receive',
      'Receive an authenticated webhook payload as the first workflow step.',
      '{"payload":"jsonb","headers":"jsonb","correlation_id":"text"}'::jsonb
    ),
    (
      '99990000-0000-0000-0000-000000460202'::uuid,
      'event.consume',
      'Consume a platform event payload as the first workflow step.',
      '{"event_type":"text","payload":"jsonb","correlation_id":"text"}'::jsonb
    ),
    (
      '99990000-0000-0000-0000-000000460203'::uuid,
      'command.execute',
      'Receive an operator or system command as the first workflow step.',
      '{"command":"text","payload":"jsonb","actor_id":"uuid"}'::jsonb
    ),
    (
      '99990000-0000-0000-0000-000000460204'::uuid,
      'task.transition',
      'Consume a task lifecycle transition as the first workflow step.',
      '{"task_id":"uuid","from_status":"text","to_status":"text"}'::jsonb
    )
)
INSERT INTO public.operation_templates (
  id,
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
  handler_key,
  handler_version,
  metadata,
  call_type
)
SELECT
  operation_rows.id,
  '99990000-0000-0000-0000-000000460000'::uuid,
  operation_rows.operation_name,
  'POST',
  'workflow://internal/' || operation_rows.operation_name,
  '{}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  '99990000-0000-0000-0000-000000460001'::uuid,
  30,
  NULL,
  'workflow_binding_noop',
  'v1',
  jsonb_build_object(
    'kind', 'trigger',
    'category', 'triggers',
    'description', operation_rows.description,
    'output_schema', operation_rows.output_schema,
    'output_sample', '{}'::jsonb,
    'source', 'workflow_studio_trigger_operation_catalog'
  ),
  'provider_api'
FROM operation_rows
ON CONFLICT (provider_id, operation_name) DO UPDATE
   SET method = EXCLUDED.method,
       url_template = EXCLUDED.url_template,
       headers_template = EXCLUDED.headers_template,
       body_template = EXCLUDED.body_template,
       request_mappings = EXCLUDED.request_mappings,
       mapping_config_id = EXCLUDED.mapping_config_id,
       timeout_seconds = EXCLUDED.timeout_seconds,
       handler_key = EXCLUDED.handler_key,
       handler_version = EXCLUDED.handler_version,
       metadata = COALESCE(public.operation_templates.metadata, '{}'::jsonb) || EXCLUDED.metadata,
       call_type = EXCLUDED.call_type,
       updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605231845_workflow_studio_trigger_operation_catalog_v1'));
COMMIT;
