-- Migration: Billing invoice refund lifecycle and audit correlation repair
-- Date: 2026-05-17
--
-- Full refunds are a refund lifecycle, not a void lifecycle. Keep the refund
-- decision/domain lineage correlated by UUID and keep paid/readback balances
-- consistent for Console V2 operator proof.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605171345_billing_invoice_refund_lifecycle_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  v_correlation_id UUID := gen_random_uuid();
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

  IF v_invoice.status NOT IN ('issued', 'overdue', 'paid') THEN
    RAISE EXCEPTION 'billing_invoice_refund_v1 cannot refund invoice in status=% (only issued/overdue/paid allowed)', v_invoice.status
      USING ERRCODE = '22023';
  END IF;

  IF v_refund_amount > COALESCE(v_invoice.amount_paid, 0) THEN
    RAISE EXCEPTION 'billing_invoice_refund_v1 refund_amount % exceeds amount_paid %', v_refund_amount, v_invoice.amount_paid
      USING ERRCODE = '22023';
  END IF;

  v_new_amount_paid := v_invoice.amount_paid - v_refund_amount;
  v_next_version := v_invoice.version + 1;

  IF v_new_amount_paid <= 0 THEN
    v_new_status := 'refunded';
    v_new_amount_due := 0;
  ELSIF v_invoice.status = 'paid' THEN
    v_new_amount_due := v_invoice.total - v_new_amount_paid;
    IF v_invoice.due_at IS NOT NULL AND v_invoice.due_at < now() THEN
      v_new_status := 'overdue';
    ELSE
      v_new_status := 'issued';
    END IF;
  ELSE
    v_new_status := v_invoice.status;
    v_new_amount_due := v_invoice.total - v_new_amount_paid;
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
    'prior_amount_due', v_invoice.amount_due,
    'new_amount_due', v_new_amount_due,
    'prior_status', v_invoice.status,
    'new_status', v_new_status,
    'metadata', v_metadata
  ));

  INSERT INTO public.billing_invoice_events (
    invoice_id, organization_id,
    event_type, from_status, to_status,
    actor_user_id, payload, invoice_version
  ) VALUES (
    v_resource_id, v_invoice.organization_id,
    'billing_invoice.refunded', v_invoice.status, v_new_status,
    v_user_id, v_payload, v_next_version
  );

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_invoice.organization_id, 'billing_invoice.refund', 'billing_invoice', v_resource_id,
    'billing_invoice_refund_v1', 'refunded',
    v_payload,
    'billing_invoice_refund_v1', v_correlation_id
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_invoice.organization_id, 'billing_invoice.refunded', 'billing_invoice', v_resource_id,
    v_payload,
    v_correlation_id, 'pending'
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
  IS 'Canonical write RPC: refund an issued/paid billing invoice. Full refund -> refunded; partial keeps invoice collectible. Capability: invoices.refund.';

DROP VIEW IF EXISTS public.v_billing_invoice_directory;

