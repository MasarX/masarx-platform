-- Spec-Issue: Phase B5 - FINANCE RPCs canonical contracts
-- Step: B5-RPC-5
-- Migration: Canonical write RPC public.billing_invoice_refund_v1(p_args jsonb).
-- Capability: invoices.refund
-- Behavior: refund an issued/paid invoice. Decrements amount_paid by the refund amount;
--   when full refund, transitions status to 'void'.
-- Contract:
--   p_args := {
--     "billing_invoice_id": uuid (required),
--     "refund_amount": numeric (required; positive, <= amount_paid),
--     "refund_reason": text (optional),
--     "metadata": jsonb (optional, deep-merged into events.payload)
--   }
--   Returns: { ok, billing_invoice_id, correlation_id, settings_resolution_id, version, refunded_amount, status }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604281050_billing_invoice_refund_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.billing_invoice_refund_v1(p_args jsonb)
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
  v_refund_amount NUMERIC;
  v_refund_reason TEXT;
  v_metadata JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_next_version INT;
  v_new_amount_paid NUMERIC;
  v_new_amount_due NUMERIC;
  v_new_status TEXT;
  v_payload JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'billing_invoice_refund_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('invoices.refund');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'billing_invoice_refund_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_resource_id := NULLIF(p_args->>'billing_invoice_id', '')::UUID;
  EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'billing_invoice_refund_v1 requires billing_invoice_id'
      USING ERRCODE = '23502';
  END IF;

  v_refund_amount := NULLIF(p_args->>'refund_amount', '')::NUMERIC;
  IF v_refund_amount IS NULL OR v_refund_amount <= 0 THEN
    RAISE EXCEPTION 'billing_invoice_refund_v1 requires positive refund_amount'
      USING ERRCODE = '22023';
  END IF;

  v_refund_reason := NULLIF(btrim(COALESCE(p_args->>'refund_reason', '')), '');

  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  SELECT * INTO v_invoice
    FROM public.billing_invoices
   WHERE id = v_resource_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_invoice_refund_v1 billing_invoice_id % not found', v_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_platform_user() AND v_invoice.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'billing_invoice_refund_v1 cannot refund billing invoices in other organizations'
      USING ERRCODE = '42501';
  END IF;

  -- Refunds are only valid against issued/overdue/paid invoices (must have been broadcast).
  IF v_invoice.status NOT IN ('issued', 'overdue', 'paid') THEN
    RAISE EXCEPTION 'billing_invoice_refund_v1 cannot refund invoice in status=% (only issued/overdue/paid allowed)', v_invoice.status
      USING ERRCODE = '22023';
  END IF;

  IF v_refund_amount > COALESCE(v_invoice.amount_paid, 0) THEN
    RAISE EXCEPTION 'billing_invoice_refund_v1 refund_amount % exceeds amount_paid %', v_refund_amount, v_invoice.amount_paid
      USING ERRCODE = '22023';
  END IF;

  v_new_amount_paid := v_invoice.amount_paid - v_refund_amount;
  v_new_amount_due := v_invoice.total - v_new_amount_paid;
  v_next_version := v_invoice.version + 1;

  -- Status transition: full refund -> void; partial refund keeps issued/overdue.
  IF v_new_amount_paid <= 0 THEN
    v_new_status := 'void';
  ELSIF v_invoice.status = 'paid' THEN
    -- Was fully paid, now partial: revert to issued (or overdue if past due).
    IF v_invoice.due_at IS NOT NULL AND v_invoice.due_at < now() THEN
      v_new_status := 'overdue';
    ELSE
      v_new_status := 'issued';
    END IF;
  ELSE
    v_new_status := v_invoice.status;
  END IF;

  UPDATE public.billing_invoices
     SET status = v_new_status,
         status_reason = COALESCE(v_refund_reason, status_reason),
         amount_paid = v_new_amount_paid,
         amount_due = v_new_amount_due,
         version = v_next_version,
         updated_at = now()
   WHERE id = v_resource_id;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'refund_amount', v_refund_amount,
    'refund_reason', v_refund_reason,
    'prior_amount_paid', v_invoice.amount_paid,
    'new_amount_paid', v_new_amount_paid,
    'prior_status', v_invoice.status,
    'new_status', v_new_status,
    'metadata', v_metadata
  ));

  -- Append immutable invoice event (SSOT ledger).
  INSERT INTO public.billing_invoice_events (
    invoice_id, organization_id,
    event_type, from_status, to_status,
    actor_user_id, payload, invoice_version
  ) VALUES (
    v_resource_id, v_invoice.organization_id,
    'billing_invoice.refunded', v_invoice.status, v_new_status,
    v_user_id, v_payload, v_next_version
  );

  -- Append decision_log entry.
  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_invoice.organization_id, 'billing_invoice.refund', 'billing_invoice', v_resource_id,
    'billing_invoice_refund_v1', 'refunded',
    v_payload,
    'billing_invoice_refund_v1', v_correlation_id::uuid
  );

  -- Append domain event (engine-first ledger).
  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_invoice.organization_id, 'billing_invoice.refunded', 'billing_invoice', v_resource_id,
    v_payload,
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'billing_invoice_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id,
    'version', v_next_version,
    'refunded_amount', v_refund_amount,
    'status', v_new_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.billing_invoice_refund_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_invoice_refund_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.billing_invoice_refund_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.billing_invoice_refund_v1(jsonb)
  IS 'Canonical write RPC: refund an issued/paid billing invoice. Full refund -> void; partial keeps invoice live. Capability: invoices.refund.';

SELECT pg_advisory_unlock(hashtext('202604281050_billing_invoice_refund_v1'));
COMMIT;
