-- Plan: PLAN-202603-shared-mapping-studio / Step: S04
-- Migration: Generic import reference metadata and row-level override materialization
--
-- Purpose:
--   - Enrich ui_read_registry_v1() with generic forward-reference import metadata
--     derived from live FK contracts instead of resource-specific UI code.
--   - Support row-specific import fixes in the authoritative prepare flow without
--     introducing a second execution path or resource-specific branches.

BEGIN;

SELECT pg_advisory_lock(hashtext('202603101100_tabular_import_reference_and_row_overrides_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_read_registry_enrich_reference_import_v1(
  p_value JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_current JSONB := COALESCE(p_value, '{}'::jsonb);
  v_resources JSONB := COALESCE(v_current->'resources', '[]'::jsonb);
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_columns JSONB;
  v_updated_columns JSONB;
  v_column JSONB;
  v_relation TEXT;
  v_relation_schema TEXT;
  v_relation_table TEXT;
  v_column_key TEXT;
  v_column_import JSONB;
  v_existing_reference JSONB;
  v_reference JSONB;
  v_ref_schema TEXT;
  v_ref_table TEXT;
  v_ref_column TEXT;
  v_target_resource JSONB;
  v_target_resource_key TEXT;
  v_target_id_column TEXT;
  v_target_scope_columns JSONB;
  v_display_columns JSONB;
  v_label_column TEXT;
BEGIN
  IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
    RETURN v_current;
  END IF;

  FOR v_resource IN
    SELECT value
    FROM jsonb_array_elements(v_resources) AS value
  LOOP
    v_relation := NULLIF(btrim(COALESCE(v_resource->>'relation', '')), '');
    v_relation_schema := split_part(COALESCE(v_relation, ''), '.', 1);
    v_relation_table := split_part(COALESCE(v_relation, ''), '.', 2);
    IF NULLIF(btrim(COALESCE(v_relation_table, '')), '') IS NULL THEN
      v_relation_table := v_relation_schema;
      v_relation_schema := 'public';
    END IF;

    v_columns := COALESCE(v_resource->'columns', '[]'::jsonb);
    IF jsonb_typeof(v_columns) IS DISTINCT FROM 'array' OR v_relation IS NULL THEN
      v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
      CONTINUE;
    END IF;

    v_updated_columns := '[]'::jsonb;

    FOR v_column IN
      SELECT value
      FROM jsonb_array_elements(v_columns) AS value
    LOOP
      v_column_key := NULLIF(btrim(COALESCE(v_column->>'key', '')), '');
      IF v_column_key IS NULL THEN
        v_updated_columns := v_updated_columns || jsonb_build_array(v_column);
        CONTINUE;
      END IF;

      v_ref_schema := NULL;
      v_ref_table := NULL;
      v_ref_column := NULL;

      SELECT ref_ns.nspname,
             ref_cls.relname,
             ref_att.attname
        INTO v_ref_schema,
             v_ref_table,
             v_ref_column
        FROM pg_constraint con
        JOIN pg_class src_cls
          ON src_cls.oid = con.conrelid
        JOIN pg_namespace src_ns
          ON src_ns.oid = src_cls.relnamespace
        JOIN pg_class ref_cls
          ON ref_cls.oid = con.confrelid
        JOIN pg_namespace ref_ns
          ON ref_ns.oid = ref_cls.relnamespace
        JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS src_key(attnum, ordinality)
          ON TRUE
        JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS ref_key(attnum, ordinality)
          ON ref_key.ordinality = src_key.ordinality
        JOIN pg_attribute src_att
          ON src_att.attrelid = src_cls.oid
         AND src_att.attnum = src_key.attnum
        JOIN pg_attribute ref_att
          ON ref_att.attrelid = ref_cls.oid
         AND ref_att.attnum = ref_key.attnum
       WHERE con.contype = 'f'
         AND src_ns.nspname = v_relation_schema
         AND src_cls.relname = v_relation_table
         AND array_length(con.conkey, 1) = 1
         AND src_att.attname = v_column_key
       LIMIT 1;

      IF v_ref_table IS NULL THEN
        v_updated_columns := v_updated_columns || jsonb_build_array(v_column);
        CONTINUE;
      END IF;

      SELECT value
        INTO v_target_resource
        FROM jsonb_array_elements(v_resources) AS value
       WHERE COALESCE(value->>'relation', '') = format('%s.%s', v_ref_schema, v_ref_table)
       LIMIT 1;

      v_target_resource_key := NULLIF(btrim(COALESCE(v_target_resource->>'key', '')), '');
      IF v_target_resource_key IS NULL THEN
        v_updated_columns := v_updated_columns || jsonb_build_array(v_column);
        CONTINUE;
      END IF;

      v_target_id_column := COALESCE(
        NULLIF(btrim(COALESCE(v_ref_column, '')), ''),
        NULLIF(btrim(COALESCE(v_target_resource->>'id_column', '')), ''),
        'id'
      );
      v_target_scope_columns := COALESCE(v_target_resource->'scope_columns', '{}'::jsonb);

      SELECT COALESCE(jsonb_agg(to_jsonb(display_key) ORDER BY sort_order), '[]'::jsonb)
        INTO v_display_columns
        FROM (
          SELECT display_key, min(sort_order) AS sort_order
          FROM (
            SELECT NULLIF(btrim(value), '') AS display_key, ordinality AS sort_order
            FROM jsonb_array_elements_text(COALESCE(v_target_resource->'select', '[]'::jsonb)) WITH ORDINALITY AS select_columns(value, ordinality)
            UNION ALL
            SELECT NULLIF(btrim(COALESCE(column_value.value->>'key', '')), '') AS display_key, 1000 + ordinality AS sort_order
            FROM jsonb_array_elements(COALESCE(v_target_resource->'columns', '[]'::jsonb)) WITH ORDINALITY AS column_value(value, ordinality)
          ) candidates
          WHERE display_key IS NOT NULL
            AND display_key <> v_target_id_column
            AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_scope_columns->>'tenant', '')), ''), '__none__')
            AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_scope_columns->>'client', '')), ''), '__none__')
            AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_scope_columns->>'sender', '')), ''), '__none__')
            AND display_key NOT IN ('created_at', 'updated_at')
          GROUP BY display_key
          ORDER BY min(sort_order)
          LIMIT 3
        ) ranked;

      SELECT ranked.display_key
        INTO v_label_column
        FROM (
          SELECT display_key, min(sort_order) AS sort_order
          FROM (
            SELECT NULLIF(btrim(value), '') AS display_key, ordinality AS sort_order
            FROM jsonb_array_elements_text(COALESCE(v_target_resource->'select', '[]'::jsonb)) WITH ORDINALITY AS select_columns(value, ordinality)
            UNION ALL
            SELECT NULLIF(btrim(COALESCE(column_value.value->>'key', '')), '') AS display_key, 1000 + ordinality AS sort_order
            FROM jsonb_array_elements(COALESCE(v_target_resource->'columns', '[]'::jsonb)) WITH ORDINALITY AS column_value(value, ordinality)
          ) candidates
          WHERE display_key IS NOT NULL
            AND display_key <> v_target_id_column
            AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_scope_columns->>'tenant', '')), ''), '__none__')
            AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_scope_columns->>'client', '')), ''), '__none__')
            AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_scope_columns->>'sender', '')), ''), '__none__')
            AND display_key NOT IN ('created_at', 'updated_at')
          GROUP BY display_key
          ORDER BY min(sort_order)
          LIMIT 1
        ) ranked;

      v_column_import := COALESCE(v_column->'import', '{}'::jsonb);
      IF jsonb_typeof(v_column_import) IS DISTINCT FROM 'object' THEN
        v_column_import := '{}'::jsonb;
      END IF;

      v_existing_reference := COALESCE(v_column_import->'reference', '{}'::jsonb);
      IF jsonb_typeof(v_existing_reference) IS DISTINCT FROM 'object' THEN
        v_existing_reference := '{}'::jsonb;
      END IF;

      v_reference := jsonb_strip_nulls(
        jsonb_build_object(
          'resource', v_target_resource_key,
          'relation', format('%s.%s', v_ref_schema, v_ref_table),
          'id_column', v_target_id_column,
          'label', NULLIF(btrim(COALESCE(v_target_resource->>'label', '')), ''),
          'label_column', NULLIF(btrim(COALESCE(v_label_column, '')), ''),
          'display_columns', CASE
            WHEN jsonb_typeof(v_display_columns) = 'array' AND jsonb_array_length(v_display_columns) > 0
              THEN v_display_columns
            ELSE NULL
          END
        )
      ) || v_existing_reference;

      v_column_import := jsonb_set(v_column_import, '{reference}', v_reference, TRUE);

      v_updated_columns := v_updated_columns || jsonb_build_array(
        jsonb_set(v_column, '{import}', v_column_import, TRUE)
      );
    END LOOP;

    v_updated_resources := v_updated_resources || jsonb_build_array(
      jsonb_set(v_resource, '{columns}', v_updated_columns, TRUE)
    );
  END LOOP;

  RETURN jsonb_set(v_current, '{resources}', COALESCE(v_updated_resources, '[]'::jsonb), TRUE);
