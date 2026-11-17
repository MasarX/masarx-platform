-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: RBAC foundation v1 (permissions + roles + assignments; row-driven; least privilege ready)
-- Date: 2026-01-30
--
-- Goals:
--   - Enterprise-grade authorization primitives without hardcoding per-app role checks.
--   - Row-driven permissions registry (stable keys) + org-scoped roles + user-role assignments.
--   - Provide stable predicate function(s) for RLS/RPC guardrails (incremental rollout).
--   - Enforce org consistency (no cross-tenant links) and enable RLS + least privilege grants.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601300030_rbac_foundation_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Permission registry (row-driven via lookup_definitions/lookup_values)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('rbac_permission', 'RBAC permissions registry (stable keys) for RLS/RPC predicates', 'security', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

-- Seed a minimal enterprise baseline (extend later; keep keys stable).
INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, status, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  FALSE,
  'active',
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('shipments.read', 'Shipments Read', 'Read shipments, recipients, and shipment actions', 10, '{"resource":"shipments","action":"read"}'),
  ('shipments.write', 'Shipments Write', 'Create/update shipments via approved service paths', 20, '{"resource":"shipments","action":"write"}'),
  ('tasks.read', 'Tasks Read', 'Read tasks and task events', 30, '{"resource":"tasks","action":"read"}'),
  ('tasks.write', 'Tasks Write', 'Create/update tasks via approved service paths', 40, '{"resource":"tasks","action":"write"}'),
  ('tasks.complete', 'Tasks Complete', 'Complete/transition tasks', 50, '{"resource":"tasks","action":"complete"}'),
  ('finance.read', 'Finance Read', 'Read finance ledger events and settlement projections', 60, '{"resource":"finance","action":"read"}'),
  ('finance.write', 'Finance Write', 'Create finance events/settlement actions via approved service paths', 70, '{"resource":"finance","action":"write"}'),
  ('agreements.read', 'Agreements Read', 'Read commercial agreements and terms', 80, '{"resource":"agreements","action":"read"}'),
  ('agreements.write', 'Agreements Write', 'Manage commercial agreements and settings references', 90, '{"resource":"agreements","action":"write"}'),
  ('settings.read', 'Settings Read', 'Read effective settings and policies', 100, '{"resource":"settings","action":"read"}'),
  ('settings.write', 'Settings Write', 'Propose/update settings versions (approval-gated)', 110, '{"resource":"settings","action":"write"}'),
  ('settings.approve', 'Settings Approve', 'Approve settings versions and trigger apply', 120, '{"resource":"settings","action":"approve"}'),
  ('fleet.read', 'Fleet Read', 'Read fleet assets and assignments', 130, '{"resource":"fleet","action":"read"}'),
  ('fleet.write', 'Fleet Write', 'Manage fleet assets and assignments', 140, '{"resource":"fleet","action":"write"}')
) AS v(value, label, description, sort_order, metadata)
WHERE ld.category = 'rbac_permission'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) RBAC tables (org-scoped roles + mapping + assignments)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.rbac_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT rbac_roles_key_ck CHECK (btrim(key) <> '' AND key = lower(key)),
  CONSTRAINT rbac_roles_name_ck CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rbac_roles_org_key
  ON public.rbac_roles (organization_id, key);

