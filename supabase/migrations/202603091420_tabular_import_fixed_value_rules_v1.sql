-- Plan: PLAN-202603-shared-mapping-studio / Step: S06
-- Migration: Support one shared value per target field in the canonical tabular import prepare flow

BEGIN;

SELECT pg_advisory_lock(hashtext('202603091420_tabular_import_fixed_value_rules_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER FUNCTION public.tabular_import_prepare_v1(JSONB)
  RENAME TO tabular_import_prepare_base_v1;

CREATE OR REPLACE FUNCTION public.tabular_import_materialize_fixed_rules_v1(
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
  v_materialized_rules JSONB := '[]'::jsonb;
  v_materialized_headers JSONB := COALESCE(v_headers, '[]'::jsonb);
  v_materialized_rows JSONB := '[]'::jsonb;
  v_rule JSONB;
  v_row JSONB;
  v_target_field TEXT;
  v_rule_mode TEXT;
  v_synthetic_header TEXT;
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

  FOR v_rule IN
    SELECT value
    FROM jsonb_array_elements(v_rules) AS value
  LOOP
    v_target_field := NULLIF(btrim(COALESCE(v_rule->>'target_field', '')), '');
    v_rule_mode := lower(
      COALESCE(
        NULLIF(btrim(COALESCE(v_rule->>'value_mode', '')), ''),
        CASE
          WHEN v_rule ? 'fixed_value' THEN 'fixed'
          ELSE 'source'
        END
      )
    );

    IF v_rule_mode = 'fixed' AND v_target_field IS NOT NULL THEN
      v_synthetic_header := format('__shared__%s', public.tabular_import_slug_v1(v_target_field));
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
            'value_mode', 'fixed'
          )
        )
      );
    ELSE
      v_materialized_rules := v_materialized_rules || jsonb_build_array(
        jsonb_strip_nulls(
          (v_rule - 'fixed_value') || jsonb_build_object('value_mode', 'source')
        )
      );
    END IF;
  END LOOP;

  FOR v_row IN
    SELECT value
    FROM jsonb_array_elements(v_rows) AS value
  LOOP
    IF jsonb_typeof(v_row) IS DISTINCT FROM 'object' THEN
      v_materialized_rows := v_materialized_rows || jsonb_build_array(v_row);
      CONTINUE;
    END IF;

    FOR v_rule IN
      SELECT value
      FROM jsonb_array_elements(v_rules) AS value
    LOOP
      v_target_field := NULLIF(btrim(COALESCE(v_rule->>'target_field', '')), '');
      v_rule_mode := lower(
        COALESCE(
          NULLIF(btrim(COALESCE(v_rule->>'value_mode', '')), ''),
          CASE
            WHEN v_rule ? 'fixed_value' THEN 'fixed'
            ELSE 'source'
          END
        )
      );

      IF v_rule_mode <> 'fixed' OR v_target_field IS NULL THEN
        CONTINUE;
      END IF;

      v_synthetic_header := format('__shared__%s', public.tabular_import_slug_v1(v_target_field));
      v_row := jsonb_set(
        v_row,
        ARRAY[v_synthetic_header],
        COALESCE(v_rule->'fixed_value', 'null'::jsonb),
        TRUE
      );
    END LOOP;

    v_materialized_rows := v_materialized_rows || jsonb_build_array(v_row);
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

  v_payload := jsonb_set(v_payload, '{rules}', v_selected_rules, TRUE);
  IF v_header_fingerprint IS NOT NULL THEN
    v_payload := jsonb_set(v_payload, '{header_fingerprint}', to_jsonb(v_header_fingerprint), TRUE);
  END IF;

  v_result := public.tabular_import_prepare_base_v1(
    public.tabular_import_materialize_fixed_rules_v1(v_payload)
  );

  v_run_id := public.mapping_studio_try_uuid_v1(v_result->>'run_id');
  IF v_run_id IS NOT NULL THEN
    UPDATE public.tabular_import_runs
       SET summary = jsonb_strip_nulls(
             COALESCE(summary, '{}'::jsonb) || jsonb_build_object(
               'headers', COALESCE(v_original_headers, '[]'::jsonb),
               'resolved_rules', COALESCE(v_selected_rules, '[]'::jsonb),
               'rule_source', v_effective_rule_source
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
  'Prepare a tabular import run and support fixed shared values that apply to every imported row.';

REVOKE ALL ON FUNCTION public.tabular_import_prepare_base_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_prepare_base_v1(JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.tabular_import_materialize_fixed_rules_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_materialize_fixed_rules_v1(JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.tabular_import_prepare_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_prepare_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603091420_tabular_import_fixed_value_rules_v1'));

COMMIT;
