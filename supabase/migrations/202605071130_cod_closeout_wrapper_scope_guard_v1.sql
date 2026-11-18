-- Spec-Issue: Console V2 operations lifecycle finance closeout
-- Step: COD closeout wrapper scope guard
-- Date: 2026-05-07
--
-- Purpose:
--   Keep Console V2 COD cashier-count and adjustment wrappers fail-closed to
--   canonical COD collection inputs. The preserved implementation still owns
--   append-only ledger writes; this migration adds the missing scope guard at
--   the browser-safe wrapper boundary.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605071130_cod_closeout_wrapper_scope_guard_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
BEGIN
  IF to_regprocedure('public.ui_record_cod_remittance_v1_pre_cod_scope_guard_v1(jsonb)') IS NULL THEN
    IF to_regprocedure('public.ui_record_cod_remittance_v1(jsonb)') IS NULL THEN
      RAISE EXCEPTION 'Expected public.ui_record_cod_remittance_v1(jsonb) before installing COD scope guard'
        USING ERRCODE = '42883';
    END IF;
    EXECUTE 'ALTER FUNCTION public.ui_record_cod_remittance_v1(jsonb) RENAME TO ui_record_cod_remittance_v1_pre_cod_scope_guard_v1';
  END IF;

  IF to_regprocedure('public.ui_adjust_cod_collection_v1_pre_cod_scope_guard_v1(jsonb)') IS NULL THEN
    IF to_regprocedure('public.ui_adjust_cod_collection_v1(jsonb)') IS NULL THEN
      RAISE EXCEPTION 'Expected public.ui_adjust_cod_collection_v1(jsonb) before installing COD scope guard'
        USING ERRCODE = '42883';
    END IF;
    EXECUTE 'ALTER FUNCTION public.ui_adjust_cod_collection_v1(jsonb) RENAME TO ui_adjust_cod_collection_v1_pre_cod_scope_guard_v1';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.ui_record_cod_remittance_v1_pre_cod_scope_guard_v1(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ui_adjust_cod_collection_v1_pre_cod_scope_guard_v1(jsonb)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ui_assert_cod_closeout_scope_v1(
  p_function_name text,
  p_args jsonb,
  p_require_cod_entry boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_org_id uuid := public.current_user_org_id();
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_function_name text := COALESCE(NULLIF(btrim(p_function_name), ''), 'COD closeout action');
  v_cod_entry_id uuid := NULL;
  v_settlement_batch_id uuid := NULL;
  v_event_type text := NULL;
  v_batch record;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION '% requires authenticated user', v_function_name
      USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_capability_v1('finance.write');
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION '% requires resolved organization scope', v_function_name
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(v_args) <> 'object' THEN
    RETURN;
  END IF;

  BEGIN
    v_cod_entry_id := NULLIF(v_args->>'cod_entry_id', '')::uuid;
  EXCEPTION WHEN others THEN
    v_cod_entry_id := NULL;
  END;
  BEGIN
    v_settlement_batch_id := NULLIF(v_args->>'settlement_batch_id', '')::uuid;
  EXCEPTION WHEN others THEN
    v_settlement_batch_id := NULL;
  END;

  IF p_require_cod_entry IS TRUE AND v_cod_entry_id IS NULL THEN
    RAISE EXCEPTION '% requires cod_entry_id', v_function_name
      USING ERRCODE = '23502';
  END IF;

  IF v_cod_entry_id IS NOT NULL THEN
    SELECT lower(COALESCE(fe.event_type, ''))
      INTO v_event_type
      FROM public.finance_events fe
     WHERE fe.id = v_cod_entry_id
       AND fe.organization_id = v_org_id
     ORDER BY fe.occurred_at DESC
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION '% cod_entry_id % not found in current organization',
        v_function_name,
        v_cod_entry_id
        USING ERRCODE = 'P0002';
    END IF;
    IF v_event_type <> 'cod_collected' THEN
      RAISE EXCEPTION '% requires cod_entry_id to reference a cod_collected finance event',
        v_function_name
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_settlement_batch_id IS NOT NULL THEN
    SELECT sb.organization_id, lower(COALESCE(sb.kind, '')) AS kind
      INTO v_batch
      FROM public.settlement_batches sb
     WHERE sb.id = v_settlement_batch_id
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION '% settlement_batch_id % not found',
        v_function_name,
        v_settlement_batch_id
        USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.is_platform_user() AND v_batch.organization_id <> v_org_id THEN
      RAISE EXCEPTION '% cannot use settlements in other organizations', v_function_name
        USING ERRCODE = '42501';
    END IF;
    IF v_batch.kind <> 'cod' THEN
      RAISE EXCEPTION '% requires settlement_batch_id to reference a cod settlement batch',
        v_function_name
        USING ERRCODE = '23514';
    END IF;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_resolve_cod_closeout_finance_event_v1(
  p_function_name text,
  p_cod_entry_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id uuid := public.current_user_org_id();
  v_function_name text := COALESCE(NULLIF(btrim(p_function_name), ''), 'COD closeout action');
  v_event public.finance_events%ROWTYPE;
  v_action record;
  v_amount numeric := NULL;
  v_currency text := NULL;
  v_account_id uuid := NULL;
  v_finance_event_id uuid := NULL;
  v_created boolean := NULL;
BEGIN
  IF p_cod_entry_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION '% requires resolved organization scope', v_function_name
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_event
    FROM public.finance_events fe
   WHERE fe.id = p_cod_entry_id
     AND fe.organization_id = v_org_id
   ORDER BY fe.occurred_at DESC
   LIMIT 1;
  IF FOUND THEN
    IF lower(COALESCE(v_event.event_type, '')) <> 'cod_collected' THEN
      RAISE EXCEPTION '% requires cod_entry_id to reference COD collection truth',
        v_function_name
        USING ERRCODE = '23514';
    END IF;
    RETURN v_event.id;
  END IF;

  SELECT
    sa.id,
    sa.organization_id,
    sa.shipment_id,
    sa.performed_by_user_id,
    sa.assigned_to,
    sa.payment_collected_amount,
    sa.payment_expected_amount,
    sa.payment_currency,
    sa.timestamp,
    sa.payment_collection_method,
    sa.payment_collection_outcome,
    s.tracking_number,
    s.cod_amount,
    s.cod_currency,
    s.driver_user_id
    INTO v_action
    FROM public.shipment_actions sa
    LEFT JOIN public.shipments s
      ON s.id = sa.shipment_id
   WHERE sa.id = p_cod_entry_id
     AND sa.organization_id = v_org_id
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION '% cod_entry_id % not found in current organization',
      v_function_name,
      p_cod_entry_id
      USING ERRCODE = 'P0002';
  END IF;

  v_amount := COALESCE(v_action.payment_collected_amount, 0);
  IF v_amount <= 0 THEN
    RAISE EXCEPTION '% requires a COD collection action with positive collected amount',
      v_function_name
      USING ERRCODE = '23514';
  END IF;
  v_currency := COALESCE(
    NULLIF(btrim(v_action.payment_currency), ''),
    NULLIF(btrim(v_action.cod_currency), '')
  );
  IF v_currency IS NULL THEN
    RAISE EXCEPTION '% requires COD collection currency from payment collection or shipment',
      v_function_name
      USING ERRCODE = '23514';
  END IF;
  v_account_id := COALESCE(v_action.performed_by_user_id, v_action.driver_user_id, v_action.assigned_to);

  SELECT finance_event_id, created
    INTO v_finance_event_id, v_created
    FROM public.record_finance_event_v1(jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_org_id,
      'event_type', 'cod_collected',
      'direction', 'in',
      'amount', v_amount,
      'currency', v_currency,
      'account_type', CASE WHEN v_account_id IS NOT NULL THEN 'driver' ELSE 'cod_custody' END,
      'account_id', v_account_id,
      'subject_type', 'shipment',
      'subject_id', v_action.shipment_id,
      'idempotency_key', format('console-v2:cod-collected-from-shipment-action:%s', v_action.id),
      'metadata', jsonb_strip_nulls(jsonb_build_object(
        'source', 'console-v2/finance/cod',
        'shipment_action_id', v_action.id,
        'tracking', v_action.tracking_number,
        'expected', COALESCE(v_action.payment_expected_amount, v_action.cod_amount),
        'collected', v_amount,
        'collection_method', v_action.payment_collection_method,
        'collection_outcome', v_action.payment_collection_outcome,
        'created_from', 'shipment_actions.payment_collection'
      )),
      'occurred_at', COALESCE(v_action.timestamp, now())
    )))
   LIMIT 1;

  RETURN v_finance_event_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_record_cod_remittance_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_cod_entry_id uuid := NULL;
  v_finance_event_id uuid := NULL;
BEGIN
  BEGIN
    v_cod_entry_id := NULLIF(v_args->>'cod_entry_id', '')::uuid;
  EXCEPTION WHEN others THEN
    v_cod_entry_id := NULL;
  END;
  IF v_cod_entry_id IS NOT NULL THEN
    v_finance_event_id := public.ui_resolve_cod_closeout_finance_event_v1(
      'ui_record_cod_remittance_v1',
      v_cod_entry_id
    );
    v_args := jsonb_set(v_args, '{cod_entry_id}', to_jsonb(v_finance_event_id::text), true);
  END IF;
  PERFORM public.ui_assert_cod_closeout_scope_v1(
    'ui_record_cod_remittance_v1',
    v_args,
    false
  );
  RETURN public.ui_record_cod_remittance_v1_pre_cod_scope_guard_v1(v_args);
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_adjust_cod_collection_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_cod_entry_id uuid := NULL;
  v_finance_event_id uuid := NULL;
BEGIN
  BEGIN
    v_cod_entry_id := NULLIF(v_args->>'cod_entry_id', '')::uuid;
  EXCEPTION WHEN others THEN
    v_cod_entry_id := NULL;
  END;
  IF v_cod_entry_id IS NOT NULL THEN
    v_finance_event_id := public.ui_resolve_cod_closeout_finance_event_v1(
      'ui_adjust_cod_collection_v1',
      v_cod_entry_id
    );
    v_args := jsonb_set(v_args, '{cod_entry_id}', to_jsonb(v_finance_event_id::text), true);
  END IF;
  PERFORM public.ui_assert_cod_closeout_scope_v1(
    'ui_adjust_cod_collection_v1',
    v_args,
    true
  );
  RETURN public.ui_adjust_cod_collection_v1_pre_cod_scope_guard_v1(v_args);
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_assert_cod_closeout_scope_v1(text, jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_resolve_cod_closeout_finance_event_v1(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_record_cod_remittance_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_adjust_cod_collection_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_record_cod_remittance_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.ui_adjust_cod_collection_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_record_cod_remittance_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ui_adjust_cod_collection_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_assert_cod_closeout_scope_v1(text, jsonb, boolean) IS
  'Fail-closed scope guard for Console V2 COD closeout wrappers. COD entries must be cod_collected finance events; settlement batches must be kind=cod.';
COMMENT ON FUNCTION public.ui_resolve_cod_closeout_finance_event_v1(text, uuid) IS
  'Resolves Console V2 COD closeout input to immutable finance_events truth. Accepts existing cod_collected finance_event ids or shipment_actions payment-collection ids, creating the idempotent cod_collected ledger projection when needed.';
COMMENT ON FUNCTION public.ui_record_cod_remittance_v1(jsonb) IS
  'Console V2 COD remittance wrapper. Requires finance.write; resolves shipment-action COD collection truth before appending paired cod_handover finance_events.';
COMMENT ON FUNCTION public.ui_adjust_cod_collection_v1(jsonb) IS
  'Console V2 COD collection adjustment wrapper. Requires finance.write; resolves shipment-action COD collection truth before appending an adjustment finance_event.';

CREATE OR REPLACE FUNCTION api.ui_record_cod_remittance_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.ui_record_cod_remittance_v1(p_args);
$$;

CREATE OR REPLACE FUNCTION api.ui_adjust_cod_collection_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.ui_adjust_cod_collection_v1(p_args);
$$;

REVOKE ALL ON FUNCTION api.ui_record_cod_remittance_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_adjust_cod_collection_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_record_cod_remittance_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION api.ui_adjust_cod_collection_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_record_cod_remittance_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_adjust_cod_collection_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION api.ui_record_cod_remittance_v1(jsonb) IS
  'API schema wrapper for guarded public.ui_record_cod_remittance_v1.';
COMMENT ON FUNCTION api.ui_adjust_cod_collection_v1(jsonb) IS
  'API schema wrapper for guarded public.ui_adjust_cod_collection_v1.';

SELECT pg_advisory_unlock(hashtext('202605071130_cod_closeout_wrapper_scope_guard_v1'));

COMMIT;
