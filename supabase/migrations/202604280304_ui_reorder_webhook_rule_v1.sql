-- Spec-Issue: REAUDIT INTEGRATIONS P0 - canonical webhook_rules priority reorder
-- Step: B6-RPC-Webhook-Rule-Reorder
-- Capability: webhooks.write
--
-- Behavior: updates public.webhook_rules.priority for a single rule. The
-- priority column is the canonical ordering hint (higher priority = evaluated
-- first per migration 202510110004:264 idx_webhook_rules_priority DESC).
-- Append-only audit: writes a decision_log row + emits a domain_event.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280304_ui_reorder_webhook_rule_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.ui_reorder_webhook_rule_v1(p_args jsonb)
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
  v_resource_id UUID := NULLIF(p_args->>'rule_id', '')::uuid;
  v_priority INTEGER := NULLIF(p_args->>'priority', '')::int;
  v_before public.webhook_rules%ROWTYPE;
  v_target_org UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_reorder_webhook_rule_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('webhooks.write');

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'ui_reorder_webhook_rule_v1 requires rule_id'
      USING ERRCODE = '23502';
  END IF;
  IF v_priority IS NULL THEN
    RAISE EXCEPTION 'ui_reorder_webhook_rule_v1 requires priority'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_before FROM public.webhook_rules WHERE id = v_resource_id FOR UPDATE;
  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'ui_reorder_webhook_rule_v1 webhook_rule % not found', v_resource_id
      USING ERRCODE = '23503';
  END IF;

  SELECT organization_id INTO v_target_org
    FROM public.webhook_sources
   WHERE id = v_before.webhook_source_id;
  IF v_org_id IS NOT NULL
     AND v_target_org IS NOT NULL
     AND v_target_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'ui_reorder_webhook_rule_v1 webhook_rule % outside tenant scope', v_resource_id
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.webhook_rules
     SET priority = v_priority
   WHERE id = v_resource_id;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, COALESCE(v_target_org, '00000000-0000-0000-0000-000000000000'::uuid),
    'webhooks.reorder_rule', 'webhook_rule', v_resource_id,
    'ui_reorder_webhook_rule_v1', 'reordered',
    jsonb_build_object('prior_priority', v_before.priority, 'priority', v_priority),
    'ui_reorder_webhook_rule_v1', v_correlation_id::uuid
  );

  IF v_target_org IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_target_org, 'webhook_rule.reordered', 'webhook_rule', v_resource_id,
      jsonb_build_object('prior_priority', v_before.priority, 'priority', v_priority),
      v_correlation_id::uuid, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'webhook_rule_id', v_resource_id,
    'priority', v_priority,
    'prior_priority', v_before.priority,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_reorder_webhook_rule_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_reorder_webhook_rule_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ui_reorder_webhook_rule_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.ui_reorder_webhook_rule_v1(jsonb)
  IS 'Canonical write RPC: update priority on a webhook_rule (higher = evaluated first). Capability: webhooks.write.';

SELECT pg_advisory_unlock(hashtext('202604280304_ui_reorder_webhook_rule_v1'));
COMMIT;
