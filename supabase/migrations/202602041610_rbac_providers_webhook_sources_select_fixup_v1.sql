-- Plan: PLAN-202601-ladder-phase2-scope-from-context / Step: S04
-- Migration: RBAC gates for providers + webhook_sources SELECT policies fixup v1
-- Purpose:
--   - Repair drift where authenticated tenants can read providers/webhook_sources without
--     RBAC permission (agreements.read).
--   - Canonical contract: authenticated reads require RBAC (agreements.read); writes require RBAC (agreements.write).

BEGIN;
SELECT pg_advisory_lock(hashtext('202602041610_rbac_providers_webhook_sources_select_fixup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

REVOKE ALL ON TABLE public.providers FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.providers TO authenticated;

REVOKE ALL ON TABLE public.webhook_sources FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.webhook_sources TO authenticated;

DROP POLICY IF EXISTS providers_select ON public.providers;
CREATE POLICY providers_select ON public.providers
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
      AND public.user_has_permission_v1('agreements.read', organization_id)
    )
  );

DROP POLICY IF EXISTS webhook_sources_select ON public.webhook_sources;
CREATE POLICY webhook_sources_select ON public.webhook_sources
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
      AND public.user_has_permission_v1('agreements.read', organization_id)
    )
  );

SELECT pg_advisory_unlock(hashtext('202602041610_rbac_providers_webhook_sources_select_fixup_v1'));
COMMIT;

