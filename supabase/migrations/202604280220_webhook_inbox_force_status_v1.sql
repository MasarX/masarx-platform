-- Spec-Issue: Phase B6 - Integrations RPC contract: webhook_inbox_force_status_v1
-- Step: B6-RPC-20
-- Capability: webhooks.write
--
-- Behavior: forcibly sets webhook_inbox.processing_status to a target value
-- (e.g. 'failed' to short-circuit a stuck queue entry, or 'succeeded' to
-- manually mark something resolved out-of-band). Always writes audit row.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280220_webhook_inbox_force_status_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.webhook_inbox_force_status_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_resource_id UUID := NULLIF(p_args->>'webhook_inbox_id', '')::uuid;
  v_target_status TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'target_status', '')), ''));
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_before public.webhook_inbox%ROWTYPE;
  v_source_org UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'webhook_inbox_force_status_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('webhooks.write');

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'webhook_inbox_force_status_v1 requires webhook_inbox_id'
      USING ERRCODE = '23502';
  END IF;
  IF v_target_status IS NULL OR v_target_status NOT IN ('pending', 'processing', 'succeeded', 'failed') THEN
    RAISE EXCEPTION 'webhook_inbox_force_status_v1 invalid target_status %', v_target_status
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_before FROM public.webhook_inbox WHERE id = v_resource_id FOR UPDATE;
  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'webhook_inbox_force_status_v1 webhook_inbox % not found', v_resource_id
      USING ERRCODE = '23503';
  END IF;

  SELECT organization_id INTO v_source_org
    FROM public.webhook_sources WHERE id = v_before.webhook_source_id;
  IF v_org_id IS NOT NULL
     AND v_source_org IS NOT NULL
     AND v_source_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'webhook_inbox_force_status_v1 webhook_inbox % outside tenant scope', v_resource_id
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.webhook_inbox
     SET processing_status = v_target_status,
         processed_at = CASE WHEN v_target_status IN ('succeeded', 'failed') THEN now() ELSE processed_at END,
         error_message = CASE WHEN v_target_status = 'failed' THEN COALESCE(v_reason, error_message) ELSE error_message END,
         lease_expires_at = NULL
   WHERE id = v_resource_id;

  INSERT INTO public.webhook_inbox_replays (
    webhook_inbox_id, organization_id, webhook_source_id, action,
    prior_status, forced_status, reason, changed_by, correlation_id, decision_log_id
  ) VALUES (
    v_resource_id, v_source_org, v_before.webhook_source_id, 'force_status',
    v_before.processing_status, v_target_status, v_reason, v_user_id, v_correlation_id, v_decision_id
  );

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, COALESCE(v_source_org, '00000000-0000-0000-0000-000000000000'::uuid),
    'webhooks.force_status', 'webhook_inbox', v_resource_id,
    'webhook_inbox_force_status_v1', 'forced',
    jsonb_strip_nulls(jsonb_build_object(
      'prior_status', v_before.processing_status,
      'target_status', v_target_status,
      'reason', v_reason
    )),
    'webhook_inbox_force_status_v1', v_correlation_id::uuid
  );

  IF v_source_org IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_source_org, 'webhook_inbox.force_status', 'webhook_inbox', v_resource_id,
      jsonb_build_object(
        'prior_status', v_before.processing_status,
        'target_status', v_target_status
      ),
      v_correlation_id::uuid, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'webhook_inbox_id', v_resource_id,
    'prior_status', v_before.processing_status,
    'forced_status', v_target_status,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.webhook_inbox_force_status_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.webhook_inbox_force_status_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.webhook_inbox_force_status_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.webhook_inbox_force_status_v1(jsonb)
  IS 'Canonical write RPC: forcibly set webhook_inbox.processing_status + append force-status audit. Capability: webhooks.write.';

SELECT pg_advisory_unlock(hashtext('202604280220_webhook_inbox_force_status_v1'));
COMMIT;
