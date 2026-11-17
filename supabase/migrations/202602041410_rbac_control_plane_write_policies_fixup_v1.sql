-- Plan: PLAN-202601-ladder-phase2-scope-from-context / Step: S04
-- Migration: RBAC control-plane write policies fixup v1
-- Purpose:
--   - Repair drift in long-lived environments where authenticated write policies for control-plane
--     tables do not reference RBAC (user_has_permission_v1), causing regression guards to fail.
--   - Targets: providers, webhook_sources, mapping_configs (write paths).

BEGIN;
SELECT pg_advisory_lock(hashtext('202602041410_rbac_control_plane_write_policies_fixup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- Providers: authenticated writes require agreements.write (RBAC)
-------------------------------------------------------------------------------

REVOKE ALL ON TABLE public.providers FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.providers TO authenticated;

DROP POLICY IF EXISTS providers_insert ON public.providers;
CREATE POLICY providers_insert ON public.providers
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS providers_update ON public.providers;
CREATE POLICY providers_update ON public.providers
  FOR UPDATE
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS providers_delete ON public.providers;
CREATE POLICY providers_delete ON public.providers
  FOR DELETE
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

-------------------------------------------------------------------------------
-- Webhook sources: authenticated writes require agreements.write (RBAC)
-------------------------------------------------------------------------------

REVOKE ALL ON TABLE public.webhook_sources FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.webhook_sources TO authenticated;

DROP POLICY IF EXISTS webhook_sources_insert ON public.webhook_sources;
CREATE POLICY webhook_sources_insert ON public.webhook_sources
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS webhook_sources_update ON public.webhook_sources;
CREATE POLICY webhook_sources_update ON public.webhook_sources
  FOR UPDATE
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS webhook_sources_delete ON public.webhook_sources;
CREATE POLICY webhook_sources_delete ON public.webhook_sources
  FOR DELETE
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

-------------------------------------------------------------------------------
-- Mapping configs: authenticated writes require agreements.write (RBAC)
-- Notes:
--   - Ensure org scope column exists for policy expressions.
--   - Policy semantics mirror the canonical org-scoped RBAC model.
-------------------------------------------------------------------------------

ALTER TABLE public.mapping_configs
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id);

ALTER TABLE public.mapping_configs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.mapping_configs FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mapping_configs TO authenticated;

DROP POLICY IF EXISTS mapping_configs_insert ON public.mapping_configs;
CREATE POLICY mapping_configs_insert ON public.mapping_configs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_platform_user()
    OR (
      public.user_can_write()
      AND public.current_user_scope_type() = 'tenant'
      AND organization_id IS NOT NULL
      AND organization_id = public.current_user_org_id()
      AND public.user_has_permission_v1('agreements.write', organization_id)
    )
  );

DROP POLICY IF EXISTS mapping_configs_update ON public.mapping_configs;
CREATE POLICY mapping_configs_update ON public.mapping_configs
  FOR UPDATE
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.user_can_write()
      AND public.current_user_scope_type() = 'tenant'
      AND organization_id IS NOT NULL
      AND organization_id = public.current_user_org_id()
      AND public.user_has_permission_v1('agreements.write', organization_id)
    )
  )
  WITH CHECK (
    public.is_platform_user()
    OR (
      public.user_can_write()
      AND public.current_user_scope_type() = 'tenant'
      AND organization_id IS NOT NULL
      AND organization_id = public.current_user_org_id()
      AND public.user_has_permission_v1('agreements.write', organization_id)
    )
  );

DROP POLICY IF EXISTS mapping_configs_delete ON public.mapping_configs;
CREATE POLICY mapping_configs_delete ON public.mapping_configs
  FOR DELETE
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.user_can_write()
      AND public.current_user_scope_type() = 'tenant'
      AND organization_id IS NOT NULL
      AND organization_id = public.current_user_org_id()
      AND public.user_has_permission_v1('agreements.write', organization_id)
    )
  );

SELECT pg_advisory_unlock(hashtext('202602041410_rbac_control_plane_write_policies_fixup_v1'));
COMMIT;

