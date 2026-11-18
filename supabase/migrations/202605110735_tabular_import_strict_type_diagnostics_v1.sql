-- Plan: PLAN-202605-console-v2-first-tenant-readiness
-- Step: Block invalid typed shipment-import values during prepare.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605110735_tabular_import_strict_type_diagnostics_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_function_definition TEXT;
BEGIN
  IF to_regprocedure('public.tabular_import_coerce_value_core_20260511_v1(jsonb,jsonb,text)') IS NULL THEN
    SELECT pg_get_functiondef('public.tabular_import_coerce_value_v1(jsonb,jsonb,text)'::regprocedure)
      INTO v_function_definition;

    IF v_function_definition IS NULL THEN
      RAISE EXCEPTION 'tabular_import_coerce_value_v1 is missing';
    END IF;

    v_function_definition := replace(
      v_function_definition,
      'CREATE OR REPLACE FUNCTION public.tabular_import_coerce_value_v1',
      'CREATE OR REPLACE FUNCTION public.tabular_import_coerce_value_core_20260511_v1'
    );
    EXECUTE v_function_definition;
  END IF;
END
$$;

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
  v_result JSONB := public.tabular_import_coerce_value_core_20260511_v1(p_value, p_column, p_source_column);
  v_value JSONB := COALESCE(p_value, 'null'::jsonb);
  v_column JSONB := COALESCE(p_column, '{}'::jsonb);
  v_target_type TEXT := public.tabular_import_resolve_column_type_v1(v_column);
  v_original_type TEXT := COALESCE(jsonb_typeof(v_value), 'null');
  v_text TEXT := NULL;
  v_trimmed TEXT := NULL;
  v_label TEXT := COALESCE(NULLIF(v_column->>'label', ''), NULLIF(v_column->>'key', ''), 'Field');
  v_field_path TEXT := COALESCE(NULLIF(v_column->>'key', ''), NULLIF(p_source_column, ''), 'value');
  v_numeric NUMERIC;
  v_date DATE;
  v_timestamp TIMESTAMPTZ;
  v_extra_diagnostics JSONB := '[]'::jsonb;
BEGIN
  IF v_original_type IS DISTINCT FROM 'string' THEN
    RETURN v_result;
  END IF;

  v_text := v_value #>> '{}';
  v_trimmed := btrim(COALESCE(v_text, ''));
  IF v_trimmed = '' THEN
    RETURN v_result;
  END IF;

  IF v_target_type IN ('integer', 'number') THEN
    BEGIN
      v_numeric := replace(v_trimmed, ',', '')::numeric;
      IF v_target_type = 'integer' AND v_numeric <> trunc(v_numeric) THEN
        v_extra_diagnostics := v_extra_diagnostics || jsonb_build_array(
          jsonb_build_object(
            'level', 'error',
            'blocking', TRUE,
            'code', 'integer_parse_failed',
            'fieldPath', v_field_path,
            'message', format('%s must be a whole number.', v_label),
            'why', format('The source value "%s" cannot be used where an integer is required.', v_trimmed),
            'recommended_fix', 'Enter a whole number without decimal places.'
          )
        );
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        v_extra_diagnostics := v_extra_diagnostics || jsonb_build_array(
          jsonb_build_object(
            'level', 'error',
            'blocking', TRUE,
            'code', CASE WHEN v_target_type = 'integer' THEN 'integer_parse_failed' ELSE 'number_parse_failed' END,
            'fieldPath', v_field_path,
            'message', format('%s must be numeric.', v_label),
            'why', format('The source value "%s" cannot be parsed as a number.', v_trimmed),
            'recommended_fix', 'Use digits only, with an optional decimal point for numeric fields.'
          )
        );
    END;
  ELSIF v_target_type = 'boolean' THEN
    IF lower(v_trimmed) NOT IN ('true', '1', 'yes', 'y', 'false', '0', 'no', 'n') THEN
      v_extra_diagnostics := v_extra_diagnostics || jsonb_build_array(
        jsonb_build_object(
          'level', 'error',
          'blocking', TRUE,
          'code', 'boolean_parse_failed',
          'fieldPath', v_field_path,
          'message', format('%s must be true or false.', v_label),
          'why', format('The source value "%s" is not a supported boolean value.', v_trimmed),
          'recommended_fix', 'Use true/false, yes/no, or 1/0.'
        )
      );
    END IF;
  ELSIF v_target_type IN ('date', 'datetime') THEN
    BEGIN
      IF v_target_type = 'date' THEN
        v_date := v_trimmed::date;
      ELSE
        v_timestamp := v_trimmed::timestamptz;
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        v_extra_diagnostics := v_extra_diagnostics || jsonb_build_array(
          jsonb_build_object(
            'level', 'error',
            'blocking', TRUE,
            'code', CASE WHEN v_target_type = 'date' THEN 'date_parse_failed' ELSE 'datetime_parse_failed' END,
            'fieldPath', v_field_path,
            'message', format('%s must be a valid %s.', v_label, CASE WHEN v_target_type = 'date' THEN 'date' ELSE 'date/time' END),
            'why', format('The source value "%s" cannot be parsed as a %s.', v_trimmed, CASE WHEN v_target_type = 'date' THEN 'date' ELSE 'date/time' END),
            'recommended_fix', CASE WHEN v_target_type = 'date' THEN 'Use an ISO date such as 2026-05-20.' ELSE 'Use an ISO date/time such as 2026-05-20T09:00:00Z.' END
          )
        );
    END;
  END IF;

  IF jsonb_array_length(v_extra_diagnostics) > 0 THEN
    v_result := jsonb_set(
      v_result,
      '{diagnostics}',
      COALESCE(v_result->'diagnostics', '[]'::jsonb) || v_extra_diagnostics,
      TRUE
    );
  END IF;

  RETURN v_result;
