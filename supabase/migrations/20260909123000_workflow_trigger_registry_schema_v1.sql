-- Optional edit_permission must be omitted rather than JSON null.
-- Read-only edit_mode and lifecycle-only mutation authority remain unchanged.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20260909123000_workflow_trigger_registry_schema_v1'));

DO $repair$
DECLARE
  v_setting RECORD;
  v_resources JSONB;
BEGIN
  FOR v_setting IN
    SELECT s.scope_type, s.scope_id, sv.value, sv.schema_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
      AND sv.value->'resources' @> '[{"key":"workflow_run_triggers"}]'::jsonb
  LOOP
    SELECT jsonb_agg(
      CASE WHEN r.value->>'key' = 'workflow_run_triggers'
        AND jsonb_typeof(r.value->'columns') = 'array' THEN
        jsonb_set(r.value, '{columns}', COALESCE((
          SELECT jsonb_agg(
            CASE WHEN c.value->>'edit_mode' = 'none'
              AND c.value->'edit_permission' = 'null'::jsonb
              THEN c.value - 'edit_permission' ELSE c.value END
            ORDER BY c.ordinality)
          FROM jsonb_array_elements(r.value->'columns') WITH ORDINALITY c(value, ordinality)
        ), '[]'::jsonb))
      ELSE r.value END ORDER BY r.ordinality
    ) INTO v_resources
    FROM jsonb_array_elements(v_setting.value->'resources') WITH ORDINALITY r(value, ordinality);

    IF v_resources IS DISTINCT FROM v_setting.value->'resources' THEN
      PERFORM public.upsert_settings_value_v1(
        'ui_read_registry', v_setting.scope_type, v_setting.scope_id,
        jsonb_set(v_setting.value, '{resources}', v_resources), v_setting.schema_version,
        'Omit invalid null edit permission on read-only workflow trigger columns'
      );
    END IF;
  END LOOP;
END;
$repair$;
COMMIT;
