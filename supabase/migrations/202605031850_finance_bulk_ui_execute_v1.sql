-- Console V2 finance bulk actions: keep selected-row operations server-side.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605031850_finance_bulk_ui_execute_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

CREATE OR REPLACE FUNCTION public.ui_bulk_billing_invoice_send_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_ids jsonb := COALESCE(p_args->'billing_invoice_ids', '[]'::jsonb);
  v_invoice_numbers jsonb := COALESCE(p_args->'invoice_numbers', '{}'::jsonb);
  v_results jsonb := '[]'::jsonb;
  v_id_text text;
  v_id uuid;
  v_result jsonb;
  v_succeeded integer := 0;
  v_failed integer := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_bulk_billing_invoice_send_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('invoices.send');

  IF jsonb_typeof(v_args) <> 'object' THEN
    RAISE EXCEPTION 'ui_bulk_billing_invoice_send_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(v_ids) <> 'array' OR jsonb_array_length(v_ids) = 0 THEN
    RAISE EXCEPTION 'ui_bulk_billing_invoice_send_v1 requires billing_invoice_ids'
      USING ERRCODE = '23502';
  END IF;

  IF jsonb_typeof(v_invoice_numbers) IS DISTINCT FROM 'object' THEN
    v_invoice_numbers := '{}'::jsonb;
  END IF;

  FOR v_id_text IN SELECT jsonb_array_elements_text(v_ids)
  LOOP
    BEGIN
      v_id := NULLIF(v_id_text, '')::uuid;
      v_result := public.billing_invoice_send_v1(jsonb_strip_nulls(jsonb_build_object(
        'billing_invoice_id', v_id,
        'invoice_number', NULLIF(v_invoice_numbers ->> v_id::text, ''),
        'due_at', NULLIF(v_args->>'due_at', '')
      )));

      v_succeeded := v_succeeded + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'ok', TRUE,
        'billing_invoice_id', v_id,
        'result', v_result
      ));
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'ok', FALSE,
        'billing_invoice_id', v_id_text,
        'error_code', SQLSTATE,
        'error', SQLERRM
      ));
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', v_failed = 0,
    'operation', 'billing_invoice_send',
    'succeeded_count', v_succeeded,
    'failed_count', v_failed,
    'results', v_results
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_bulk_dispute_action_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_ids jsonb := COALESCE(p_args->'dispute_ids', '[]'::jsonb);
  v_operation text := lower(NULLIF(btrim(COALESCE(p_args->>'operation', '')), ''));
  v_metadata jsonb := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_results jsonb := '[]'::jsonb;
  v_id_text text;
  v_id uuid;
  v_rpc_args jsonb;
  v_result jsonb;
  v_succeeded integer := 0;
  v_failed integer := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_bulk_dispute_action_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('disputes.write');

  IF jsonb_typeof(v_args) <> 'object' THEN
    RAISE EXCEPTION 'ui_bulk_dispute_action_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(v_ids) <> 'array' OR jsonb_array_length(v_ids) = 0 THEN
    RAISE EXCEPTION 'ui_bulk_dispute_action_v1 requires dispute_ids'
      USING ERRCODE = '23502';
  END IF;

  IF v_operation NOT IN ('resolve', 'reject', 'acknowledge', 'escalate') THEN
    RAISE EXCEPTION 'ui_bulk_dispute_action_v1 unsupported operation=%', COALESCE(v_operation, '')
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  IF v_operation = 'resolve' AND NULLIF(btrim(COALESCE(v_args->>'resolution', '')), '') IS NULL THEN
    RAISE EXCEPTION 'ui_bulk_dispute_action_v1 requires resolution for resolve'
      USING ERRCODE = '23502';
  END IF;
  IF v_operation = 'reject' AND NULLIF(btrim(COALESCE(v_args->>'rejection_reason', '')), '') IS NULL THEN
    RAISE EXCEPTION 'ui_bulk_dispute_action_v1 requires rejection_reason for reject'
      USING ERRCODE = '23502';
  END IF;
  IF v_operation = 'escalate' AND NULLIF(btrim(COALESCE(v_args->>'escalation_reason', '')), '') IS NULL THEN
    RAISE EXCEPTION 'ui_bulk_dispute_action_v1 requires escalation_reason for escalate'
      USING ERRCODE = '23502';
  END IF;

  FOR v_id_text IN SELECT jsonb_array_elements_text(v_ids)
  LOOP
    BEGIN
      v_id := NULLIF(v_id_text, '')::uuid;
      v_rpc_args := jsonb_build_object('dispute_id', v_id);
      IF v_metadata <> '{}'::jsonb THEN
        v_rpc_args := v_rpc_args || jsonb_build_object('metadata', v_metadata);
      END IF;

      IF v_operation = 'resolve' THEN
        v_rpc_args := v_rpc_args || jsonb_build_object('resolution', NULLIF(btrim(COALESCE(v_args->>'resolution', '')), ''));
        v_result := public.dispute_resolve_v1(v_rpc_args);
      ELSIF v_operation = 'reject' THEN
        v_rpc_args := v_rpc_args || jsonb_build_object('rejection_reason', NULLIF(btrim(COALESCE(v_args->>'rejection_reason', '')), ''));
        v_result := public.dispute_reject_v1(v_rpc_args);
      ELSIF v_operation = 'acknowledge' THEN
        v_rpc_args := v_rpc_args || jsonb_strip_nulls(jsonb_build_object('acknowledgement_notes', NULLIF(btrim(COALESCE(v_args->>'acknowledgement_notes', '')), '')));
        v_result := public.dispute_acknowledge_v1(v_rpc_args);
      ELSE
        v_rpc_args := v_rpc_args || jsonb_build_object('escalation_reason', NULLIF(btrim(COALESCE(v_args->>'escalation_reason', '')), ''));
        v_result := public.dispute_escalate_v1(v_rpc_args);
      END IF;

      v_succeeded := v_succeeded + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'ok', TRUE,
        'dispute_id', v_id,
        'result', v_result
      ));
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'ok', FALSE,
        'dispute_id', v_id_text,
        'error_code', SQLSTATE,
        'error', SQLERRM
      ));
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', v_failed = 0,
    'operation', v_operation,
    'succeeded_count', v_succeeded,
    'failed_count', v_failed,
    'results', v_results
  );