END;
$function$;

COMMENT ON FUNCTION public.ui_read_registry_enrich_reference_import_v1(JSONB)
  IS 'Enrich ui_read_registry import metadata with generic FK-backed reference resources and picker display hints.';

CREATE OR REPLACE FUNCTION public.tabular_import_materialize_row_overrides_v1(
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_rules JSONB := COALESCE(v_payload->'rules', '[]'::jsonb);
  v_headers JSONB := COALESCE(v_payload->'headers', '[]'::jsonb);
  v_rows JSONB := COALESCE(v_payload->'rows', '[]'::jsonb);
  v_row_overrides JSONB := COALESCE(v_payload->'row_overrides', '{}'::jsonb);
  v_materialized_rules JSONB := '[]'::jsonb;
  v_materialized_headers JSONB := COALESCE(v_headers, '[]'::jsonb);
  v_materialized_rows JSONB := '[]'::jsonb;
  v_override_targets JSONB := '[]'::jsonb;
  v_original_rule_map JSONB := '{}'::jsonb;
  v_seen_targets TEXT[] := ARRAY[]::TEXT[];
  v_rule JSONB;
  v_row_record RECORD;
  v_override_target TEXT;
  v_target_field TEXT;
  v_synthetic_header TEXT;
  v_current_row JSONB;
  v_current_override JSONB;
  v_base_rule JSONB;
  v_base_value JSONB;
BEGIN
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    RETURN COALESCE(p_payload, '{}'::jsonb);
  END IF;
  IF jsonb_typeof(v_rules) IS DISTINCT FROM 'array' THEN
    RETURN v_payload;
  END IF;
  IF jsonb_typeof(v_headers) IS DISTINCT FROM 'array' THEN
    v_materialized_headers := '[]'::jsonb;
  END IF;
  IF jsonb_typeof(v_rows) IS DISTINCT FROM 'array' THEN
    v_rows := '[]'::jsonb;
  END IF;
  IF jsonb_typeof(v_row_overrides) IS DISTINCT FROM 'object' OR v_row_overrides = '{}'::jsonb THEN
    RETURN v_payload;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(target_field) ORDER BY target_field), '[]'::jsonb)
    INTO v_override_targets
    FROM (
      SELECT DISTINCT NULLIF(btrim(field_entry.key), '') AS target_field
      FROM jsonb_each(v_row_overrides) AS row_entry(row_key, row_value)
      CROSS JOIN LATERAL jsonb_each(
        CASE
          WHEN jsonb_typeof(row_entry.row_value) = 'object' THEN row_entry.row_value
          ELSE '{}'::jsonb
        END
      ) AS field_entry(key, value)
      WHERE NULLIF(btrim(field_entry.key), '') IS NOT NULL
    ) AS targets;

  IF jsonb_typeof(v_override_targets) IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_override_targets) = 0 THEN
    RETURN v_payload;
  END IF;

  FOR v_rule IN
    SELECT value
    FROM jsonb_array_elements(v_rules) AS value
  LOOP
    v_target_field := NULLIF(btrim(COALESCE(v_rule->>'target_field', '')), '');
    IF v_target_field IS NOT NULL THEN
      v_original_rule_map := v_original_rule_map || jsonb_build_object(v_target_field, v_rule);
    END IF;
  END LOOP;

  FOR v_rule IN
    SELECT value
    FROM jsonb_array_elements(v_rules) AS value
  LOOP
    v_target_field := NULLIF(btrim(COALESCE(v_rule->>'target_field', '')), '');
    IF v_target_field IS NULL THEN
      v_materialized_rules := v_materialized_rules || jsonb_build_array(v_rule);
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_override_targets) AS target_value
      WHERE target_value = v_target_field
    ) THEN
      IF v_target_field = ANY(v_seen_targets) THEN
        CONTINUE;
      END IF;

      v_synthetic_header := format('__row_override__%s', public.tabular_import_slug_v1(v_target_field));
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(v_materialized_headers) AS header_value
        WHERE header_value = v_synthetic_header
      ) THEN
        v_materialized_headers := v_materialized_headers || to_jsonb(v_synthetic_header);
      END IF;

      v_materialized_rules := v_materialized_rules || jsonb_build_array(
        jsonb_strip_nulls(
          (v_rule - 'fixed_value') || jsonb_build_object(
            'source_column', v_synthetic_header,
            'value_mode', 'source',
            'source', 'row_override'
          )
        )
      );
      v_seen_targets := array_append(v_seen_targets, v_target_field);
    ELSE
      v_materialized_rules := v_materialized_rules || jsonb_build_array(v_rule);
    END IF;
  END LOOP;

  FOR v_override_target IN
    SELECT value
    FROM jsonb_array_elements_text(v_override_targets) AS value
  LOOP
    IF v_override_target = ANY(v_seen_targets) THEN
      CONTINUE;
    END IF;

    v_synthetic_header := format('__row_override__%s', public.tabular_import_slug_v1(v_override_target));
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_materialized_headers) AS header_value
      WHERE header_value = v_synthetic_header
    ) THEN
      v_materialized_headers := v_materialized_headers || to_jsonb(v_synthetic_header);
    END IF;

    v_materialized_rules := v_materialized_rules || jsonb_build_array(
      jsonb_build_object(
        'target_field', v_override_target,
        'source_column', v_synthetic_header,
        'value_mode', 'source',
        'source', 'row_override',
        'enabled', TRUE
      )
    );
  END LOOP;

  FOR v_row_record IN
    SELECT value, ordinality
    FROM jsonb_array_elements(v_rows) WITH ORDINALITY AS rows(value, ordinality)
  LOOP
    v_current_row := v_row_record.value;
    IF jsonb_typeof(v_current_row) IS DISTINCT FROM 'object' THEN
      v_materialized_rows := v_materialized_rows || jsonb_build_array(v_current_row);
      CONTINUE;
    END IF;

    v_current_override := COALESCE(v_row_overrides->(v_row_record.ordinality::text), '{}'::jsonb);
    IF jsonb_typeof(v_current_override) IS DISTINCT FROM 'object' THEN
      v_current_override := '{}'::jsonb;
    END IF;

    FOR v_override_target IN
      SELECT value
      FROM jsonb_array_elements_text(v_override_targets) AS value
    LOOP
      v_synthetic_header := format('__row_override__%s', public.tabular_import_slug_v1(v_override_target));
      v_base_rule := COALESCE(v_original_rule_map->v_override_target, '{}'::jsonb);

      IF v_current_override ? v_override_target THEN
        v_base_value := v_current_override->v_override_target;
      ELSIF jsonb_typeof(v_base_rule) = 'object'
            AND NULLIF(btrim(COALESCE(v_base_rule->>'source_column', '')), '') IS NOT NULL THEN
        v_base_value := v_current_row -> (v_base_rule->>'source_column');
      ELSIF jsonb_typeof(v_base_rule) = 'object' AND v_base_rule ? 'fixed_value' THEN
        v_base_value := v_base_rule->'fixed_value';
      ELSE
        v_base_value := 'null'::jsonb;
      END IF;

      v_current_row := jsonb_set(
        v_current_row,
        ARRAY[v_synthetic_header],
        COALESCE(v_base_value, 'null'::jsonb),
        TRUE
      );
    END LOOP;

    v_materialized_rows := v_materialized_rows || jsonb_build_array(v_current_row);
  END LOOP;

  RETURN jsonb_set(
    jsonb_set(
      jsonb_set(v_payload, '{rules}', v_materialized_rules, TRUE),
      '{headers}',
      v_materialized_headers,
      TRUE
    ),
    '{rows}',
    v_materialized_rows,
    TRUE
  );
