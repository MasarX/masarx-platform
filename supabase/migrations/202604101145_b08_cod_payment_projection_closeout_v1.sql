-- Plan: B08 Delivery proof & closeout / Step: E05
-- Migration: COD payment projection closeout v1
-- Purpose:
--   - Project canonical COD payment collection fields onto shipment_actions for browser-safe reads.
--   - Persist payment_collection into shipment / route_stop delivery_completion through the finalize wrapper.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604101145_b08_cod_payment_projection_closeout_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Browser-safe shipment_actions COD payment projections
-------------------------------------------------------------------------------

ALTER TABLE public.shipment_actions
  ADD COLUMN IF NOT EXISTS payment_collection_outcome TEXT
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(
          COALESCE(
            action_data #>> ARRAY['delivery_completion', 'payment_collection', 'outcome'],
            action_data #>> ARRAY['task_event_payload', 'payment_collection', 'outcome'],
            action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'payment_collection', 'outcome'],
            ''
          )
        ),
        ''
      )
    ) STORED,
  ADD COLUMN IF NOT EXISTS payment_collection_method TEXT
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(
          COALESCE(
            action_data #>> ARRAY['delivery_completion', 'payment_collection', 'method'],
            action_data #>> ARRAY['task_event_payload', 'payment_collection', 'method'],
            action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'payment_collection', 'method'],
            ''
          )
        ),
        ''
      )
    ) STORED,
  ADD COLUMN IF NOT EXISTS payment_expected_amount NUMERIC
    GENERATED ALWAYS AS (
      CASE
        WHEN COALESCE(
          action_data #>> ARRAY['delivery_completion', 'payment_collection', 'expected_amount'],
          action_data #>> ARRAY['task_event_payload', 'payment_collection', 'expected_amount'],
          action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'payment_collection', 'expected_amount'],
          ''
        ) ~ '^-?[0-9]+(\.[0-9]+)?$'
        THEN (
          COALESCE(
            action_data #>> ARRAY['delivery_completion', 'payment_collection', 'expected_amount'],
            action_data #>> ARRAY['task_event_payload', 'payment_collection', 'expected_amount'],
            action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'payment_collection', 'expected_amount']
          )
        )::numeric
        ELSE NULL
      END
    ) STORED,
  ADD COLUMN IF NOT EXISTS payment_collected_amount NUMERIC
    GENERATED ALWAYS AS (
      CASE
        WHEN COALESCE(
          action_data #>> ARRAY['delivery_completion', 'payment_collection', 'collected_amount'],
          action_data #>> ARRAY['task_event_payload', 'payment_collection', 'collected_amount'],
          action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'payment_collection', 'collected_amount'],
          ''
        ) ~ '^-?[0-9]+(\.[0-9]+)?$'
        THEN (
          COALESCE(
            action_data #>> ARRAY['delivery_completion', 'payment_collection', 'collected_amount'],
            action_data #>> ARRAY['task_event_payload', 'payment_collection', 'collected_amount'],
            action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'payment_collection', 'collected_amount']
          )
        )::numeric
        ELSE NULL
      END
    ) STORED,
  ADD COLUMN IF NOT EXISTS payment_variance_amount NUMERIC
    GENERATED ALWAYS AS (
      CASE
        WHEN COALESCE(
          action_data #>> ARRAY['delivery_completion', 'payment_collection', 'variance_amount'],
          action_data #>> ARRAY['task_event_payload', 'payment_collection', 'variance_amount'],
          action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'payment_collection', 'variance_amount'],
          ''
        ) ~ '^-?[0-9]+(\.[0-9]+)?$'
        THEN (
          COALESCE(
            action_data #>> ARRAY['delivery_completion', 'payment_collection', 'variance_amount'],
            action_data #>> ARRAY['task_event_payload', 'payment_collection', 'variance_amount'],
            action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'payment_collection', 'variance_amount']
          )
        )::numeric
        ELSE NULL
      END
    ) STORED,
  ADD COLUMN IF NOT EXISTS payment_discrepancy_kind TEXT
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(
          COALESCE(
            action_data #>> ARRAY['delivery_completion', 'payment_collection', 'discrepancy_kind'],
            action_data #>> ARRAY['task_event_payload', 'payment_collection', 'discrepancy_kind'],
            action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'payment_collection', 'discrepancy_kind'],
            ''
          )
        ),
        ''
      )
    ) STORED,
  ADD COLUMN IF NOT EXISTS payment_currency TEXT
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(
          COALESCE(
            action_data #>> ARRAY['delivery_completion', 'payment_collection', 'currency'],
            action_data #>> ARRAY['task_event_payload', 'payment_collection', 'currency'],
            action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'payment_collection', 'currency'],
            ''
          )
        ),
        ''
      )
    ) STORED,
  ADD COLUMN IF NOT EXISTS payment_receipt_context TEXT
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(
          COALESCE(
            action_data #>> ARRAY['delivery_completion', 'payment_collection', 'receipt_context'],
            action_data #>> ARRAY['task_event_payload', 'payment_collection', 'receipt_context'],
            action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'payment_collection', 'receipt_context'],
            ''
          )
        ),
        ''
      )
    ) STORED,
  ADD COLUMN IF NOT EXISTS payment_has_discrepancy BOOLEAN
    GENERATED ALWAYS AS (
      CASE
        WHEN lower(COALESCE(
          action_data #>> ARRAY['delivery_completion', 'payment_collection', 'has_discrepancy'],
          action_data #>> ARRAY['task_event_payload', 'payment_collection', 'has_discrepancy'],
          action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'payment_collection', 'has_discrepancy'],
          ''
        )) = 'true'
        THEN TRUE
        WHEN lower(COALESCE(
          action_data #>> ARRAY['delivery_completion', 'payment_collection', 'has_discrepancy'],
          action_data #>> ARRAY['task_event_payload', 'payment_collection', 'has_discrepancy'],
          action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'payment_collection', 'has_discrepancy'],
          ''
        )) = 'false'
        THEN FALSE
        WHEN COALESCE(
          action_data #>> ARRAY['delivery_completion', 'payment_collection', 'variance_amount'],
          action_data #>> ARRAY['task_event_payload', 'payment_collection', 'variance_amount'],
          action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'payment_collection', 'variance_amount'],
          ''
        ) ~ '^-?[0-9]+(\.[0-9]+)?$'
        THEN (
          COALESCE(
            action_data #>> ARRAY['delivery_completion', 'payment_collection', 'variance_amount'],
            action_data #>> ARRAY['task_event_payload', 'payment_collection', 'variance_amount'],
            action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'payment_collection', 'variance_amount']
          )::numeric <> 0
        )
        ELSE NULL
      END
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_shipment_actions_payment_collection_outcome_not_null
  ON public.shipment_actions (payment_collection_outcome, timestamp DESC)
  WHERE payment_collection_outcome IS NOT NULL;

