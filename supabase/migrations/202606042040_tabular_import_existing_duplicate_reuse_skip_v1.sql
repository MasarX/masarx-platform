-- Console V2 imports: classify existing-shipment duplicate reuse as skipped.
--
-- The same-run duplicate branch already avoids inflated created counts. This
-- follow-up keeps the external existing-shipment reuse branch aligned after
-- workflow-lineage updates changed the function body.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606042040_tabular_import_existing_duplicate_reuse_skip_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $patch$
DECLARE
  v_def TEXT;
  v_new_def TEXT;
  v_old TEXT := $old$      v_result := public.tabular_import_execute_row_graph_v1(v_run.id, v_row.id);

      UPDATE public.tabular_import_run_rows
         SET execution_status = 'succeeded',
             processed_at = now(),
             mapped_row = COALESCE(v_result->'mapped_row', mapped_row),
             target_record_id = NULLIF(btrim(COALESCE(v_result->>'target_record_id', '')), ''),
             metadata = jsonb_strip_nulls(
               COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                 'related_nodes', COALESCE(v_result->'related_nodes', '[]'::jsonb),
                 'primary_result', COALESCE(v_result->'primary_result', '{}'::jsonb)
               )
             ),
             updated_at = now()
       WHERE id = v_row.id;
$old$;
  v_new TEXT := $new$      v_result := public.tabular_import_execute_row_graph_v1(v_run.id, v_row.id);

      IF v_row.action = 'create'
         AND (
           COALESCE(v_result->'primary_result'->>'operation', '') IN ('reused', 'reused_client_reference')
           OR COALESCE(NULLIF(v_result->'primary_result'->>'duplicate_reused', '')::BOOLEAN, FALSE)
         ) THEN
        UPDATE public.tabular_import_run_rows
           SET action = 'skip',
               execution_status = 'skipped',
               processed_at = now(),
               mapped_row = COALESCE(v_result->'mapped_row', mapped_row),
               target_record_id = NULLIF(btrim(COALESCE(v_result->>'target_record_id', '')), ''),
               reason_codes = COALESCE(reason_codes, '[]'::jsonb)
                 || jsonb_build_array('duplicate_shipment_reused'),
               reason_messages = COALESCE(reason_messages, '[]'::jsonb)
                 || jsonb_build_array('Duplicate shipment input reused an existing shipment; no new shipment was created.'),
               diagnostics = COALESCE(diagnostics, '[]'::jsonb) || jsonb_build_array(
                 jsonb_build_object(
                   'level', 'warning',
                   'blocking', false,
                   'code', 'duplicate_shipment_reused',
                   'message', 'Duplicate shipment input reused an existing shipment; no new shipment was created.',
                   'recommended_fix', 'Review duplicate tracking or client reference values before importing again.'
                 )
               ),
               metadata = jsonb_strip_nulls(
                 COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                   'related_nodes', COALESCE(v_result->'related_nodes', '[]'::jsonb),
                   'primary_result', COALESCE(v_result->'primary_result', '{}'::jsonb),
                   'duplicate_reused', true,
                   'duplicate_operation', COALESCE(v_result->'primary_result'->>'operation', 'reused')
                 )
               ),
               updated_at = now()
         WHERE id = v_row.id;
      ELSE
        UPDATE public.tabular_import_run_rows
           SET execution_status = 'succeeded',
               processed_at = now(),
               mapped_row = COALESCE(v_result->'mapped_row', mapped_row),
               target_record_id = NULLIF(btrim(COALESCE(v_result->>'target_record_id', '')), ''),
               metadata = jsonb_strip_nulls(
                 COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                   'related_nodes', COALESCE(v_result->'related_nodes', '[]'::jsonb),
                   'primary_result', COALESCE(v_result->'primary_result', '{}'::jsonb)
                 )
               ),
               updated_at = now()
         WHERE id = v_row.id;
      END IF;
$new$;
BEGIN
  SELECT pg_get_functiondef('public.process_tabular_import_run_v1(uuid, integer)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.process_tabular_import_run_v1(uuid, integer) is missing';
  END IF;

  IF position('existing_duplicate_reuse_skip_branch_v1' IN v_def) = 0 THEN
    v_new_def := replace(v_def, v_old, replace(v_new, 'v_result := public.tabular_import_execute_row_graph_v1', '-- existing_duplicate_reuse_skip_branch_v1' || chr(10) || '      v_result := public.tabular_import_execute_row_graph_v1'));

    IF v_new_def = v_def THEN
      RAISE EXCEPTION 'Could not patch process_tabular_import_run_v1 existing duplicate reuse branch';
    END IF;

    EXECUTE v_new_def;
  END IF;
END;
$patch$;

COMMENT ON FUNCTION public.process_tabular_import_run_v1(UUID, INTEGER)
  IS 'Processes queued tabular import rows through canonical row graph execution, classifying shipment-create duplicate reuse as skipped duplicate rows so run counts match actual created shipment truth.';

SELECT pg_advisory_unlock(hashtext('202606042040_tabular_import_existing_duplicate_reuse_skip_v1'));
COMMIT;
