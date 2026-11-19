-- Purpose:
--   Console V2 Inbound intake depends on the browser-facing
--   ui_list_resource_v1('webhook_inbox_directory') path. Some long-lived
--   environments can carry scoped ui_read_registry rows or cache entries from
--   before the richer webhook directory registration. Repair every scoped row
--   and clear resolved registry cache so operators do not need to reload or
--   wait for cache expiry to see the backend-backed intake monitor.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605111650_console_v2_webhook_inbox_directory_registry_cache_guard_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $read_registry$
DECLARE
  v_scope RECORD;
  v_seen INT := 0;
  v_current JSONB;
  v_resources JSONB;
  v_filtered JSONB;
  v_next JSONB;
  v_resource JSONB := jsonb_build_object(
    'key', 'webhook_inbox_directory',
    'relation', 'public.v_webhook_inbox_directory',
    'id_column', 'id',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'capability_read', 'webhooks.read',
    'capability_write', 'webhooks.write',
    'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc'),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
      jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
      jsonb_build_object('key', 'processing_status', 'column', 'processing_status', 'op', 'eq'),
      jsonb_build_object('key', 'event_type', 'column', 'event_type', 'op', 'eq'),
      jsonb_build_object('key', 'webhook_source_id', 'column', 'webhook_source_id', 'op', 'eq'),
      jsonb_build_object('key', 'workflow_run_id', 'column', 'workflow_run_id', 'op', 'eq'),
      jsonb_build_object('key', 'idempotency_key', 'column', 'idempotency_key', 'op', 'eq'),
      jsonb_build_object('key', 'shipment_id', 'column', 'shipment_id', 'op', 'eq'),
      jsonb_build_object('key', 'mapping_config_id', 'column', 'mapping_config_id', 'op', 'eq'),
      jsonb_build_object('key', 'external_id', 'column', 'external_id', 'op', 'ilike'),
      jsonb_build_object('key', 'correlation_id', 'column', 'correlation_id', 'op', 'eq')
    ),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'created_at', 'label', 'When', 'format', 'datetime', 'sortable', TRUE),
      jsonb_build_object('key', 'source_label', 'label', 'Source', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'source_identifier', 'label', 'Source ID', 'mono', TRUE, 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'mapping_label', 'label', 'Mapping', 'mono', TRUE, 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'mapping_target', 'label', 'Target', 'mono', TRUE, 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'event_type', 'label', 'Event', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'payload_size', 'label', 'Size', 'align', 'right', 'sortable', TRUE),
      jsonb_build_object('key', 'external_id', 'label', 'External ID', 'mono', TRUE),
      jsonb_build_object('key', 'processing_status', 'label', 'Status', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'shipment_id', 'label', 'Shipment', 'mono', TRUE, 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'tracking_number', 'label', 'Tracking', 'mono', TRUE, 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'is_terminal', 'label', 'Terminal', 'filterable', TRUE, 'sortable', TRUE),
      jsonb_build_object('key', 'is_actionable', 'label', 'Actionable', 'filterable', TRUE, 'sortable', TRUE),
      jsonb_build_object('key', 'replay_count', 'label', 'Replays', 'align', 'right', 'mono', TRUE, 'sortable', TRUE, 'type', 'number'),
      jsonb_build_object('key', 'force_status_count', 'label', 'Force-status', 'align', 'right', 'mono', TRUE, 'sortable', TRUE, 'type', 'number'),
      jsonb_build_object('key', 'last_replay_at', 'label', 'Last replay', 'format', 'datetime', 'sortable', TRUE),
      jsonb_build_object('key', 'last_replay_actor', 'label', 'Last actor', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'age_seconds', 'label', 'Age (s)', 'align', 'right', 'mono', TRUE, 'sortable', TRUE, 'type', 'number'),
      jsonb_build_object('key', 'age_hours', 'label', 'Age (h)', 'align', 'right', 'mono', TRUE, 'sortable', TRUE, 'type', 'number')
    )
  );
BEGIN
  FOR v_scope IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_seen := v_seen + 1;
    v_current := COALESCE(v_scope.value, '{"resources":[]}'::jsonb);
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    SELECT COALESCE(jsonb_agg(resource), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(v_resources) AS resource
     WHERE resource->>'key' <> 'webhook_inbox_directory';

    v_next := jsonb_set(v_current, '{resources}', v_filtered || jsonb_build_array(v_resource), TRUE);

    UPDATE public.settings_versions sv
       SET value = v_next,
           version = v_scope.version + 1,
           change_reason = 'Repair Console V2 webhook inbox directory registry across all scopes',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE sv.id = v_scope.settings_version_id
       AND sv.value IS DISTINCT FROM v_next;

    UPDATE public.settings s
       SET cached_value = v_next,
           last_updated = now()
     WHERE s.id = v_scope.settings_id
       AND s.cached_value IS DISTINCT FROM v_next;
  END LOOP;

  IF v_seen = 0 THEN
    RAISE EXCEPTION 'ui_read_registry settings missing';
  END IF;
END;
$read_registry$;

DELETE FROM public.settings_cache
 WHERE cache_key LIKE 'ui_read_registry:%';

DO $assert$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
          WHERE resource->>'key' = 'webhook_inbox_directory'
            AND resource->>'relation' = 'public.v_webhook_inbox_directory'
            AND resource->>'capability_read' = 'webhooks.read'
            AND resource#>>'{scope_columns,tenant}' = 'organization_id'
       )
  ) THEN
    RAISE EXCEPTION 'webhook_inbox_directory missing from one or more ui_read_registry scopes';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.settings_cache
     WHERE cache_key LIKE 'ui_read_registry:%'
  ) THEN
    RAISE EXCEPTION 'ui_read_registry settings cache was not invalidated';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'v_webhook_inbox_directory'
       AND COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
  ) THEN
    RAISE EXCEPTION 'v_webhook_inbox_directory must remain a security_invoker view';
  END IF;
END;
$assert$;

SELECT pg_advisory_unlock(hashtext('202605111650_console_v2_webhook_inbox_directory_registry_cache_guard_v1'));

COMMIT;
