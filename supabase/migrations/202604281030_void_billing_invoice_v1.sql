-- Spec-Issue: Phase B5 - FINANCE RPCs canonical contracts
-- Step: B5-RPC-3
-- Migration: Canonical write RPC public.void_billing_invoice_v1(p_args jsonb).
-- Capability: billing.write
-- Behavior: void draft invoices only (issued/paid invoices require refund flow instead).
-- Contract:
--   p_args := {
--     "billing_invoice_id": uuid (required),
--     "status_reason": text (optional)
--   }
--   Returns: { ok, billing_invoice_id, correlation_id, settings_resolution_id, version }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604281030_void_billing_invoice_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.void_billing_invoice_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_resource_id UUID;
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_invoice public.billing_invoices%ROWTYPE;
  v_status_reason TEXT;
  v_next_version INT;
  v_payload JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'void_billing_invoice_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('billing.write');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'void_billing_invoice_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_resource_id := NULLIF(p_args->>'billing_invoice_id', '')::UUID;
  EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'void_billing_invoice_v1 requires billing_invoice_id'
      USING ERRCODE = '23502';
  END IF;

  v_status_reason := NULLIF(btrim(COALESCE(p_args->>'status_reason', '')), '');

  SELECT * INTO v_invoice
    FROM public.billing_invoices
   WHERE id = v_resource_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'void_billing_invoice_v1 billing_invoice_id % not found', v_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_platform_user() AND v_invoice.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'void_billing_invoice_v1 cannot void billing invoices in other organizations'
      USING ERRCODE = '42501';
  END IF;

  -- Idempotent: if already void, return ok with already_processed flag.
  IF v_invoice.status = 'void' THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'billing_invoice_id', v_resource_id,
      'correlation_id', v_correlation_id,
      'settings_resolution_id', v_decision_id,
      'version', v_invoice.version,
      'already_processed', TRUE
    );
  END IF;

  -- Block void on issued/overdue/paid invoices (those require refund flow instead).
  IF v_invoice.status <> 'draft' THEN
    RAISE EXCEPTION 'void_billing_invoice_v1 only voids draft invoices (current status=%); use billing_invoice_refund_v1 for issued invoices', v_invoice.status
      USING ERRCODE = '22023';
  END IF;

  v_next_version := v_invoice.version + 1;

  UPDATE public.billing_invoices
     SET status = 'void',
         status_reason = v_status_reason,
         version = v_next_version,
         updated_at = now()
   WHERE id = v_resource_id;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'status_reason', v_status_reason,
    'prior_status', v_invoice.status
  ));

  -- Append immutable invoice event (SSOT ledger).
  INSERT INTO public.billing_invoice_events (
    invoice_id, organization_id,
    event_type, from_status, to_status,
    actor_user_id, payload, invoice_version
  ) VALUES (
    v_resource_id, v_invoice.organization_id,
    'billing_invoice.voided', v_invoice.status, 'void',
    v_user_id, v_payload, v_next_version
  );

  -- Append decision_log entry.
  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_invoice.organization_id, 'billing_invoice.void', 'billing_invoice', v_resource_id,
    'void_billing_invoice_v1', 'voided',
    v_payload,
    'void_billing_invoice_v1', v_correlation_id::uuid
  );

  -- Append domain event (engine-first ledger).
  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_invoice.organization_id, 'billing_invoice.voided', 'billing_invoice', v_resource_id,
    v_payload,
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'billing_invoice_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id,
    'version', v_next_version
  );
END;
$$;

REVOKE ALL ON FUNCTION public.void_billing_invoice_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.void_billing_invoice_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_billing_invoice_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.void_billing_invoice_v1(jsonb)
  IS 'Canonical write RPC: void a draft billing invoice. Blocked once issued/paid (use refund flow instead). Capability: billing.write.';

SELECT pg_advisory_unlock(hashtext('202604281030_void_billing_invoice_v1'));
COMMIT;
