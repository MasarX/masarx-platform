-- Migration: Subscription cancel lifecycle and readback repair
-- Date: 2026-05-17
--
-- Console V2 cancellation proof requires a visible operator reason workflow,
-- UUID-correlated decision/domain lineage, and subscription readback that keeps
-- the Billing drawer in the same operator context after cancellation.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605171525_cancel_subscription_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.cancel_subscription_v1(p_args jsonb)
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
  v_subscription public.subscriptions%ROWTYPE;
  v_cancellation_reason TEXT;
  v_ends_at TIMESTAMPTZ;
  v_metadata JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_next_version INT;
  v_payload JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'cancel_subscription_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('billing.write');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'cancel_subscription_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_resource_id := NULLIF(p_args->>'subscription_id', '')::UUID;
  EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'cancel_subscription_v1 requires subscription_id'
      USING ERRCODE = '23502';
  END IF;

  v_cancellation_reason := NULLIF(btrim(COALESCE(p_args->>'cancellation_reason', '')), '');
  IF v_cancellation_reason IS NULL THEN
    RAISE EXCEPTION 'cancel_subscription_v1 requires non-empty cancellation_reason'
      USING ERRCODE = '23502';
  END IF;

  BEGIN v_ends_at := NULLIF(p_args->>'ends_at', '')::TIMESTAMPTZ;
  EXCEPTION WHEN others THEN v_ends_at := NULL; END;
  IF v_ends_at IS NULL THEN
    v_ends_at := now();
  END IF;

  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  SELECT * INTO v_subscription
    FROM public.subscriptions
   WHERE id = v_resource_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cancel_subscription_v1 subscription_id % not found', v_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_platform_user() AND v_subscription.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'cancel_subscription_v1 cannot cancel subscriptions in other organizations'
      USING ERRCODE = '42501';
  END IF;

  IF v_subscription.status = 'canceled' THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'subscription_id', v_resource_id,
      'correlation_id', v_correlation_id,
      'settings_resolution_id', v_decision_id,
      'version', v_subscription.version,
      'status', 'canceled',
      'ends_at', v_subscription.ends_at,
      'already_processed', TRUE
    );
  END IF;

  IF v_subscription.status NOT IN ('active', 'paused') THEN
    RAISE EXCEPTION 'cancel_subscription_v1 cannot cancel subscription in status=% (only active/paused allowed)', v_subscription.status
      USING ERRCODE = '22023';
  END IF;

  v_next_version := v_subscription.version + 1;

  IF v_ends_at <= v_subscription.starts_at THEN
    v_ends_at := v_subscription.starts_at + interval '1 second';
  END IF;

  UPDATE public.subscriptions
     SET status = 'canceled',
         status_reason = v_cancellation_reason,
         ends_at = v_ends_at,
         metadata = COALESCE(metadata, '{}'::jsonb) || v_metadata,
         version = v_next_version,
         updated_at = now()
   WHERE id = v_resource_id;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'cancellation_reason', v_cancellation_reason,
    'prior_status', v_subscription.status,
    'new_status', 'canceled',
    'ends_at', v_ends_at,
    'metadata', v_metadata
  ));

  INSERT INTO public.subscription_events (
    subscription_id, organization_id,
    event_type, from_status, to_status,
    actor_user_id, payload, subscription_version
  ) VALUES (
    v_resource_id, v_subscription.organization_id,
    'subscription.canceled', v_subscription.status, 'canceled',
    v_user_id, v_payload, v_next_version
  );

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_subscription.organization_id, 'subscription.cancel', 'subscription', v_resource_id,
    'cancel_subscription_v1', 'canceled',
    v_payload,
    'cancel_subscription_v1', v_correlation_id
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_subscription.organization_id, 'subscription.canceled', 'subscription', v_resource_id,
    v_payload,
    v_correlation_id, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'subscription_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id,
    'version', v_next_version,
    'status', 'canceled',
    'ends_at', v_ends_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_subscription_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_subscription_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_subscription_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.cancel_subscription_v1(jsonb)
  IS 'Canonical write RPC: cancel an active/paused subscription with UUID-correlated lineage. Capability: billing.write.';

SELECT pg_advisory_unlock(hashtext('202605171525_cancel_subscription_readback_v1'));
COMMIT;