END;
$function$;

COMMENT ON FUNCTION public.tabular_import_materialize_row_overrides_v1(JSONB) IS
  'Materialize per-row target-field overrides into synthetic source columns so the canonical prepare flow can validate them without resource-specific branches.';

CREATE OR REPLACE FUNCTION public.ui_read_registry_v1()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB;
BEGIN
  v_registry := public.resolve_settings_merged('ui_read_registry', v_scope_type, v_scope_id);
  RETURN public.ui_read_registry_enrich_reference_import_v1(
    public.ui_read_registry_enrich_lookup_import_v1(v_registry)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.tabular_import_prepare_v1(
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_original_headers JSONB := COALESCE(v_payload->'headers', '[]'::jsonb);
  v_candidate_rules JSONB := COALESCE(v_payload->'rules', '[]'::jsonb);
  v_selected_rules JSONB := '[]'::jsonb;
  v_profile_match JSONB := NULL;
  v_rule_source TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_payload->>'rule_source', '')), ''), 'auto'));
  v_effective_rule_source TEXT := CASE WHEN v_rule_source = 'manual' THEN 'manual' ELSE 'auto' END;
  v_resource_key TEXT := NULLIF(btrim(COALESCE(v_payload->>'resource_key', '')), '');
  v_header_fingerprint TEXT := NULLIF(btrim(COALESCE(v_payload->>'header_fingerprint', '')), '');
  v_result JSONB;
  v_run_id UUID;
  v_row_override_count INT := 0;