CREATE VIEW public.v_billing_invoice_directory
WITH (security_invoker = true)
AS
WITH line_agg AS (
  SELECT
    bil.invoice_id,
    COUNT(*)::INT AS line_count,
    COALESCE(SUM(bil.amount), 0)::NUMERIC AS line_total_amount
  FROM public.billing_invoice_lines bil
  GROUP BY bil.invoice_id
),
event_agg AS (
  SELECT
    bie.invoice_id,
    MAX(bie.created_at) AS last_event_at
  FROM public.billing_invoice_events bie
  GROUP BY bie.invoice_id
),
event_sent AS (
  SELECT bie.invoice_id, MAX(bie.created_at) AS sent_at
  FROM public.billing_invoice_events bie
  WHERE bie.event_type IN ('billing_invoice.issued', 'sent')
  GROUP BY bie.invoice_id
),
event_refunded AS (
  SELECT bie.invoice_id, MAX(bie.created_at) AS refunded_at
  FROM public.billing_invoice_events bie
  WHERE bie.event_type IN ('billing_invoice.refunded', 'refunded')
  GROUP BY bie.invoice_id
),
event_voided AS (
  SELECT bie.invoice_id, MAX(bie.created_at) AS voided_at
  FROM public.billing_invoice_events bie
  WHERE bie.event_type IN ('billing_invoice.voided', 'voided')
  GROUP BY bie.invoice_id
)
SELECT
  bi.id                AS invoice_id,
  bi.id                AS id,
  bi.organization_id,
  bi.client_id,
  bi.sender_id,
  bi.invoice_number,
  bi.status,
  bi.status_reason,
  bi.currency,
  bi.subtotal,
  bi.tax_total,
  bi.total,
  bi.amount_paid,
  bi.amount_due,
  bi.period_start_at,
  bi.period_end_at,
  bi.issued_at,
  bi.due_at,
  bi.paid_at,
  bi.metadata,
  bi.created_at,
  bi.updated_at,
  c.name              AS client_label,
  c.slug              AS client_slug,
  s.name              AS sender_label,
  COALESCE(line_agg.line_count, 0) AS line_count,
  COALESCE(line_agg.line_total_amount, 0)::NUMERIC AS line_total_amount,
  event_agg.last_event_at,
  (
    SELECT bie.event_type
    FROM public.billing_invoice_events bie
    WHERE bie.invoice_id = bi.id
    ORDER BY bie.created_at DESC
    LIMIT 1
  )                   AS last_event_type,
  event_sent.sent_at,
  event_refunded.refunded_at,
  event_voided.voided_at,
  (
    bi.status = 'overdue'
    OR (bi.status IN ('issued', 'sent') AND bi.due_at IS NOT NULL AND now() > bi.due_at)
  ) AS is_overdue,
  CASE
    WHEN bi.status = 'refunded' THEN 'refunded'
    WHEN bi.status IN ('void', 'voided') THEN 'void'
    WHEN bi.status = 'overdue' THEN 'overdue'
    WHEN bi.status IN ('issued', 'sent') AND bi.due_at IS NOT NULL AND now() > bi.due_at THEN 'overdue'
    WHEN bi.paid_at IS NOT NULL THEN 'paid'
    WHEN bi.status IN ('issued', 'sent') THEN 'issued'
    ELSE 'draft'
  END AS payment_status,
  GREATEST(0, EXTRACT(DAY FROM (now() - bi.created_at)))::INT AS age_days
FROM public.billing_invoices bi
LEFT JOIN public.clients c   ON c.id = bi.client_id
LEFT JOIN public.senders s   ON s.id = bi.sender_id
LEFT JOIN line_agg           ON line_agg.invoice_id = bi.id
LEFT JOIN event_agg          ON event_agg.invoice_id = bi.id
LEFT JOIN event_sent         ON event_sent.invoice_id = bi.id
LEFT JOIN event_refunded     ON event_refunded.invoice_id = bi.id
LEFT JOIN event_voided       ON event_voided.invoice_id = bi.id;

COMMENT ON VIEW public.v_billing_invoice_directory IS
  'FE-friendly projection of billing_invoices with derived joins/counters and canonical billing_invoice_status payment projection. Current statuses: draft, issued, overdue, paid, refunded, void. Read-only; SSOT remains billing_invoices; mutations go through create_billing_invoice_v1 / update_billing_invoice_v1 / billing_invoice_send_v1 / billing_invoice_refund_v1 / void_billing_invoice_v1.';

REVOKE ALL ON public.v_billing_invoice_directory FROM PUBLIC;
REVOKE ALL ON public.v_billing_invoice_directory FROM anon;
REVOKE ALL ON public.v_billing_invoice_directory FROM authenticated;
GRANT SELECT ON public.v_billing_invoice_directory TO authenticated;
GRANT SELECT ON public.v_billing_invoice_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202605171345_billing_invoice_refund_lifecycle_v1'));
COMMIT;
