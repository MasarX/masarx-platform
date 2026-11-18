-- Spec-Issue: Phase B1 - Platform RPC contract: delete_alert_rule_v1
-- Step: B1-RPC-5
-- Capability: alerts.write (soft-delete: deleted_at = now())

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280051_delete_alert_rule_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.delete_alert_rule_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_resource_id UUID := NULLIF(p_args->>'alert_rule_id', '')::uuid;
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_rule public.alert_rules%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'delete_alert_rule_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('alerts.write');

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'delete_alert_rule_v1 requires alert_rule_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_rule
    FROM public.alert_rules
   WHERE id = v_resource_id
   FOR UPDATE;

  IF v_rule.id IS NULL THEN
    RAISE EXCEPTION 'delete_alert_rule_v1 alert rule % not found', v_resource_id
      USING ERRCODE = '23503';
  END IF;

  -- Idempotent soft-delete
  IF v_rule.deleted_at IS NULL THEN
    UPDATE public.alert_rules
       SET deleted_at = now(),
           deleted_by = v_user_id,
           enabled = FALSE,
           updated_by = v_user_id,
           updated_at = now()
     WHERE id = v_resource_id;

    INSERT INTO public.decision_log (
      id, organization_id, decision_category, resource_type, resource_id,
      decision_point, decision_outcome, performed_by_system, correlation_id
    ) VALUES (
      v_decision_id, v_rule.organization_id, 'alerts.delete', 'alert_rule', v_resource_id,
      'delete_alert_rule_v1', 'deleted', 'delete_alert_rule_v1', v_correlation_id::uuid
    );

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_rule.organization_id, 'alert_rule.deleted', 'alert_rule', v_resource_id,
      '{}'::jsonb, v_correlation_id::uuid, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'alert_rule_id', v_resource_id,
    'deleted_at', COALESCE(v_rule.deleted_at, now()),
    'idempotent', v_rule.deleted_at IS NOT NULL,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.delete_alert_rule_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_alert_rule_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_alert_rule_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.delete_alert_rule_v1(jsonb)
  IS 'Canonical write RPC: soft-delete alert_rule (deleted_at=now, idempotent). Capability: alerts.write.';

SELECT pg_advisory_unlock(hashtext('202604280051_delete_alert_rule_v1'));
COMMIT;
