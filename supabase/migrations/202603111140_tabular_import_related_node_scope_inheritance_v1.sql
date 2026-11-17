-- Plan: PLAN-202603-resource-import-related-node-graph / Step: S04
-- Migration: Inherit resolved primary scope values into related-node payloads during graph staging

BEGIN;

SELECT pg_advisory_lock(hashtext('202603111140_tabular_import_related_node_scope_inheritance_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.tabular_import_apply_inherited_scope_defaults_v1(
  p_payload JSONB,
  p_scope_columns JSONB,
  p_primary_payload JSONB,
  p_org_id UUID,
  p_client_id UUID,
  p_sender_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_payload JSONB := CASE
    WHEN jsonb_typeof(p_payload) = 'object' THEN p_payload
    ELSE '{}'::jsonb
  END;
  v_scope_columns JSONB := CASE
    WHEN jsonb_typeof(p_scope_columns) = 'object' THEN p_scope_columns
    ELSE '{}'::jsonb
  END;
  v_primary_payload JSONB := CASE
    WHEN jsonb_typeof(p_primary_payload) = 'object' THEN p_primary_payload
    ELSE '{}'::jsonb
  END;
  v_target_field TEXT;
  v_scope_value JSONB;
BEGIN
  v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'tenant', '')), '');
  IF v_target_field IS NOT NULL AND NOT (v_payload ? v_target_field) THEN
    v_scope_value := v_primary_payload -> v_target_field;
    IF v_scope_value IS NULL
       OR v_scope_value = 'null'::jsonb
       OR (
         jsonb_typeof(v_scope_value) = 'string'
         AND NULLIF(btrim(v_scope_value#>>'{}'), '') IS NULL
       ) THEN
      v_scope_value := CASE WHEN p_org_id IS NOT NULL THEN to_jsonb(p_org_id) ELSE NULL END;
    END IF;

    IF v_scope_value IS NOT NULL
       AND v_scope_value <> 'null'::jsonb
       AND (
         jsonb_typeof(v_scope_value) <> 'string'
         OR NULLIF(btrim(v_scope_value#>>'{}'), '') IS NOT NULL
       ) THEN
      v_payload := jsonb_set(v_payload, ARRAY[v_target_field], v_scope_value, TRUE);
    END IF;
  END IF;

  v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'client', '')), '');
  IF v_target_field IS NOT NULL AND NOT (v_payload ? v_target_field) THEN
    v_scope_value := v_primary_payload -> v_target_field;
    IF v_scope_value IS NULL
       OR v_scope_value = 'null'::jsonb
       OR (
         jsonb_typeof(v_scope_value) = 'string'
         AND NULLIF(btrim(v_scope_value#>>'{}'), '') IS NULL
       ) THEN
      v_scope_value := CASE WHEN p_client_id IS NOT NULL THEN to_jsonb(p_client_id) ELSE NULL END;
    END IF;

    IF v_scope_value IS NOT NULL
       AND v_scope_value <> 'null'::jsonb
       AND (
         jsonb_typeof(v_scope_value) <> 'string'
         OR NULLIF(btrim(v_scope_value#>>'{}'), '') IS NOT NULL
       ) THEN
      v_payload := jsonb_set(v_payload, ARRAY[v_target_field], v_scope_value, TRUE);
    END IF;
  END IF;

  v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'sender', '')), '');
  IF v_target_field IS NOT NULL AND NOT (v_payload ? v_target_field) THEN
    v_scope_value := v_primary_payload -> v_target_field;
    IF v_scope_value IS NULL
       OR v_scope_value = 'null'::jsonb
       OR (
         jsonb_typeof(v_scope_value) = 'string'
         AND NULLIF(btrim(v_scope_value#>>'{}'), '') IS NULL
       ) THEN
      v_scope_value := CASE WHEN p_sender_id IS NOT NULL THEN to_jsonb(p_sender_id) ELSE NULL END;
    END IF;

    IF v_scope_value IS NOT NULL
       AND v_scope_value <> 'null'::jsonb
       AND (
         jsonb_typeof(v_scope_value) <> 'string'
         OR NULLIF(btrim(v_scope_value#>>'{}'), '') IS NOT NULL
       ) THEN
      v_payload := jsonb_set(v_payload, ARRAY[v_target_field], v_scope_value, TRUE);
    END IF;
  END IF;

  RETURN v_payload;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tabular_import_stage_related_nodes_v1(
  p_run_id UUID,
  p_node_contracts JSONB,
  p_node_rules JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_run public.tabular_import_runs%ROWTYPE;
  v_row public.tabular_import_run_rows%ROWTYPE;
  v_node_contracts JSONB := COALESCE(p_node_contracts, '[]'::jsonb);
  v_node_rules JSONB := COALESCE(p_node_rules, '[]'::jsonb);
  v_node_contract JSONB;
  v_node_rule JSONB;
  v_parse JSONB;
  v_node_key TEXT;
  v_column_key TEXT;
  v_reference_field TEXT;
  v_node_payload JSONB;
  v_node_diagnostics JSONB;
  v_node_coercions JSONB;
  v_node_columns JSONB;
  v_node_column JSONB;
  v_raw_value JSONB;
  v_value_result JSONB;
  v_match_fields TEXT[] := ARRAY[]::TEXT[];
  v_match_result JSONB;
  v_match_count INT := 0;
  v_node_target_id TEXT;
  v_node_action TEXT;
  v_node_execution_status TEXT;
  v_related_nodes JSONB;
  v_row_diagnostics JSONB;
  v_row_coercions JSONB;
  v_reason_codes JSONB;
  v_reason_messages JSONB;
  v_has_rules BOOLEAN;
  v_has_payload BOOLEAN;
  v_primary_action TEXT;
  v_primary_status TEXT;
  v_existing_reference TEXT;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'tabular_import_stage_related_nodes_v1 requires run id';
  END IF;

  SELECT *
    INTO v_run
    FROM public.tabular_import_runs
   WHERE id = p_run_id;

  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'tabular_import_stage_related_nodes_v1 run % not found', p_run_id;
  END IF;

  IF jsonb_typeof(v_node_contracts) IS DISTINCT FROM 'array' THEN
    v_node_contracts := '[]'::jsonb;
  END IF;
  IF jsonb_typeof(v_node_rules) IS DISTINCT FROM 'array' THEN
    v_node_rules := '[]'::jsonb;
  END IF;

  FOR v_row IN
    SELECT *
    FROM public.tabular_import_run_rows
    WHERE run_id = p_run_id
    ORDER BY row_number ASC
    FOR UPDATE
  LOOP
    v_related_nodes := '[]'::jsonb;
    v_row_diagnostics := COALESCE(v_row.diagnostics, '[]'::jsonb);
    v_row_coercions := COALESCE(v_row.coercions, '[]'::jsonb);
    v_primary_action := COALESCE(v_row.action, 'create');
    v_primary_status := COALESCE(v_row.execution_status, 'queued');

    FOR v_node_contract IN
      SELECT value
      FROM jsonb_array_elements(v_node_contracts) AS value
    LOOP
      v_node_key := NULLIF(btrim(COALESCE(v_node_contract->>'node_key', '')), '');
      v_reference_field := NULLIF(btrim(COALESCE(v_node_contract->>'reference_field', '')), '');
      IF v_node_key IS NULL OR v_reference_field IS NULL THEN
        CONTINUE;
      END IF;

      v_node_payload := '{}'::jsonb;
      v_node_diagnostics := '[]'::jsonb;
      v_node_coercions := '[]'::jsonb;
      v_node_columns := COALESCE(v_node_contract->'columns', '[]'::jsonb);
      v_has_rules := FALSE;

      FOR v_node_rule IN
        SELECT value
        FROM jsonb_array_elements(v_node_rules) AS value
      LOOP
        v_parse := public.tabular_import_parse_target_field_v1(v_node_rule->>'target_field');
        IF COALESCE(v_parse->>'node_key', '') <> v_node_key THEN
          CONTINUE;
        END IF;

        v_has_rules := TRUE;
        v_column_key := NULLIF(btrim(COALESCE(v_parse->>'column_key', '')), '');
        IF v_column_key IS NULL THEN
          CONTINUE;
        END IF;

        v_node_column := public.tabular_import_resolve_column_v1(v_node_columns, v_column_key);
        IF v_node_column IS NULL THEN
          v_node_diagnostics := v_node_diagnostics || jsonb_build_array(
            jsonb_build_object(
              'level', 'error',
              'blocking', TRUE,
              'code', 'related_target_unknown',
              'fieldPath', format('%s.%s', v_node_key, v_column_key),
              'message', format('Related target %s.%s is not importable.', v_node_key, v_column_key),
              'why', 'The selected related-node field is not enabled by the target resource import contract.',
              'recommended_fix', 'Choose one of the import-enabled fields for this related node.'
            )
          );
          CONTINUE;
        END IF;

        v_raw_value := COALESCE(
          v_row.original_row -> NULLIF(btrim(COALESCE(v_node_rule->>'source_column', '')), ''),
          'null'::jsonb
        );
        v_value_result := public.tabular_import_coerce_value_v1(
          v_raw_value,
          v_node_column,
          NULLIF(btrim(COALESCE(v_node_rule->>'source_column', '')), '')
        );
        IF v_value_result ? 'diagnostics' THEN
          v_node_diagnostics := v_node_diagnostics || COALESCE(v_value_result->'diagnostics', '[]'::jsonb);
        END IF;
        IF v_value_result ? 'coercion' THEN
          v_node_coercions := v_node_coercions || jsonb_build_array(v_value_result->'coercion');
        END IF;
        IF v_value_result ? 'value' THEN
          v_node_payload := jsonb_set(
            v_node_payload,
            ARRAY[v_column_key],
            COALESCE(v_value_result->'value', 'null'::jsonb),
            TRUE
          );
        END IF;
      END LOOP;

      IF NOT v_has_rules THEN
        CONTINUE;
      END IF;

      v_node_payload := public.tabular_import_apply_inherited_scope_defaults_v1(
        v_node_payload,
        COALESCE(v_node_contract->'scope_columns', '{}'::jsonb),
        COALESCE(v_row.mapped_row, '{}'::jsonb),
        v_run.organization_id,
        v_run.client_id,
        v_run.sender_id
      );

      SELECT EXISTS (
        SELECT 1
        FROM jsonb_each(v_node_payload)
        WHERE value IS NOT NULL
          AND value <> 'null'::jsonb
          AND (jsonb_typeof(value) <> 'string' OR NULLIF(btrim(value#>>'{}'), '') IS NOT NULL)
      )
        INTO v_has_payload;

      IF v_has_payload THEN
        FOR v_column_key IN
          SELECT value
          FROM jsonb_array_elements_text(COALESCE(v_node_contract->'required_targets', '[]'::jsonb)) AS value
        LOOP
          IF NOT (v_node_payload ? v_column_key)
             OR v_node_payload->v_column_key IS NULL
             OR v_node_payload->v_column_key = 'null'::jsonb
             OR (
               jsonb_typeof(v_node_payload->v_column_key) = 'string'
               AND NULLIF(btrim(v_node_payload->>v_column_key), '') IS NULL
             ) THEN
            v_node_diagnostics := v_node_diagnostics || jsonb_build_array(
              jsonb_build_object(
                'level', 'error',
                'blocking', TRUE,
                'code', 'related_required_field_missing',
                'fieldPath', format('%s.%s', v_node_key, v_column_key),
                'message', format('Required related field %s.%s is missing on row %s.', v_node_key, v_column_key, v_row.row_number),
                'why', 'The staged related record does not contain a value for one of its required target columns.',
                'recommended_fix', 'Map or override this related-node field before approval.'
              )
            );
          END IF;
        END LOOP;
      END IF;

      v_existing_reference := NULLIF(btrim(COALESCE(v_row.mapped_row->>v_reference_field, '')), '');
      IF v_existing_reference IS NOT NULL AND v_has_payload THEN
        v_node_diagnostics := v_node_diagnostics || jsonb_build_array(
          jsonb_build_object(
            'level', 'error',
            'blocking', TRUE,
            'code', 'related_reference_conflict',
            'fieldPath', v_reference_field,
            'message', format('Row %s maps both %s and related-node fields for %s.', v_row.row_number, v_reference_field, v_node_key),
            'why', 'The importer cannot decide whether to link the existing reference id or create/match a related node from the worksheet data.',
            'recommended_fix', 'Either keep the direct reference id mapping or use only the related-node fields for this relationship.'
          )
        );
      END IF;

      v_node_action := 'skip';
      v_node_execution_status := CASE
        WHEN v_primary_action = 'block' OR v_primary_status = 'blocked' THEN 'blocked'
        WHEN v_primary_action = 'skip' OR v_primary_status = 'skipped' THEN 'skipped'
        ELSE 'queued'
      END;
      v_node_target_id := NULL;
      v_match_count := 0;

      IF v_existing_reference IS NOT NULL AND NOT v_has_payload THEN
        v_node_action := 'link';
        v_node_target_id := v_existing_reference;
      ELSIF v_has_payload THEN
        SELECT ARRAY(
          SELECT value
          FROM jsonb_array_elements_text(COALESCE(v_node_contract->'match_fields', '[]'::jsonb)) AS value
          WHERE NULLIF(btrim(value), '') IS NOT NULL
        )
          INTO v_match_fields;

        IF v_primary_action IN ('create', 'update')
           AND v_primary_status = 'queued'
           AND NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements(v_node_diagnostics) AS diag
             WHERE COALESCE((diag->>'blocking')::boolean, FALSE) IS TRUE
           ) THEN
          IF array_length(v_match_fields, 1) IS NOT NULL
             AND COALESCE(NULLIF(v_node_contract->>'create_mode', ''), 'match_or_create') <> 'create_only' THEN
            v_match_result := public.tabular_import_match_target_v1(
              COALESCE(v_node_contract->>'relation', ''),
              COALESCE(v_node_contract->>'id_column', 'id'),
              v_node_payload,
              v_match_fields
            );
            BEGIN
              v_match_count := COALESCE(NULLIF(v_match_result->>'match_count', '')::int, 0);
            EXCEPTION
              WHEN OTHERS THEN
                v_match_count := 0;
            END;
            v_node_target_id := NULLIF(btrim(COALESCE(v_match_result->>'target_record_id', '')), '');
          END IF;

          IF v_match_count > 1 THEN
            v_node_action := 'block';
            v_node_execution_status := 'blocked';
            v_node_diagnostics := v_node_diagnostics || jsonb_build_array(
              jsonb_build_object(
                'level', 'error',
                'blocking', TRUE,
                'code', 'related_identity_match_ambiguous',
                'fieldPath', v_reference_field,
                'message', format('Row %s matched multiple %s records.', v_row.row_number, COALESCE(v_node_contract->>'target_label', v_node_key)),
                'why', 'Configured related-node match fields resolved to more than one existing target row.',
                'recommended_fix', 'Provide a more specific identifier or fix the target data before approval.'
              )
            );
          ELSIF v_match_count = 1 AND v_node_target_id IS NOT NULL THEN
            v_node_action := 'link';
          ELSIF COALESCE(NULLIF(v_node_contract->>'create_mode', ''), 'match_or_create') = 'link_only' THEN
            v_node_action := 'block';
            v_node_execution_status := 'blocked';
            v_node_diagnostics := v_node_diagnostics || jsonb_build_array(
              jsonb_build_object(
                'level', 'error',
                'blocking', TRUE,
                'code', 'related_match_missing',
                'fieldPath', v_reference_field,
                'message', format('Row %s could not match an existing %s record.', v_row.row_number, COALESCE(v_node_contract->>'target_label', v_node_key)),
                'why', 'This related node is configured to link existing records only, but no target record matched the provided data.',
                'recommended_fix', 'Choose an existing related record or widen the match fields/configuration.'
              )
            );
          ELSE
            v_node_action := 'create';
          END IF;
        ELSE
          v_node_action := CASE
            WHEN v_primary_action = 'block' OR v_primary_status = 'blocked' THEN 'block'
            WHEN v_primary_action = 'skip' OR v_primary_status = 'skipped' THEN 'skip'
            ELSE 'skip'
          END;
        END IF;
      END IF;

      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_node_diagnostics) AS diag
        WHERE COALESCE((diag->>'blocking')::boolean, FALSE) IS TRUE
      ) THEN
        IF v_primary_action IN ('create', 'update') THEN
          v_primary_action := 'block';
          v_primary_status := 'blocked';
        END IF;
        IF v_node_execution_status = 'queued' THEN
          v_node_execution_status := 'blocked';
        END IF;
      END IF;

      v_related_nodes := v_related_nodes || jsonb_build_array(
        jsonb_strip_nulls(
          jsonb_build_object(
            'node_key', v_node_key,
            'node_label', COALESCE(v_node_contract->>'node_label', v_node_key),
            'reference_field', v_reference_field,
            'target_resource', v_node_contract->>'target_resource',
            'target_label', v_node_contract->>'target_label',
            'relation', v_node_contract->>'relation',
            'id_column', v_node_contract->>'id_column',
            'create_mode', v_node_contract->>'create_mode',
            'match_fields', COALESCE(v_node_contract->'match_fields', '[]'::jsonb),
            'payload', v_node_payload,
            'action', v_node_action,
            'execution_status', v_node_execution_status,
            'match_count', v_match_count,
            'target_record_id', v_node_target_id,
            'diagnostics', COALESCE(v_node_diagnostics, '[]'::jsonb),
            'coercions', COALESCE(v_node_coercions, '[]'::jsonb)
          )
        )
      );

      v_row_diagnostics := v_row_diagnostics || COALESCE(v_node_diagnostics, '[]'::jsonb);
      v_row_coercions := v_row_coercions || COALESCE(v_node_coercions, '[]'::jsonb);
    END LOOP;

    SELECT COALESCE(jsonb_agg(diag->>'code'), '[]'::jsonb),
           COALESCE(jsonb_agg(diag->>'message'), '[]'::jsonb)
      INTO v_reason_codes, v_reason_messages
      FROM jsonb_array_elements(COALESCE(v_row_diagnostics, '[]'::jsonb)) AS diag;

    UPDATE public.tabular_import_run_rows
       SET action = v_primary_action,
           execution_status = v_primary_status,
           diagnostics = COALESCE(v_row_diagnostics, '[]'::jsonb),
           coercions = COALESCE(v_row_coercions, '[]'::jsonb),
           reason_codes = COALESCE(v_reason_codes, '[]'::jsonb),
           reason_messages = COALESCE(v_reason_messages, '[]'::jsonb),
           metadata = jsonb_strip_nulls(
             COALESCE(v_row.metadata, '{}'::jsonb) || jsonb_build_object(
               'related_nodes', COALESCE(v_related_nodes, '[]'::jsonb)
             )
           ),
           updated_at = now()
     WHERE id = v_row.id;
  END LOOP;

  RETURN public.tabular_import_refresh_run_rollups_v1(p_run_id);
END;
$function$;

COMMENT ON FUNCTION public.tabular_import_apply_inherited_scope_defaults_v1(JSONB, JSONB, JSONB, UUID, UUID, UUID) IS
  'Apply related-node scope defaults from the resolved primary row payload first, then fall back to run scope context.';

REVOKE ALL ON FUNCTION public.tabular_import_apply_inherited_scope_defaults_v1(JSONB, JSONB, JSONB, UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_apply_inherited_scope_defaults_v1(JSONB, JSONB, JSONB, UUID, UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.tabular_import_stage_related_nodes_v1(UUID, JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_stage_related_nodes_v1(UUID, JSONB, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603111140_tabular_import_related_node_scope_inheritance_v1'));

COMMIT;
