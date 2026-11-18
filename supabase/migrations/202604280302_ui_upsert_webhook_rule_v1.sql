-- Spec-Issue: REAUDIT INTEGRATIONS P0 - canonical webhook_rules upsert RPC
-- Step: B6-RPC-Webhook-Rule-Upsert
-- Capability: webhooks.write
--
-- Behavior: idempotent upsert of public.webhook_rules rows.
--   * When p_args->>'rule_id' is NULL: CREATE path; requires webhook_source_id,
--     event_type, name, mapping_config_id, domain_category.
--   * When p_args->>'rule_id' is set: UPDATE path; only mutates explicitly
--     provided keys.
--
-- Tenant isolation: rules inherit the organization of their webhook_source.
-- Append-only audit: writes a decision_log row + emits a domain_event.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280302_ui_upsert_webhook_rule_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE TABLE IF NOT EXISTS public.webhook_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_source_id UUID NOT NULL REFERENCES public.webhook_sources(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  mapping_config_id UUID NOT NULL REFERENCES public.mapping_configs(id),
  workflow_template_id UUID REFERENCES public.workflow_templates(id),
  domain_category TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_rules_source_id
  ON public.webhook_rules(webhook_source_id);
CREATE INDEX IF NOT EXISTS idx_webhook_rules_event_type
  ON public.webhook_rules(event_type);
CREATE INDEX IF NOT EXISTS idx_webhook_rules_enabled
  ON public.webhook_rules(enabled)
  WHERE enabled = TRUE;
CREATE INDEX IF NOT EXISTS idx_webhook_rules_priority
  ON public.webhook_rules(priority DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_rules_source_event_priority
  ON public.webhook_rules(webhook_source_id, event_type, priority DESC, created_at DESC);

ALTER TABLE public.webhook_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_rules_tenant_select ON public.webhook_rules;
CREATE POLICY webhook_rules_tenant_select
  ON public.webhook_rules
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR EXISTS (
      SELECT 1
      FROM public.webhook_sources ws
      WHERE ws.id = webhook_rules.webhook_source_id
        AND ws.organization_id = public.current_user_org_id()
    )
  );

REVOKE ALL ON public.webhook_rules FROM PUBLIC;
GRANT SELECT ON public.webhook_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.webhook_rules TO service_role;

CREATE OR REPLACE FUNCTION public.ui_upsert_webhook_rule_v1(p_args jsonb)
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
  v_webhook_source_id UUID := NULLIF(p_args->>'webhook_source_id', '')::uuid;
  v_event_type TEXT := NULLIF(btrim(COALESCE(p_args->>'event_type', '')), '');
  v_name TEXT := NULLIF(btrim(COALESCE(p_args->>'name', '')), '');
  v_priority INTEGER := NULLIF(p_args->>'priority', '')::int;
  v_mapping_config_id UUID := NULLIF(p_args->>'mapping_config_id', '')::uuid;
  v_workflow_template_id UUID := NULLIF(p_args->>'workflow_template_id', '')::uuid;
  v_domain_category TEXT := NULLIF(btrim(COALESCE(p_args->>'domain_category', '')), '');
  v_enabled_present BOOLEAN := (p_args ? 'enabled');
  v_enabled BOOLEAN := COALESCE((p_args->>'enabled')::boolean, TRUE);
  v_before public.webhook_rules%ROWTYPE;
  v_target_org UUID;
  v_action TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_webhook_rule_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('webhooks.write');

  IF v_resource_id IS NULL THEN
    -- CREATE path
    IF v_webhook_source_id IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_rule_v1 requires webhook_source_id on create'
        USING ERRCODE = '23502';
    END IF;
    IF v_event_type IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_rule_v1 requires event_type on create'
        USING ERRCODE = '23502';
    END IF;
    IF v_name IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_rule_v1 requires name on create'
        USING ERRCODE = '23502';
    END IF;
    IF v_mapping_config_id IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_rule_v1 requires mapping_config_id on create'
        USING ERRCODE = '23502';
    END IF;
    IF v_domain_category IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_rule_v1 requires domain_category on create'
        USING ERRCODE = '23502';
    END IF;

    -- Tenant guard via webhook_source
    SELECT organization_id INTO v_target_org
      FROM public.webhook_sources
     WHERE id = v_webhook_source_id;
    IF v_target_org IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_rule_v1 webhook_source % not found', v_webhook_source_id
        USING ERRCODE = '23503';
    END IF;
    IF v_org_id IS NOT NULL
       AND v_target_org <> v_org_id
       AND NOT public.is_platform_user() THEN
      RAISE EXCEPTION 'ui_upsert_webhook_rule_v1 webhook_source % outside tenant scope', v_webhook_source_id
        USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.webhook_rules (
      webhook_source_id, event_type, name, priority,
      mapping_config_id, workflow_template_id, domain_category, enabled
    ) VALUES (
      v_webhook_source_id, v_event_type, v_name, COALESCE(v_priority, 100),
      v_mapping_config_id, v_workflow_template_id, v_domain_category, v_enabled
    )
    RETURNING id INTO v_resource_id;

    v_action := 'created';
  ELSE
    -- UPDATE path
    SELECT * INTO v_before FROM public.webhook_rules WHERE id = v_resource_id FOR UPDATE;
    IF v_before.id IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_rule_v1 webhook_rule % not found', v_resource_id
        USING ERRCODE = '23503';
    END IF;

    -- Resolve org via parent webhook_source
    SELECT organization_id INTO v_target_org
      FROM public.webhook_sources
     WHERE id = v_before.webhook_source_id;
    IF v_org_id IS NOT NULL
       AND v_target_org IS NOT NULL
       AND v_target_org <> v_org_id
       AND NOT public.is_platform_user() THEN
      RAISE EXCEPTION 'ui_upsert_webhook_rule_v1 webhook_rule % outside tenant scope', v_resource_id
        USING ERRCODE = '42501';
    END IF;

    UPDATE public.webhook_rules
       SET event_type = COALESCE(v_event_type, event_type),
           name = COALESCE(v_name, name),
           priority = COALESCE(v_priority, priority),
           mapping_config_id = COALESCE(v_mapping_config_id, mapping_config_id),
           workflow_template_id = COALESCE(v_workflow_template_id, workflow_template_id),
           domain_category = COALESCE(v_domain_category, domain_category),
           enabled = CASE WHEN v_enabled_present THEN v_enabled ELSE enabled END
     WHERE id = v_resource_id;

    v_action := 'updated';
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, COALESCE(v_target_org, '00000000-0000-0000-0000-000000000000'::uuid),
    'webhooks.upsert_rule', 'webhook_rule', v_resource_id,
    'ui_upsert_webhook_rule_v1', v_action,
    jsonb_strip_nulls(jsonb_build_object(
      'webhook_source_id', v_webhook_source_id,
      'event_type', v_event_type,
      'name', v_name,
      'priority', v_priority,
      'enabled', CASE WHEN v_enabled_present THEN to_jsonb(v_enabled) ELSE NULL END
    )),
    'ui_upsert_webhook_rule_v1', v_correlation_id::uuid
  );

  IF v_target_org IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_target_org, 'webhook_rule.' || v_action, 'webhook_rule', v_resource_id,
      jsonb_strip_nulls(jsonb_build_object('event_type', v_event_type, 'name', v_name)),
      v_correlation_id::uuid, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'webhook_rule_id', v_resource_id,
    'action', v_action,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_upsert_webhook_rule_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_upsert_webhook_rule_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ui_upsert_webhook_rule_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.ui_upsert_webhook_rule_v1(jsonb)
  IS 'Canonical write RPC: insert or update public.webhook_rules. Capability: webhooks.write.';

SELECT pg_advisory_unlock(hashtext('202604280302_ui_upsert_webhook_rule_v1'));
COMMIT;
