-- Migration: Billing invoice payment capture workflow.
-- Date: 2026-05-24
--
-- Console V2 Billing can create, edit, send, refund, and void invoices. This
-- closes the first-tenant payment-capture gap with a backend-owned full-payment
-- transition that updates invoice truth, timeline, decision log, and domain
-- events in one auditable RPC.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605241430_billing_invoice_mark_paid_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES (
  'billing_invoice_event_type',
  'Billing invoice timeline event type',
  'finance',
  'tier_1',
  TRUE
)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id,
       'billing_invoice.paid',
       'Paid',
       28,
       jsonb_build_object('tone', 'good', 'lifecycle', 'paid', 'is_terminal', true)
FROM public.lookup_definitions ld
WHERE ld.category = 'billing_invoice_event_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('decision_category', 'Business decision categories for decision_log', 'engineering', 'tier_1', FALSE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default)
SELECT ld.id,
       'billing_invoice.payment',
       'Billing Invoice Payment',
       1770,
       FALSE
FROM public.lookup_definitions ld
WHERE ld.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    updated_at = now();

CREATE OR REPLACE FUNCTION public.billing_invoice_mark_paid_v1(p_args jsonb)
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
  v_payment_amount NUMERIC;
  v_payment_reference TEXT;
  v_paid_at TIMESTAMPTZ;
  v_metadata JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_outstanding_amount NUMERIC;
  v_next_version INT;
  v_payload JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'billing_invoice_mark_paid_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('billing.write');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'billing_invoice_mark_paid_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_resource_id := NULLIF(p_args->>'billing_invoice_id', '')::UUID;
  EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'billing_invoice_mark_paid_v1 requires billing_invoice_id'
      USING ERRCODE = '23502';
  END IF;

  v_payment_amount := NULLIF(p_args->>'payment_amount', '')::NUMERIC;
  IF v_payment_amount IS NULL OR v_payment_amount <= 0 THEN
    RAISE EXCEPTION 'billing_invoice_mark_paid_v1 requires positive payment_amount'
      USING ERRCODE = '22023';
  END IF;

  v_payment_reference := NULLIF(btrim(COALESCE(p_args->>'payment_reference', '')), '');
  IF v_payment_reference IS NULL THEN
    RAISE EXCEPTION 'billing_invoice_mark_paid_v1 requires payment_reference'
      USING ERRCODE = '23502';
  END IF;

  BEGIN v_paid_at := NULLIF(p_args->>'paid_at', '')::TIMESTAMPTZ;
  EXCEPTION WHEN others THEN v_paid_at := NULL; END;
  v_paid_at := COALESCE(v_paid_at, now());

  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  SELECT * INTO v_invoice
    FROM public.billing_invoices
   WHERE id = v_resource_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_invoice_mark_paid_v1 billing_invoice_id % not found', v_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_platform_user() AND v_invoice.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'billing_invoice_mark_paid_v1 cannot mark paid billing invoices in other organizations'
      USING ERRCODE = '42501';
  END IF;

  IF v_invoice.status NOT IN ('issued', 'overdue') THEN
    RAISE EXCEPTION 'billing_invoice_mark_paid_v1 cannot mark paid invoice in status=% (only issued/overdue allowed)', v_invoice.status
      USING ERRCODE = '22023';
  END IF;

  v_outstanding_amount := GREATEST(
    0,
    COALESCE(
      v_invoice.amount_due,
      v_invoice.total - COALESCE(v_invoice.amount_paid, 0),
      v_invoice.total,
      0
    )
  );

  IF v_outstanding_amount <= 0 THEN
    RAISE EXCEPTION 'billing_invoice_mark_paid_v1 invoice has no outstanding amount'
      USING ERRCODE = '22023';
  END IF;

  IF v_payment_amount <> v_outstanding_amount THEN
    RAISE EXCEPTION 'billing_invoice_mark_paid_v1 payment_amount % must equal outstanding amount %', v_payment_amount, v_outstanding_amount
      USING ERRCODE = '22023';
  END IF;

  v_next_version := v_invoice.version + 1;

  UPDATE public.billing_invoices
     SET status = 'paid',
         status_reason = NULL,
         amount_paid = COALESCE(v_invoice.amount_paid, 0) + v_payment_amount,
         amount_due = 0,
         paid_at = v_paid_at,
         version = v_next_version,
         updated_at = now()
   WHERE id = v_resource_id;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'payment_amount', v_payment_amount,
    'payment_reference', v_payment_reference,
    'paid_at', v_paid_at,
    'prior_amount_paid', v_invoice.amount_paid,
    'new_amount_paid', COALESCE(v_invoice.amount_paid, 0) + v_payment_amount,
    'prior_amount_due', v_invoice.amount_due,
    'new_amount_due', 0,
    'prior_status', v_invoice.status,
    'new_status', 'paid',
    'metadata', v_metadata
  ));

  INSERT INTO public.billing_invoice_events (
    invoice_id, organization_id,
    event_type, from_status, to_status,
    actor_user_id, payload, invoice_version
  ) VALUES (
    v_resource_id, v_invoice.organization_id,
    'billing_invoice.paid', v_invoice.status, 'paid',
    v_user_id, v_payload, v_next_version
  );

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_invoice.organization_id, 'billing_invoice.payment', 'billing_invoice', v_resource_id,
    'billing_invoice_mark_paid_v1', 'paid',
    v_payload,
    'billing_invoice_mark_paid_v1', v_correlation_id
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_invoice.organization_id, 'billing_invoice.paid', 'billing_invoice', v_resource_id,
    v_payload,
    v_correlation_id, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'billing_invoice_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id,
    'version', v_next_version,
    'paid_amount', v_payment_amount,
    'status', 'paid',
    'paid_at', v_paid_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION api.billing_invoice_mark_paid_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.billing_invoice_mark_paid_v1(p_args);
