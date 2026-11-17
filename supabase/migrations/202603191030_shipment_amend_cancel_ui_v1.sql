-- Plan: PLAN-B01-UC030 / Step: S04
-- Migration: Shared authenticated shipment amend/cancel path for console + portal
-- Purpose:
--   - Add one authenticated shipment amend/cancel RPC for console/portal.
--   - Keep temporary pre-dispatch lock semantics sourced only from shipment_operation_policy.
--   - Start real workflow runs through the canonical engine seam instead of fabricating run/step rows.
--   - Reuse existing shipment operation templates for modify/address/cancel and add the missing reschedule template.

BEGIN;

SELECT pg_advisory_lock(hashtext('202603191030_shipment_amend_cancel_ui_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_scope RECORD;
  v_value JSONB;
BEGIN
  UPDATE public.schema_registry
     SET schema = jsonb_set(
           schema,
           '{properties,reschedule}',
           jsonb_build_object('type', 'object'),
           TRUE
         ),
         examples = COALESCE(examples, '[]'::jsonb) || jsonb_build_array(
           jsonb_build_object(
             'version', 1,
             'modify', jsonb_build_object(
               'workflow_template_name', 'shipment_modify_v1'
             ),
             'reschedule', jsonb_build_object(
               'allowed_statuses', jsonb_build_array(
                 'pending',
                 'created',
                 'delivery_failed',
                 'postponed_delivery'
               ),
               'workflow_template_name', 'shipment_reschedule_v1'
             ),
             'address', jsonb_build_object(
               'workflow_template_name', 'shipment_update_address_v1',
               'default_country_code', 'SA'
             ),
             'delete', jsonb_build_object(
               'workflow_template_name', 'shipment_delete_v1'
             )
           ),
           jsonb_build_object(
             'version', 1,
             'address', jsonb_build_object(
               'default_country_code', 'SA'
             ),
             'modify', jsonb_build_object(
               'workflow_template_name', 'shipment_modify_v1'
             ),
             'delete', jsonb_build_object(
               'workflow_template_name', 'shipment_delete_v1'
             ),
             'reschedule', jsonb_build_object(
               'workflow_template_name', 'shipment_reschedule_v1',
               'allowed_statuses', jsonb_build_array(
                 'pending',
                 'created',
                 'delivery_failed',
                 'postponed_delivery'
               )
             )
           )
         )
   WHERE category = 'shipment_operation_policy'
     AND version = 1;

  SELECT *
    INTO v_scope
    FROM public.resolve_settings_row_from_context(
      'shipment_operation_policy',
      '{}'::jsonb
    )
   LIMIT 1;

  v_value := public.resolve_shipment_operation_policy_v1('{}'::jsonb);
  IF COALESCE(jsonb_typeof(v_value->'reschedule'), 'null') <> 'object' THEN
    v_value := jsonb_set(
      v_value,
      '{reschedule}',
      jsonb_build_object(
        'allowed_statuses',
        COALESCE(
          v_value#>'{address,allowed_statuses}',
          jsonb_build_array(
            'pending',
            'created',
            'delivery_failed',
            'postponed_delivery'
          )
        )
      ),
      TRUE
    );
  END IF;

  IF NULLIF(v_value#>>'{modify,workflow_template_name}', '') IS NULL THEN
    v_value := jsonb_set(
      v_value,
      '{modify,workflow_template_name}',
      to_jsonb('shipment_modify_v1'::TEXT),
      TRUE
    );
  END IF;

  IF NULLIF(v_value#>>'{reschedule,workflow_template_name}', '') IS NULL THEN
    v_value := jsonb_set(
      v_value,
      '{reschedule,workflow_template_name}',
      to_jsonb('shipment_reschedule_v1'::TEXT),
      TRUE
    );
  END IF;

  IF NULLIF(v_value#>>'{address,workflow_template_name}', '') IS NULL THEN
    v_value := jsonb_set(
      v_value,
      '{address,workflow_template_name}',
      to_jsonb('shipment_update_address_v1'::TEXT),
      TRUE
    );
  END IF;

  IF NULLIF(v_value#>>'{address,default_country_code}', '') IS NULL THEN
    v_value := jsonb_set(
      v_value,
      '{address,default_country_code}',
      to_jsonb('SA'::TEXT),
      TRUE
    );
  END IF;

  IF NULLIF(v_value#>>'{delete,workflow_template_name}', '') IS NULL THEN
    v_value := jsonb_set(
      v_value,
      '{delete,workflow_template_name}',
      to_jsonb('shipment_delete_v1'::TEXT),
      TRUE
    );
  END IF;

  PERFORM public.upsert_settings_value_v1(
    'shipment_operation_policy',
    COALESCE(v_scope.scope_type, 'global'),
    v_scope.scope_id,
    v_value,
    1,
    'Add temporary reschedule guardrails for authenticated shipment amend/cancel.'
  );
END;
$do$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_reschedule_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_payload JSONB := workflow_handlers.resolve_input_payload_v1(v_ctx);
  v_policy JSONB := public.resolve_shipment_operation_policy_v1(v_ctx);
  v_target RECORD;
  v_result public.workflow_handler_response;
  v_allowed_statuses JSONB := COALESCE(
    v_policy#>'{reschedule,allowed_statuses}',
    v_policy#>'{address,allowed_statuses}',
    '[]'::jsonb
  );
  v_slot_date DATE := NULL;
  v_reserve_result JSONB := '{}'::jsonb;
  v_action_id UUID := NULL;
  v_performed_by_system TEXT := COALESCE(
    NULLIF(v_ctx->>'performed_by_system', ''),
    'workflow_handlers.execute_shipment_reschedule_v1'
  );
BEGIN
  SELECT *
    INTO v_target
    FROM workflow_handlers.resolve_shipment_target_v1(v_ctx)
   LIMIT 1;

  IF v_target.shipment_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_not_found';
    v_result.operation_result := jsonb_build_object('error', 'shipment_not_found');
    RETURN v_result;
  END IF;

  IF NOT workflow_handlers.shipment_status_allowed_v1(v_target.status, v_allowed_statuses) THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_status_not_allowed';
    v_result.operation_result := jsonb_build_object(
      'error',
      'shipment_status_not_allowed',
      'status',
      v_target.status
    );
    RETURN v_result;
  END IF;

  BEGIN
    v_slot_date := COALESCE(
      NULLIF(v_ctx->>'slot_date', '')::DATE,
      NULLIF(v_payload->>'slot_date', '')::DATE
    );
  EXCEPTION
    WHEN others THEN
      v_slot_date := NULL;
  END;

  IF v_slot_date IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'slot_date_required';
    v_result.operation_result := jsonb_build_object('error', 'slot_date_required');
    RETURN v_result;
  END IF;

  v_reserve_result := public.reserve_delivery_slot_v1(
    jsonb_build_object(
      'shipment_id',
      v_target.shipment_id,
      'client_id',
      v_target.client_id,
      'slot_date',
      v_slot_date,
      'performed_by_system',
      v_performed_by_system
    )
  );

  IF COALESCE((v_reserve_result->>'reserved')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
    v_result.status := 'failed';
    v_result.last_error := COALESCE(v_reserve_result->>'reason', 'reschedule_failed');
    v_result.operation_result := v_reserve_result;
    RETURN v_result;
  END IF;

  BEGIN
    v_action_id := NULLIF(v_reserve_result->>'action_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_action_id := NULL;
  END;

  v_result.status := 'completed';
  v_result.retry_attempt := 1;
  v_result.max_retries := 1;
  v_result.context_patch := jsonb_build_object(
    'shipment',
    jsonb_build_object(
      'id',
      v_target.shipment_id,
      'tracking_number',
      v_target.tracking_number
    )
  );
  v_result.operation_result := jsonb_strip_nulls(
    jsonb_build_object(
      'shipment_id',
      v_target.shipment_id,
      'shipment_action_id',
      v_action_id,
      'slot_date',
      v_slot_date,
      'operation',
      CASE
        WHEN COALESCE((v_reserve_result->>'updated')::BOOLEAN, FALSE) THEN 'rescheduled'
        ELSE 'reschedule_no_change'
      END,
      'reserve_result',
      v_reserve_result
    )
  );
  RETURN v_result;
END;
$function$;

INSERT INTO public.operation_handlers AS oh (
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
  'shipment_reschedule',
  'workflow_handlers',
  'execute_shipment_reschedule_v1',
  '(public.workflow_run_steps,public.workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Reserve or reapply a shipment delivery slot through the workflow engine.',
  'docs/ops/runbooks/shipment-amend-cancel.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET
  handler_schema = EXCLUDED.handler_schema,
  handler_name = EXCLUDED.handler_name,
  handler_signature = EXCLUDED.handler_signature,
  handler_version = EXCLUDED.handler_version,
  is_active = EXCLUDED.is_active,
  notes = EXCLUDED.notes,
  doc_url = EXCLUDED.doc_url,
  updated_at = now();

INSERT INTO public.workflow_templates AS wt (
  id,
  name,
  description,
  version,
  status,
  scope_type,
  scope_id,
  created_at,
  updated_at,
  published_at,
  notes,
  metadata
)
VALUES (
  '9d7f95b1-40a2-4f92-9e4c-bdf8d3aa1030',
  'shipment_reschedule_v1',
  'Workflow-engine backed shipment reschedule flow for authenticated UI mutations.',
  1,
  'active',
  'global',
  NULL,
  now(),
  now(),
  now(),
  'Seeded for console/portal shipment amend-cancel reschedule flow.',
  jsonb_build_object(
    'source',
    'shipment_amend_cancel_ui_v1',
    'operation',
    'reschedule'
  )
)
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  version = EXCLUDED.version,
  status = EXCLUDED.status,
  scope_type = EXCLUDED.scope_type,
  scope_id = EXCLUDED.scope_id,
  updated_at = now(),
  published_at = EXCLUDED.published_at,
  notes = EXCLUDED.notes,
  metadata = EXCLUDED.metadata;

INSERT INTO public.workflow_template_steps AS wts (
  id,
  workflow_template_id,
  sequence_order,
  operation_name,
  operation_settings_category,
  transition_condition,
  handler_key,
  handler_version,
  metadata,
  manual_action_required,
  enabled,
  created_at,
  updated_at
)
VALUES
  (
    '9d7f95b1-40a2-4f92-9e4c-bdf8d3aa1031',
    '9d7f95b1-40a2-4f92-9e4c-bdf8d3aa1030',
    0,
    'context_extract_from_mapping',
    'workflow',
    'always',
    'context_extract_from_mapping',
    'v1',
    '{}'::jsonb,
    FALSE,
    TRUE,
    now(),
    now()
  ),
  (
    '9d7f95b1-40a2-4f92-9e4c-bdf8d3aa1032',
    '9d7f95b1-40a2-4f92-9e4c-bdf8d3aa1030',
    10,
    'reserve_delivery_slot',
    'workflow',
    'always',
    'shipment_reschedule',
    'v1',
    '{}'::jsonb,
    FALSE,
    TRUE,
    now(),
    now()
  )
ON CONFLICT (id) DO UPDATE
SET
  workflow_template_id = EXCLUDED.workflow_template_id,
  sequence_order = EXCLUDED.sequence_order,
  operation_name = EXCLUDED.operation_name,
  operation_settings_category = EXCLUDED.operation_settings_category,
  transition_condition = EXCLUDED.transition_condition,
  handler_key = EXCLUDED.handler_key,
  handler_version = EXCLUDED.handler_version,
  metadata = EXCLUDED.metadata,
  manual_action_required = EXCLUDED.manual_action_required,
  enabled = EXCLUDED.enabled,
  updated_at = now();

WITH recalculated AS (
  SELECT
    wts.workflow_template_id,
    md5(
      string_agg(
        concat_ws(
          '|',
          wts.sequence_order,
          COALESCE(wts.operation_name, ''),
          COALESCE(wts.operation_settings_category, ''),
          COALESCE(wts.transition_condition, ''),
          COALESCE(wts.handler_key, ''),
          COALESCE(wts.handler_version, ''),
          COALESCE(wts.metadata::TEXT, '')
        ),
        '||' ORDER BY wts.sequence_order
      )
    ) AS checksum
  FROM public.workflow_template_steps wts
  WHERE wts.workflow_template_id = '9d7f95b1-40a2-4f92-9e4c-bdf8d3aa1030'::UUID
  GROUP BY wts.workflow_template_id
)
UPDATE public.workflow_templates wt
   SET steps_checksum = recalculated.checksum,
       updated_at = now()
  FROM recalculated
 WHERE wt.id = recalculated.workflow_template_id;

CREATE OR REPLACE FUNCTION public.ui_shipment_mutation_access_v1(
  p_shipment_id UUID
)
RETURNS TABLE (
  shipment_id UUID,
  organization_id UUID,
  client_id UUID,
  sender_id UUID,
  tracking_number TEXT,
  status TEXT,
  created_at TIMESTAMPTZ,
  promised_delivery_date DATE,
  service_type TEXT,
  service_level TEXT,
  special_instructions TEXT,
  client_reference_number TEXT,
  carrier_reference_number TEXT,
  cod_amount NUMERIC,
  address_line1 TEXT,
  address_line2 TEXT,
  address_city TEXT,
  address_province TEXT,
  address_country TEXT,
  address_postal_code TEXT,
  address_district TEXT,
  address_building_number TEXT,
  address_additional_directions TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := COALESCE(public.current_user_scope_type(), 'global');
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'shipment amend/cancel requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_resource_capability_v1('shipments', 'write') THEN
    RAISE EXCEPTION 'shipment amend/cancel requires shipments.write capability'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    s.id,
    s.organization_id,
    s.client_id,
    s.sender_id,
    s.tracking_number,
    s.status,
    s.created_at,
    s.promised_delivery_date,
    s.service_type,
    s.service_level,
    s.special_instructions,
    s.client_reference_number,
    s.carrier_reference_number,
    s.cod_amount,
    a.normalized_line1,
    a.normalized_line2,
    a.city,
    a.province,
    a.country,
    a.postal_code,
    a.district,
    a.building_number,
    a.additional_directions
  FROM public.shipments s
  LEFT JOIN public.addresses a
    ON a.id = s.destination_address_id
  WHERE s.id = p_shipment_id
    AND (
      public.is_platform_user()
      OR (
        v_scope_type = 'tenant'
        AND s.organization_id = v_org_id
      )
      OR (
        v_scope_type = 'client'
        AND s.client_id = v_scope_id
      )
      OR (
        v_scope_type = 'sender'
        AND s.sender_id = v_scope_id
      )
    )
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'shipment amend/cancel forbidden or shipment not found: %', p_shipment_id
      USING ERRCODE = '42501';
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.ui_shipment_mutation_access_v1(UUID)
  IS 'Resolve one shipment row for authenticated console/portal amend-cancel flows with scope-aware shipment access.';

CREATE OR REPLACE FUNCTION public.resolve_shipment_operation_template_name_v1(
  p_policy JSONB,
  p_operation TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB := COALESCE(p_policy, '{}'::jsonb);
  v_global_policy JSONB := public.resolve_shipment_operation_policy_v1('{}'::jsonb);
  v_operation TEXT := lower(NULLIF(btrim(COALESCE(p_operation, '')), ''));
BEGIN
  CASE v_operation
    WHEN 'modify' THEN
      RETURN COALESCE(
        NULLIF(v_policy#>>'{modify,workflow_template_name}', ''),
        NULLIF(v_global_policy#>>'{modify,workflow_template_name}', '')
      );
    WHEN 'reschedule' THEN
      RETURN COALESCE(
        NULLIF(v_policy#>>'{reschedule,workflow_template_name}', ''),
        NULLIF(v_global_policy#>>'{reschedule,workflow_template_name}', '')
      );
    WHEN 'address' THEN
      RETURN COALESCE(
        NULLIF(v_policy#>>'{address,workflow_template_name}', ''),
        NULLIF(v_global_policy#>>'{address,workflow_template_name}', '')
      );
    WHEN 'cancel' THEN
      RETURN COALESCE(
        NULLIF(v_policy#>>'{delete,workflow_template_name}', ''),
        NULLIF(v_global_policy#>>'{delete,workflow_template_name}', '')
      );
    ELSE
      RETURN NULL;
  END CASE;
END;
$function$;

COMMENT ON FUNCTION public.resolve_shipment_operation_template_name_v1(JSONB, TEXT)
  IS 'Resolve the workflow template name for one shipment operation from shipment_operation_policy with global fallback.';

CREATE OR REPLACE FUNCTION public.shipment_operation_guard_state_v1(
  p_policy JSONB,
  p_operation TEXT,
  p_status TEXT,
  p_created_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_policy JSONB := COALESCE(p_policy, '{}'::jsonb);
  v_operation TEXT := lower(NULLIF(btrim(COALESCE(p_operation, '')), ''));
  v_status TEXT := lower(NULLIF(btrim(COALESCE(p_status, '')), ''));
  v_allowed_statuses JSONB := '[]'::jsonb;
  v_window_hours INT := NULL;
  v_source TEXT := 'shipment_operation_policy';
  v_reason TEXT := NULL;
  v_allowed BOOLEAN := FALSE;
  v_window_expires_at TIMESTAMPTZ := NULL;
BEGIN
  CASE v_operation
    WHEN 'modify' THEN
      v_allowed_statuses := COALESCE(v_policy#>'{modify,allowed_statuses}', '[]'::jsonb);
    WHEN 'reschedule' THEN
      v_allowed_statuses := COALESCE(
        v_policy#>'{reschedule,allowed_statuses}',
        v_policy#>'{address,allowed_statuses}',
        '[]'::jsonb
      );
    WHEN 'address' THEN
      v_allowed_statuses := COALESCE(v_policy#>'{address,allowed_statuses}', '[]'::jsonb);
    WHEN 'cancel' THEN
      v_allowed_statuses := COALESCE(v_policy#>'{delete,allowed_statuses}', '[]'::jsonb);
      v_window_hours := NULLIF(v_policy#>>'{delete,window_hours}', '')::INT;
    ELSE
      RETURN jsonb_build_object(
        'operation',
        COALESCE(v_operation, 'unknown'),
        'allowed',
        FALSE,
        'reason',
        'invalid_operation',
        'lock_source',
        v_source
      );
  END CASE;

  v_allowed := workflow_handlers.shipment_status_allowed_v1(v_status, v_allowed_statuses);
  IF NOT v_allowed THEN
    v_reason := 'shipment_status_not_allowed';
  ELSIF v_operation = 'cancel'
     AND COALESCE(v_window_hours, 0) > 0
     AND p_created_at < now() - make_interval(hours => v_window_hours) THEN
    v_allowed := FALSE;
    v_reason := 'shipment_delete_window_expired';
    v_window_expires_at := p_created_at + make_interval(hours => v_window_hours);
  END IF;

  IF v_operation = 'cancel' AND v_window_expires_at IS NULL AND COALESCE(v_window_hours, 0) > 0 THEN
    v_window_expires_at := p_created_at + make_interval(hours => v_window_hours);
  END IF;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'operation',
      v_operation,
      'allowed',
      v_allowed,
      'reason',
      v_reason,
      'lock_source',
      v_source,
      'status',
      v_status,
      'allowed_statuses',
      v_allowed_statuses,
      'window_hours',
      v_window_hours,
      'window_expires_at',
      v_window_expires_at
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.shipment_operation_guard_state_v1(JSONB, TEXT, TEXT, TIMESTAMPTZ)
  IS 'Return temporary pre-dispatch lock state for one shipment mutation using shipment_operation_policy only.';

CREATE OR REPLACE FUNCTION public.shipment_amend_cancel_options_v1(
  p_shipment_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_target RECORD;
  v_policy JSONB;
  v_global_policy JSONB;
BEGIN
  SELECT *
    INTO v_target
    FROM public.ui_shipment_mutation_access_v1(p_shipment_id)
   LIMIT 1;

  v_policy := public.resolve_shipment_operation_policy_v1(
    jsonb_build_object(
      'organization_id',
      v_target.organization_id,
      'client_id',
      v_target.client_id,
      'sender_id',
      v_target.sender_id,
      'shipment_id',
      v_target.shipment_id
    )
  );
  v_global_policy := public.resolve_shipment_operation_policy_v1('{}'::jsonb);

  RETURN jsonb_build_object(
    'shipment_id',
    v_target.shipment_id,
    'tracking_number',
    v_target.tracking_number,
    'status',
    v_target.status,
    'created_at',
    v_target.created_at,
    'lock_source',
    'shipment_operation_policy',
    'policy',
    jsonb_build_object(
      'delete_window_hours',
      NULLIF(v_policy#>>'{delete,window_hours}', '')::INT,
      'modify_allowed_fields',
      COALESCE(v_policy#>'{modify,allowed_fields}', '[]'::jsonb),
      'address_default_country_code',
      COALESCE(
        NULLIF(v_policy#>>'{address,default_country_code}', ''),
        NULLIF(v_global_policy#>>'{address,default_country_code}', '')
      )
    ),
    'current_values',
    jsonb_strip_nulls(
      jsonb_build_object(
        'tracking_number',
        v_target.tracking_number,
        'status',
        v_target.status,
        'promised_delivery_date',
        v_target.promised_delivery_date,
        'service_type',
        v_target.service_type,
        'service_level',
        v_target.service_level,
        'special_instructions',
        v_target.special_instructions,
        'client_reference_number',
        v_target.client_reference_number,
        'carrier_reference_number',
        v_target.carrier_reference_number,
        'cod_amount',
        v_target.cod_amount,
        'address_line1',
        v_target.address_line1,
        'address_line2',
        v_target.address_line2,
        'address_city',
        v_target.address_city,
        'address_province',
        v_target.address_province,
        'address_country',
        v_target.address_country,
        'address_postal_code',
        v_target.address_postal_code,
        'address_district',
        v_target.address_district,
        'address_building_number',
        v_target.address_building_number,
        'address_additional_directions',
        v_target.address_additional_directions
      )
    ),
    'operations',
    jsonb_build_object(
      'modify',
      public.shipment_operation_guard_state_v1(v_policy, 'modify', v_target.status, v_target.created_at),
      'reschedule',
      public.shipment_operation_guard_state_v1(v_policy, 'reschedule', v_target.status, v_target.created_at),
      'address',
      public.shipment_operation_guard_state_v1(v_policy, 'address', v_target.status, v_target.created_at),
      'cancel',
      public.shipment_operation_guard_state_v1(v_policy, 'cancel', v_target.status, v_target.created_at)
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.shipment_amend_cancel_options_v1(UUID)
  IS 'Return authenticated shipment amend/cancel availability, current values, and temporary lock semantics from shipment_operation_policy.';

CREATE OR REPLACE FUNCTION public.shipment_amend_cancel_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_shipment_id UUID := NULL;
  v_operation TEXT := lower(NULLIF(btrim(COALESCE(v_input->>'operation', '')), ''));
  v_surface TEXT := lower(NULLIF(btrim(COALESCE(v_input->>'surface', '')), ''));
  v_user_id UUID := auth.uid();
  v_scope_type TEXT := COALESCE(public.current_user_scope_type(), 'global');
  v_scope_id UUID := public.current_user_scope_id();
  v_actor_system TEXT := CASE
    WHEN v_surface IN ('console', 'portal') THEN format('%s.shipment_amend_cancel', v_surface)
    ELSE 'ui.shipment_amend_cancel'
  END;
  v_target RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_options JSONB;
  v_guard JSONB;
  v_idempotency_key TEXT := NULL;
  v_audit_actor JSONB;
  v_action_types TEXT[] := ARRAY[]::TEXT[];
  v_existing_action RECORD;
  v_template_name TEXT := NULL;
  v_template_id UUID := NULL;
  v_context JSONB := '{}'::jsonb;
  v_run_id UUID := NULL;
  v_progress JSONB := '{}'::jsonb;
  v_workflow_status TEXT := NULL;
  v_step_status TEXT := NULL;
  v_step_error TEXT := NULL;
  v_result JSONB := '{}'::jsonb;
  v_action_id UUID := NULL;
  v_changes JSONB := COALESCE(v_input->'changes', '{}'::jsonb);
  v_address JSONB := COALESCE(v_input->'address', v_input->'destination_address', '{}'::jsonb);
  v_slot_date DATE := NULL;
  v_reason TEXT := NULLIF(btrim(COALESCE(v_input->>'reason', '')), '');
  v_inline_kick_max_attempts INT := 3;
  v_inline_kick_budget_ms INT := 500;
  v_inline_kick_poll_ms INT := 50;
  v_inline_attempts INT := 0;
  v_inline_started_at TIMESTAMPTZ := clock_timestamp();
  v_inline_elapsed_ms INT := 0;
  v_inline_error TEXT := NULL;
  v_inline_next_run_at TIMESTAMPTZ := NULL;
  v_inline_deadline TIMESTAMPTZ := NULL;
  v_inline_explicit_input JSONB := jsonb_build_object(
    'ui_explicit_wake',
    TRUE,
    'source',
    'shipment_amend_cancel_v1'
  );
BEGIN
  BEGIN
    v_shipment_id := NULLIF(v_input->>'shipment_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_shipment_id := NULL;
  END;

  BEGIN
    v_slot_date := NULLIF(v_input->>'slot_date', '')::DATE;
  EXCEPTION
    WHEN others THEN
      v_slot_date := NULL;
  END;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'shipment amend/cancel requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF v_shipment_id IS NULL OR v_operation NOT IN ('modify', 'reschedule', 'address', 'cancel') THEN
    RETURN jsonb_build_object(
      'ok',
      FALSE,
      'error',
      jsonb_build_object('code', 'invalid_request')
    );
  END IF;

  SELECT *
    INTO v_target
    FROM public.ui_shipment_mutation_access_v1(v_shipment_id)
   LIMIT 1;

  v_policy := public.resolve_shipment_operation_policy_v1(
    jsonb_build_object(
      'organization_id',
      v_target.organization_id,
      'client_id',
      v_target.client_id,
      'sender_id',
      v_target.sender_id,
      'shipment_id',
      v_target.shipment_id
    )
  );

    v_idempotency_key := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
    IF v_idempotency_key IS NULL THEN
      v_idempotency_key := encode(
        digest(
        format(
          '%s|%s|%s|%s|%s',
          v_operation,
          v_shipment_id,
          v_user_id,
          COALESCE(v_surface, 'ui'),
          COALESCE(
            CASE
              WHEN v_operation = 'modify' THEN v_changes::TEXT
              WHEN v_operation = 'address' THEN v_address::TEXT
              WHEN v_operation = 'reschedule' THEN COALESCE(v_slot_date::TEXT, '')
              WHEN v_operation = 'cancel' THEN COALESCE(v_reason, '')
              ELSE ''
            END,
            ''
          )
        ),
        'sha256'
      ),
      'hex'
    );
  END IF;

  v_audit_actor := jsonb_strip_nulls(
    jsonb_build_object(
      'user_id',
      v_user_id,
      'scope_type',
      v_scope_type,
      'scope_id',
      v_scope_id,
      'surface',
      COALESCE(v_surface, 'ui'),
      'source',
      v_actor_system
    )
  );

    v_action_types := CASE v_operation
      WHEN 'modify' THEN ARRAY['modify']
      WHEN 'reschedule' THEN ARRAY['delivery_slot_reserved']
      WHEN 'address' THEN ARRAY['address_update']
      WHEN 'cancel' THEN ARRAY['delete']
      ELSE ARRAY[]::TEXT[]
    END;

    SELECT
      sa.id,
      sa.action_type,
      sa.action_data,
      sa.canonical_status
    INTO v_existing_action
    FROM public.shipment_actions sa
    WHERE sa.shipment_id = v_shipment_id
      AND sa.action_type = ANY(v_action_types)
      AND sa.action_data->>'idempotency_key' = v_idempotency_key
    ORDER BY sa.created_at DESC
    LIMIT 1;

    v_options := public.shipment_amend_cancel_options_v1(v_shipment_id);
    v_guard := COALESCE(v_options#>ARRAY['operations', v_operation], '{}'::jsonb);

  IF v_existing_action.id IS NOT NULL THEN
    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'ok',
        TRUE,
        'already_processed',
        TRUE,
        'shipment_id',
        v_shipment_id,
        'operation',
        v_operation,
        'shipment_action_id',
        v_existing_action.id,
        'lock_state',
        v_guard,
        'canonical_status',
        v_existing_action.canonical_status
        )
      );
    END IF;

    IF COALESCE((v_guard->>'allowed')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
      RETURN jsonb_strip_nulls(
        jsonb_build_object(
          'ok',
          FALSE,
          'error',
          jsonb_build_object(
            'code',
            COALESCE(v_guard->>'reason', 'shipment_mutation_blocked')
          ),
          'lock_state',
          v_guard
        )
      );
    END IF;

    IF v_operation = 'modify' AND jsonb_typeof(v_changes) <> 'object' THEN
      RETURN jsonb_build_object(
        'ok',
      FALSE,
      'error',
      jsonb_build_object('code', 'modify_patch_invalid'),
      'lock_state',
      v_guard
    );
  END IF;

  IF v_operation = 'modify' AND v_changes = '{}'::jsonb THEN
    RETURN jsonb_build_object(
      'ok',
      FALSE,
      'error',
      jsonb_build_object('code', 'modify_patch_empty'),
      'lock_state',
      v_guard
    );
  END IF;

  IF v_operation = 'address' AND jsonb_typeof(v_address) <> 'object' THEN
    RETURN jsonb_build_object(
      'ok',
      FALSE,
      'error',
      jsonb_build_object('code', 'address_payload_invalid'),
      'lock_state',
      v_guard
    );
  END IF;

  IF v_operation = 'address' AND v_address = '{}'::jsonb THEN
    RETURN jsonb_build_object(
      'ok',
      FALSE,
      'error',
      jsonb_build_object('code', 'address_payload_empty'),
      'lock_state',
      v_guard
    );
  END IF;

  IF v_operation = 'reschedule' AND v_slot_date IS NULL THEN
    RETURN jsonb_build_object(
      'ok',
      FALSE,
      'error',
      jsonb_build_object('code', 'slot_date_required'),
      'lock_state',
      v_guard
    );
  END IF;

  v_template_name := public.resolve_shipment_operation_template_name_v1(v_policy, v_operation);

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = v_template_name
     AND status = 'active'
   ORDER BY version DESC, updated_at DESC NULLS LAST
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok',
      FALSE,
      'error',
      jsonb_build_object('code', 'workflow_template_missing', 'template_name', v_template_name),
      'lock_state',
      v_guard
    );
  END IF;

  v_context := jsonb_strip_nulls(
    jsonb_build_object(
      'trigger_source',
      'manual',
      'requested_by',
      v_user_id,
      'organization_id',
      v_target.organization_id,
      'client_id',
      v_target.client_id,
      'sender_id',
      v_target.sender_id,
      'shipment_id',
      v_target.shipment_id,
      'tracking_number',
      v_target.tracking_number,
      'performed_by_system',
      v_actor_system,
      'surface',
      COALESCE(v_surface, 'ui'),
      'idempotency_key',
      v_idempotency_key,
      'event_id',
      v_idempotency_key,
      'event',
      jsonb_build_object('id', v_idempotency_key),
      'audit_actor',
      v_audit_actor,
      'shipment',
      jsonb_strip_nulls(
        jsonb_build_object(
          'id',
          v_target.shipment_id,
          'organization_id',
          v_target.organization_id,
          'client_id',
          v_target.client_id,
          'sender_id',
          v_target.sender_id,
          'tracking_number',
          v_target.tracking_number
        )
      ),
      'changes',
      CASE WHEN v_operation = 'modify' THEN v_changes ELSE NULL END,
      'modify',
      CASE WHEN v_operation = 'modify' THEN v_changes ELSE NULL END,
      'address',
      CASE WHEN v_operation = 'address' THEN v_address ELSE NULL END,
      'slot_date',
      CASE WHEN v_operation = 'reschedule' THEN v_slot_date ELSE NULL END,
      'reason',
      CASE WHEN v_operation = 'cancel' THEN v_reason ELSE NULL END,
      'payload',
      jsonb_strip_nulls(
        jsonb_build_object(
          'shipment_id',
          v_target.shipment_id,
          'operation',
          v_operation,
          'changes',
          CASE WHEN v_operation = 'modify' THEN v_changes ELSE NULL END,
          'address',
          CASE WHEN v_operation = 'address' THEN v_address ELSE NULL END,
          'slot_date',
          CASE WHEN v_operation = 'reschedule' THEN v_slot_date ELSE NULL END,
          'reason',
          CASE WHEN v_operation = 'cancel' THEN v_reason ELSE NULL END
        )
      ),
      'ui_mutation',
      jsonb_build_object(
        'operation',
        v_operation,
        'lock_source',
        'shipment_operation_policy'
      )
    )
  );

  v_run_id := public.start_workflow_run(v_template_id, v_context);
  v_inline_deadline := v_inline_started_at + ((v_inline_kick_budget_ms::TEXT || ' milliseconds')::INTERVAL);

  WHILE v_inline_attempts < v_inline_kick_max_attempts LOOP
    EXIT WHEN clock_timestamp() >= v_inline_deadline;

    BEGIN
      IF v_inline_attempts = 0 THEN
        v_progress := public.progress_workflow_run(v_run_id, v_inline_explicit_input);
      ELSE
        v_progress := public.progress_workflow_run(v_run_id);
      END IF;
      v_inline_attempts := v_inline_attempts + 1;
      v_step_status := lower(NULLIF(v_progress->>'status', ''));

      BEGIN
        v_inline_next_run_at := NULLIF(v_progress->>'next_run_at', '')::TIMESTAMPTZ;
      EXCEPTION
        WHEN others THEN
          v_inline_next_run_at := NULL;
      END;

      SELECT lower(COALESCE(workflow_status, ''))
        INTO v_workflow_status
        FROM public.workflow_runs
       WHERE id = v_run_id;

      EXIT WHEN v_workflow_status IN ('completed', 'failed', 'cancelled', 'blocked', 'waiting');
      EXIT WHEN v_step_status IN ('failed', 'cancelled', 'blocked', 'waiting');
      EXIT WHEN v_inline_next_run_at IS NOT NULL AND v_inline_next_run_at > now();

      IF v_inline_attempts < v_inline_kick_max_attempts AND clock_timestamp() < v_inline_deadline THEN
        PERFORM pg_sleep((v_inline_kick_poll_ms::NUMERIC) / 1000.0);
      END IF;
    EXCEPTION
      WHEN others THEN
        v_inline_error := SQLERRM;
        EXIT;
    END;
  END LOOP;

  v_inline_elapsed_ms := GREATEST(
    0,
    FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - v_inline_started_at)) * 1000)
  )::INT;

  SELECT workflow_status
    INTO v_workflow_status
    FROM public.workflow_runs
   WHERE id = v_run_id;

  SELECT
    wrs.step_status,
    wrs.operation_result,
    wrs.last_error
  INTO
    v_step_status,
    v_result,
    v_step_error
  FROM public.workflow_run_steps wrs
  WHERE wrs.workflow_run_id = v_run_id
  ORDER BY wrs.sequence_order DESC, wrs.updated_at DESC
  LIMIT 1;

  IF v_result IS NULL THEN
    v_result := '{}'::jsonb;
  END IF;

  BEGIN
    v_action_id := COALESCE(
      NULLIF(v_result->>'shipment_action_id', '')::UUID,
      NULLIF(v_result#>>'{reserve_result,action_id}', '')::UUID
    );
  EXCEPTION
    WHEN others THEN
      v_action_id := NULL;
  END;

    IF v_action_id IS NOT NULL THEN
      UPDATE public.shipment_actions sa
         SET performed_by_system = v_actor_system,
             notes = CASE
               WHEN v_operation = 'cancel' AND v_reason IS NOT NULL THEN v_reason
               ELSE sa.notes
             END,
           action_data = public.deep_merge_jsonb(
             COALESCE(sa.action_data, '{}'::jsonb),
             jsonb_strip_nulls(
               jsonb_build_object(
                 'idempotency_key',
                 v_idempotency_key,
                 'audit_actor',
                 v_audit_actor,
                 'ui_operation',
                 v_operation,
                 'surface',
                 COALESCE(v_surface, 'ui'),
                 'workflow_run_id',
                 v_run_id
               )
             )
           )
     WHERE sa.id = v_action_id;
  END IF;

  IF v_workflow_status IN ('failed', 'blocked', 'cancelled') THEN
    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'ok',
        FALSE,
        'shipment_id',
        v_shipment_id,
        'operation',
        v_operation,
        'workflow_run_id',
        v_run_id,
        'workflow_status',
        v_workflow_status,
        'workflow_inline_kick',
        jsonb_strip_nulls(
          jsonb_build_object(
            'attempts',
            v_inline_attempts,
            'elapsed_ms',
            v_inline_elapsed_ms,
            'next_run_at',
            v_inline_next_run_at,
            'error',
            v_inline_error
          )
        ),
        'error',
        jsonb_build_object(
          'code',
          COALESCE(v_step_error, v_result->>'error', 'shipment_mutation_failed')
        ),
        'lock_state',
        v_guard,
        'operation_result',
        v_result
      )
    );
  END IF;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'ok',
      TRUE,
      'shipment_id',
      v_shipment_id,
      'operation',
      v_operation,
      'shipment_action_id',
      v_action_id,
      'workflow_run_id',
      v_run_id,
      'workflow_status',
      v_workflow_status,
      'workflow_step_status',
      v_step_status,
      'workflow_inline_kick',
      jsonb_strip_nulls(
        jsonb_build_object(
          'attempts',
          v_inline_attempts,
          'elapsed_ms',
          v_inline_elapsed_ms,
          'next_run_at',
          v_inline_next_run_at,
          'error',
          v_inline_error
        )
      ),
      'lock_state',
      v_guard,
      'operation_result',
      v_result
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.shipment_amend_cancel_v1(JSONB)
  IS 'Authenticated console/portal shipment amend-cancel RPC that starts canonical workflow-engine runs and keeps temporary lock semantics sourced from shipment_operation_policy only.';

REVOKE ALL ON FUNCTION workflow_handlers.execute_shipment_reschedule_v1(public.workflow_run_steps, public.workflow_runs, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ui_shipment_mutation_access_v1(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resolve_shipment_operation_template_name_v1(JSONB, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.shipment_operation_guard_state_v1(JSONB, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.shipment_amend_cancel_options_v1(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.shipment_amend_cancel_v1(JSONB) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION workflow_handlers.execute_shipment_reschedule_v1(public.workflow_run_steps, public.workflow_runs, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.ui_shipment_mutation_access_v1(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_shipment_operation_template_name_v1(JSONB, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shipment_operation_guard_state_v1(JSONB, TEXT, TEXT, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shipment_amend_cancel_options_v1(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shipment_amend_cancel_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603191030_shipment_amend_cancel_ui_v1'));

COMMIT;