CREATE OR REPLACE VIEW api.shipment_actions
WITH (security_invoker = true) AS
SELECT *
FROM public.shipment_actions;

REVOKE ALL ON api.shipment_actions FROM PUBLIC;
REVOKE ALL ON api.shipment_actions FROM anon;
GRANT SELECT ON api.shipment_actions TO authenticated, service_role;

DO $do$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_select JSONB := '[]'::jsonb;
  v_columns JSONB := '[]'::jsonb;
  v_select_key TEXT;
  v_found BOOLEAN := FALSE;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

  FOR v_resource IN
    SELECT value
      FROM jsonb_array_elements(v_resources) AS value
  LOOP
    IF v_resource->>'key' = 'shipment_actions' THEN
      v_found := TRUE;
      v_resource := jsonb_set(v_resource, '{relation}', to_jsonb('api.shipment_actions'::text), TRUE);
      v_select := COALESCE(v_resource->'select', '[]'::jsonb);
      v_columns := COALESCE(v_resource->'columns', '[]'::jsonb);

      FOREACH v_select_key IN ARRAY ARRAY[
        'payment_collection_outcome',
        'payment_collection_method',
        'payment_expected_amount',
        'payment_collected_amount',
        'payment_variance_amount',
        'payment_discrepancy_kind',
        'payment_currency',
        'payment_receipt_context',
        'payment_has_discrepancy'
      ] LOOP
        IF NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(v_select) AS item(value)
          WHERE item.value = v_select_key
        ) THEN
          v_select := v_select || to_jsonb(v_select_key);
        END IF;
      END LOOP;

      v_columns := v_columns
        || jsonb_build_array(
          jsonb_build_object('key', 'payment_collection_outcome', 'label', 'Payment outcome', 'detail_section', 'Payment collection'),
          jsonb_build_object('key', 'payment_collection_method', 'label', 'Payment method', 'detail_section', 'Payment collection'),
          jsonb_build_object('key', 'payment_expected_amount', 'label', 'Expected amount', 'render_type', 'number', 'detail_section', 'Payment collection'),
          jsonb_build_object('key', 'payment_collected_amount', 'label', 'Collected amount', 'render_type', 'number', 'detail_section', 'Payment collection'),
          jsonb_build_object('key', 'payment_variance_amount', 'label', 'Variance amount', 'render_type', 'number', 'detail_section', 'Payment collection'),
          jsonb_build_object('key', 'payment_discrepancy_kind', 'label', 'Discrepancy kind', 'detail_section', 'Payment collection'),
          jsonb_build_object('key', 'payment_currency', 'label', 'Currency', 'detail_section', 'Payment collection'),
          jsonb_build_object('key', 'payment_receipt_context', 'label', 'Receipt context', 'detail_section', 'Payment collection'),
          jsonb_build_object('key', 'payment_has_discrepancy', 'label', 'Has discrepancy', 'detail_section', 'Payment collection')
        );

      v_resource := jsonb_set(v_resource, '{select}', v_select, TRUE);
      v_resource := jsonb_set(v_resource, '{columns}', v_columns, TRUE);
    END IF;

    v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
  END LOOP;

  IF v_found IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_read_registry missing shipment_actions resource';
  END IF;

  v_current := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

  WITH current AS (
    SELECT s.id AS settings_id, s.settings_version_id, sv.version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Expose COD payment collection projections on shipment_actions',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value, current.settings_id
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.id = applied.settings_id;
END;
$do$;

-------------------------------------------------------------------------------
-- 2) Canonical route-stop finalize wrapper persists payment_collection
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_route_stop_finalize_v8(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_payload JSONB := COALESCE(v_ctx->'payload', '{}'::jsonb);
  v_task_event_payload JSONB := COALESCE(v_payload->'task_event_payload', '{}'::jsonb);
  v_route_stop_id UUID := NULL;
  v_task_event_id UUID := NULL;
  v_stop RECORD;
  v_payment_collection JSONB := NULL;
  v_delivered_box_ids JSONB := NULL;
  v_delivered_box_numbers JSONB := NULL;
  v_shipment_action_id UUID := NULL;
  v_delivery_completion_patch JSONB := '{}'::jsonb;
  v_delivery_completion JSONB := '{}'::jsonb;
  v_resp public.workflow_handler_response;
BEGIN
  IF jsonb_typeof(v_task_event_payload->'payment_collection') = 'object' THEN
    v_payment_collection := v_task_event_payload->'payment_collection';
  ELSIF jsonb_typeof(v_task_event_payload #> '{delivery_completion,payment_collection}') = 'object' THEN
    v_payment_collection := v_task_event_payload #> '{delivery_completion,payment_collection}';
  END IF;

  IF jsonb_typeof(v_task_event_payload #> '{delivery_completion,delivered_box_ids}') = 'array' THEN
    v_delivered_box_ids := v_task_event_payload #> '{delivery_completion,delivered_box_ids}';
  ELSIF jsonb_typeof(v_task_event_payload->'delivered_box_ids') = 'array' THEN
    v_delivered_box_ids := v_task_event_payload->'delivered_box_ids';
  ELSIF jsonb_typeof(v_task_event_payload #> '{pod,delivered_box_ids}') = 'array' THEN
    v_delivered_box_ids := v_task_event_payload #> '{pod,delivered_box_ids}';
  END IF;

  IF jsonb_typeof(v_task_event_payload #> '{delivery_completion,delivered_box_numbers}') = 'array' THEN
    v_delivered_box_numbers := v_task_event_payload #> '{delivery_completion,delivered_box_numbers}';
  ELSIF jsonb_typeof(v_task_event_payload->'delivered_box_numbers') = 'array' THEN
    v_delivered_box_numbers := v_task_event_payload->'delivered_box_numbers';
  ELSIF jsonb_typeof(v_task_event_payload #> '{pod,delivered_box_numbers}') = 'array' THEN
    v_delivered_box_numbers := v_task_event_payload #> '{pod,delivered_box_numbers}';
  END IF;

  v_resp := workflow_handlers.execute_route_stop_finalize_v7(p_step, p_run, p_operation_result);
  IF COALESCE(v_resp.status, '') <> 'completed' THEN
    RETURN v_resp;
  END IF;

  IF v_payment_collection IS NOT NULL THEN
    v_delivery_completion_patch := v_delivery_completion_patch || jsonb_build_object('payment_collection', v_payment_collection);
  END IF;
  IF v_delivered_box_ids IS NOT NULL THEN
    v_delivery_completion_patch := v_delivery_completion_patch || jsonb_build_object('delivered_box_ids', v_delivered_box_ids);
  END IF;
  IF v_delivered_box_numbers IS NOT NULL THEN
    v_delivery_completion_patch := v_delivery_completion_patch || jsonb_build_object('delivered_box_numbers', v_delivered_box_numbers);
  END IF;
  IF v_delivery_completion_patch = '{}'::jsonb THEN
    RETURN v_resp;
  END IF;

  v_delivery_completion := COALESCE(v_resp.operation_result->'delivery_completion', '{}'::jsonb);
  IF jsonb_typeof(v_delivery_completion) <> 'object' THEN
    v_delivery_completion := '{}'::jsonb;
  END IF;
  v_delivery_completion := v_delivery_completion || v_delivery_completion_patch;

  v_resp.operation_result := jsonb_set(
    COALESCE(v_resp.operation_result, '{}'::jsonb),
    '{delivery_completion}',
    v_delivery_completion,
    TRUE
  );

  BEGIN
    v_route_stop_id := NULLIF(v_ctx->>'resource_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_stop_id := NULL;
  END;
  BEGIN
    v_task_event_id := NULLIF(v_task_event_payload->>'task_event_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_task_event_id := NULL;
  END;

  IF v_route_stop_id IS NULL THEN
    RETURN v_resp;
  END IF;

  SELECT rs.organization_id, rs.client_id, rs.shipment_id
    INTO v_stop
    FROM public.route_stops rs
   WHERE rs.id = v_route_stop_id
   LIMIT 1;

  IF v_stop.shipment_id IS NULL THEN
    RETURN v_resp;
  END IF;

  SELECT sa.id
    INTO v_shipment_action_id
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = v_stop.shipment_id
     AND sa.organization_id = v_stop.organization_id
     AND sa.client_id = v_stop.client_id
     AND (
       (v_task_event_id IS NOT NULL AND (sa.action_data->>'task_event_id') = v_task_event_id::text)
       OR (sa.action_data->>'route_stop_id') = v_route_stop_id::text
     )
   ORDER BY
     CASE
       WHEN v_task_event_id IS NOT NULL AND (sa.action_data->>'task_event_id') = v_task_event_id::text THEN 0
       ELSE 1
     END,
     sa.timestamp DESC,
     sa.created_at DESC
   LIMIT 1;

  IF v_shipment_action_id IS NOT NULL THEN
    UPDATE public.shipment_actions sa
       SET action_data = jsonb_set(COALESCE(sa.action_data, '{}'::jsonb), '{delivery_completion}', v_delivery_completion, TRUE)
     WHERE sa.id = v_shipment_action_id;
  END IF;

  UPDATE public.shipments s
     SET metadata = jsonb_set(COALESCE(s.metadata, '{}'::jsonb), '{delivery_completion}', v_delivery_completion, TRUE),
         updated_at = now()
   WHERE s.id = v_stop.shipment_id
     AND s.client_id = v_stop.client_id;

  UPDATE public.route_stops rs
     SET metadata = jsonb_set(COALESCE(rs.metadata, '{}'::jsonb), '{delivery_completion}', v_delivery_completion, TRUE),
         updated_at = now()
   WHERE rs.id = v_route_stop_id;

  RETURN v_resp;
END;
$function$;

ALTER TABLE public.operation_handlers DISABLE TRIGGER operation_handlers_validate_signature;

INSERT INTO public.operation_handlers (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES (
  'route_stop_finalize',
  'workflow_handlers',
  'execute_route_stop_finalize_v8',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v8',
  TRUE,
  'Finalize a dispatch route_stop execution through v7 while persisting canonical payment_collection into shipment_actions, shipments, and route_stops delivery completion metadata.',
  'docs/product/guides/handlers-cookbook.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

ALTER TABLE public.operation_handlers ENABLE TRIGGER operation_handlers_validate_signature;

DO $do$
DECLARE
  v_template_id UUID;
BEGIN
  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'dispatch_route_stop_finalize_v1'
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.workflow_template_steps
     SET handler_version = 'v8',
         updated_at = now()
   WHERE workflow_template_id = v_template_id
     AND handler_key = 'route_stop_finalize';
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604101145_b08_cod_payment_projection_closeout_v1'));
COMMIT;
