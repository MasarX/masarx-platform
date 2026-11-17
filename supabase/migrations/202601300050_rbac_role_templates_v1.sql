-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: RBAC role templates + provisioning RPC v1 (row-driven)
-- Date: 2026-01-30
--
-- Goals:
--   - Provide reusable, row-driven RBAC role templates (global) to bootstrap tenant roles consistently.
--   - Provide a service-only provisioning RPC to instantiate org roles from templates (idempotent, additive).
--   - Keep security strict: service-only mutation; audited configuration.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601300050_rbac_role_templates_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Global role templates (row-driven; service-only access)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.rbac_role_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT rbac_role_templates_key_ck CHECK (btrim(key) <> '' AND key = lower(key)),
  CONSTRAINT rbac_role_templates_name_ck CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rbac_role_templates_key
  ON public.rbac_role_templates (key);

DROP TRIGGER IF EXISTS trg_rbac_role_templates_set_updated_at ON public.rbac_role_templates;
CREATE TRIGGER trg_rbac_role_templates_set_updated_at
  BEFORE UPDATE ON public.rbac_role_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.rbac_role_template_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  role_template_id UUID NOT NULL REFERENCES public.rbac_role_templates(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES public.lookup_values(id) ON DELETE RESTRICT,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT rbac_role_template_permissions_unique UNIQUE (role_template_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_rbac_role_template_permissions_template
  ON public.rbac_role_template_permissions (role_template_id);

CREATE INDEX IF NOT EXISTS idx_rbac_role_template_permissions_permission
  ON public.rbac_role_template_permissions (permission_id);

DROP TRIGGER IF EXISTS trg_rbac_role_template_permissions_set_updated_at ON public.rbac_role_template_permissions;
CREATE TRIGGER trg_rbac_role_template_permissions_set_updated_at
  BEFORE UPDATE ON public.rbac_role_template_permissions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.rbac_role_template_permissions_validate_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_perm_category TEXT;
BEGIN
  SELECT ld.category
    INTO v_perm_category
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
   WHERE lv.id = NEW.permission_id;

  IF v_perm_category IS NULL THEN
    RAISE EXCEPTION 'rbac_role_template_permissions: permission % not found', NEW.permission_id
      USING ERRCODE = '23503';
  END IF;

  IF v_perm_category IS DISTINCT FROM 'rbac_permission' THEN
    RAISE EXCEPTION 'rbac_role_template_permissions: permission % is not an rbac_permission (category=%)', NEW.permission_id, v_perm_category
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_rbac_role_template_permissions_validate_v1 ON public.rbac_role_template_permissions;
CREATE TRIGGER trg_rbac_role_template_permissions_validate_v1
  BEFORE INSERT OR UPDATE ON public.rbac_role_template_permissions
  FOR EACH ROW
  EXECUTE FUNCTION public.rbac_role_template_permissions_validate_v1();

-- RLS + least privilege: service-only (templates are operational/security configuration).
ALTER TABLE public.rbac_role_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rbac_role_template_permissions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rbac_role_templates FROM PUBLIC;
REVOKE ALL ON TABLE public.rbac_role_templates FROM anon;
REVOKE ALL ON TABLE public.rbac_role_templates FROM authenticated;

REVOKE ALL ON TABLE public.rbac_role_template_permissions FROM PUBLIC;
REVOKE ALL ON TABLE public.rbac_role_template_permissions FROM anon;
REVOKE ALL ON TABLE public.rbac_role_template_permissions FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.rbac_role_templates TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.rbac_role_template_permissions TO service_role;

DROP POLICY IF EXISTS rbac_role_templates_service_policy ON public.rbac_role_templates;
CREATE POLICY rbac_role_templates_service_policy
  ON public.rbac_role_templates
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS rbac_role_template_permissions_service_policy ON public.rbac_role_template_permissions;
CREATE POLICY rbac_role_template_permissions_service_policy
  ON public.rbac_role_template_permissions
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-------------------------------------------------------------------------------
-- 2) Seed baseline templates (extend later; keys stable)
-------------------------------------------------------------------------------

INSERT INTO public.rbac_role_templates (key, name, description, is_active, metadata)
VALUES
  ('ops_admin', 'Ops Admin', 'Full operational access (tenant admin baseline; use sparingly)', TRUE, jsonb_build_object('seed', TRUE, 'tier', 'admin')),
  ('finance', 'Finance', 'Finance access (ledger visibility + settlement operations)', TRUE, jsonb_build_object('seed', TRUE, 'tier', 'functional')),
  ('agreements_admin', 'Agreements Admin', 'Manage commercial agreements and settings references', TRUE, jsonb_build_object('seed', TRUE, 'tier', 'functional')),
  ('fleet_manager', 'Fleet Manager', 'Manage fleet assets and assignments', TRUE, jsonb_build_object('seed', TRUE, 'tier', 'functional')),
  ('warehouse_operator', 'Warehouse Operator', 'Warehouse task execution and scanning', TRUE, jsonb_build_object('seed', TRUE, 'tier', 'operational')),
  ('driver', 'Driver', 'Driver task execution and scanning', TRUE, jsonb_build_object('seed', TRUE, 'tier', 'operational'))
ON CONFLICT (key) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  is_active = EXCLUDED.is_active,
  metadata = public.rbac_role_templates.metadata || EXCLUDED.metadata,
  updated_at = now();

WITH template_perm_map AS (
  SELECT *
  FROM (VALUES
    ('ops_admin', 'shipments.read'),
    ('ops_admin', 'shipments.write'),
    ('ops_admin', 'tasks.read'),
    ('ops_admin', 'tasks.write'),
    ('ops_admin', 'tasks.complete'),
    ('ops_admin', 'finance.read'),
    ('ops_admin', 'finance.write'),
    ('ops_admin', 'agreements.read'),
    ('ops_admin', 'agreements.write'),
    ('ops_admin', 'settings.read'),
    ('ops_admin', 'settings.write'),
    ('ops_admin', 'settings.approve'),
    ('ops_admin', 'fleet.read'),
    ('ops_admin', 'fleet.write'),

    ('finance', 'finance.read'),
    ('finance', 'finance.write'),
    ('finance', 'agreements.read'),

    ('agreements_admin', 'agreements.read'),
    ('agreements_admin', 'agreements.write'),

    ('fleet_manager', 'fleet.read'),
    ('fleet_manager', 'fleet.write'),
    ('fleet_manager', 'tasks.read'),

    ('warehouse_operator', 'tasks.read'),
    ('warehouse_operator', 'tasks.complete'),
    ('warehouse_operator', 'shipments.read'),

    ('driver', 'tasks.read'),
    ('driver', 'tasks.complete'),
    ('driver', 'shipments.read')
  ) AS v(template_key, permission_value)
),
permission_registry AS (
  SELECT lv.id, lv.value
  FROM public.lookup_values lv
  JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
  WHERE ld.category = 'rbac_permission'
)
INSERT INTO public.rbac_role_template_permissions (role_template_id, permission_id, metadata)
SELECT
  t.id,
  p.id,
  jsonb_build_object('seed', TRUE, 'template_key', t.key)
FROM template_perm_map m
JOIN public.rbac_role_templates t ON t.key = m.template_key
JOIN permission_registry p ON p.value = m.permission_value
ON CONFLICT (role_template_id, permission_id) DO NOTHING;

-------------------------------------------------------------------------------
-- 3) Provisioning RPC: instantiate org roles from templates (additive, idempotent)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.provision_rbac_roles_from_templates_v1(
  p_organization_id UUID,
  p_template_keys TEXT[] DEFAULT NULL,
  p_granted_by_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  template_key TEXT,
  role_id UUID,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'provision_rbac_roles_from_templates_v1: organization_id is required' USING ERRCODE = '23502';
  END IF;

  RETURN QUERY
  WITH templates AS (
    SELECT t.id, t.key, t.name, t.description
    FROM public.rbac_role_templates t
    WHERE t.is_active IS TRUE
      AND (p_template_keys IS NULL OR t.key = ANY(p_template_keys))
  ),
  upserted_roles AS (
    INSERT INTO public.rbac_roles (organization_id, key, name, description, metadata)
    SELECT
      p_organization_id,
      t.key,
      t.name,
      t.description,
      jsonb_build_object('provisioned_from_template', TRUE, 'template_key', t.key)
    FROM templates t
    ON CONFLICT (organization_id, key) DO UPDATE
    SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      metadata = public.rbac_roles.metadata || EXCLUDED.metadata,
      updated_at = now()
    RETURNING public.rbac_roles.id, public.rbac_roles.key, (xmax = 0) AS created
  ),
  seeded_perms AS (
    INSERT INTO public.rbac_role_permissions (
      organization_id,
      role_id,
      permission_id,
      granted_by_user_id,
      metadata
    )
    SELECT
      p_organization_id,
      r.id,
      tp.permission_id,
      p_granted_by_user_id,
      jsonb_build_object('source', 'template', 'template_key', r.key)
    FROM upserted_roles r
    JOIN public.rbac_role_templates t ON t.key = r.key
    JOIN public.rbac_role_template_permissions tp ON tp.role_template_id = t.id
    ON CONFLICT (role_id, permission_id) DO NOTHING
    RETURNING role_id
  )
  SELECT r.key, r.id, r.created
  FROM upserted_roles r;
END;
$function$;

COMMENT ON FUNCTION public.provision_rbac_roles_from_templates_v1(UUID, TEXT[], UUID)
  IS 'Service-only: Provision org RBAC roles from global templates (additive, idempotent).';

REVOKE ALL ON FUNCTION public.provision_rbac_roles_from_templates_v1(UUID, TEXT[], UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.provision_rbac_roles_from_templates_v1(UUID, TEXT[], UUID) FROM anon;
REVOKE ALL ON FUNCTION public.provision_rbac_roles_from_templates_v1(UUID, TEXT[], UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.provision_rbac_roles_from_templates_v1(UUID, TEXT[], UUID) TO service_role;

-------------------------------------------------------------------------------
-- 4) Table contracts + audit triggers
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'rbac_role_templates', TRUE, TRUE, TRUE, 'Global RBAC role templates (service-only).'),
  ('public', 'rbac_role_template_permissions', TRUE, TRUE, TRUE, 'Global RBAC template-permission mapping (service-only).')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202601300050_rbac_role_templates_v1'));
COMMIT;
