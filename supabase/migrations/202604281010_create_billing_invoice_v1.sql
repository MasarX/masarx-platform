-- Spec-Issue: Phase B5 - FINANCE RPCs canonical contracts
-- Step: B5-RPC-1
-- Migration: Canonical write RPC public.create_billing_invoice_v1(p_args jsonb).
-- Capability: billing.write
-- Contract:
--   p_args := {
--     "client_id": uuid (required),
--     "sender_id": uuid (optional),
--     "currency": text (required),
--     "subtotal": numeric (optional, default 0),
--     "tax_total": numeric (optional, default 0),
--     "total": numeric (optional, default subtotal+tax_total),
--     "period_start_at": timestamptz (optional),
--     "period_end_at": timestamptz (optional),
--     "due_at": timestamptz (optional),
--     "metadata": jsonb (optional),
--     "idempotency_key": text (optional)
--   }
--   Returns: { ok, billing_invoice_id, correlation_id, settings_resolution_id }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604281010_create_billing_invoice_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.create_billing_invoice_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_resource_id UUID := gen_random_uuid();
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_client_id UUID;
  v_sender_id UUID;
  v_currency TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'currency', '')), ''));
  v_subtotal NUMERIC := COALESCE((p_args->>'subtotal')::numeric, 0);
  v_tax_total NUMERIC := COALESCE((p_args->>'tax_total')::numeric, 0);
  v_total NUMERIC;
  v_period_start TIMESTAMPTZ;
  v_period_end TIMESTAMPTZ;
  v_due_at TIMESTAMPTZ;
  v_metadata JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_idempotency_key TEXT := NULLIF(btrim(COALESCE(p_args->>'idempotency_key', '')), '');
  v_existing_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'create_billing_invoice_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('billing.write');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'create_billing_invoice_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_client_id := NULLIF(p_args->>'client_id', '')::UUID;
  EXCEPTION WHEN others THEN v_client_id := NULL; END;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'create_billing_invoice_v1 requires client_id'
      USING ERRCODE = '23502';
  END IF;

  BEGIN v_sender_id := NULLIF(p_args->>'sender_id', '')::UUID;
  EXCEPTION WHEN others THEN v_sender_id := NULL; END;

  IF v_currency IS NULL THEN
    RAISE EXCEPTION 'create_billing_invoice_v1 requires currency'
      USING ERRCODE = '23502';
  END IF;

  IF v_subtotal < 0 OR v_tax_total < 0 THEN
    RAISE EXCEPTION 'create_billing_invoice_v1 amounts must be non-negative'
      USING ERRCODE = '22023';
  END IF;

  v_total := COALESCE((p_args->>'total')::numeric, v_subtotal + v_tax_total);
  IF v_total < 0 THEN
    RAISE EXCEPTION 'create_billing_invoice_v1 total must be non-negative'
      USING ERRCODE = '22023';
  END IF;

  BEGIN v_period_start := NULLIF(p_args->>'period_start_at', '')::TIMESTAMPTZ;
  EXCEPTION WHEN others THEN v_period_start := NULL; END;

  BEGIN v_period_end := NULLIF(p_args->>'period_end_at', '')::TIMESTAMPTZ;
  EXCEPTION WHEN others THEN v_period_end := NULL; END;

  BEGIN v_due_at := NULLIF(p_args->>'due_at', '')::TIMESTAMPTZ;
  EXCEPTION WHEN others THEN v_due_at := NULL; END;

  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  -- Idempotency: short-circuit if same key already used in this org.
  IF v_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing_id
      FROM public.billing_invoices
     WHERE organization_id = v_org_id
       AND idempotency_key = v_idempotency_key
     LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', TRUE,
        'billing_invoice_id', v_existing_id,
        'correlation_id', v_correlation_id,
        'settings_resolution_id', v_decision_id,
        'already_processed', TRUE
      );
    END IF;
  END IF;

  INSERT INTO public.billing_invoices (
    id, organization_id, client_id, sender_id,
    status, currency,
    subtotal, tax_total, total, amount_paid, amount_due,
    period_start_at, period_end_at, due_at,
    created_by_user_id, idempotency_key, metadata,
    created_at, updated_at
  ) VALUES (
    v_resource_id, v_org_id, v_client_id, v_sender_id,
    'draft', v_currency,
    v_subtotal, v_tax_total, v_total, 0, v_total,
    v_period_start, v_period_end, v_due_at,
    v_user_id, v_idempotency_key, v_metadata,
    now(), now()
  );

  -- Append immutable invoice event (SSOT ledger).
  INSERT INTO public.billing_invoice_events (
    invoice_id, organization_id,
    event_type, from_status, to_status,
    actor_user_id, payload, idempotency_key, invoice_version
  ) VALUES (
    v_resource_id, v_org_id,
    'billing_invoice.created', NULL, 'draft',
    v_user_id,
    jsonb_build_object(
      'currency', v_currency,
      'subtotal', v_subtotal,
      'tax_total', v_tax_total,
      'total', v_total
    ),
    v_idempotency_key, 1
  );

  -- Append decision_log entry.
  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_org_id, 'billing_invoice.create', 'billing_invoice', v_resource_id,
    'create_billing_invoice_v1', 'created',
    jsonb_strip_nulls(jsonb_build_object(
      'client_id', v_client_id,
      'sender_id', v_sender_id,
      'currency', v_currency,
      'total', v_total
    )),
    'create_billing_invoice_v1', v_correlation_id::uuid
  );

  -- Append domain event (engine-first ledger).
  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_org_id, 'billing_invoice.created', 'billing_invoice', v_resource_id,
    jsonb_build_object(
      'client_id', v_client_id,
      'sender_id', v_sender_id,
      'currency', v_currency,
      'total', v_total
    ),
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'billing_invoice_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_billing_invoice_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_billing_invoice_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_billing_invoice_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.create_billing_invoice_v1(jsonb)
  IS 'Canonical write RPC: create draft billing_invoices row + event + domain_event + decision_log. Capability: billing.write.';

SELECT pg_advisory_unlock(hashtext('202604281010_create_billing_invoice_v1'));
COMMIT;