DROP TRIGGER IF EXISTS trg_rbac_roles_set_updated_at ON public.rbac_roles;
CREATE TRIGGER trg_rbac_roles_set_updated_at
  BEFORE UPDATE ON public.rbac_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.rbac_role_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  role_id UUID NOT NULL REFERENCES public.rbac_roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES public.lookup_values(id) ON DELETE RESTRICT,

  granted_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT rbac_role_permissions_unique UNIQUE (role_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_rbac_role_permissions_org_role
  ON public.rbac_role_permissions (organization_id, role_id);

CREATE INDEX IF NOT EXISTS idx_rbac_role_permissions_org_permission
  ON public.rbac_role_permissions (organization_id, permission_id);

DROP TRIGGER IF EXISTS trg_rbac_role_permissions_set_updated_at ON public.rbac_role_permissions;
CREATE TRIGGER trg_rbac_role_permissions_set_updated_at
  BEFORE UPDATE ON public.rbac_role_permissions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.rbac_user_role_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES public.rbac_roles(id) ON DELETE CASCADE,

  assigned_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  revoked_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ NULL,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT rbac_user_role_assignments_revoked_range_ck CHECK (revoked_at IS NULL OR revoked_at >= assigned_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rbac_user_role_assignments_active_unique
  ON public.rbac_user_role_assignments (organization_id, user_id, role_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rbac_user_role_assignments_org_user
  ON public.rbac_user_role_assignments (organization_id, user_id, assigned_at DESC);

CREATE INDEX IF NOT EXISTS idx_rbac_user_role_assignments_org_role
  ON public.rbac_user_role_assignments (organization_id, role_id, assigned_at DESC);

DROP TRIGGER IF EXISTS trg_rbac_user_role_assignments_set_updated_at ON public.rbac_user_role_assignments;
CREATE TRIGGER trg_rbac_user_role_assignments_set_updated_at
  BEFORE UPDATE ON public.rbac_user_role_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 3) Guardrails: enforce org consistency + permission category validation
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rbac_role_permissions_validate_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_role_org UUID;
  v_perm_category TEXT;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'rbac_role_permissions: organization_id is required' USING ERRCODE = '23502';
  END IF;

  SELECT r.organization_id INTO v_role_org
  FROM public.rbac_roles r
  WHERE r.id = NEW.role_id;

  IF v_role_org IS NULL THEN
    RAISE EXCEPTION 'rbac_role_permissions: role % not found', NEW.role_id USING ERRCODE = '23503';
  END IF;

  IF v_role_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'rbac_role_permissions: organization mismatch (mapping org %, role org %)', NEW.organization_id, v_role_org
      USING ERRCODE = '23514';
  END IF;

  SELECT ld.category
    INTO v_perm_category
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
   WHERE lv.id = NEW.permission_id;

  IF v_perm_category IS NULL THEN
    RAISE EXCEPTION 'rbac_role_permissions: permission % not found', NEW.permission_id USING ERRCODE = '23503';
  END IF;

  IF v_perm_category IS DISTINCT FROM 'rbac_permission' THEN
    RAISE EXCEPTION 'rbac_role_permissions: permission % is not an rbac_permission (category=%)', NEW.permission_id, v_perm_category
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_rbac_role_permissions_validate_v1 ON public.rbac_role_permissions;
CREATE TRIGGER trg_rbac_role_permissions_validate_v1
  BEFORE INSERT OR UPDATE ON public.rbac_role_permissions
  FOR EACH ROW
  EXECUTE FUNCTION public.rbac_role_permissions_validate_v1();

CREATE OR REPLACE FUNCTION public.rbac_user_role_assignments_validate_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_org UUID;
  v_role_org UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'rbac_user_role_assignments: organization_id is required' USING ERRCODE = '23502';
  END IF;

  SELECT u.organization_id INTO v_user_org
  FROM public.users u
  WHERE u.id = NEW.user_id;

  IF v_user_org IS NULL THEN
    RAISE EXCEPTION 'rbac_user_role_assignments: user % not found', NEW.user_id USING ERRCODE = '23503';
  END IF;

  IF v_user_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'rbac_user_role_assignments: organization mismatch (assignment org %, user org %)', NEW.organization_id, v_user_org
      USING ERRCODE = '23514';
  END IF;

  SELECT r.organization_id INTO v_role_org
  FROM public.rbac_roles r
  WHERE r.id = NEW.role_id;

  IF v_role_org IS NULL THEN
    RAISE EXCEPTION 'rbac_user_role_assignments: role % not found', NEW.role_id USING ERRCODE = '23503';
  END IF;

  IF v_role_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'rbac_user_role_assignments: organization mismatch (assignment org %, role org %)', NEW.organization_id, v_role_org
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_rbac_user_role_assignments_validate_v1 ON public.rbac_user_role_assignments;
CREATE TRIGGER trg_rbac_user_role_assignments_validate_v1
  BEFORE INSERT OR UPDATE ON public.rbac_user_role_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.rbac_user_role_assignments_validate_v1();

-------------------------------------------------------------------------------
-- 4) Permission predicate helper (incremental rollout; does not change existing policies yet)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.user_has_permission_v1(
  p_permission_key TEXT,
  p_organization_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_perm TEXT := lower(NULLIF(btrim(COALESCE(p_permission_key, '')), ''));
  v_org UUID := COALESCE(p_organization_id, public.current_user_org_id());
  v_user UUID := auth.uid();

  v_claims JSONB := NULL;
  v_role TEXT := NULL;

  v_exists BOOLEAN := FALSE;
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;
  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  -- service_role bypass (required for workflows/RPCs).
  IF v_role IS NOT DISTINCT FROM 'service_role' THEN
    RETURN TRUE;
  END IF;

  -- Platform users are trusted for cross-org support tooling.
  IF COALESCE(public.is_platform_user(), FALSE) IS TRUE THEN
    RETURN TRUE;
  END IF;

  IF v_perm IS NULL OR v_user IS NULL OR v_org IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.rbac_user_role_assignments ura
    JOIN public.rbac_roles r ON r.id = ura.role_id
    JOIN public.rbac_role_permissions rp ON rp.role_id = r.id
    JOIN public.lookup_values lv ON lv.id = rp.permission_id
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ura.organization_id = v_org
      AND ura.user_id = v_user
      AND ura.revoked_at IS NULL
      AND r.is_active = TRUE
      AND rp.organization_id = v_org
      AND ld.category = 'rbac_permission'
      AND lv.value = v_perm
  )
  INTO v_exists;

  RETURN v_exists;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.user_has_permission_v1(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_has_permission_v1(TEXT, UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.user_has_permission_v1(TEXT, UUID)
  IS 'RBAC predicate (stable): returns true if current user has permission_key in org (service_role and platform bypass). Used by RLS/RPC guardrails (incremental rollout).';

-------------------------------------------------------------------------------
-- 5) RLS + grants (least privilege: select for tenant, manage via service_role)
-------------------------------------------------------------------------------

ALTER TABLE public.rbac_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rbac_role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rbac_user_role_assignments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rbac_roles FROM PUBLIC;
REVOKE ALL ON TABLE public.rbac_roles FROM anon;
REVOKE ALL ON TABLE public.rbac_roles FROM authenticated;

REVOKE ALL ON TABLE public.rbac_role_permissions FROM PUBLIC;
REVOKE ALL ON TABLE public.rbac_role_permissions FROM anon;
REVOKE ALL ON TABLE public.rbac_role_permissions FROM authenticated;

REVOKE ALL ON TABLE public.rbac_user_role_assignments FROM PUBLIC;
REVOKE ALL ON TABLE public.rbac_user_role_assignments FROM anon;
REVOKE ALL ON TABLE public.rbac_user_role_assignments FROM authenticated;

GRANT SELECT ON TABLE public.rbac_roles TO authenticated;
GRANT SELECT ON TABLE public.rbac_role_permissions TO authenticated;
GRANT SELECT ON TABLE public.rbac_user_role_assignments TO authenticated;

GRANT ALL ON TABLE public.rbac_roles TO service_role;
GRANT ALL ON TABLE public.rbac_role_permissions TO service_role;
GRANT ALL ON TABLE public.rbac_user_role_assignments TO service_role;

-- service_role full access
DROP POLICY IF EXISTS rbac_roles_service_policy ON public.rbac_roles;
CREATE POLICY rbac_roles_service_policy ON public.rbac_roles
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS rbac_role_permissions_service_policy ON public.rbac_role_permissions;
CREATE POLICY rbac_role_permissions_service_policy ON public.rbac_role_permissions
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS rbac_user_role_assignments_service_policy ON public.rbac_user_role_assignments;
CREATE POLICY rbac_user_role_assignments_service_policy ON public.rbac_user_role_assignments
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- Authenticated SELECT (tenant-only; platform can read all)
DROP POLICY IF EXISTS rbac_roles_select_policy ON public.rbac_roles;
CREATE POLICY rbac_roles_select_policy ON public.rbac_roles
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS rbac_role_permissions_select_policy ON public.rbac_role_permissions;
CREATE POLICY rbac_role_permissions_select_policy ON public.rbac_role_permissions
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS rbac_user_role_assignments_select_policy ON public.rbac_user_role_assignments;
CREATE POLICY rbac_user_role_assignments_select_policy ON public.rbac_user_role_assignments
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

-------------------------------------------------------------------------------
-- 6) Table contracts (timestamp + audit SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'rbac_roles', TRUE, TRUE, TRUE, 'RBAC roles (org-scoped).'),
  ('public', 'rbac_role_permissions', TRUE, TRUE, TRUE, 'RBAC role-permission mapping (org-scoped).'),
  ('public', 'rbac_user_role_assignments', TRUE, TRUE, TRUE, 'RBAC user-role assignments (org-scoped; audited).')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET created_at_required = EXCLUDED.created_at_required,
    updated_at_required = EXCLUDED.updated_at_required,
    audit_enabled = EXCLUDED.audit_enabled,
    notes = EXCLUDED.notes;

SELECT * FROM public.apply_table_contracts('public');

SELECT pg_advisory_unlock(hashtext('202601300030_rbac_foundation_v1'));
COMMIT;
