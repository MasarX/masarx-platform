-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: RBAC gates for providers + webhook_sources (read/write) v1
-- Date: 2026-01-30
--
-- Why:
--   - providers/webhook_sources are tenant control-plane integration surfaces.
--   - Prior baseline allowed any tenant-scoped user to read/write these tables.
--   - Enforce least-privilege by requiring RBAC permissions for authenticated access:
--       - reads:  agreements.read
--       - writes: agreements.write
--
-- Notes:
--   - service_role and edge roles remain authoritative for automation/workflows.
--   - Make grants explicit (stable contract; avoid implicit default privilege drift).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601300370_rbac_providers_webhook_sources_gates_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- Grants (explicit contract): authenticated access is RLS + RBAC gated.
-------------------------------------------------------------------------------

REVOKE ALL ON TABLE public.providers FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.providers TO authenticated;

REVOKE ALL ON TABLE public.webhook_sources FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.webhook_sources TO authenticated;

-------------------------------------------------------------------------------
-- Providers: authenticated reads/writes require agreements.* (RBAC)
-------------------------------------------------------------------------------

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
-- Webhook sources: authenticated reads/writes require agreements.* (RBAC)
-------------------------------------------------------------------------------

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
-- Table contracts (docs): reflect RBAC gating
-------------------------------------------------------------------------------

UPDATE public.table_contracts
   SET notes = 'Tenant control-plane: providers. Authenticated reads require RBAC (agreements.read); writes require RBAC (agreements.write).'
 WHERE table_schema = 'public' AND table_name = 'providers';

UPDATE public.table_contracts
   SET notes = 'Tenant control-plane: webhook sources. Authenticated reads require RBAC (agreements.read); writes require RBAC (agreements.write).'
 WHERE table_schema = 'public' AND table_name = 'webhook_sources';

SELECT pg_advisory_unlock(hashtext('202601300370_rbac_providers_webhook_sources_gates_v1'));
COMMIT;

