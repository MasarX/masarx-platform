BEGIN;

DO $do$
DECLARE
  v_keys TEXT[] := ARRAY[
    'alert_rules',
    'alert_triggers',
    'ops_alerts',
    'alert_rule_directory'
  ];
  v_canonical_resources JSONB;
  v_row RECORD;
  v_filtered JSONB;
  v_next JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(resource.value ORDER BY resource.ordinality), '[]'::jsonb)
    INTO v_canonical_resources
    FROM public.settings global_registry
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(global_registry.cached_value->'resources', '[]'::jsonb))
      WITH ORDINALITY AS resource(value, ordinality)
   WHERE global_registry.category = 'ui_read_registry'
     AND global_registry.scope_type = 'global'
     AND global_registry.scope_id IS NULL
     AND resource.value->>'key' = ANY(v_keys);

  IF jsonb_array_length(v_canonical_resources) <> array_length(v_keys, 1) THEN
    RAISE EXCEPTION 'global ui_read_registry is missing one or more Console V2 alert resources';
  END IF;

  FOR v_row IN
    SELECT sv.id, sv.value
      FROM public.settings_versions sv
     WHERE sv.category = 'ui_read_registry'
       AND sv.scope_type <> 'global'
       AND sv.effective_until IS NULL
  LOOP
    SELECT COALESCE(jsonb_agg(resource.value ORDER BY resource.ordinality), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(COALESCE(v_row.value->'resources', '[]'::jsonb))
        WITH ORDINALITY AS resource(value, ordinality)
     WHERE NOT (resource.value->>'key' = ANY(v_keys));

    v_next := jsonb_set(
      COALESCE(v_row.value, '{"resources":[]}'::jsonb),
      '{resources}',
      v_filtered || v_canonical_resources,
      TRUE
    );

    UPDATE public.settings_versions
       SET value = v_next,
           updated_at = now(),
           change_reason = 'Backfill scoped Console V2 alert registry resources from global registry'
     WHERE id = v_row.id;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE settings_version_id = v_row.id;
  END LOOP;
END;
$do$;

COMMIT;
