-- Migration: Billing invoice draft update lifecycle and readback repair
-- Date: 2026-05-17
--
-- Console V2 edit-draft proof requires UUID-correlated decision/domain
-- lineage and backend readback that keeps the invoice drawer in the same
-- operator workflow after the draft update succeeds.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605171610_billing_invoice_update_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.update_billing_invoice_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_resource_id UUID;
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_invoice public.billing_invoices%ROWTYPE;
  v_currency TEXT;
  v_subtotal NUMERIC;
  v_tax_total NUMERIC;
  v_total NUMERIC;
  v_period_start TIMESTAMPTZ;
  v_period_end TIMESTAMPTZ;
  v_due_at TIMESTAMPTZ;
  v_metadata_patch JSONB;
  v_next_version INT;
  v_payload JSONB := '{}'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'update_billing_invoice_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('billing.write');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'update_billing_invoice_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_resource_id := NULLIF(p_args->>'billing_invoice_id', '')::UUID;
  EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'update_billing_invoice_v1 requires billing_invoice_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_invoice
    FROM public.billing_invoices
   WHERE id = v_resource_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'update_billing_invoice_v1 billing_invoice_id % not found', v_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_platform_user() AND v_invoice.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'update_billing_invoice_v1 cannot edit billing invoices in other organizations'
      USING ERRCODE = '42501';
  END IF;

  IF v_invoice.status <> 'draft' THEN
    RAISE EXCEPTION 'update_billing_invoice_v1 only edits draft invoices (current status=%)', v_invoice.status
      USING ERRCODE = '22023';
  END IF;

  v_currency := upper(NULLIF(btrim(COALESCE(p_args->>'currency', '')), ''));
  IF v_currency IS NULL THEN
    v_currency := v_invoice.currency;
  END IF;

  v_subtotal := COALESCE((p_args->>'subtotal')::numeric, v_invoice.subtotal);
  v_tax_total := COALESCE((p_args->>'tax_total')::numeric, v_invoice.tax_total);
  IF v_subtotal < 0 OR v_tax_total < 0 THEN
    RAISE EXCEPTION 'update_billing_invoice_v1 amounts must be non-negative'
      USING ERRCODE = '22023';
  END IF;

  v_total := COALESCE((p_args->>'total')::numeric, v_subtotal + v_tax_total);
  IF v_total < 0 THEN
    RAISE EXCEPTION 'update_billing_invoice_v1 total must be non-negative'
      USING ERRCODE = '22023';
  END IF;

  BEGIN v_period_start := NULLIF(p_args->>'period_start_at', '')::TIMESTAMPTZ;
  EXCEPTION WHEN others THEN v_period_start := NULL; END;
  IF v_period_start IS NULL THEN
    v_period_start := v_invoice.period_start_at;
  END IF;

  BEGIN v_period_end := NULLIF(p_args->>'period_end_at', '')::TIMESTAMPTZ;
  EXCEPTION WHEN others THEN v_period_end := NULL; END;
  IF v_period_end IS NULL THEN
    v_period_end := v_invoice.period_end_at;
  END IF;

  BEGIN v_due_at := NULLIF(p_args->>'due_at', '')::TIMESTAMPTZ;
  EXCEPTION WHEN others THEN v_due_at := NULL; END;
  IF v_due_at IS NULL THEN
    v_due_at := v_invoice.due_at;
  END IF;

  v_metadata_patch := COALESCE(p_args->'metadata', NULL);
  IF v_metadata_patch IS NOT NULL AND jsonb_typeof(v_metadata_patch) IS DISTINCT FROM 'object' THEN
    v_metadata_patch := NULL;
  END IF;

  v_next_version := v_invoice.version + 1;

  UPDATE public.billing_invoices
     SET currency = v_currency,
         subtotal = v_subtotal,
         tax_total = v_tax_total,
         total = v_total,
         amount_due = v_total - amount_paid,
         period_start_at = v_period_start,
         period_end_at = v_period_end,
         due_at = v_due_at,
         metadata = CASE
           WHEN v_metadata_patch IS NULL THEN metadata
           ELSE COALESCE(metadata, '{}'::jsonb) || v_metadata_patch
         END,
         version = v_next_version,
         updated_at = now()
   WHERE id = v_resource_id;

  v_payload := jsonb_build_object(
    'currency', v_currency,
    'subtotal', v_subtotal,
    'tax_total', v_tax_total,
    'total', v_total,
    'amount_due', v_total - v_invoice.amount_paid,
    'period_start_at', v_period_start,
    'period_end_at', v_period_end,
    'due_at', v_due_at,
    'prior_total', v_invoice.total,
    'new_version', v_next_version
  );

  INSERT INTO public.billing_invoice_events (
    invoice_id, organization_id,
    event_type, from_status, to_status,
    actor_user_id, payload, invoice_version
  ) VALUES (
    v_resource_id, v_invoice.organization_id,
    'billing_invoice.updated', 'draft', 'draft',
    v_user_id, v_payload, v_next_version
  );

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_invoice.organization_id, 'billing_invoice.update', 'billing_invoice', v_resource_id,
    'update_billing_invoice_v1', 'updated',
    v_payload,
    'update_billing_invoice_v1', v_correlation_id
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_invoice.organization_id, 'billing_invoice.updated', 'billing_invoice', v_resource_id,
    v_payload,
    v_correlation_id, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'billing_invoice_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id,
    'version', v_next_version,
    'total', v_total,
    'amount_due', v_total - v_invoice.amount_paid
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_billing_invoice_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_billing_invoice_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_billing_invoice_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.update_billing_invoice_v1(jsonb)
  IS 'Canonical write RPC: edit draft billing invoice with UUID-correlated lineage. Capability: billing.write.';

SELECT pg_advisory_unlock(hashtext('202605171610_billing_invoice_update_readback_v1'));
COMMIT;