$$;

REVOKE ALL ON FUNCTION public.billing_invoice_mark_paid_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_invoice_mark_paid_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION api.billing_invoice_mark_paid_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.billing_invoice_mark_paid_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.billing_invoice_mark_paid_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.billing_invoice_mark_paid_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.billing_invoice_mark_paid_v1(jsonb)
  IS 'Canonical write RPC: record full payment for an issued/overdue billing invoice. Capability: billing.write.';
COMMENT ON FUNCTION api.billing_invoice_mark_paid_v1(jsonb)
  IS 'Browser-safe api schema wrapper for public.billing_invoice_mark_paid_v1.';

DO $$
DECLARE
  v_scope RECORD;
  v_commands JSONB;
  v_updated JSONB;
BEGIN
  FOR v_scope IN
    SELECT s.scope_type,
           s.scope_id,
           s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
  LOOP
    v_commands := COALESCE(v_scope.value->'commands', '[]'::jsonb);

    WITH command_items AS (
      SELECT item, ordinality
        FROM jsonb_array_elements(v_commands) WITH ORDINALITY AS e(item, ordinality)
    ),
    patched AS (
      SELECT COALESCE(
        jsonb_agg(
          CASE
            WHEN item->>'key' = 'invoices.mark_paid'
              THEN jsonb_set(
                jsonb_set(item, '{label}', to_jsonb('Record invoice payment'::text), true),
                '{route_targets,console}',
                jsonb_build_object('path', '/finance/billing', 'label', 'Billing'),
                true
              )
            ELSE item
          END
          ORDER BY ordinality
        ),
        '[]'::jsonb
      ) AS commands
      FROM command_items
    )
    SELECT jsonb_set(v_scope.value, '{commands}', patched.commands, true)
      INTO v_updated
      FROM patched;

    UPDATE public.settings_versions sv
       SET value = v_updated,
           version = v_scope.version + 1,
           change_reason = 'Enable Billing payment capture command route',
           approved_at = now(),
           effective_from = now()
     WHERE sv.id = v_scope.settings_version_id
       AND v_updated IS DISTINCT FROM sv.value;

    UPDATE public.settings s
       SET cached_value = v_updated,
           last_updated = now()
     WHERE s.category = 'ui_command_registry'
       AND s.scope_type = v_scope.scope_type
       AND s.scope_id IS NOT DISTINCT FROM v_scope.scope_id
       AND s.settings_version_id = v_scope.settings_version_id
       AND v_updated IS DISTINCT FROM s.cached_value;
  END LOOP;
END $$;

SELECT pg_advisory_unlock(hashtext('202605241430_billing_invoice_mark_paid_v1'));
COMMIT;
