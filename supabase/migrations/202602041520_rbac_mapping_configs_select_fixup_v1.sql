-- Plan: PLAN-202601-ladder-phase2-scope-from-context / Step: S04
-- Migration: RBAC gates for mapping_configs SELECT policy fixup v1
-- Purpose:
--   - Repair drift where mapping_configs SELECT is too permissive for authenticated tenants,
--     allowing reads of global/shared rows (organization_id NULL).
--   - Canonical contract: authenticated tenants can read only org-scoped rows via RBAC (agreements.read).

BEGIN;
SELECT pg_advisory_lock(hashtext('202602041520_rbac_mapping_configs_select_fixup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.mapping_configs
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id);

ALTER TABLE public.mapping_configs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.mapping_configs FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mapping_configs TO authenticated;

DROP POLICY IF EXISTS mapping_configs_select ON public.mapping_configs;
CREATE POLICY mapping_configs_select ON public.mapping_configs
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id IS NOT NULL
      AND organization_id = public.current_user_org_id()
      AND public.user_has_permission_v1('agreements.read', organization_id)
    )
  );

SELECT pg_advisory_unlock(hashtext('202602041520_rbac_mapping_configs_select_fixup_v1'));
COMMIT;

