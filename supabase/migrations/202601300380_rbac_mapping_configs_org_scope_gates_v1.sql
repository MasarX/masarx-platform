-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: RBAC + org scoping for mapping_configs v1
-- Date: 2026-01-30
--
-- Why:
--   - mapping_configs are required to onboard webhook_sources (tenant integrations).
--   - Tenants need self-serve mapping definitions, but we must prevent cross-tenant drift.
--   - Global/shared mapping configs must remain service-managed (no tenant edits).
--
-- Approach:
--   - Add optional organization_id to mapping_configs (NULL => global/shared).
--   - Backfill org-scoped mapping_configs from webhook_sources references (safe: only single-org refs).
--   - Grant authenticated DML and gate via RBAC (agreements.read/write) + org match.
--   - Enforce FK org consistency via triggers on webhook_sources + operation_templates.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601300380_rbac_mapping_configs_org_scope_gates_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Schema: optional org scoping (NULL => global/shared)
-------------------------------------------------------------------------------

ALTER TABLE public.mapping_configs
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id);

CREATE INDEX IF NOT EXISTS idx_mapping_configs_org_id
  ON public.mapping_configs (organization_id)
  WHERE organization_id IS NOT NULL;

-- Backfill org scope only when the mapping_config is referenced by exactly one org.
WITH one_org AS (
  SELECT
    ws.mapping_config_id,
    min(ws.organization_id::text)::uuid AS organization_id
  FROM public.webhook_sources ws
  GROUP BY ws.mapping_config_id
  HAVING COUNT(DISTINCT ws.organization_id) = 1
)
UPDATE public.mapping_configs mc
   SET organization_id = o.organization_id
  FROM one_org o
 WHERE mc.id = o.mapping_config_id
   AND mc.organization_id IS NULL;

-------------------------------------------------------------------------------
-- 2) Org consistency triggers (prevent cross-tenant links)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.webhook_sources_enforce_mapping_config_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_mc_org UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'webhook_sources: organization_id is required' USING ERRCODE = '23502';
  END IF;

  IF NEW.mapping_config_id IS NULL THEN
    RAISE EXCEPTION 'webhook_sources: mapping_config_id is required' USING ERRCODE = '23502';
  END IF;

  SELECT mc.organization_id
    INTO v_mc_org
    FROM public.mapping_configs mc
   WHERE mc.id = NEW.mapping_config_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'webhook_sources: mapping_config % not found', NEW.mapping_config_id USING ERRCODE = '23503';
  END IF;

  -- NULL means global/shared mapping config: allowed to be referenced by any org.
  IF v_mc_org IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_mc_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'webhook_sources: organization mismatch (source org %, mapping_config org %)', NEW.organization_id, v_mc_org
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_webhook_sources_enforce_mapping_config_org_match ON public.webhook_sources;
CREATE TRIGGER trg_webhook_sources_enforce_mapping_config_org_match
  BEFORE INSERT OR UPDATE ON public.webhook_sources
  FOR EACH ROW
  EXECUTE FUNCTION public.webhook_sources_enforce_mapping_config_org_match_v1();

CREATE OR REPLACE FUNCTION public.operation_templates_enforce_mapping_config_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_provider_org UUID;
  v_mc_org UUID;
BEGIN
  IF NEW.provider_id IS NULL THEN
    RAISE EXCEPTION 'operation_templates: provider_id is required' USING ERRCODE = '23502';
  END IF;

  IF NEW.mapping_config_id IS NULL THEN
    RAISE EXCEPTION 'operation_templates: mapping_config_id is required' USING ERRCODE = '23502';
  END IF;

  SELECT p.organization_id
    INTO v_provider_org
    FROM public.providers p
   WHERE p.id = NEW.provider_id;

  IF v_provider_org IS NULL THEN
    RAISE EXCEPTION 'operation_templates: provider % not found', NEW.provider_id USING ERRCODE = '23503';
  END IF;

  SELECT mc.organization_id
    INTO v_mc_org
    FROM public.mapping_configs mc
   WHERE mc.id = NEW.mapping_config_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation_templates: mapping_config % not found', NEW.mapping_config_id USING ERRCODE = '23503';
  END IF;

  -- NULL means global/shared mapping config: allowed to be referenced by any org.
  IF v_mc_org IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_mc_org IS DISTINCT FROM v_provider_org THEN
    RAISE EXCEPTION 'operation_templates: organization mismatch (provider org %, mapping_config org %)', v_provider_org, v_mc_org
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_operation_templates_enforce_mapping_config_org_match ON public.operation_templates;
CREATE TRIGGER trg_operation_templates_enforce_mapping_config_org_match
  BEFORE INSERT OR UPDATE ON public.operation_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.operation_templates_enforce_mapping_config_org_match_v1();

-------------------------------------------------------------------------------
-- 3) RLS + grants: authenticated is RBAC-gated (agreements.*)
-------------------------------------------------------------------------------

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

-------------------------------------------------------------------------------
-- 4) Table contract note (docs)
-------------------------------------------------------------------------------

UPDATE public.table_contracts
   SET notes = 'Tenant control-plane: mapping_configs. Org-scoped rows (organization_id set) are readable via RBAC (agreements.read) and writable via RBAC (agreements.write). Global/shared rows (organization_id NULL) remain service-managed.'
 WHERE table_schema = 'public' AND table_name = 'mapping_configs';

SELECT pg_advisory_unlock(hashtext('202601300380_rbac_mapping_configs_org_scope_gates_v1'));
COMMIT;
