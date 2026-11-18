-- Migration: Billing invoice send lifecycle and readback repair
-- Date: 2026-05-17
--
-- Console V2 send proof requires a backend-owned invoice number when a legacy
-- draft lacks one, UUID-correlated decision/domain lineage, and directory
-- readback that reflects the issued state in the same operator workflow.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605171430_billing_invoice_send_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.billing_invoice_send_v1(p_args jsonb)
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
  v_invoice_number TEXT;
  v_due_at TIMESTAMPTZ;
  v_issued_at TIMESTAMPTZ := now();
  v_next_version INT;
  v_payload JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'billing_invoice_send_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('invoices.send');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'billing_invoice_send_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_resource_id := NULLIF(p_args->>'billing_invoice_id', '')::UUID;
  EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'billing_invoice_send_v1 requires billing_invoice_id'
      USING ERRCODE = '23502';
  END IF;

  v_invoice_number := NULLIF(btrim(COALESCE(p_args->>'invoice_number', '')), '');
  BEGIN v_due_at := NULLIF(p_args->>'due_at', '')::TIMESTAMPTZ;
  EXCEPTION WHEN others THEN v_due_at := NULL; END;

  SELECT * INTO v_invoice
    FROM public.billing_invoices
   WHERE id = v_resource_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_invoice_send_v1 billing_invoice_id % not found', v_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_platform_user() AND v_invoice.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'billing_invoice_send_v1 cannot send billing invoices in other organizations'
      USING ERRCODE = '42501';
  END IF;

  IF v_invoice.status <> 'draft' THEN
    IF v_invoice.status IN ('issued', 'overdue', 'paid') THEN
      RETURN jsonb_build_object(
        'ok', TRUE,
        'billing_invoice_id', v_resource_id,
        'correlation_id', v_correlation_id,
        'settings_resolution_id', v_decision_id,
        'version', v_invoice.version,
        'invoice_number', v_invoice.invoice_number,
        'issued_at', v_invoice.issued_at,
        'already_processed', TRUE
      );
    END IF;
    RAISE EXCEPTION 'billing_invoice_send_v1 cannot send invoice in status=%', v_invoice.status
      USING ERRCODE = '22023';
  END IF;

  IF v_invoice.invoice_number IS NULL OR btrim(v_invoice.invoice_number) = '' THEN
    v_invoice_number := COALESCE(v_invoice_number, public.next_billing_invoice_number_v1(v_invoice.organization_id));
  ELSE
    v_invoice_number := v_invoice.invoice_number;
  END IF;

  IF v_due_at IS NULL THEN
    v_due_at := v_invoice.due_at;
  END IF;

  v_next_version := v_invoice.version + 1;

  UPDATE public.billing_invoices
     SET status = 'issued',
         status_reason = NULL,
         invoice_number = v_invoice_number,
         issued_at = v_issued_at,
         due_at = v_due_at,
         version = v_next_version,
         updated_at = now()
   WHERE id = v_resource_id;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'invoice_number', v_invoice_number,
    'issued_at', v_issued_at,
    'due_at', v_due_at,
    'total', v_invoice.total,
    'prior_status', v_invoice.status,
    'new_status', 'issued'
  ));

  INSERT INTO public.billing_invoice_events (
    invoice_id, organization_id,
    event_type, from_status, to_status,
    actor_user_id, payload, invoice_version
  ) VALUES (
    v_resource_id, v_invoice.organization_id,
    'billing_invoice.issued', v_invoice.status, 'issued',
    v_user_id, v_payload, v_next_version
  );

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_invoice.organization_id, 'billing_invoice.send', 'billing_invoice', v_resource_id,
    'billing_invoice_send_v1', 'issued',
    v_payload,
    'billing_invoice_send_v1', v_correlation_id
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_invoice.organization_id, 'billing_invoice.issued', 'billing_invoice', v_resource_id,
    v_payload,
    v_correlation_id, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'billing_invoice_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id,
    'version', v_next_version,
    'invoice_number', v_invoice_number,
    'issued_at', v_issued_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.billing_invoice_send_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_invoice_send_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.billing_invoice_send_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.billing_invoice_send_v1(jsonb)
  IS 'Canonical write RPC: transition draft billing invoice to issued. Generates backend-owned invoice number when missing. Capability: invoices.send.';

SELECT pg_advisory_unlock(hashtext('202605171430_billing_invoice_send_readback_v1'));
COMMIT;
