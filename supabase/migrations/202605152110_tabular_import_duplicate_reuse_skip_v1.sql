-- Console V2 import duplicate-row readback guard.
--
-- Shipment creation is canonical and may reuse an existing shipment when a
-- tracking number or client reference is duplicated. The tabular import worker
-- must surface that reuse as a skipped duplicate row instead of counting it as
-- a second created shipment.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605152110_tabular_import_duplicate_reuse_skip_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_def TEXT;
  v_new_def TEXT;
  v_loop_old TEXT := $loop_old$  LOOP
    BEGIN
      v_result := public.tabular_import_execute_row_graph_v1(v_run.id, v_row.id);
$loop_old$;
  v_loop_new TEXT := $loop_new$  LOOP
    BEGIN
      -- duplicate_tracking_or_reference_reused_in_file: do not execute a second create row
      -- that resolves to an already processed shipment identity in this same import run.
      IF v_row.action = 'create'
         AND EXISTS (
           SELECT 1
             FROM public.tabular_import_run_rows prior_row
            WHERE prior_row.run_id = v_run.id
              AND prior_row.id <> v_row.id
              AND prior_row.row_number < v_row.row_number
              AND prior_row.execution_status IN ('succeeded', 'skipped')
              AND prior_row.target_record_id IS NOT NULL
              AND (
                (
                  NULLIF(upper(btrim(COALESCE(v_row.mapped_row->>'tracking_number', ''))), '') IS NOT NULL
                  AND upper(btrim(COALESCE(prior_row.mapped_row->>'tracking_number', ''))) =
                    upper(btrim(COALESCE(v_row.mapped_row->>'tracking_number', '')))
                )
                OR (
                  NULLIF(upper(btrim(COALESCE(v_row.mapped_row->>'client_reference_number', ''))), '') IS NOT NULL
                  AND upper(btrim(COALESCE(prior_row.mapped_row->>'client_reference_number', ''))) =
                    upper(btrim(COALESCE(v_row.mapped_row->>'client_reference_number', '')))
                )
              )
            LIMIT 1
         ) THEN
        UPDATE public.tabular_import_run_rows
           SET action = 'skip',
               execution_status = 'skipped',
               processed_at = now(),
               target_record_id = (
                 SELECT prior_row.target_record_id
                   FROM public.tabular_import_run_rows prior_row
                  WHERE prior_row.run_id = v_run.id
                    AND prior_row.id <> v_row.id
                    AND prior_row.row_number < v_row.row_number
                    AND prior_row.execution_status IN ('succeeded', 'skipped')
                    AND prior_row.target_record_id IS NOT NULL
                    AND (
                      (
                        NULLIF(upper(btrim(COALESCE(v_row.mapped_row->>'tracking_number', ''))), '') IS NOT NULL
                        AND upper(btrim(COALESCE(prior_row.mapped_row->>'tracking_number', ''))) =
                          upper(btrim(COALESCE(v_row.mapped_row->>'tracking_number', '')))
                      )
                      OR (
                        NULLIF(upper(btrim(COALESCE(v_row.mapped_row->>'client_reference_number', ''))), '') IS NOT NULL
                        AND upper(btrim(COALESCE(prior_row.mapped_row->>'client_reference_number', ''))) =
                          upper(btrim(COALESCE(v_row.mapped_row->>'client_reference_number', '')))
                      )
                    )
                  ORDER BY prior_row.row_number ASC
                  LIMIT 1
               ),
               reason_codes = COALESCE(reason_codes, '[]'::jsonb)
                 || jsonb_build_array('duplicate_shipment_reused'),
               reason_messages = COALESCE(reason_messages, '[]'::jsonb)
                 || jsonb_build_array('Duplicate shipment input reused an earlier shipment in this import run; no new shipment was created.'),
               diagnostics = COALESCE(diagnostics, '[]'::jsonb) || jsonb_build_array(
                 jsonb_build_object(
                   'level', 'warning',
                   'blocking', false,
                   'code', 'duplicate_shipment_reused',
                   'message', 'Duplicate shipment input reused an earlier shipment in this import run; no new shipment was created.',
                   'recommended_fix', 'Review duplicate tracking or client reference values before importing again.'
                 )
               ),
               metadata = jsonb_strip_nulls(
                 COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                   'duplicate_reused', true,
                   'duplicate_operation', 'reused_in_file'
                 )
               ),
               updated_at = now()
         WHERE id = v_row.id;

        CONTINUE;
      END IF;

      v_result := public.tabular_import_execute_row_graph_v1(v_run.id, v_row.id);
$loop_new$;
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
         AND COALESCE(v_result->'primary_result'->>'operation', '') IN ('reused', 'reused_client_reference') THEN
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
                   'duplicate_operation', COALESCE(v_result->'primary_result'->>'operation', '')
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

  IF position('duplicate_tracking_or_reference_reused_in_file' IN v_def) = 0 THEN
    v_new_def := replace(v_def, v_loop_old, v_loop_new);

    IF v_new_def = v_def THEN
      RAISE EXCEPTION 'Could not patch process_tabular_import_run_v1 same-run duplicate shipment reuse branch';
    END IF;

    EXECUTE v_new_def;
    SELECT pg_get_functiondef('public.process_tabular_import_run_v1(uuid, integer)'::regprocedure)
      INTO v_def;
  END IF;

  IF position('duplicate_shipment_reused' IN v_def) = 0 THEN
    v_new_def := replace(v_def, v_old, v_new);

    IF v_new_def = v_def THEN
      RAISE EXCEPTION 'Could not patch process_tabular_import_run_v1 duplicate shipment reuse branch';
    END IF;

    EXECUTE v_new_def;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.process_tabular_import_run_v1(UUID, INTEGER)
  IS 'Processes queued tabular import rows through canonical row graph execution, classifying shipment-create duplicate reuse as skipped duplicate rows so run counts match actual created shipment truth.';

SELECT pg_advisory_unlock(hashtext('202605152110_tabular_import_duplicate_reuse_skip_v1'));
COMMIT;