END;
$function$;

CREATE OR REPLACE FUNCTION api.ui_bulk_billing_invoice_send_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_bulk_billing_invoice_send_v1(p_args);
$function$;

CREATE OR REPLACE FUNCTION api.ui_bulk_dispute_action_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_bulk_dispute_action_v1(p_args);
$function$;

REVOKE ALL ON FUNCTION public.ui_bulk_billing_invoice_send_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_bulk_billing_invoice_send_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION api.ui_bulk_billing_invoice_send_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_bulk_billing_invoice_send_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_bulk_billing_invoice_send_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_bulk_billing_invoice_send_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ui_bulk_dispute_action_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_bulk_dispute_action_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION api.ui_bulk_dispute_action_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_bulk_dispute_action_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_bulk_dispute_action_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_bulk_dispute_action_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_bulk_billing_invoice_send_v1(jsonb) IS
  'Console V2 guarded bulk wrapper for billing_invoice_send_v1. Requires invoices.send and returns per-row results.';
COMMENT ON FUNCTION api.ui_bulk_billing_invoice_send_v1(jsonb) IS
  'Browser-safe api schema wrapper for public.ui_bulk_billing_invoice_send_v1.';
COMMENT ON FUNCTION public.ui_bulk_dispute_action_v1(jsonb) IS
  'Console V2 guarded bulk wrapper for dispute resolve/reject/acknowledge/escalate actions. Requires disputes.write and returns per-row results.';
COMMENT ON FUNCTION api.ui_bulk_dispute_action_v1(jsonb) IS
  'Browser-safe api schema wrapper for public.ui_bulk_dispute_action_v1.';

SELECT pg_advisory_unlock(hashtext('202605031850_finance_bulk_ui_execute_v1'));
COMMIT;
