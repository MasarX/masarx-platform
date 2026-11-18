BEGIN;
SELECT pg_advisory_lock(hashtext('202605051330_console_v2_branch_registry_scope_backfill_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_global_settings_version_id UUID;
  v_global_current JSONB;
  v_global_resources JSONB;
  v_setting RECORD;
  v_current JSONB;
  v_required_key TEXT;
  v_resource JSONB;
  v_required_keys TEXT[] := ARRAY[
    'branches',
    'branch_summary',
    'branch_zones',
    'branch_memberships',
    'branch_capacity_heatmap',
    'branch_coverage_windows',
    'zones',
    'route_runs',
    'vehicle_directory'
  ];
BEGIN
  SELECT s.settings_version_id,
         COALESCE(s.cached_value, '{"resources":[]}'::jsonb)
    INTO v_global_settings_version_id,
         v_global_current
    FROM public.settings s
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_global_settings_version_id IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_global_resources := COALESCE(v_global_current->'resources', '[]'::jsonb);

  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_global_resources) AS r(value)
     WHERE r.value->>'key' = 'vehicle_directory'
  ) THEN
    v_global_resources := v_global_resources || jsonb_build_array(
      '{
        "key":"vehicle_directory",
        "relation":"public.v_vehicle_directory",
        "id_column":"id",
        "capability_read":"fleet.read",
        "scope_columns":{"tenant":"organization_id"},
        "default_sort":{"column":"created_at","direction":"desc"},
        "filters":[
          {"key":"status","column":"status","op":"eq"},
          {"key":"plate_number","column":"plate_number","op":"ilike"},
          {"key":"branch_id","column":"branch_id","op":"eq"},
          {"key":"current_branch_id","column":"current_branch_id","op":"eq"}
        ]
      }'::jsonb
    );
  END IF;

  SELECT COALESCE(
           jsonb_agg(
             CASE
               WHEN value->>'key' = 'branch_zones' THEN
                 value - 'scope_columns'
               WHEN value->>'key' = 'vehicle_directory' THEN
                 jsonb_set(
                   value,
                   '{filters}',
                   '[
                     {"key":"status","column":"status","op":"eq"},
                     {"key":"plate_number","column":"plate_number","op":"ilike"},
                     {"key":"branch_id","column":"branch_id","op":"eq"},
                     {"key":"current_branch_id","column":"current_branch_id","op":"eq"}
                   ]'::jsonb,
                   true
                 )
               ELSE value
             END
           ),
           '[]'::jsonb
         )
    INTO v_global_resources
    FROM jsonb_array_elements(v_global_resources) AS value;

  SELECT jsonb_set(v_global_current, '{resources}', v_global_resources, true)
    INTO v_global_current;

  UPDATE public.settings_versions
     SET value = v_global_current,
         updated_at = now()
   WHERE id = v_global_settings_version_id;

  UPDATE public.settings
     SET cached_value = v_global_current,
         last_updated = now()
   WHERE settings_version_id = v_global_settings_version_id;

  FOR v_required_key IN SELECT unnest(v_required_keys) LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_global_resources) AS r(value)
       WHERE r.value->>'key' = v_required_key
    ) THEN
      RAISE EXCEPTION 'required branch lifecycle registry resource % missing from global registry', v_required_key;
    END IF;
  END LOOP;

  FOR v_setting IN
    SELECT s.id AS setting_id,
           s.settings_version_id,
           COALESCE(s.cached_value, '{"resources":[]}'::jsonb) AS cached_value
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
       AND NOT (s.scope_type = 'global' AND s.scope_id IS NULL)
  LOOP
    v_current := v_setting.cached_value;

    FOREACH v_required_key IN ARRAY v_required_keys LOOP
      SELECT value
        INTO v_resource
        FROM jsonb_array_elements(v_global_resources) AS value
       WHERE value->>'key' = v_required_key
       LIMIT 1;

      SELECT jsonb_set(
               v_current,
               '{resources}',
               COALESCE(jsonb_agg(value), '[]'::jsonb),
               true
             )
        INTO v_current
        FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS value
       WHERE value->>'key' <> v_required_key;

      v_current := jsonb_set(
        v_current,
        '{resources}',
        COALESCE(v_current->'resources', '[]'::jsonb) || jsonb_build_array(v_resource),
        true
      );
    END LOOP;

    UPDATE public.settings_versions
       SET value = v_current,
           updated_at = now()
     WHERE id = v_setting.settings_version_id;

    UPDATE public.settings
       SET cached_value = v_current,
           last_updated = now()
     WHERE id = v_setting.setting_id;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605051330_console_v2_branch_registry_scope_backfill_v1'));
COMMIT;
