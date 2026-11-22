-- Keep log totals scoped to rows visible to the caller.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('20261122044002_ui_registry_log_total_strategy_v1'));

DO $exact$
DECLARE
  current_registry RECORD;
  next_value JSONB;
BEGIN
  FOR current_registry IN
    SELECT s.scope_type, s.scope_id, sv.value, sv.schema_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
    WHERE s.category = 'ui_read_registry' AND s.scope_type = public.get_root_scope_type_key_v1()
      AND s.scope_id IS NULL
    FOR UPDATE OF s
  LOOP
    SELECT jsonb_set(current_registry.value, '{resources}', COALESCE(jsonb_agg(
      CASE WHEN entry.value->>'key' IN ('decision_log', 'settings_resolution_log', 'webhook_inbox')
        THEN entry.value || '{"total_strategy":"exact"}'::jsonb
        ELSE entry.value END ORDER BY entry.ordinal
    ), '[]'::jsonb))
    INTO next_value
    FROM jsonb_array_elements(current_registry.value->'resources') WITH ORDINALITY AS entry(value, ordinal);
    IF next_value IS DISTINCT FROM current_registry.value THEN
      PERFORM public.upsert_settings_value_v1('ui_read_registry', current_registry.scope_type,
        current_registry.scope_id, next_value, current_registry.schema_version,
        'Use scoped exact totals for log resources');
    END IF;
  END LOOP;
END;
$exact$;

DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%';
COMMIT;
