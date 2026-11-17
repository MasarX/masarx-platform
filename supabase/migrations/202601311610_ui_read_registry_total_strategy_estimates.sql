-- Migration: Configure ui_read_registry totals strategy to estimate totals for high-volume resources (avoids statement timeouts)
BEGIN;
SELECT pg_advisory_lock(hashtext('202601311610_ui_read_registry_total_strategy_estimates'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_item JSONB;
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

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) LOOP
    IF (v_item->>'key') IN ('audit_table_changes', 'webhook_log', 'api_call_log') THEN
      v_item := jsonb_set(v_item, '{total_strategy}', to_jsonb('estimate'::text), true);
    END IF;
    v_resources := v_resources || jsonb_build_array(v_item);
  END LOOP;

  v_current := jsonb_set(v_current, '{resources}', v_resources, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
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
           change_reason = 'Tune ui_read_registry totals strategy for high-volume resources',
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

SELECT pg_advisory_unlock(hashtext('202601311610_ui_read_registry_total_strategy_estimates'));
COMMIT;

