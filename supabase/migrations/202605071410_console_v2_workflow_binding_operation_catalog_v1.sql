-- Tenant bootstrap workflow templates reference binding_* operations. Console V2
-- must resolve those steps from the backend operation catalog so first-tenant
-- workflow setup does not show missing-operation warnings.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605071410_console_v2_workflow_binding_operation_catalog_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.providers (
  id,
  organization_id,
  name,
  provider_type,
  enabled,
  priority_rank,
  health_status,
  metadata
)
VALUES (
  '99990000-0000-0000-0000-000000460000',
  '00000000-0000-0000-0000-000000000000',
  'MasarX Workflow Engine',
  'http',
  true,
  0,
  'healthy',
  jsonb_build_object(
    'vendor', 'MasarX',
    'purpose', 'workflow_internal_operations',
    'requires_credentials', false
  )
)
ON CONFLICT (id) DO UPDATE
   SET name = EXCLUDED.name,
       provider_type = EXCLUDED.provider_type,
       enabled = EXCLUDED.enabled,
       priority_rank = EXCLUDED.priority_rank,
       health_status = EXCLUDED.health_status,
       metadata = EXCLUDED.metadata,
       updated_at = now();

INSERT INTO public.mapping_configs (
  id,
  organization_id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  notes,
  managed_by,
  managed_metadata
)
VALUES (
  '99990000-0000-0000-0000-000000460001',
  NULL,
  'event_extraction',
  'workflow_internal::operation_context_passthrough_v1',
  jsonb_build_object('mode', 'context_passthrough'),
  1,
  'Internal workflow operation catalog passthrough mapping.',
  'platform',
  jsonb_build_object('source', 'console_v2_first_tenant_lifecycle')
)
ON CONFLICT (mapping_type, mapping_key) DO UPDATE
   SET mapping_config = EXCLUDED.mapping_config,
       mapping_version = EXCLUDED.mapping_version,
       notes = EXCLUDED.notes,
       managed_by = EXCLUDED.managed_by,
       managed_metadata = EXCLUDED.managed_metadata,
       updated_at = now();

WITH operation_rows(id, operation_name, handler_key, category, description, output_schema) AS (
  VALUES
    (
      '99990000-0000-0000-0000-000000460101'::uuid,
      'binding_request_received_notify',
      'recipient_notification_dynamic',
      'notifications',
      'Notify the requester that a shipment change request was received.',
      '{"notification_id":"uuid","status":"queued"}'::jsonb
    ),
    (
      '99990000-0000-0000-0000-000000460102'::uuid,
      'binding_post_apply_notify',
      'recipient_notification_dynamic',
      'notifications',
      'Notify the requester that a shipment change was applied.',
      '{"notification_id":"uuid","status":"queued"}'::jsonb
    ),
    (
      '99990000-0000-0000-0000-000000460103'::uuid,
      'binding_post_reject_notify',
      'recipient_notification_dynamic',
      'notifications',
      'Notify the requester that a shipment change was rejected.',
      '{"notification_id":"uuid","status":"queued"}'::jsonb
    ),
    (
      '99990000-0000-0000-0000-000000460104'::uuid,
      'binding_review_requested_task',
      'task_enqueue_dynamic',
      'review tasks',
      'Create a review task for a customer shipment change.',
      '{"task_id":"uuid","queue_key":"text"}'::jsonb
    ),
    (
      '99990000-0000-0000-0000-000000460105'::uuid,
      'binding_tenant_signup_review_task',
      'task_enqueue_dynamic',
      'review tasks',
      'Create the platform review task for a tenant signup.',
      '{"task_id":"uuid","queue_key":"text"}'::jsonb
    ),
    (
      '99990000-0000-0000-0000-000000460106'::uuid,
      'binding_marketing_lead_review_task',
      'task_enqueue_dynamic',
      'review tasks',
      'Create the platform review task for a marketing lead.',
      '{"task_id":"uuid","queue_key":"text"}'::jsonb
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
  operation_rows.handler_key,
  'v1',
  jsonb_build_object(
    'kind', 'action',
    'category', operation_rows.category,
    'description', operation_rows.description,
    'output_schema', operation_rows.output_schema,
    'output_sample', '{}'::jsonb,
    'source', 'tenant_bootstrap_binding_templates'
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
       metadata = EXCLUDED.metadata,
       call_type = EXCLUDED.call_type,
       updated_at = now();

CREATE OR REPLACE VIEW public.v_operation_template_directory
WITH (security_invoker = true)
AS
SELECT
  ot.id,
  ot.provider_id,
  p.name AS provider_name,
  ot.operation_name,
  COALESCE(NULLIF(ot.metadata->>'kind', ''), 'action') AS kind,
  COALESCE(NULLIF(ot.metadata->>'category', ''), oh.ui_category, p.provider_type, 'workflow') AS category,
  ot.timeout_seconds,
  COALESCE(NULLIF(ot.metadata->>'description', ''), oh.ui_description, oh.ui_label, ot.operation_name) AS description,
  ot.handler_key,
  ot.handler_version,
  ot.call_type,
  ot.metadata,
  ot.metadata->'output_schema' AS output_schema,
  ot.metadata->'output_sample' AS output_sample,
  ot.created_at,
  ot.updated_at
FROM public.operation_templates ot
JOIN public.providers p ON p.id = ot.provider_id
LEFT JOIN public.operation_handlers oh
  ON oh.handler_key = ot.handler_key
 AND oh.handler_version = ot.handler_version;

GRANT SELECT ON public.v_operation_template_directory TO authenticated, service_role;

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  SELECT COALESCE(jsonb_agg(
           CASE
             WHEN item->>'key' = 'operation_templates' THEN
               item || jsonb_build_object(
                 'relation', 'public.v_operation_template_directory',
                 'select', jsonb_build_array(
                   'id',
                   'provider_id',
                   'provider_name',
                   'operation_name',
                   'kind',
                   'category',
                   'timeout_seconds',
                   'description',
                   'handler_key',
                   'handler_version',
                   'call_type',
                   'metadata',
                   'output_schema',
                   'output_sample',
                   'created_at',
                   'updated_at'
                 ),
                 'filters', jsonb_build_array(
                   jsonb_build_object('key', 'operation_name', 'column', 'operation_name', 'op', 'eq'),
                   jsonb_build_object('key', 'kind', 'column', 'kind', 'op', 'eq'),
                   jsonb_build_object('key', 'category', 'column', 'category', 'op', 'eq')
                 ),
                 'default_sort', jsonb_build_object('column', 'operation_name', 'direction', 'asc')
               )
             ELSE item
           END
         ), '[]'::jsonb)
    INTO v_resources
    FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS item;

  v_current := jsonb_set(v_current, '{resources}', v_resources, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Register workflow operation template directory for Console V2',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202605071410_console_v2_workflow_binding_operation_catalog_v1'));
COMMIT;
