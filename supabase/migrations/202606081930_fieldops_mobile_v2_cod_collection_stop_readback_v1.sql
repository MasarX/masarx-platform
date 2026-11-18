-- Migration: FieldOps Mobile V2 COD collection stop-detail readback
-- Purpose:
--   Native Mobile V2 COD delivery proof already persists canonical
--   delivery_completion.payment_collection truth through submit_fieldops_proof_v1.
--   This wrapper projects that same backend truth onto the stop-detail resolver
--   so the device can require same-screen COD expected/collected readback before
--   showing a delivered COD stop as complete.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606081930_fieldops_mobile_v2_cod_collection_stop_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
BEGIN
  IF to_regprocedure('public.resolve_fieldops_stop_detail_cod_collection_base_v1(uuid,text,jsonb)') IS NULL
     AND to_regprocedure('public.resolve_fieldops_stop_detail_v1(uuid,text,jsonb)') IS NOT NULL THEN
    ALTER FUNCTION public.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB)
      RENAME TO resolve_fieldops_stop_detail_cod_collection_base_v1;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.resolve_fieldops_stop_detail_v1(
  p_stop_id UUID,
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_envelope JSONB;
  v_cod_amount NUMERIC;
  v_cod_currency TEXT;
  v_action_id UUID;
  v_payment JSONB;
  v_expected_amount NUMERIC;
  v_collected_amount NUMERIC;
  v_tendered_amount NUMERIC;
  v_change_due_amount NUMERIC;
  v_expected_text TEXT;
  v_collected_text TEXT;
  v_tendered_text TEXT;
  v_change_text TEXT;
  v_outcome TEXT;
  v_method TEXT;
  v_source TEXT := 'shipment_cod_amount';
BEGIN
  v_envelope := public.resolve_fieldops_stop_detail_cod_collection_base_v1(
    p_stop_id,
    p_active_role,
    p_context
  );

  SELECT
    s.cod_amount,
    COALESCE(NULLIF(s.cod_currency, ''), 'SAR'),
    latest_action.id,
    COALESCE(
      latest_action.payment_collection,
      rs.metadata #> '{delivery_completion,payment_collection}',
      s.metadata #> '{delivery_completion,payment_collection}'
    ),
    CASE
      WHEN latest_action.payment_collection IS NOT NULL THEN 'shipment_action'
      WHEN rs.metadata #> '{delivery_completion,payment_collection}' IS NOT NULL THEN 'route_stop'
      WHEN s.metadata #> '{delivery_completion,payment_collection}' IS NOT NULL THEN 'shipment'
      ELSE 'shipment_cod_amount'
    END
  INTO
    v_cod_amount,
    v_cod_currency,
    v_action_id,
    v_payment,
    v_source
  FROM public.route_stops rs
  JOIN public.shipments s
    ON s.id = rs.shipment_id
   AND s.organization_id = rs.organization_id
   AND s.client_id = rs.client_id
  LEFT JOIN LATERAL (
    SELECT
      sa.id,
      COALESCE(
        sa.action_data #> '{delivery_completion,payment_collection}',
        sa.action_data #> '{task_event_payload,delivery_completion,payment_collection}',
        sa.action_data #> '{task_event_payload,payment_collection}'
      ) AS payment_collection
    FROM public.shipment_actions sa
    WHERE sa.organization_id = rs.organization_id
      AND sa.client_id = rs.client_id
      AND sa.shipment_id = rs.shipment_id
      AND sa.action_data->>'route_stop_id' = rs.id::text
      AND (
        sa.action_data #> '{delivery_completion,payment_collection}' IS NOT NULL
        OR sa.action_data #> '{task_event_payload,delivery_completion,payment_collection}' IS NOT NULL
        OR sa.action_data #> '{task_event_payload,payment_collection}' IS NOT NULL
      )
    ORDER BY sa.timestamp DESC, sa.created_at DESC, sa.id DESC
    LIMIT 1
  ) latest_action ON TRUE
  WHERE rs.id = p_stop_id
  LIMIT 1;

  IF v_cod_amount IS NULL OR v_cod_amount <= 0 THEN
    RETURN v_envelope;
  END IF;

  v_expected_text := COALESCE(v_payment->>'expected_amount', '');
  v_collected_text := COALESCE(v_payment->>'collected_amount', '');
  v_tendered_text := COALESCE(v_payment->>'tendered_amount', '');
  v_change_text := COALESCE(v_payment->>'change_due_amount', '');

  v_expected_amount := CASE
    WHEN v_expected_text ~ '^-?[0-9]+(\.[0-9]+)?$' THEN v_expected_text::numeric
    ELSE v_cod_amount
  END;
  v_collected_amount := CASE
    WHEN v_collected_text ~ '^-?[0-9]+(\.[0-9]+)?$' THEN v_collected_text::numeric
    ELSE NULL
  END;
  v_tendered_amount := CASE
    WHEN v_tendered_text ~ '^-?[0-9]+(\.[0-9]+)?$' THEN v_tendered_text::numeric
    ELSE NULL
  END;
  v_change_due_amount := CASE
    WHEN v_change_text ~ '^-?[0-9]+(\.[0-9]+)?$' THEN v_change_text::numeric
    ELSE NULL
  END;
  v_outcome := NULLIF(btrim(COALESCE(v_payment->>'outcome', '')), '');
  v_method := NULLIF(btrim(COALESCE(v_payment->>'method', '')), '');

  v_envelope := jsonb_set(
    v_envelope,
    '{paymentCollection}',
    jsonb_strip_nulls(jsonb_build_object(
      'outcome', v_outcome,
      'method', v_method,
      'expectedAmount', v_expected_amount,
      'collectedAmount', v_collected_amount,
      'tenderedAmount', v_tendered_amount,
      'changeDueAmount', v_change_due_amount,
      'currency', COALESCE(NULLIF(v_payment->>'currency', ''), v_cod_currency, 'SAR'),
      'source', v_source,
      'shipmentActionId', v_action_id
    )),
    TRUE
  );

  RETURN v_envelope;
END;
$$;

COMMENT ON FUNCTION public.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) IS
  'Mobile V2 stop-detail readback wrapper. Preserves canonical stop-detail behavior and projects COD expected/collected/tendered/change values from delivery_completion.payment_collection for same-screen native COD collection proof.';

REVOKE ALL ON FUNCTION public.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_fieldops_stop_detail_v1(
  p_stop_id UUID,
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.resolve_fieldops_stop_detail_v1(p_stop_id, p_active_role, p_context);
$$;

REVOKE ALL ON FUNCTION api.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202606081930_fieldops_mobile_v2_cod_collection_stop_readback_v1'));
COMMIT;
