-- Plan: PLAN-202603-shared-mapping-studio / Step: S04
-- Migration: Tabular import prepare/staging RPC

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091180_tabular_import_prepare_v1'));
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
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_client_id UUID := public.current_user_client_id();
  v_sender_id UUID := public.current_user_sender_id();
  v_resource_key TEXT := NULLIF(btrim(COALESCE(v_payload->>'resource_key', '')), '');
  v_write_mode TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_payload->>'write_mode', '')), ''), 'create'));
  v_rule_source TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_payload->>'rule_source', '')), ''), 'auto'));
  v_source_format TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_payload->>'source_format', '')), ''), 'csv'));
  v_source_file_name TEXT := NULLIF(btrim(COALESCE(v_payload->>'source_file_name', '')), '');
  v_source_artifact_id UUID := public.mapping_studio_try_uuid_v1(v_payload->>'source_artifact_id');
  v_sheet_name TEXT := NULLIF(btrim(COALESCE(v_payload->>'sheet_name', '')), '');
  v_header_fingerprint TEXT := NULLIF(btrim(COALESCE(v_payload->>'header_fingerprint', '')), '');
  v_headers JSONB := COALESCE(v_payload->'headers', '[]'::jsonb);
  v_rows JSONB := COALESCE(v_payload->'rows', '[]'::jsonb);
  v_rules_payload JSONB := COALESCE(v_payload->'rules', '[]'::jsonb);
  v_resource JSONB;
  v_relation TEXT;
  v_id_column TEXT;
  v_scope_columns JSONB := '{}'::jsonb;
  v_capability TEXT;
  v_allow_upsert BOOLEAN := FALSE;
  v_default_write_mode TEXT := 'create';
  v_identity_columns TEXT[] := ARRAY[]::TEXT[];
  v_resource_formats TEXT[] := ARRAY[]::TEXT[];
  v_importable_columns JSONB := '[]'::jsonb;
  v_required_targets TEXT[] := ARRAY[]::TEXT[];
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_policy_formats TEXT[] := ARRAY['csv','xls','xlsx'];
  v_policy_max_rows INT := 5000;
  v_global_blocking JSONB := '[]'::jsonb;
  v_global_warnings JSONB := '[]'::jsonb;
  v_available_profiles JSONB := '[]'::jsonb;
  v_profile_match JSONB := NULL;
  v_profile_rules JSONB := '[]'::jsonb;
  v_candidate_rules JSONB := '[]'::jsonb;
  v_effective_rules JSONB := '[]'::jsonb;
  v_effective_target_keys TEXT[] := ARRAY[]::TEXT[];
  v_effective_source_headers TEXT[] := ARRAY[]::TEXT[];
  v_unmatched_headers TEXT[] := ARRAY[]::TEXT[];
  v_unresolved_targets TEXT[] := ARRAY[]::TEXT[];
  v_run_id UUID;
  v_row_item JSONB;
  v_rule JSONB;
  v_column JSONB;
  v_source_column TEXT;
  v_target_field TEXT;
  v_header TEXT;
  v_index INT := 0;
  v_total_rows INT := 0;
  v_will_create INT := 0;
  v_will_update INT := 0;
  v_will_skip INT := 0;
  v_blocked_count INT := 0;
  v_warning_count INT := 0;
  v_rows_preview JSONB := '[]'::jsonb;
  v_automatic_corrections JSONB := '[]'::jsonb;
  v_blocking_diagnostics JSONB := '[]'::jsonb;
  v_warning_diagnostics JSONB := '[]'::jsonb;
  v_mapped_row JSONB;
  v_diagnostics JSONB;
  v_coercions JSONB;
  v_action TEXT;
  v_execution_status TEXT;
  v_reason_codes JSONB;
  v_reason_messages JSONB;
  v_value_result JSONB;
  v_match JSONB;
  v_match_count INT;
  v_target_record_id TEXT;
  v_required_target TEXT;
  v_identity_signature TEXT;
  v_seen_identity_signatures TEXT[] := ARRAY[]::TEXT[];
  v_rows_count_from_json INT := 0;
