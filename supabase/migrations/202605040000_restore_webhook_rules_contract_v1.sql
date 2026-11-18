-- Migration: Restore webhook_rules canonical contract
-- Purpose:
--   - Reintroduce the webhook_rules table after the pre-production cleanup
--     removed it.
--   - Keep mapping-studio workflow binding, Console V2 webhook-rule RPCs, and
--     webhook source/mapping directory projections on one canonical table.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091095_restore_webhook_rules_contract_v1'));
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

COMMENT ON TABLE public.webhook_rules
  IS 'Canonical tenant-scoped inbound webhook rule contract. Sources remain webhook_sources; mapping lives in mapping_configs; workflow linkage is workflow_templates.';
COMMENT ON COLUMN public.webhook_rules.event_type
  IS 'Inbound event type identifier, for example shipment.created or status_update.';
COMMENT ON COLUMN public.webhook_rules.mapping_config_id
  IS 'Canonical payload transformation/validation mapping config.';
COMMENT ON COLUMN public.webhook_rules.workflow_template_id
  IS 'Optional workflow template started after inbound mapping succeeds.';
COMMENT ON COLUMN public.webhook_rules.domain_category
  IS 'Domain classification for workflow routing and Console V2 filtering.';

SELECT pg_advisory_unlock(hashtext('202603091095_restore_webhook_rules_contract_v1'));
COMMIT;