END;
$function$;

DO $$
DECLARE
  v_settings RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_updated_resources JSONB;
  v_resource JSONB;
  v_columns JSONB;
  v_updated_columns JSONB;
  v_column JSONB;
BEGIN
  FOR v_settings IN
    SELECT s.settings_version_id, s.cached_value
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_settings.cached_value, '{"resources":[]}'::jsonb);
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      CONTINUE;
    END IF;

    v_updated_resources := '[]'::jsonb;
    FOR v_resource IN SELECT value FROM jsonb_array_elements(v_resources) AS value
    LOOP
      IF v_resource->>'key' = 'shipments' THEN
        v_columns := COALESCE(v_resource->'columns', '[]'::jsonb);
        v_updated_columns := '[]'::jsonb;

        IF jsonb_typeof(v_columns) = 'array' THEN
          FOR v_column IN SELECT value FROM jsonb_array_elements(v_columns) AS value
          LOOP
            IF v_column->>'key' = 'box_count' THEN
              v_column := jsonb_set(v_column, '{edit_type}', to_jsonb('integer'::text), TRUE);
              v_column := jsonb_set(
                v_column,
                '{import,coercions}',
                jsonb_build_array('trim', 'null', 'integer'),
                TRUE
              );
            END IF;
            v_updated_columns := v_updated_columns || jsonb_build_array(v_column);
          END LOOP;

          v_resource := jsonb_set(v_resource, '{columns}', v_updated_columns, TRUE);
        END IF;
      END IF;

      v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
    END LOOP;

    v_current := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = sv.version + 1,
           change_reason = 'Repair shipment import box_count integer validation',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE sv.id = v_settings.settings_version_id
       AND sv.value IS DISTINCT FROM v_current;

    UPDATE public.settings s
       SET cached_value = v_current,
           last_updated = now()
     WHERE s.settings_version_id = v_settings.settings_version_id
       AND s.cached_value IS DISTINCT FROM v_current;
  END LOOP;
END
$$;

COMMENT ON FUNCTION public.tabular_import_coerce_value_core_20260511_v1(JSONB, JSONB, TEXT) IS
  'Internal snapshot of the pre-2026-05-11 tabular import coercion helper, used by strict typed diagnostics wrapper.';

COMMENT ON FUNCTION public.tabular_import_coerce_value_v1(JSONB, JSONB, TEXT) IS
  'Coerce tabular import cell values and emit blocking diagnostics for invalid typed values before execution.';

REVOKE ALL ON FUNCTION public.tabular_import_coerce_value_core_20260511_v1(JSONB, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_coerce_value_core_20260511_v1(JSONB, JSONB, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.tabular_import_coerce_value_v1(JSONB, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_coerce_value_v1(JSONB, JSONB, TEXT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605110735_tabular_import_strict_type_diagnostics_v1'));
COMMIT;