BEGIN
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 requires payload object';
  END IF;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 requires organization context';
  END IF;
  IF v_resource_key IS NULL THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 requires resource_key';
  END IF;
  IF jsonb_typeof(v_headers) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 requires headers array';
  END IF;
  IF jsonb_typeof(v_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 requires rows array';
  END IF;
  IF jsonb_typeof(v_rules_payload) IS DISTINCT FROM 'array' THEN
    v_rules_payload := '[]'::jsonb;
  END IF;

  v_resource := public.tabular_import_resolve_resource_v1(v_resource_key);
  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 unknown resource %', v_resource_key;
  END IF;

  IF COALESCE((v_resource#>>ARRAY['import','enabled'])::boolean, FALSE) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 import disabled for resource %', v_resource_key;
  END IF;

  v_capability := COALESCE(
    NULLIF(btrim(COALESCE(v_resource#>>ARRAY['import','capability'], '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_write', '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_read', '')), '')
  );
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, 'tenant', v_org_id);
  END IF;

  v_relation := NULLIF(btrim(COALESCE(v_resource->>'relation', '')), '');
  v_id_column := COALESCE(NULLIF(btrim(COALESCE(v_resource->>'id_column', '')), ''), 'id');
  v_scope_columns := COALESCE(v_resource->'scope_columns', '{}'::jsonb);
  v_default_write_mode := lower(COALESCE(NULLIF(btrim(COALESCE(v_resource#>>ARRAY['import','default_write_mode'], '')), ''), 'create'));
  BEGIN
    v_allow_upsert := COALESCE(NULLIF(v_resource#>>ARRAY['import','allow_upsert'], '')::boolean, FALSE);
  EXCEPTION
    WHEN OTHERS THEN
      v_allow_upsert := FALSE;
  END;

  IF v_relation IS NULL THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 resource % missing relation', v_resource_key;
  END IF;

  SELECT ARRAY(
    SELECT value
    FROM jsonb_array_elements_text(COALESCE(v_resource#>'{import,identity_columns}', '[]'::jsonb)) AS value
    WHERE NULLIF(btrim(value), '') IS NOT NULL
  )
    INTO v_identity_columns;

  SELECT ARRAY(
    SELECT lower(value)
    FROM jsonb_array_elements_text(COALESCE(v_resource#>'{import,accepted_formats}', '[]'::jsonb)) AS value
    WHERE NULLIF(btrim(value), '') IS NOT NULL
  )
    INTO v_resource_formats;

  IF v_write_mode NOT IN ('create', 'upsert') THEN
    v_write_mode := v_default_write_mode;
  END IF;
  IF v_write_mode = 'upsert' AND (NOT v_allow_upsert OR array_length(v_identity_columns, 1) IS NULL) THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 upsert not allowed for resource %', v_resource_key;
  END IF;

  SELECT jsonb_agg(column_entry.value)
    INTO v_importable_columns
    FROM jsonb_array_elements(COALESCE(v_resource->'columns', '[]'::jsonb)) AS column_entry(value)
   WHERE NULLIF(btrim(COALESCE(column_entry.value->>'key', '')), '') IS NOT NULL
     AND (
       COALESCE(
         NULLIF(column_entry.value#>>ARRAY['import','enabled'], '')::boolean,
         CASE
           WHEN lower(COALESCE(column_entry.value->>'edit_mode', '')) IN ('none', 'read') THEN FALSE
           ELSE TRUE
         END
       ) IS TRUE
     );

  v_importable_columns := COALESCE(v_importable_columns, '[]'::jsonb);

  SELECT ARRAY(
    SELECT value->>'key'
    FROM jsonb_array_elements(v_importable_columns) AS value
    WHERE COALESCE(NULLIF(value#>>ARRAY['import','required'], '')::boolean, FALSE) IS TRUE
      AND NULLIF(btrim(COALESCE(value->>'key', '')), '') IS NOT NULL
  )
    INTO v_required_targets;

  SELECT *
    INTO v_policy_row
    FROM public.resolve_tabular_import_policy_v1(
      jsonb_strip_nulls(
        jsonb_build_object(
          'organization_id', v_org_id,
          'client_id', v_client_id,
          'sender_id', v_sender_id,
          'resource_key', v_resource_key
        )
      )
    )
   LIMIT 1;

  v_policy := COALESCE(v_policy_row.value, '{}'::jsonb);
  SELECT ARRAY(
    SELECT lower(value)
    FROM jsonb_array_elements_text(COALESCE(v_policy->'accepted_formats', '[]'::jsonb)) AS value
    WHERE NULLIF(btrim(value), '') IS NOT NULL
  )
    INTO v_policy_formats;

  BEGIN
    v_policy_max_rows := COALESCE(NULLIF(v_policy->>'max_rows', '')::int, v_policy_max_rows);
  EXCEPTION
    WHEN OTHERS THEN
      v_policy_max_rows := 5000;
  END;

  v_rows_count_from_json := COALESCE(jsonb_array_length(v_rows), 0);
  IF v_rows_count_from_json > v_policy_max_rows THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 max rows exceeded (% > %)', v_rows_count_from_json, v_policy_max_rows;
  END IF;

  IF array_length(v_policy_formats, 1) IS NOT NULL AND NOT (v_source_format = ANY(v_policy_formats)) THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 format % not allowed by tabular_import_policy', v_source_format;
  END IF;
  IF array_length(v_resource_formats, 1) IS NOT NULL AND NOT (v_source_format = ANY(v_resource_formats)) THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 format % not allowed for resource %', v_source_format, v_resource_key;
  END IF;

  IF v_header_fingerprint IS NULL THEN
    SELECT string_agg(normalized_header, '|' ORDER BY normalized_header)
      INTO v_header_fingerprint
      FROM (
        SELECT regexp_replace(lower(btrim(value)), '[^a-z0-9]+', '_', 'g') AS normalized_header
        FROM jsonb_array_elements_text(v_headers) AS value
        WHERE NULLIF(btrim(value), '') IS NOT NULL
      ) normalized;
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
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
      )
      ORDER BY profile.updated_at DESC, profile.created_at DESC
    ),
    '[]'::jsonb
  )
    INTO v_available_profiles
    FROM public.ui_tabular_import_profiles_v1(v_resource_key) profile;

  SELECT value
    INTO v_profile_match
    FROM jsonb_array_elements(v_available_profiles) AS value
   WHERE COALESCE(value->>'header_fingerprint', '') = COALESCE(v_header_fingerprint, '')
   ORDER BY COALESCE(value->>'updated_at', value->>'created_at', '') DESC
   LIMIT 1;

  IF v_profile_match IS NOT NULL AND jsonb_typeof(v_profile_match#>'{mapping_config,field_rules}') = 'array' THEN
    v_profile_rules := COALESCE(v_profile_match#>'{mapping_config,field_rules}', '[]'::jsonb);
  END IF;

  IF v_rule_source <> 'manual'
     AND v_profile_match IS NOT NULL
     AND jsonb_array_length(v_profile_rules) > 0 THEN
    v_candidate_rules := v_profile_rules;
  ELSE
    v_candidate_rules := v_rules_payload;
  END IF;

  FOR v_rule IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(v_candidate_rules, '[]'::jsonb)) AS value
  LOOP
    v_source_column := NULLIF(btrim(COALESCE(v_rule->>'source_column', '')), '');
    v_target_field := NULLIF(btrim(COALESCE(v_rule->>'target_field', '')), '');

    IF COALESCE(NULLIF(v_rule->>'enabled', '')::boolean, TRUE) IS DISTINCT FROM TRUE THEN
      CONTINUE;
    END IF;
    IF v_source_column IS NULL OR v_target_field IS NULL THEN
      CONTINUE;
    END IF;

    v_column := public.tabular_import_resolve_column_v1(v_importable_columns, v_target_field);
    IF v_column IS NULL THEN
      v_global_blocking := v_global_blocking || jsonb_build_array(
        jsonb_build_object(
          'level', 'error',
          'blocking', TRUE,
          'code', 'target_not_importable',
          'fieldPath', v_target_field,
          'message', format('The target field %s is not importable for %s.', v_target_field, v_resource_key),
          'why', 'The selected target column is not enabled in the resource import contract.',
          'recommended_fix', 'Choose one of the import-enabled target columns.'
        )
      );
      CONTINUE;
    END IF;

    IF v_target_field = ANY(v_effective_target_keys) THEN
      v_global_blocking := v_global_blocking || jsonb_build_array(
        jsonb_build_object(
          'level', 'error',
          'blocking', TRUE,
          'code', 'duplicate_target_mapping',
          'fieldPath', v_target_field,
          'message', format('Multiple source columns are mapped to %s.', v_target_field),
          'why', 'Each target field can only receive one source column in the automatic import flow.',
          'recommended_fix', 'Keep one source column for this target field and remove the duplicate mapping.'
        )
      );
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_headers) AS header_value
      WHERE header_value = v_source_column
    ) THEN
      v_global_blocking := v_global_blocking || jsonb_build_array(
        jsonb_build_object(
          'level', 'error',
          'blocking', TRUE,
          'code', 'source_header_missing',
          'fieldPath', v_target_field,
          'message', format('Mapped source column %s is missing from the uploaded file.', v_source_column),
          'why', 'The saved or inferred mapping references a header that does not exist in this worksheet.',
          'recommended_fix', 'Choose an existing header from the uploaded file or update the saved profile.'
        )
      );
      CONTINUE;
    END IF;

    v_effective_rules := v_effective_rules || jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'source_column', v_source_column,
          'target_field', v_target_field,
          'confidence', v_rule->'confidence',
          'source', v_rule->'source',
          'enabled', TRUE
        )
      )
    );
    v_effective_target_keys := array_append(v_effective_target_keys, v_target_field);
    v_effective_source_headers := array_append(v_effective_source_headers, v_source_column);
  END LOOP;

  FOREACH v_required_target IN ARRAY COALESCE(v_required_targets, ARRAY[]::TEXT[])
  LOOP
    IF NOT (v_required_target = ANY(v_effective_target_keys)) THEN
      v_unresolved_targets := array_append(v_unresolved_targets, v_required_target);
      v_global_blocking := v_global_blocking || jsonb_build_array(
        jsonb_build_object(
          'level', 'error',
          'blocking', TRUE,
          'code', 'required_target_unmapped',
          'fieldPath', v_required_target,
          'message', format('Required target field %s is not mapped.', v_required_target),
          'why', 'This table marks the target column as required for imports.',
          'recommended_fix', 'Map a source column to this target field before approving the import.'
        )
      );
    END IF;
  END LOOP;

  SELECT ARRAY(
    SELECT value
    FROM jsonb_array_elements_text(v_headers) AS value
    WHERE NOT (value = ANY(COALESCE(v_effective_source_headers, ARRAY[]::TEXT[])))
  )
    INTO v_unmatched_headers;

  INSERT INTO public.tabular_import_runs (
    organization_id,
    client_id,
    sender_id,
    resource_key,
    relation_name,
    write_mode,
    status,
    profile_name,
    header_fingerprint,
    sheet_name,
    source_format,
    source_file_name,
    source_artifact_id,
    created_by,
    updated_by,
    summary
  )
  VALUES (
    v_org_id,
    v_client_id,
    v_sender_id,
    v_resource_key,
    v_relation,
    v_write_mode,
    'prepared',
    NULLIF(btrim(COALESCE(v_profile_match->>'profile_name', '')), ''),
    v_header_fingerprint,
    v_sheet_name,
    v_source_format,
    v_source_file_name,
    v_source_artifact_id,
    v_user_id,
    v_user_id,
    jsonb_strip_nulls(
      jsonb_build_object(
        'headers', v_headers,
        'resolved_rules', v_effective_rules,
        'profile_match', v_profile_match,
        'available_profiles', v_available_profiles,
        'unmatched_headers', to_jsonb(COALESCE(v_unmatched_headers, ARRAY[]::TEXT[])),
        'unresolved_targets', to_jsonb(COALESCE(v_unresolved_targets, ARRAY[]::TEXT[]))
      )
    )
  )
  RETURNING id INTO v_run_id;

  IF v_source_artifact_id IS NOT NULL THEN
    INSERT INTO public.artifact_links (
      organization_id,
      artifact_id,
      resource_type,
      resource_id,
      relation_type,
      metadata
    )
    VALUES (
      v_org_id,
      v_source_artifact_id,
      'tabular_import_runs',
      v_run_id,
      'source',
      jsonb_build_object('file_name', v_source_file_name, 'sheet_name', v_sheet_name)
    )
    ON CONFLICT (organization_id, artifact_id, resource_type, resource_id, relation_type) DO NOTHING;
  END IF;

  FOR v_row_item IN
    SELECT value
    FROM jsonb_array_elements(v_rows) AS value
  LOOP
    v_index := v_index + 1;
    IF jsonb_typeof(v_row_item) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_total_rows := v_total_rows + 1;
    v_mapped_row := '{}'::jsonb;
    v_diagnostics := COALESCE(v_global_blocking, '[]'::jsonb);
    v_coercions := '[]'::jsonb;

    FOR v_rule IN
      SELECT value
      FROM jsonb_array_elements(v_effective_rules) AS value
    LOOP
      v_source_column := v_rule->>'source_column';
      v_target_field := v_rule->>'target_field';
      v_column := public.tabular_import_resolve_column_v1(v_importable_columns, v_target_field);
      IF v_column IS NULL THEN
        CONTINUE;
      END IF;

      v_value_result := public.tabular_import_coerce_value_v1(v_row_item -> v_source_column, v_column, v_source_column);
      IF v_value_result ? 'diagnostics' THEN
        v_diagnostics := v_diagnostics || COALESCE(v_value_result->'diagnostics', '[]'::jsonb);
      END IF;
      IF v_value_result ? 'coercion' THEN
        v_coercions := v_coercions || jsonb_build_array(v_value_result->'coercion');
      END IF;
      IF v_value_result ? 'value' THEN
        v_mapped_row := jsonb_set(v_mapped_row, ARRAY[v_target_field], COALESCE(v_value_result->'value', 'null'::jsonb), TRUE);
      END IF;
    END LOOP;

    IF v_scope_columns ? 'tenant' AND v_org_id IS NOT NULL THEN
      v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'tenant', '')), '');
      IF v_target_field IS NOT NULL AND NOT (v_mapped_row ? v_target_field) THEN
        v_mapped_row := jsonb_set(v_mapped_row, ARRAY[v_target_field], to_jsonb(v_org_id), TRUE);
      END IF;
    END IF;
    IF v_scope_columns ? 'client' AND v_client_id IS NOT NULL THEN
      v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'client', '')), '');
      IF v_target_field IS NOT NULL AND NOT (v_mapped_row ? v_target_field) THEN
        v_mapped_row := jsonb_set(v_mapped_row, ARRAY[v_target_field], to_jsonb(v_client_id), TRUE);
      END IF;
    END IF;
    IF v_scope_columns ? 'sender' AND v_sender_id IS NOT NULL THEN
      v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'sender', '')), '');
      IF v_target_field IS NOT NULL AND NOT (v_mapped_row ? v_target_field) THEN
        v_mapped_row := jsonb_set(v_mapped_row, ARRAY[v_target_field], to_jsonb(v_sender_id), TRUE);
      END IF;
    END IF;

    FOREACH v_required_target IN ARRAY COALESCE(v_required_targets, ARRAY[]::TEXT[])
    LOOP
      IF NOT (v_mapped_row ? v_required_target)
         OR v_mapped_row->v_required_target IS NULL
         OR v_mapped_row->v_required_target = 'null'::jsonb
         OR (jsonb_typeof(v_mapped_row->v_required_target) = 'string' AND NULLIF(btrim(v_mapped_row->>v_required_target), '') IS NULL) THEN
        v_diagnostics := v_diagnostics || jsonb_build_array(
          jsonb_build_object(
            'level', 'error',
            'blocking', TRUE,
            'code', 'required_field_missing',
            'fieldPath', v_required_target,
            'message', format('Required field %s is missing on row %s.', v_required_target, v_index),
            'why', 'The mapped row does not contain a value for a required target column.',
            'recommended_fix', 'Provide a source value for this field or fix the mapping before approval.'
          )
        );
      END IF;
    END LOOP;

    v_target_record_id := NULL;
    v_match_count := 0;
    IF array_length(v_identity_columns, 1) IS NOT NULL THEN
      v_identity_signature := NULL;
      IF NOT EXISTS (
        SELECT 1
        FROM unnest(v_identity_columns) AS identity_key
        WHERE NOT (v_mapped_row ? identity_key)
           OR v_mapped_row->identity_key IS NULL
           OR v_mapped_row->identity_key = 'null'::jsonb
      ) THEN
        SELECT string_agg(COALESCE(v_mapped_row->>identity_key, ''), '||' ORDER BY identity_key)
          INTO v_identity_signature
          FROM unnest(v_identity_columns) AS identity_key;
      END IF;

      IF v_identity_signature IS NOT NULL THEN
        IF v_identity_signature = ANY(v_seen_identity_signatures) THEN
          v_diagnostics := v_diagnostics || jsonb_build_array(
            jsonb_build_object(
              'level', 'error',
              'blocking', TRUE,
              'code', 'duplicate_identity_in_file',
              'message', format('Row %s duplicates an earlier identity in the same file.', v_index),
              'why', 'The import file contains multiple rows with the same configured identity columns.',
              'recommended_fix', 'Remove the duplicate row or consolidate the source data before import.'
            )
          );
        ELSE
          v_seen_identity_signatures := array_append(v_seen_identity_signatures, v_identity_signature);
        END IF;
      END IF;

      IF v_diagnostics = '[]'::jsonb OR NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_diagnostics) AS diag
        WHERE COALESCE((diag->>'blocking')::boolean, FALSE) IS TRUE
      ) THEN
        v_match := public.tabular_import_match_target_v1(v_relation, v_id_column, v_mapped_row, v_identity_columns);
        BEGIN
          v_match_count := COALESCE(NULLIF(v_match->>'match_count', '')::int, 0);
        EXCEPTION
          WHEN OTHERS THEN
            v_match_count := 0;
        END;
        v_target_record_id := NULLIF(btrim(COALESCE(v_match->>'target_record_id', '')), '');

        IF v_write_mode = 'upsert' THEN
          IF v_match_count > 1 THEN
            v_diagnostics := v_diagnostics || jsonb_build_array(
              jsonb_build_object(
                'level', 'error',
                'blocking', TRUE,
                'code', 'identity_match_ambiguous',
                'message', format('Row %s matched more than one existing record.', v_index),
                'why', 'Configured upsert identity columns resolved to multiple target rows.',
                'recommended_fix', 'Tighten the identity columns or clean the target data before import.'
              )
            );
          END IF;
        ELSIF v_write_mode = 'create' AND v_match_count > 0 THEN
          v_diagnostics := v_diagnostics || jsonb_build_array(
            jsonb_build_object(
              'level', 'warning',
              'blocking', FALSE,
              'code', 'existing_identity_conflict',
              'message', format('Row %s matches an existing record and will be skipped in create mode.', v_index),
              'why', 'Create mode does not overwrite or update rows that already exist.',
              'recommended_fix', 'Switch to upsert for this resource or remove existing duplicates before import.'
            )
          );
        END IF;
      END IF;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_diagnostics) AS diag
      WHERE COALESCE((diag->>'blocking')::boolean, FALSE) IS TRUE
    ) THEN
      v_action := 'block';
      v_execution_status := 'blocked';
      v_blocked_count := v_blocked_count + 1;
    ELSIF v_write_mode = 'create' AND v_match_count > 0 THEN
      v_action := 'skip';
      v_execution_status := 'skipped';
      v_will_skip := v_will_skip + 1;
    ELSIF v_write_mode = 'upsert' AND v_match_count = 1 THEN
      v_action := 'update';
      v_execution_status := 'queued';
      v_will_update := v_will_update + 1;
    ELSE
      v_action := 'create';
      v_execution_status := 'queued';
      v_will_create := v_will_create + 1;
    END IF;

    SELECT COALESCE(jsonb_agg(diag->>'code'), '[]'::jsonb),
           COALESCE(jsonb_agg(diag->>'message'), '[]'::jsonb)
      INTO v_reason_codes, v_reason_messages
      FROM jsonb_array_elements(v_diagnostics) AS diag;

    INSERT INTO public.tabular_import_run_rows (
      run_id,
      organization_id,
      row_number,
      action,
      execution_status,
      original_row,
      mapped_row,
      diagnostics,
      coercions,
      target_record_id,
      reason_codes,
      reason_messages,
      metadata
    )
    VALUES (
      v_run_id,
      v_org_id,
      v_index,
      v_action,
      v_execution_status,
      v_row_item,
      v_mapped_row,
      v_diagnostics,
      v_coercions,
      v_target_record_id,
      COALESCE(v_reason_codes, '[]'::jsonb),
      COALESCE(v_reason_messages, '[]'::jsonb),
      jsonb_build_object('match_count', v_match_count)
    );

    IF v_index <= 25 THEN
      v_rows_preview := v_rows_preview || jsonb_build_array(
        jsonb_build_object(
          'row_number', v_index,
          'execution_status', v_execution_status,
          'action', v_action,
          'diagnostics', v_diagnostics,
          'coercions', v_coercions,
          'mapped_row', v_mapped_row,
          'target_record_id', v_target_record_id,
          'reason_codes', COALESCE(v_reason_codes, '[]'::jsonb),
          'reason_messages', COALESCE(v_reason_messages, '[]'::jsonb)
        )
      );
    END IF;

    IF jsonb_array_length(v_coercions) > 0 THEN
      v_automatic_corrections := v_automatic_corrections || v_coercions;
    END IF;

    IF jsonb_array_length(v_diagnostics) > 0 THEN
      v_warning_count := v_warning_count + COALESCE((
        SELECT count(*)
        FROM jsonb_array_elements(v_diagnostics) AS diag
        WHERE lower(COALESCE(diag->>'level', '')) = 'warning'
      ), 0);
      v_blocking_diagnostics := v_blocking_diagnostics || COALESCE((
        SELECT jsonb_agg(diag)
        FROM jsonb_array_elements(v_diagnostics) AS diag
        WHERE COALESCE((diag->>'blocking')::boolean, FALSE) IS TRUE
      ), '[]'::jsonb);
      v_warning_diagnostics := v_warning_diagnostics || COALESCE((
        SELECT jsonb_agg(diag)
        FROM jsonb_array_elements(v_diagnostics) AS diag
        WHERE lower(COALESCE(diag->>'level', '')) = 'warning'
      ), '[]'::jsonb);
    END IF;
  END LOOP;

  UPDATE public.tabular_import_runs
     SET total_rows = v_total_rows,
         will_create = v_will_create,
         will_update = v_will_update,
         will_skip = v_will_skip,
         blocked_count = v_blocked_count,
         warning_count = v_warning_count,
         summary = jsonb_strip_nulls(
           COALESCE(summary, '{}'::jsonb) || jsonb_build_object(
             'headers', v_headers,
             'resolved_rules', v_effective_rules,
             'profile_match', v_profile_match,
             'available_profiles', v_available_profiles,
             'unmatched_headers', to_jsonb(COALESCE(v_unmatched_headers, ARRAY[]::TEXT[])),
             'unresolved_targets', to_jsonb(COALESCE(v_unresolved_targets, ARRAY[]::TEXT[])),
             'write_mode', v_write_mode,
             'sheet_name', v_sheet_name,
             'source_file_name', v_source_file_name,
             'source_format', v_source_format
           )
         ),
         updated_at = now(),
         updated_by = v_user_id
   WHERE id = v_run_id;

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'resource', v_resource_key,
    'write_mode', v_write_mode,
    'source_format', v_source_format,
    'source_file_name', v_source_file_name,
    'header_fingerprint', v_header_fingerprint,
    'sheet_name', v_sheet_name,
    'unmatched_headers', to_jsonb(COALESCE(v_unmatched_headers, ARRAY[]::TEXT[])),
    'unresolved_targets', to_jsonb(COALESCE(v_unresolved_targets, ARRAY[]::TEXT[])),
    'total_rows', v_total_rows,
    'will_create', v_will_create,
    'will_update', v_will_update,
    'will_skip', v_will_skip,
    'blocked_count', v_blocked_count,
    'warning_count', v_warning_count,
    'automatic_corrections', COALESCE(v_automatic_corrections, '[]'::jsonb),
    'blocking_diagnostics', COALESCE(v_blocking_diagnostics, '[]'::jsonb),
    'warning_diagnostics', COALESCE(v_warning_diagnostics, '[]'::jsonb),
    'rows', COALESCE(v_rows_preview, '[]'::jsonb),
    'profile', v_profile_match,
    'available_profiles', COALESCE(v_available_profiles, '[]'::jsonb),
    'resolved_rules', COALESCE(v_effective_rules, '[]'::jsonb)
  );
END;
$function$;

COMMENT ON FUNCTION public.tabular_import_prepare_v1(JSONB) IS
  'Prepare a tabular import run: resolve profiles, stage rows, compute dry-run diagnostics/coercions, and persist the canonical run ledger.';

REVOKE ALL ON FUNCTION public.tabular_import_prepare_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_prepare_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603091180_tabular_import_prepare_v1'));
COMMIT;
