-- Migration: Shipment return request UI contract
-- Date: 2026-04-28
--
-- Purpose:
-- - Add a row-driven Console/Portal return request operation backed by
--   shipment_operation_policy and shipment_return_v1.
-- - Keep the return shipment separate from the original shipment by carrying
--   original shipment lineage in metadata instead of overloading context.shipment.

BEGIN;
SELECT pg_advisory_xact_lock(hashtext('20261122029004_shipment_return_request_ui_v1'));
SET LOCAL search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

UPDATE public.schema_registry
   SET schema = jsonb_set(
         COALESCE(schema, '{}'::jsonb),
         '{properties,return}',
         jsonb_build_object('type', 'object'),
         TRUE
       ),
       examples = CASE
         WHEN jsonb_typeof(examples) = 'array' AND jsonb_array_length(examples) > 0 THEN
           jsonb_set(
             examples,
             '{0,return}',
             jsonb_build_object(
               'workflow_template_name', 'shipment_return_v1',
               'allowed_statuses', jsonb_build_array('delivered', 'delivery_failed', 'return_to_origin')
             ),
             TRUE
           )
         ELSE examples
       END
 WHERE category = 'shipment_operation_policy'
   AND is_active IS TRUE
   AND NOT (schema#>'{properties}' ? 'return');

DO $settings$
DECLARE
  v_row RECORD;
  v_return_policy constant JSONB := jsonb_build_object(
    'workflow_template_name', 'shipment_return_v1',
    'allowed_statuses', jsonb_build_array('delivered', 'delivery_failed', 'return_to_origin')
  );
BEGIN
  FOR v_row IN
    SELECT s.scope_type, s.scope_id, sv.schema_version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
     WHERE s.category = 'shipment_operation_policy'
       AND s.scope_type = public.get_root_scope_type_key_v1()
       AND s.scope_id IS NULL
       AND NOT (sv.value ? 'return')
     FOR UPDATE OF s, sv
  LOOP
    PERFORM public.upsert_settings_value_v1(
      'shipment_operation_policy', v_row.scope_type, v_row.scope_id,
      jsonb_set(v_row.value, '{return}', v_return_policy), v_row.schema_version,
      'Add the default Console and Portal return request policy'
    );
  END LOOP;
END;
$settings$;

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
    WHEN 'return' THEN
      RETURN COALESCE(
        NULLIF(v_policy#>>'{return,workflow_template_name}', ''),
        NULLIF(v_global_policy#>>'{return,workflow_template_name}', ''),
        'shipment_return_v1'
      );
    ELSE
      RETURN NULL;
  END CASE;
END;
$function$;

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
    WHEN 'return' THEN
      v_allowed_statuses := COALESCE(v_policy#>'{return,allowed_statuses}', '[]'::jsonb);
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
      public.shipment_operation_guard_state_v1(v_policy, 'cancel', v_target.status, v_target.created_at),
      'return',
      public.shipment_operation_guard_state_v1(v_policy, 'return', v_target.status, v_target.created_at)
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.shipment_return_request_v1(
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
    WHEN v_surface IN ('console', 'portal') THEN format('%s.shipment_return_request', v_surface)
    ELSE 'ui.shipment_return_request'
  END;
  v_target RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_guard JSONB := '{}'::jsonb;
  v_idempotency_key TEXT := NULL;
  v_audit_actor JSONB := '{}'::jsonb;
  v_template_name TEXT := NULL;
  v_template_id UUID := NULL;
  v_existing_run RECORD;
  v_unsuccessful_statuses CONSTANT TEXT[] := ARRAY[
    'failed', 'cancelled', 'canceled', 'stopped', 'skipped', 'timed_out', 'timeout'
  ];
  v_context JSONB := '{}'::jsonb;
  v_run_id UUID := NULL;
  v_progress JSONB := '{}'::jsonb;
  v_workflow_status TEXT := NULL;
  v_step_status TEXT := NULL;
  v_step_error TEXT := NULL;
  v_result JSONB := '{}'::jsonb;
  v_return_shipment RECORD;
  v_reason TEXT := NULLIF(btrim(COALESCE(v_input->>'reason', '')), '');
  v_inline_attempts INT := 0;
  v_inline_error TEXT := NULL;
  v_inline_next_run_at TIMESTAMPTZ := NULL;
  v_inline_explicit_input JSONB := jsonb_build_object(
    'ui_explicit_wake',
    TRUE,
    'source',
    'shipment_return_request_v1'
  );
BEGIN
  BEGIN
    v_shipment_id := NULLIF(v_input->>'shipment_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_shipment_id := NULL;
  END;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'shipment return request requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF v_shipment_id IS NULL OR v_operation IS DISTINCT FROM 'return' THEN
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

  v_guard := public.shipment_operation_guard_state_v1(
    v_policy,
    'return',
    v_target.status,
    v_target.created_at
  );

  IF COALESCE((v_guard->>'allowed')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'ok',
        FALSE,
        'error',
        jsonb_build_object(
          'code',
          COALESCE(v_guard->>'reason', 'shipment_return_blocked')
        ),
        'lock_state',
        v_guard
      )
    );
  END IF;

  v_template_name := public.resolve_shipment_operation_template_name_v1(v_policy, 'return');
  IF v_template_name IS DISTINCT FROM 'shipment_return_v1' THEN
    RAISE EXCEPTION 'Shipment return requires the shipment return workflow' USING ERRCODE = '42501';
  END IF;

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = v_template_name
     AND status = 'active'
     AND public.workflow_template_scope_allowed(scope_type, scope_id)
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

  v_idempotency_key := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  IF v_idempotency_key IS NULL THEN
    v_idempotency_key := encode(
      digest(
        format(
          'return|%s|%s|%s|%s',
          v_shipment_id,
          v_user_id,
          COALESCE(v_surface, 'ui'),
          COALESCE(v_reason, '')
        ),
        'sha256'
      ),
      'hex'
    );
  END IF;

  -- The workflow engine deduplicates by (template, key).
  v_idempotency_key := format(
    'shipment_return:%s:%s:%s',
    v_target.organization_id,
    v_shipment_id,
    encode(digest(lower(v_idempotency_key), 'sha256'), 'hex')
  );

  -- Serialize replay and open-run admission for this shipment.
  PERFORM pg_advisory_xact_lock(hashtextextended('shipment_return:' || v_shipment_id::text, 0));

  SELECT wr.id, wr.workflow_status
    INTO v_existing_run
    FROM public.workflow_runs wr
   WHERE wr.workflow_template_id = v_template_id
     AND wr.idempotency_key = v_idempotency_key
     AND wr.context->>'original_shipment_id' = v_shipment_id::text
     AND wr.context->>'organization_id' = v_target.organization_id::text
   ORDER BY wr.created_at DESC, wr.id DESC
   LIMIT 1;

  IF v_existing_run.id IS NOT NULL THEN
    IF v_existing_run.workflow_status = ANY (v_unsuccessful_statuses) THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'original_shipment_id', v_shipment_id,
        'operation', 'return',
        'workflow_run_id', v_existing_run.id,
        'workflow_status', v_existing_run.workflow_status,
        'error', jsonb_build_object('code', 'shipment_return_failed'),
        'lock_state', v_guard
      );
    END IF;

    SELECT s.id, s.tracking_number, s.status
      INTO v_return_shipment
      FROM public.shipments s
     WHERE s.organization_id = v_target.organization_id
       AND s.client_id = v_target.client_id
       AND s.metadata->>'workflow_run_id' = v_existing_run.id::TEXT
     ORDER BY s.created_at DESC, s.id DESC
     LIMIT 1;

    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'ok',
        TRUE,
        'already_processed',
        TRUE,
        'original_shipment_id',
        v_shipment_id,
        'return_shipment_id',
        v_return_shipment.id,
        'return_tracking_number',
        v_return_shipment.tracking_number,
        'return_status',
        v_return_shipment.status,
        'operation',
        'return',
        'workflow_run_id',
        v_existing_run.id,
        'workflow_status',
        v_existing_run.workflow_status,
        'lock_state',
        v_guard
      )
    );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.workflow_runs wr
      JOIN public.workflow_templates wt ON wt.id = wr.workflow_template_id
     WHERE wt.name = v_template_name
       AND wr.context->>'original_shipment_id' = v_shipment_id::text
       AND wr.context->>'organization_id' = v_target.organization_id::text
       AND wr.workflow_status IN ('pending', 'in_progress', 'running')
  ) THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'shipment_return_already_open')
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
      'original_shipment_id',
      v_target.shipment_id,
      'original_tracking_number',
      v_target.tracking_number,
      'original_shipment',
      jsonb_strip_nulls(
        jsonb_build_object(
          'id',
          v_target.shipment_id,
          'tracking_number',
          v_target.tracking_number,
          'status',
          v_target.status,
          'organization_id',
          v_target.organization_id,
          'client_id',
          v_target.client_id,
          'sender_id',
          v_target.sender_id
        )
      ),
      'metadata',
      jsonb_strip_nulls(
        jsonb_build_object(
          'source', 'shipment_return_request_v1',
          'original_shipment_id', v_target.shipment_id,
          'original_tracking_number', v_target.tracking_number,
          'return_reason', v_reason
        )
      ),
      'return_request',
      jsonb_strip_nulls(
        jsonb_build_object(
          'reason', v_reason,
          'surface', COALESCE(v_surface, 'ui'),
          'requested_by', v_user_id
        )
      ),
      'payload',
      jsonb_strip_nulls(
        jsonb_build_object(
          'operation', 'return',
          'original_shipment_id', v_target.shipment_id,
          'original_tracking_number', v_target.tracking_number,
          'reason', v_reason
        )
      ),
      'ui_mutation',
      jsonb_build_object(
        'operation',
        'return',
        'lock_source',
        'shipment_operation_policy'
      )
    )
  );

  v_run_id := public.start_workflow_run(v_template_id, v_context);
  IF NOT EXISTS (
    SELECT 1 FROM public.workflow_runs wr
     WHERE wr.id = v_run_id
       AND wr.context->>'original_shipment_id' = v_shipment_id::text
       AND wr.context->>'organization_id' = v_target.organization_id::text
  ) THEN
    RAISE EXCEPTION 'Shipment return workflow scope mismatch' USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_progress := public.progress_workflow_run_until_wait_v1(v_run_id, v_inline_explicit_input, 2000, 12);
    v_inline_attempts := COALESCE((v_progress->>'attempts')::INTEGER, 0);
    v_inline_next_run_at := NULLIF(v_progress->>'next_run_at', '')::TIMESTAMPTZ;
    v_inline_error := NULLIF(v_progress->>'error', '');
  EXCEPTION
    WHEN insufficient_privilege THEN RAISE;
    WHEN others THEN
      v_inline_error := SQLERRM;
  END;

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

  SELECT s.id, s.tracking_number, s.status
    INTO v_return_shipment
    FROM public.shipments s
   WHERE s.organization_id = v_target.organization_id
     AND s.client_id = v_target.client_id
     AND s.metadata->>'workflow_run_id' = v_run_id::TEXT
   ORDER BY s.created_at DESC, s.id DESC
   LIMIT 1;

  IF v_workflow_status = ANY (v_unsuccessful_statuses) THEN
    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'ok',
        FALSE,
        'original_shipment_id',
        v_shipment_id,
        'operation',
        'return',
        'workflow_run_id',
        v_run_id,
        'workflow_status',
        v_workflow_status,
        'error',
        jsonb_build_object(
          'code',
          COALESCE(v_step_error, v_result->>'error', 'shipment_return_failed')
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
      'original_shipment_id',
      v_shipment_id,
      'return_shipment_id',
      v_return_shipment.id,
      'return_tracking_number',
      v_return_shipment.tracking_number,
      'return_status',
      v_return_shipment.status,
      'operation',
      'return',
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

COMMENT ON FUNCTION public.shipment_return_request_v1(JSONB)
  IS 'Authenticated Console/Portal return request RPC that starts shipment_return_v1 from shipment_operation_policy without mutating the original shipment context identity.';

CREATE OR REPLACE FUNCTION api.shipment_return_request_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.shipment_return_request_v1(p_input);
$function$;

REVOKE ALL ON FUNCTION public.shipment_return_request_v1(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shipment_return_request_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.shipment_return_request_v1(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION api.shipment_return_request_v1(JSONB) TO authenticated, service_role;

COMMIT;