BEGIN
  IF jsonb_typeof(v_candidate_rules) = 'array' AND jsonb_array_length(v_candidate_rules) > 0 THEN
    v_selected_rules := v_candidate_rules;
  END IF;

  IF v_rule_source <> 'manual' AND v_resource_key IS NOT NULL THEN
    IF v_header_fingerprint IS NULL THEN
      SELECT string_agg(normalized_header, '|' ORDER BY normalized_header)
        INTO v_header_fingerprint
        FROM (
          SELECT regexp_replace(lower(btrim(value)), '[^a-z0-9]+', '_', 'g') AS normalized_header
          FROM jsonb_array_elements_text(COALESCE(v_original_headers, '[]'::jsonb)) AS value
          WHERE NULLIF(btrim(value), '') IS NOT NULL
        ) normalized;
    END IF;

    SELECT value
      INTO v_profile_match
      FROM (
        SELECT jsonb_build_object(
          'id', profile.id,
          'profile_name', profile.profile_name,
          'profile_slug', profile.profile_slug,
          'header_fingerprint', profile.header_fingerprint,
          'sheet_hint', profile.sheet_hint,
          'write_mode', profile.write_mode,
          'mapping_key', profile.mapping_key,
          'mapping_config', profile.mapping_config,
          'created_at', profile.created_at,
          'updated_at', profile.updated_at
        ) AS value
        FROM public.ui_tabular_import_profiles_v1(v_resource_key) AS profile
      ) profiles
     WHERE COALESCE(value->>'header_fingerprint', '') = COALESCE(v_header_fingerprint, '')
     ORDER BY COALESCE(value->>'updated_at', value->>'created_at', '') DESC
     LIMIT 1;

    IF v_profile_match IS NOT NULL
       AND jsonb_typeof(v_profile_match#>'{mapping_config,field_rules}') = 'array'
       AND jsonb_array_length(v_profile_match#>'{mapping_config,field_rules}') > 0 THEN
      v_selected_rules := COALESCE(v_profile_match#>'{mapping_config,field_rules}', '[]'::jsonb);
      v_effective_rule_source := 'profile';
    END IF;
  END IF;

  IF jsonb_typeof(v_selected_rules) IS DISTINCT FROM 'array' THEN
    v_selected_rules := '[]'::jsonb;
  END IF;

  IF jsonb_typeof(v_payload->'row_overrides') = 'object' THEN
    SELECT count(*)
      INTO v_row_override_count
      FROM jsonb_each(v_payload->'row_overrides') AS row_entry(row_key, row_value)
      CROSS JOIN LATERAL jsonb_each(
        CASE
          WHEN jsonb_typeof(row_entry.row_value) = 'object' THEN row_entry.row_value
          ELSE '{}'::jsonb
        END
      ) AS field_entry(key, value);
  END IF;

  v_payload := jsonb_set(v_payload, '{rules}', v_selected_rules, TRUE);
  IF v_header_fingerprint IS NOT NULL THEN
    v_payload := jsonb_set(v_payload, '{header_fingerprint}', to_jsonb(v_header_fingerprint), TRUE);
  END IF;

  v_result := public.tabular_import_prepare_base_v1(
    public.tabular_import_materialize_row_overrides_v1(
      public.tabular_import_materialize_fixed_rules_v1(v_payload)
    )
  );

  v_run_id := public.mapping_studio_try_uuid_v1(v_result->>'run_id');
  IF v_run_id IS NOT NULL THEN
    UPDATE public.tabular_import_runs
       SET summary = jsonb_strip_nulls(
             COALESCE(summary, '{}'::jsonb) || jsonb_build_object(
               'headers', COALESCE(v_original_headers, '[]'::jsonb),
               'resolved_rules', COALESCE(v_selected_rules, '[]'::jsonb),
               'rule_source', v_effective_rule_source,
               'row_override_count', v_row_override_count
             )
           ),
           updated_at = now()
     WHERE id = v_run_id;
  END IF;

  IF jsonb_typeof(v_result) = 'object' THEN
    v_result := jsonb_set(v_result, '{resolved_rules}', COALESCE(v_selected_rules, '[]'::jsonb), TRUE);
  END IF;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.tabular_import_prepare_v1(JSONB) IS
  'Prepare a tabular import run and support shared fixed values plus row-specific overrides inside the canonical dry-run path.';

REVOKE ALL ON FUNCTION public.ui_read_registry_enrich_reference_import_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_read_registry_enrich_reference_import_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.tabular_import_materialize_row_overrides_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_materialize_row_overrides_v1(JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.ui_read_registry_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_read_registry_v1() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.tabular_import_prepare_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_prepare_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603101100_tabular_import_reference_and_row_overrides_v1'));

COMMIT;
