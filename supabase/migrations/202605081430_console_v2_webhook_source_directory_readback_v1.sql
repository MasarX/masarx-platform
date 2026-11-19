-- Console V2 webhook source directory readback repair.
--
-- Webhook source create/update/rotate actions are backend-backed and must
-- verify both the canonical source row and the operator directory projection.
-- Register the projection resource so live Console V2 can complete the
-- post-mutation readback without falling back to seed/demo state.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605081430_console_v2_webhook_source_directory_readback_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $read_registry$
DECLARE
  v_scope RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_filtered JSONB;
  v_resource JSONB := jsonb_build_object(
    'key', 'webhook_source_directory',
    'relation', 'public.v_webhook_source_directory',
    'id_column', 'id',
    'capability_read', 'webhooks.read',
    'capability_write', 'webhooks.write',
    'default_sort', jsonb_build_object('column', 'last_event_at', 'direction', 'desc'),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'source_identifier', 'column', 'source_identifier', 'op', 'ilike'),
      jsonb_build_object('key', 'provider_type', 'column', 'provider_type', 'op', 'eq'),
      jsonb_build_object('key', 'mapping_config_id', 'column', 'mapping_config_id', 'op', 'eq'),
      jsonb_build_object('key', 'enabled', 'column', 'enabled', 'op', 'eq')
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
    v_current := COALESCE(v_scope.value, '{"resources":[]}'::jsonb);
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(v_resources) AS value
     WHERE value->>'key' <> v_resource->>'key';

    v_current := jsonb_set(v_current, '{resources}', v_filtered || jsonb_build_array(v_resource), TRUE);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = v_scope.version + 1,
           change_reason = 'Expose Console V2 webhook_source_directory readback resource',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE sv.id = v_scope.settings_version_id
       AND sv.value IS DISTINCT FROM v_current;

    UPDATE public.settings s
       SET cached_value = v_current,
           last_updated = now()
     WHERE s.id = v_scope.settings_id
       AND s.cached_value IS DISTINCT FROM v_current;
  END LOOP;
END;
$read_registry$;

ALTER VIEW public.v_webhook_source_directory SET (security_invoker = true);

SELECT pg_advisory_unlock(hashtext('202605081430_console_v2_webhook_source_directory_readback_v1'));

COMMIT;
