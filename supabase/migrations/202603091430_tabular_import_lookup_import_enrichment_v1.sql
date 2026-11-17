-- Plan: PLAN-202603-shared-mapping-studio / Step: S06
-- Migration: Dynamically enrich import contracts with live lookup metadata
--
-- Purpose:
--   - Keep universal import fully row-driven for lookup-backed destination columns.
--   - Expose canonical lookup options through ui_read_registry_v1() so the browser
--     and authoritative dry-run share the same import metadata.
--   - Allow label-style source values (for example "Out for delivery") to coerce
--     into canonical lookup values (for example "out_for_delivery") without
--     hardcoding shipment-specific behavior.

BEGIN;

SELECT pg_advisory_lock(hashtext('202603091430_tabular_import_lookup_import_enrichment_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_read_registry_enrich_lookup_import_v1(
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
  v_existing_lookup JSONB;
  v_lookup_category TEXT;
  v_allow_inactive BOOLEAN;
  v_allowed_values TEXT[];
  v_lookup_options JSONB;
  v_lookup_enum_values JSONB;
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

      SELECT contract.lookup_category,
             contract.allow_inactive,
             contract.allowed_values
        INTO v_lookup_category,
             v_allow_inactive,
             v_allowed_values
        FROM public.lookup_column_contracts AS contract
       WHERE contract.table_schema = v_relation_schema
         AND contract.table_name = v_relation_table
         AND contract.column_name = v_column_key
       LIMIT 1;

      IF v_lookup_category IS NULL THEN
        v_updated_columns := v_updated_columns || jsonb_build_array(v_column);
        CONTINUE;
      END IF;

      SELECT COALESCE(
               jsonb_agg(
                 jsonb_strip_nulls(
                   jsonb_build_object(
                     'value', lv.value,
                     'label', COALESCE(NULLIF(btrim(lv.label), ''), lv.value),
                     'aliases',
                       CASE
                         WHEN COALESCE(NULLIF(btrim(lv.label), ''), lv.value) <> lv.value
                           THEN jsonb_build_array(COALESCE(NULLIF(btrim(lv.label), ''), lv.value))
                         ELSE NULL
                       END
                   )
                 )
                 ORDER BY lv.sort_order NULLS LAST, COALESCE(NULLIF(btrim(lv.label), ''), lv.value), lv.value
               ),
               '[]'::jsonb
             ),
             COALESCE(
               jsonb_agg(
                 to_jsonb(lv.value)
                 ORDER BY lv.sort_order NULLS LAST, COALESCE(NULLIF(btrim(lv.label), ''), lv.value), lv.value
               ),
               '[]'::jsonb
             )
        INTO v_lookup_options,
             v_lookup_enum_values
        FROM public.lookup_values AS lv
        JOIN public.lookup_definitions AS ld
          ON ld.id = lv.lookup_definition_id
       WHERE ld.category = v_lookup_category
         AND (v_allow_inactive IS TRUE OR lv.status = 'active')
         AND (
           v_allowed_values IS NULL
           OR array_length(v_allowed_values, 1) IS NULL
           OR lv.value = ANY(v_allowed_values)
         );

      v_column_import := COALESCE(v_column->'import', '{}'::jsonb);
      IF jsonb_typeof(v_column_import) IS DISTINCT FROM 'object' THEN
        v_column_import := '{}'::jsonb;
      END IF;

      v_existing_lookup := COALESCE(v_column_import->'lookup', '{}'::jsonb);
      IF jsonb_typeof(v_existing_lookup) IS DISTINCT FROM 'object' THEN
        v_existing_lookup := '{}'::jsonb;
      END IF;

      v_existing_lookup := v_existing_lookup || jsonb_strip_nulls(
        jsonb_build_object(
          'relation', 'public.lookup_values',
          'key_column', 'value',
          'label_column', 'label',
          'category', v_lookup_category,
          'allowed_values', CASE
            WHEN v_allowed_values IS NULL OR array_length(v_allowed_values, 1) IS NULL THEN NULL
            ELSE to_jsonb(v_allowed_values)
          END,
          'options', CASE
            WHEN jsonb_typeof(v_lookup_options) = 'array' AND jsonb_array_length(v_lookup_options) > 0
              THEN v_lookup_options
            ELSE NULL
          END
        )
      );

      v_column_import := jsonb_set(v_column_import, '{lookup}', v_existing_lookup, TRUE);

      IF jsonb_typeof(v_column_import->'enum_values') = 'array'
         AND jsonb_array_length(v_column_import->'enum_values') > 0 THEN
        NULL;
      ELSE
        v_column_import := jsonb_set(v_column_import, '{enum_values}', COALESCE(v_lookup_enum_values, '[]'::jsonb), TRUE);
      END IF;

      v_updated_columns := v_updated_columns || jsonb_build_array(
        jsonb_set(v_column, '{import}', v_column_import, TRUE)
      );

      v_lookup_category := NULL;
      v_allow_inactive := FALSE;
      v_allowed_values := NULL;
      v_lookup_options := '[]'::jsonb;
      v_lookup_enum_values := '[]'::jsonb;
    END LOOP;

    v_updated_resources := v_updated_resources || jsonb_build_array(
      jsonb_set(v_resource, '{columns}', v_updated_columns, TRUE)
    );
  END LOOP;

  RETURN jsonb_set(v_current, '{resources}', COALESCE(v_updated_resources, '[]'::jsonb), TRUE);
END;
$function$;

COMMENT ON FUNCTION public.ui_read_registry_enrich_lookup_import_v1(JSONB)
  IS 'Enrich ui_read_registry import metadata with live lookup contracts and allowed values.';

CREATE OR REPLACE FUNCTION public.tabular_import_coerce_value_v1(
  p_value JSONB,
  p_column JSONB,
  p_source_column TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_value JSONB := COALESCE(p_value, 'null'::jsonb);
  v_prepared_value JSONB := v_value;
  v_column JSONB := COALESCE(p_column, '{}'::jsonb);
  v_import JSONB := COALESCE(v_column->'import', '{}'::jsonb);
  v_lookup JSONB := COALESCE(v_import->'lookup', '{}'::jsonb);
  v_lookup_options JSONB := COALESCE(v_lookup->'options', '[]'::jsonb);
  v_has_lookup_options BOOLEAN := jsonb_typeof(v_lookup_options) = 'array' AND jsonb_array_length(v_lookup_options) > 0;
  v_target_type TEXT := public.tabular_import_resolve_column_type_v1(v_column);
  v_original_type TEXT := COALESCE(jsonb_typeof(v_value), 'null');
  v_source_path TEXT := format('column:%s', COALESCE(NULLIF(p_source_column, ''), 'source'));
  v_text TEXT := NULL;
  v_trimmed TEXT := NULL;
  v_required BOOLEAN := FALSE;
  v_numeric NUMERIC;
  v_bigint BIGINT;
  v_bool BOOLEAN;
  v_enum_value TEXT;
  v_lookup_value TEXT;
  v_date DATE;
  v_timestamp TIMESTAMPTZ;
  v_result JSONB := jsonb_build_object('value', v_prepared_value);
  v_diagnostics JSONB := '[]'::jsonb;
  v_trim_coercion JSONB := NULL;
BEGIN
  BEGIN
    v_required := COALESCE(NULLIF(v_import->>'required', '')::boolean, FALSE);
  EXCEPTION
    WHEN OTHERS THEN
      v_required := FALSE;
  END;

  IF v_original_type = 'null' THEN
    RETURN v_result;
  END IF;

  IF v_original_type = 'string' THEN
    v_text := v_value #>> '{}';
    v_trimmed := btrim(COALESCE(v_text, ''));

    IF v_trimmed = '' AND NOT v_required THEN
      RETURN jsonb_build_object(
        'value', 'null'::jsonb,
        'coercion', jsonb_build_object(
          'target_field', v_column->>'key',
          'source_path', v_source_path,
          'original_type', v_original_type,
          'original_value', v_value,
          'converted_type', 'null',
          'converted_value', 'null'::jsonb,
          'reason', 'Blank text normalized to null for an optional field.',
          'can_override', TRUE
        )
      );
    END IF;

    IF v_trimmed IS DISTINCT FROM COALESCE(v_text, '') THEN
      v_prepared_value := to_jsonb(v_trimmed);
      v_trim_coercion := jsonb_build_object(
        'target_field', v_column->>'key',
        'source_path', v_source_path,
        'original_type', v_original_type,
        'original_value', v_value,
        'converted_type', 'string',
        'converted_value', to_jsonb(v_trimmed),
        'reason', 'Trimmed surrounding whitespace to match the target field format.',
        'can_override', TRUE
      );
    END IF;

    IF v_has_lookup_options THEN
      SELECT option->>'value'
        INTO v_lookup_value
        FROM jsonb_array_elements(v_lookup_options) AS option
       WHERE public.tabular_import_slug_v1(COALESCE(option->>'value', '')) = public.tabular_import_slug_v1(v_trimmed)
          OR public.tabular_import_slug_v1(COALESCE(option->>'label', '')) = public.tabular_import_slug_v1(v_trimmed)
          OR EXISTS (
               SELECT 1
                 FROM jsonb_array_elements_text(
                        CASE
                          WHEN jsonb_typeof(option->'aliases') = 'array' THEN option->'aliases'
                          ELSE '[]'::jsonb
                        END
                      ) AS alias_value
                WHERE public.tabular_import_slug_v1(alias_value) = public.tabular_import_slug_v1(v_trimmed)
             )
       LIMIT 1;

      IF v_lookup_value IS NOT NULL THEN
        v_prepared_value := to_jsonb(v_lookup_value);
        IF v_lookup_value <> v_trimmed THEN
          RETURN jsonb_build_object(
            'value', to_jsonb(v_lookup_value),
            'coercion', jsonb_build_object(
              'target_field', v_column->>'key',
              'source_path', v_source_path,
              'original_type', v_original_type,
              'original_value', v_value,
              'converted_type', 'string',
              'converted_value', to_jsonb(v_lookup_value),
              'reason', 'Matched the input to a configured lookup value.',
              'can_override', TRUE
            )
          );
        END IF;
      ELSE
        v_diagnostics := v_diagnostics || jsonb_build_array(
          jsonb_build_object(
            'level', 'error',
            'blocking', TRUE,
            'code', 'lookup_value_invalid',
            'fieldPath', v_column->>'key',
            'message', format(
              '%s must match one of the configured lookup values.',
              COALESCE(NULLIF(v_column->>'label', ''), v_column->>'key')
            ),
            'why', format(
              'The source value "%s" does not match the configured lookup values for this field.',
              COALESCE(v_trimmed, '')
            ),
            'recommended_fix', format(
              'Use one of: %s.',
              COALESCE(
                (
                  SELECT string_agg(
                           CASE
                             WHEN COALESCE(NULLIF(option->>'label', ''), option->>'value') = option->>'value'
                               THEN option->>'value'
                             ELSE format('%s (%s)', COALESCE(NULLIF(option->>'label', ''), option->>'value'), option->>'value')
                           END,
                           ', '
                           ORDER BY COALESCE(NULLIF(option->>'label', ''), option->>'value'), option->>'value'
                         )
                    FROM jsonb_array_elements(v_lookup_options) AS option
                ),
                'the configured lookup values'
              )
            )
          )
        );
      END IF;
    ELSIF jsonb_typeof(v_import->'enum_values') = 'array' THEN
      SELECT enum_value
        INTO v_enum_value
        FROM (
          SELECT jsonb_array_elements_text(v_import->'enum_values') AS enum_value
        ) valueset
       WHERE public.tabular_import_slug_v1(enum_value) = public.tabular_import_slug_v1(v_trimmed)
       LIMIT 1;

      IF v_enum_value IS NOT NULL AND v_enum_value <> v_trimmed THEN
        RETURN jsonb_build_object(
          'value', to_jsonb(v_enum_value),
          'coercion', jsonb_build_object(
            'target_field', v_column->>'key',
            'source_path', v_source_path,
            'original_type', v_original_type,
            'original_value', v_value,
            'converted_type', 'string',
            'converted_value', to_jsonb(v_enum_value),
            'reason', 'Matched the input to a configured enum value.',
            'can_override', TRUE
          )
        );
      ELSIF v_enum_value IS NULL THEN
        v_diagnostics := v_diagnostics || jsonb_build_array(
          jsonb_build_object(
            'level', 'error',
            'blocking', TRUE,
            'code', 'enum_value_invalid',
            'fieldPath', v_column->>'key',
            'message', format(
              '%s must match one of the configured values.',
              COALESCE(NULLIF(v_column->>'label', ''), v_column->>'key')
            ),
            'why', format(
              'The source value "%s" does not match the configured import values for this field.',
              COALESCE(v_trimmed, '')
            ),
            'recommended_fix', format(
              'Use one of: %s.',
              COALESCE(
                (
                  SELECT string_agg(enum_value, ', ' ORDER BY enum_value)
                    FROM jsonb_array_elements_text(v_import->'enum_values') AS enum_value
                ),
                'the configured allowed values'
              )
            )
          )
        );
      END IF;
    END IF;

    IF v_target_type IN ('integer', 'number') THEN
      BEGIN
        v_numeric := replace(v_trimmed, ',', '')::numeric;
        IF v_target_type = 'integer' THEN
          v_bigint := v_numeric::bigint;
          IF v_numeric = v_bigint THEN
            RETURN jsonb_build_object(
              'value', to_jsonb(v_bigint),
              'coercion', jsonb_build_object(
                'target_field', v_column->>'key',
                'source_path', v_source_path,
                'original_type', v_original_type,
                'original_value', v_value,
                'converted_type', 'integer',
                'converted_value', to_jsonb(v_bigint),
                'reason', 'String value converted to an integer to match the target column type.',
                'can_override', TRUE
              )
            );
          END IF;
        ELSE
          RETURN jsonb_build_object(
            'value', to_jsonb(v_numeric),
            'coercion', jsonb_build_object(
              'target_field', v_column->>'key',
              'source_path', v_source_path,
              'original_type', v_original_type,
              'original_value', v_value,
              'converted_type', 'number',
              'converted_value', to_jsonb(v_numeric),
              'reason', 'String value converted to a number to match the target column type.',
              'can_override', TRUE
            )
          );
        END IF;
      EXCEPTION
        WHEN OTHERS THEN
          NULL;
      END;
    END IF;

    IF v_target_type = 'boolean' THEN
      IF lower(v_trimmed) IN ('true', '1', 'yes', 'y') THEN
        v_bool := TRUE;
      ELSIF lower(v_trimmed) IN ('false', '0', 'no', 'n') THEN
        v_bool := FALSE;
      ELSE
        v_bool := NULL;
      END IF;

      IF v_bool IS NOT NULL THEN
        RETURN jsonb_build_object(
          'value', to_jsonb(v_bool),
          'coercion', jsonb_build_object(
            'target_field', v_column->>'key',
            'source_path', v_source_path,
            'original_type', v_original_type,
            'original_value', v_value,
            'converted_type', 'boolean',
            'converted_value', to_jsonb(v_bool),
            'reason', 'String value converted to a boolean to match the target column type.',
            'can_override', TRUE
          )
        );
      END IF;
    END IF;

    IF v_target_type IN ('date', 'datetime') THEN
      BEGIN
        IF v_target_type = 'date' THEN
          v_date := v_trimmed::date;
          RETURN jsonb_build_object(
            'value', to_jsonb(v_date::text),
            'coercion', jsonb_build_object(
              'target_field', v_column->>'key',
              'source_path', v_source_path,
              'original_type', v_original_type,
              'original_value', v_value,
              'converted_type', 'date',
              'converted_value', to_jsonb(v_date::text),
              'reason', 'String value normalized into date format.',
              'can_override', TRUE
            )
          );
        ELSE
          v_timestamp := v_trimmed::timestamptz;
          RETURN jsonb_build_object(
            'value', to_jsonb(to_char(v_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
            'coercion', jsonb_build_object(
              'target_field', v_column->>'key',
              'source_path', v_source_path,
              'original_type', v_original_type,
              'original_value', v_value,
              'converted_type', 'datetime',
              'converted_value', to_jsonb(to_char(v_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
              'reason', 'String value normalized into datetime format.',
              'can_override', TRUE
            )
          );
        END IF;
      EXCEPTION
        WHEN OTHERS THEN
          NULL;
      END;
    END IF;

    IF v_target_type = 'json' THEN
      BEGIN
        RETURN jsonb_build_object(
          'value', v_trimmed::jsonb,
          'coercion', jsonb_build_object(
            'target_field', v_column->>'key',
            'source_path', v_source_path,
            'original_type', v_original_type,
            'original_value', v_value,
            'converted_type', 'json',
            'converted_value', v_trimmed::jsonb,
            'reason', 'JSON text parsed into structured JSON for the target column.',
            'can_override', TRUE
          )
        );
      EXCEPTION
        WHEN OTHERS THEN
          v_diagnostics := v_diagnostics || jsonb_build_array(
            jsonb_build_object(
              'level', 'warning',
              'blocking', FALSE,
              'code', 'json_parse_failed',
              'fieldPath', v_column->>'key',
              'message', format('Could not parse %s as JSON.', COALESCE(v_column->>'label', v_column->>'key')),
              'why', 'The cell contains text that is not valid JSON.',
              'recommended_fix', 'Provide valid JSON text or map this column to a text field instead.'
            )
          );
      END;
    END IF;
  END IF;

  IF v_target_type = 'array' AND v_original_type <> 'array' THEN
    RETURN jsonb_build_object(
      'value', jsonb_build_array(v_prepared_value),
      'coercion', jsonb_build_object(
        'target_field', v_column->>'key',
        'source_path', v_source_path,
        'original_type', v_original_type,
        'original_value', v_value,
        'converted_type', 'array',
        'converted_value', jsonb_build_array(v_prepared_value),
        'reason', 'Singleton value wrapped into an array because the target column expects multiple values.',
        'can_override', TRUE
      )
    );
  END IF;

  v_result := jsonb_build_object('value', v_prepared_value);

  IF jsonb_array_length(v_diagnostics) > 0 THEN
    v_result := jsonb_set(v_result, '{diagnostics}', v_diagnostics, TRUE);
  END IF;

  IF v_trim_coercion IS NOT NULL THEN
    v_result := jsonb_set(v_result, '{coercion}', v_trim_coercion, TRUE);
  END IF;

  RETURN v_result;
END;
$function$;

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
  RETURN public.ui_read_registry_enrich_lookup_import_v1(v_registry);
END;
$function$;

CREATE OR REPLACE FUNCTION public.tabular_import_resolve_resource_v1(p_resource_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_registry JSONB := public.ui_read_registry_v1();
  v_resource JSONB;
BEGIN
  SELECT value
    INTO v_resource
    FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS value
   WHERE value->>'key' = COALESCE(p_resource_key, '')
   LIMIT 1;

  RETURN v_resource;
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_read_registry_enrich_lookup_import_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_read_registry_enrich_lookup_import_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ui_read_registry_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_read_registry_v1() TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603091430_tabular_import_lookup_import_enrichment_v1'));

COMMIT;
