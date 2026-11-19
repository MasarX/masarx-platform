-- Plan: PLAN-202605-console-v2-first-tenant-readiness
-- Step: Shipment import prepare must return canonical post-staging validation readback.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605130045_tabular_import_prepare_canonical_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  v_scope_resolution JSONB := public.ui_resolve_import_scope_context_v1(v_payload);
  v_row_override_count INT := 0;
  v_registry JSONB;
  v_resource JSONB;
  v_node_contracts JSONB := '[]'::jsonb;
  v_materialized_payload JSONB;
  v_primary_rules JSONB := '[]'::jsonb;
  v_node_rules JSONB := '[]'::jsonb;
  v_rule JSONB;
  v_parse JSONB;
  v_base_result JSONB;
  v_run_id UUID;
  v_run_summary JSONB := '{}'::jsonb;
  v_run_preview JSONB := '{}'::jsonb;
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
        FROM public.ui_tabular_import_profiles_v1(
          v_resource_key,
          COALESCE(v_scope_resolution->'scope_context', '{}'::jsonb)
        ) AS profile
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
  v_payload := jsonb_set(
    v_payload,
    '{scope_context}',
    COALESCE(v_scope_resolution->'scope_context', '{}'::jsonb),
    TRUE
  );
  IF v_header_fingerprint IS NOT NULL THEN
    v_payload := jsonb_set(v_payload, '{header_fingerprint}', to_jsonb(v_header_fingerprint), TRUE);
  END IF;

  v_registry := public.ui_read_registry_v1();
  v_resource := public.tabular_import_resolve_resource_v1(v_resource_key);
  v_node_contracts := public.tabular_import_resolve_inline_node_contracts_v1(v_resource, v_registry);

  v_materialized_payload := public.tabular_import_materialize_row_overrides_v1(
    public.tabular_import_materialize_fixed_rules_v1(v_payload)
  );

  IF jsonb_typeof(v_materialized_payload->'rules') = 'array' THEN
    FOR v_rule IN
      SELECT value
      FROM jsonb_array_elements(v_materialized_payload->'rules') AS value
    LOOP
      v_parse := public.tabular_import_parse_target_field_v1(v_rule->>'target_field');
      IF COALESCE((v_parse->>'is_related')::boolean, FALSE) IS TRUE THEN
        v_node_rules := v_node_rules || jsonb_build_array(v_rule);
      ELSE
        v_primary_rules := v_primary_rules || jsonb_build_array(v_rule);
      END IF;
    END LOOP;
  END IF;

  v_materialized_payload := jsonb_set(v_materialized_payload, '{rules}', COALESCE(v_primary_rules, '[]'::jsonb), TRUE);
  v_base_result := public.tabular_import_prepare_base_v1(v_materialized_payload);
  v_run_id := public.mapping_studio_try_uuid_v1(v_base_result->>'run_id');

  IF v_run_id IS NOT NULL THEN
    UPDATE public.tabular_import_runs
       SET summary = jsonb_strip_nulls(
             COALESCE(summary, '{}'::jsonb) || jsonb_build_object(
               'headers', COALESCE(v_original_headers, '[]'::jsonb),
               'resolved_rules', COALESCE(v_selected_rules, '[]'::jsonb),
               'rule_source', v_effective_rule_source,
               'row_override_count', v_row_override_count,
               'scope_context', COALESCE(v_scope_resolution->'scope_context', '{}'::jsonb),
               'available_related_nodes', COALESCE(v_node_contracts, '[]'::jsonb),
               'related_node_rules', COALESCE(v_node_rules, '[]'::jsonb),
               'profile_match', v_profile_match
             )
           ),
           updated_at = now()
     WHERE id = v_run_id;

    PERFORM public.tabular_import_stage_related_nodes_v1(
      v_run_id,
      COALESCE(v_node_contracts, '[]'::jsonb),
      COALESCE(v_node_rules, '[]'::jsonb)
    );

    SELECT public.ui_get_tabular_import_run_v1(v_run_id)
      INTO v_run_preview;

    v_run_summary := COALESCE(v_run_preview->'summary', '{}'::jsonb);

    RETURN COALESCE(v_base_result, '{}'::jsonb) || jsonb_strip_nulls(
      jsonb_build_object(
        'run_id', v_run_preview->>'id',
        'id', v_run_preview->>'id',
        'resource', v_run_preview->>'resource_key',
        'resource_key', v_run_preview->>'resource_key',
        'write_mode', v_run_preview->>'write_mode',
        'source_format', v_run_preview->>'source_format',
        'source_file_name', v_run_preview->>'source_file_name',
        'header_fingerprint', v_run_preview->>'header_fingerprint',
        'sheet_name', v_run_preview->>'sheet_name',
        'unmatched_headers', COALESCE(v_run_summary->'unmatched_headers', '[]'::jsonb),
        'unresolved_targets', COALESCE(v_run_summary->'unresolved_targets', '[]'::jsonb),
        'total_rows', COALESCE((v_run_preview->>'total_rows')::int, 0),
        'will_create', COALESCE((v_run_preview->>'will_create')::int, 0),
        'will_update', COALESCE((v_run_preview->>'will_update')::int, 0),
        'will_skip', COALESCE((v_run_preview->>'will_skip')::int, 0),
        'blocked_count', COALESCE((v_run_preview->>'blocked_count')::int, 0),
        'warning_count', COALESCE((v_run_preview->>'warning_count')::int, 0),
        'automatic_corrections', COALESCE(v_run_summary->'automatic_corrections', '[]'::jsonb),
        'blocking_diagnostics', COALESCE(v_run_summary->'blocking_diagnostics', '[]'::jsonb),
        'warning_diagnostics', COALESCE(v_run_summary->'warning_diagnostics', '[]'::jsonb),
        'rows', COALESCE(v_run_preview->'rows', '[]'::jsonb),
        'profile', COALESCE(v_run_summary->'profile_match', v_base_result->'profile'),
        'available_profiles', COALESCE(v_run_summary->'available_profiles', v_base_result->'available_profiles', '[]'::jsonb),
        'resolved_rules', COALESCE(v_selected_rules, '[]'::jsonb),
        'related_nodes', COALESCE(v_run_summary->'related_node_summary', '[]'::jsonb),
        'available_related_nodes', COALESCE(v_node_contracts, '[]'::jsonb)
      )
    );
  END IF;

  RETURN v_base_result;
END;
$function$;

COMMENT ON FUNCTION public.tabular_import_prepare_v1(JSONB) IS
  'Prepare a tabular import run with related-node staging and canonical post-staging validation readback for Console V2.';

REVOKE ALL ON FUNCTION public.tabular_import_prepare_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_prepare_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605130045_tabular_import_prepare_canonical_readback_v1'));
COMMIT;
