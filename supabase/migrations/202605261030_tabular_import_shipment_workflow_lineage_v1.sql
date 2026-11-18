-- Console V2 import-created shipments must carry persisted workflow lineage.
-- The file import worker already stages rows through the tabular import SSOT;
-- this migration keeps shipment materialization on the workflow engine path and
-- exposes the resulting workflow run in the import-run detail readback.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605261030_tabular_import_shipment_workflow_lineage_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'import', 'Import', 42, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'request_entry_point'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

CREATE OR REPLACE FUNCTION public.tabular_import_write_shipment_v1(
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_org UUID;
  v_client UUID;
  v_sender UUID;
  v_tracking TEXT;
  v_client_reference TEXT;
  v_carrier_reference TEXT;
  v_service_type TEXT;
  v_status TEXT;
  v_recipient_id UUID;
  v_destination_address_id UUID;
  v_origin_address_id UUID;
  v_cod_amount NUMERIC;
  v_cod_amount_text TEXT;
  v_cod_currency TEXT;
  v_box_count INT;
  v_box_count_text TEXT;
  v_promised_delivery_date DATE;
  v_promised_delivery_date_text TEXT;
  v_special_instructions TEXT;
  v_shipment_payload JSONB;
  v_template_id UUID;
  v_correlation_id UUID := gen_random_uuid();
  v_run_id UUID;
  v_run_context JSONB := '{}'::jsonb;
  v_progress JSONB;
  v_create_result JSONB := '{}'::jsonb;
  v_shipment_id UUID;
  v_result JSONB;
  v_workflow_status TEXT;
  v_operation TEXT;
  v_is_duplicate_reuse BOOLEAN := FALSE;
  v_attempt INT;
BEGIN
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'tabular_import_write_shipment_v1 requires payload object';
  END IF;

  v_org := NULLIF(btrim(COALESCE(v_payload->>'organization_id', '')), '')::UUID;
  v_client := NULLIF(btrim(COALESCE(v_payload->>'client_id', '')), '')::UUID;
  v_sender := NULLIF(btrim(COALESCE(v_payload->>'sender_id', '')), '')::UUID;
  v_tracking := NULLIF(btrim(COALESCE(v_payload->>'tracking_number', '')), '');
  v_client_reference := NULLIF(btrim(COALESCE(v_payload->>'client_reference_number', '')), '');
  v_carrier_reference := NULLIF(btrim(COALESCE(v_payload->>'carrier_reference_number', '')), '');
  v_service_type := COALESCE(NULLIF(btrim(COALESCE(v_payload->>'service_type', '')), ''), 'delivery');
  v_status := COALESCE(NULLIF(btrim(COALESCE(v_payload->>'status', '')), ''), 'pending');
  v_recipient_id := public.mapping_studio_try_uuid_v1(v_payload->>'recipient_id');
  v_destination_address_id := public.mapping_studio_try_uuid_v1(v_payload->>'destination_address_id');
  v_origin_address_id := public.mapping_studio_try_uuid_v1(v_payload->>'origin_address_id');
  v_cod_amount_text := NULLIF(btrim(COALESCE(v_payload->>'cod_amount', '')), '');
  v_cod_currency := NULLIF(btrim(COALESCE(v_payload->>'cod_currency', '')), '');
  v_box_count_text := NULLIF(btrim(COALESCE(v_payload->>'box_count', '')), '');
  v_promised_delivery_date_text := NULLIF(btrim(COALESCE(v_payload->>'promised_delivery_date', '')), '');
  v_special_instructions := NULLIF(btrim(COALESCE(v_payload->>'special_instructions', '')), '');

  IF v_org IS NULL OR v_client IS NULL OR v_tracking IS NULL THEN
    RAISE EXCEPTION 'tabular_import_write_shipment_v1 requires organization_id, client_id, and tracking_number';
  END IF;

  IF v_cod_amount_text IS NOT NULL THEN
    IF v_cod_amount_text ~ '^-?[0-9]+(\.[0-9]+)?$' THEN
      v_cod_amount := v_cod_amount_text::NUMERIC;
    ELSE
      RAISE EXCEPTION 'tabular_import_write_shipment_v1 cod_amount must be numeric';
    END IF;
  END IF;

  IF v_box_count_text IS NOT NULL THEN
    IF v_box_count_text ~ '^[0-9]+$' THEN
      v_box_count := v_box_count_text::INT;
    ELSE
      RAISE EXCEPTION 'tabular_import_write_shipment_v1 box_count must be an integer';
    END IF;
    IF v_box_count < 1 THEN
      RAISE EXCEPTION 'tabular_import_write_shipment_v1 box_count must be at least 1';
    END IF;
  END IF;

  IF v_promised_delivery_date_text IS NOT NULL THEN
    BEGIN
      v_promised_delivery_date := v_promised_delivery_date_text::DATE;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'tabular_import_write_shipment_v1 promised_delivery_date must be a date';
    END;
  END IF;

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'shipment_manual_create_v1'
     AND status = 'active'
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'tabular_import_write_shipment_v1 workflow template shipment_manual_create_v1 not found';
  END IF;

  v_shipment_payload := jsonb_strip_nulls(jsonb_build_object(
    'tracking_number', v_tracking,
    'client_reference_number', v_client_reference,
    'carrier_reference_number', v_carrier_reference,
    'service_type', v_service_type,
    'status', v_status,
    'recipient_id', v_recipient_id,
    'destination_address_id', v_destination_address_id,
    'origin_address_id', v_origin_address_id,
    'cod_amount', v_cod_amount,
    'cod_currency', v_cod_currency,
    'box_count', v_box_count,
    'promised_delivery_date', v_promised_delivery_date,
    'special_instructions', v_special_instructions
  ));

  v_run_id := public.start_workflow_run(
    v_template_id,
    jsonb_strip_nulls(jsonb_build_object(
      'trigger_source', 'import',
      'correlation_id', v_correlation_id,
      'organization_id', v_org,
      'client_id', v_client,
      'sender_id', v_sender,
      'recipient_id', v_recipient_id,
      'destination_address_id', v_destination_address_id,
      'origin_address_id', v_origin_address_id,
      'planned_tracking_number', v_tracking,
      'client_reference_number', v_client_reference,
      'carrier_reference_number', v_carrier_reference,
      'service_type', v_service_type,
      'initial_status', v_status,
      'shipment', v_shipment_payload,
      'metadata', jsonb_strip_nulls(jsonb_build_object(
        'source', 'tabular_import',
        'correlation_id', v_correlation_id
      )),
      'payload', jsonb_build_object(
        'resource', jsonb_strip_nulls(
          v_payload || jsonb_build_object(
            'shipment', v_shipment_payload,
            'tracking_number', v_tracking,
            'client_reference_number', v_client_reference,
            'carrier_reference_number', v_carrier_reference,
            'recipient_id', v_recipient_id,
            'destination_address_id', v_destination_address_id,
            'origin_address_id', v_origin_address_id,
            'metadata', jsonb_strip_nulls(
              COALESCE(
                CASE
                  WHEN jsonb_typeof(v_payload->'metadata') = 'object' THEN v_payload->'metadata'
                  ELSE '{}'::jsonb
                END,
                '{}'::jsonb
              ) || jsonb_build_object(
                'source', 'tabular_import',
                'correlation_id', v_correlation_id
              )
            ),
            'references', jsonb_strip_nulls(jsonb_build_object(
              'client_reference_number', v_client_reference,
              'carrier_reference_number', v_carrier_reference
            ))
          )
        )
      )
    ))
  );

  UPDATE public.workflow_runs
     SET triggered_by_request_id = COALESCE(triggered_by_request_id, v_correlation_id),
         updated_at = now()
   WHERE id = v_run_id;

  FOR v_attempt IN 1..6 LOOP
    SELECT public.progress_workflow_run(v_run_id) INTO v_progress;

    SELECT workflow_status, context
      INTO v_workflow_status, v_run_context
      FROM public.workflow_runs
     WHERE id = v_run_id;

    EXIT WHEN v_workflow_status IN ('completed', 'failed', 'waiting', 'blocked');
  END LOOP;

  SELECT step.operation_result
    INTO v_create_result
    FROM public.workflow_run_steps step
   WHERE step.workflow_run_id = v_run_id
     AND step.handler_key = 'shipment_create'
   ORDER BY step.sequence_order
   LIMIT 1;

  BEGIN
    v_shipment_id := COALESCE(
      NULLIF(v_run_context#>>'{shipment,id}', '')::UUID,
      NULLIF(v_run_context#>>'{workflow,context_patch,shipment,id}', '')::UUID,
      NULLIF(v_create_result->>'shipment_id', '')::UUID,
      NULLIF(v_run_context->>'planned_shipment_id', '')::UUID
    );
  EXCEPTION
    WHEN OTHERS THEN
      v_shipment_id := NULL;
  END;

  IF v_shipment_id IS NULL AND v_client IS NOT NULL THEN
    SELECT resolved.shipment_id, resolved.operation
      INTO v_shipment_id, v_operation
      FROM public.resolve_shipment_create_duplicate_v1(
        v_client,
        COALESCE(NULLIF(v_run_context#>>'{shipment,tracking_number}', ''), v_tracking),
        v_client_reference
      ) AS resolved
     LIMIT 1;
  END IF;

  v_operation := COALESCE(v_create_result->>'operation', v_operation);
  v_is_duplicate_reuse :=
    COALESCE(v_operation, '') IN ('reused', 'reused_client_reference')
    OR COALESCE(NULLIF(v_create_result->>'duplicate_reused', '')::BOOLEAN, FALSE);

  IF v_shipment_id IS NULL THEN
    RAISE EXCEPTION 'tabular_import_write_shipment_v1 failed to resolve shipment id from workflow run % status %',
      v_run_id,
      COALESCE(v_workflow_status, 'unknown');
  END IF;

  UPDATE public.shipments
     SET recipient_id = CASE WHEN v_is_duplicate_reuse THEN recipient_id ELSE COALESCE(recipient_id, v_recipient_id) END,
         destination_address_id = CASE WHEN v_is_duplicate_reuse THEN destination_address_id ELSE COALESCE(destination_address_id, v_destination_address_id) END,
         origin_address_id = CASE WHEN v_is_duplicate_reuse THEN origin_address_id ELSE COALESCE(origin_address_id, v_origin_address_id) END,
         cod_amount = CASE WHEN v_is_duplicate_reuse THEN cod_amount ELSE COALESCE(v_cod_amount, cod_amount) END,
         cod_currency = CASE WHEN v_is_duplicate_reuse THEN cod_currency ELSE COALESCE(v_cod_currency, cod_currency) END,
         box_count = CASE WHEN v_is_duplicate_reuse THEN box_count ELSE COALESCE(v_box_count, box_count) END,
         promised_delivery_date = CASE WHEN v_is_duplicate_reuse THEN promised_delivery_date ELSE COALESCE(v_promised_delivery_date, promised_delivery_date) END,
         special_instructions = CASE WHEN v_is_duplicate_reuse THEN special_instructions ELSE COALESCE(v_special_instructions, special_instructions) END,
         metadata = jsonb_strip_nulls(
           (
             CASE
               WHEN v_is_duplicate_reuse THEN COALESCE(metadata, '{}'::jsonb)
               ELSE COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                 'source', 'tabular_import',
                 'workflow_run_id', v_run_id,
                 'workflow_template_id', v_template_id,
                 'correlation_id', v_correlation_id
               )
             END
           ) || jsonb_build_object(
             'import_workflow_runs',
             COALESCE(
               CASE
                 WHEN jsonb_typeof(metadata->'import_workflow_runs') = 'array' THEN metadata->'import_workflow_runs'
                 ELSE '[]'::jsonb
               END,
               '[]'::jsonb
             ) || jsonb_build_array(
               jsonb_strip_nulls(
                 jsonb_build_object(
                   'workflow_run_id', v_run_id,
                   'workflow_template_id', v_template_id,
                   'workflow_status', v_workflow_status,
                   'correlation_id', v_correlation_id,
                   'operation', v_operation,
                   'source', 'tabular_import'
                 )
               )
             )
           )
         ),
         updated_at = now()
   WHERE id = v_shipment_id;

  SELECT to_jsonb(s.*)
    INTO v_result
    FROM public.shipments s
   WHERE s.id = v_shipment_id;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'tabular_import_write_shipment_v1 failed to load shipment %', v_shipment_id;
  END IF;

  RETURN jsonb_strip_nulls(
    v_result || jsonb_build_object(
      'workflow_run_id', v_run_id,
      'workflow_template_id', v_template_id,
      'workflow_status', v_workflow_status,
      'correlation_id', v_correlation_id,
      'operation', v_operation
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_get_tabular_import_run_v1(
  p_run_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_run public.tabular_import_runs%ROWTYPE;
  v_resource JSONB;
  v_capability TEXT;
  v_artifacts JSONB := '[]'::jsonb;
  v_rows JSONB := '[]'::jsonb;
  v_report JSONB := NULL;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'ui_get_tabular_import_run_v1 requires run id';
  END IF;

  SELECT *
    INTO v_run
    FROM public.tabular_import_runs
   WHERE id = p_run_id;

  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'ui_get_tabular_import_run_v1 run % not found', p_run_id;
  END IF;

  IF NOT public.is_platform_user()
     AND v_run.organization_id IS DISTINCT FROM public.current_user_org_id() THEN
    RAISE EXCEPTION 'ui_get_tabular_import_run_v1 cannot read another organization';
  END IF;

  v_resource := public.tabular_import_resolve_resource_v1(v_run.resource_key);
  v_capability := COALESCE(
    NULLIF(btrim(COALESCE(v_resource#>>ARRAY['import','capability'], '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_write', '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_read', '')), ''),
    'system.write'
  );
  PERFORM public.assert_capability_v1(v_capability, 'tenant', v_run.organization_id);

  SELECT COALESCE(
    jsonb_agg(
      jsonb_strip_nulls(
        jsonb_build_object(
          'artifact_id', a.id,
          'relation_type', link.relation_type,
          'storage_bucket', a.storage_bucket,
          'storage_key', a.storage_key,
          'mime_type', a.mime_type,
          'file_name', COALESCE(NULLIF(btrim(COALESCE(a.metadata->>'file_name', '')), ''), split_part(a.storage_key, '/', array_length(string_to_array(a.storage_key, '/'), 1))),
          'metadata', a.metadata
        )
      )
      ORDER BY link.created_at ASC
    ),
    '[]'::jsonb
  )
    INTO v_artifacts
    FROM public.artifact_links link
    JOIN public.artifacts a ON a.id = link.artifact_id
   WHERE link.organization_id = v_run.organization_id
     AND link.resource_type = 'tabular_import_runs'
     AND link.resource_id = v_run.id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_strip_nulls(
        jsonb_build_object(
          'row_number', row_number,
          'execution_status', execution_status,
          'action', action,
          'diagnostics', diagnostics,
          'coercions', coercions,
          'original_row', original_row,
          'mapped_row', mapped_row,
          'target_record_id', target_record_id,
          'workflow_run_id', COALESCE(metadata#>>'{primary_result,workflow_run_id}', metadata->>'workflow_run_id'),
          'workflow_status', metadata#>>'{primary_result,workflow_status}',
          'primary_result', metadata->'primary_result',
          'reason_codes', reason_codes,
          'reason_messages', reason_messages,
          'related_nodes', COALESCE(metadata->'related_nodes', '[]'::jsonb)
        )
      )
      ORDER BY row_number ASC
    ),
    '[]'::jsonb
  )
    INTO v_rows
    FROM (
      SELECT *
      FROM public.tabular_import_run_rows
      WHERE run_id = v_run.id
      ORDER BY row_number ASC
      LIMIT 25
    ) sample_rows;

  IF v_run.report_id IS NOT NULL THEN
    SELECT to_jsonb(r.*)
      INTO v_report
      FROM public.mapping_operation_reports r
     WHERE r.id = v_run.report_id;
  END IF;

  RETURN jsonb_strip_nulls(
    to_jsonb(v_run) || jsonb_build_object(
      'artifacts', COALESCE(v_artifacts, '[]'::jsonb),
      'rows', COALESCE(v_rows, '[]'::jsonb),
      'report', v_report
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.tabular_import_write_shipment_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_write_shipment_v1(JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.ui_get_tabular_import_run_v1(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_get_tabular_import_run_v1(UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605261030_tabular_import_shipment_workflow_lineage_v1'));
COMMIT;
