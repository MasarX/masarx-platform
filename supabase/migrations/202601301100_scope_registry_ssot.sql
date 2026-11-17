-- Plan: PLAN-202601-ladder-phase6-remaining-ladder-hardcoding-ssot / Step: S04
-- Migration: Scope registry SSOT (scope types + aliases + ladder edges)
-- Purpose:
--   - Align the repo with the existing, canonical scope registry schema:
--       - public.scope_type_registry
--       - public.scope_type_aliases
--       - public.scope_ladder_edges
--   - Keep ladder behavior row-driven (no resolver hardcoding).
--   - Seed/normalize core ladder scope types and edges used by settings.
--
-- Notes:
--   - These tables are configuration/registry: write access is service_role only.
--   - The registry is shared across subsystems; avoid duplicating scope lists elsewhere.

BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) SSOT: scope_type_registry (canonical schema; shared)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.scope_type_registry (
  scope_type TEXT PRIMARY KEY,
  description TEXT,
  entity_table REGCLASS,
  id_column TEXT NOT NULL DEFAULT 'id',
  context_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settings_write_requires_platform_user BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT scope_type_registry_scope_type_ck CHECK (btrim(scope_type) <> ''),
  CONSTRAINT scope_type_registry_id_column_ck CHECK (btrim(id_column) <> ''),
  CONSTRAINT scope_type_registry_context_keys_ck CHECK (jsonb_typeof(context_keys) = 'array')
);

-- Used by settings_category_registry.allowed_scopes default selection (keep NULL for non-ladder scopes).
ALTER TABLE public.scope_type_registry
  ADD COLUMN IF NOT EXISTS ladder_rank INT;

DROP TRIGGER IF EXISTS trg_scope_type_registry_set_updated_at ON public.scope_type_registry;
CREATE TRIGGER trg_scope_type_registry_set_updated_at
BEFORE UPDATE ON public.scope_type_registry
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.scope_type_registry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.scope_type_registry FROM PUBLIC;
REVOKE ALL ON TABLE public.scope_type_registry FROM anon;
REVOKE ALL ON TABLE public.scope_type_registry FROM authenticated;

DROP POLICY IF EXISTS scope_type_registry_service_policy ON public.scope_type_registry;
CREATE POLICY scope_type_registry_service_policy
  ON public.scope_type_registry
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.scope_type_registry TO service_role;

-------------------------------------------------------------------------------
-- 2) SSOT: scope_type_aliases (normalize legacy names -> canonical scope_type)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.scope_type_aliases (
  alias TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL REFERENCES public.scope_type_registry(scope_type) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scope_type_aliases_alias_ck CHECK (btrim(alias) <> '')
);

DROP TRIGGER IF EXISTS trg_scope_type_aliases_set_updated_at ON public.scope_type_aliases;
CREATE TRIGGER trg_scope_type_aliases_set_updated_at
BEFORE UPDATE ON public.scope_type_aliases
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.scope_type_aliases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.scope_type_aliases FROM PUBLIC;
REVOKE ALL ON TABLE public.scope_type_aliases FROM anon;
REVOKE ALL ON TABLE public.scope_type_aliases FROM authenticated;

DROP POLICY IF EXISTS scope_type_aliases_service_policy ON public.scope_type_aliases;
CREATE POLICY scope_type_aliases_service_policy
  ON public.scope_type_aliases
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.scope_type_aliases TO service_role;

-------------------------------------------------------------------------------
-- 3) SSOT: scope_ladder_edges (row-driven ladder graph)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.scope_ladder_edges (
  child_scope_type TEXT NOT NULL REFERENCES public.scope_type_registry(scope_type) ON DELETE CASCADE,
  parent_scope_type TEXT NOT NULL REFERENCES public.scope_type_registry(scope_type) ON DELETE CASCADE,
  child_table REGCLASS NOT NULL,
  child_id_column TEXT NOT NULL DEFAULT 'id',
  child_parent_column TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scope_ladder_edges_child_id_column_ck CHECK (btrim(child_id_column) <> ''),
  CONSTRAINT scope_ladder_edges_child_parent_column_ck CHECK (btrim(child_parent_column) <> ''),
  CONSTRAINT scope_ladder_edges_not_self_ck CHECK (child_scope_type <> parent_scope_type),
  PRIMARY KEY (child_scope_type, parent_scope_type)
);

DROP TRIGGER IF EXISTS trg_scope_ladder_edges_set_updated_at ON public.scope_ladder_edges;
CREATE TRIGGER trg_scope_ladder_edges_set_updated_at
BEFORE UPDATE ON public.scope_ladder_edges
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.scope_ladder_edges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.scope_ladder_edges FROM PUBLIC;
REVOKE ALL ON TABLE public.scope_ladder_edges FROM anon;
REVOKE ALL ON TABLE public.scope_ladder_edges FROM authenticated;

DROP POLICY IF EXISTS scope_ladder_edges_service_policy ON public.scope_ladder_edges;
CREATE POLICY scope_ladder_edges_service_policy
  ON public.scope_ladder_edges
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.scope_ladder_edges TO service_role;

-------------------------------------------------------------------------------
-- 4) Contract enforcement: validate edge rows are consistent with the registry
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_scope_ladder_edge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_root_scope_type TEXT;
  v_child_entity_table REGCLASS;
  v_child_id_column TEXT;
  v_parent_entity_table REGCLASS;
  v_child_schema TEXT;
  v_child_table TEXT;
BEGIN
  SELECT r.scope_type
    INTO v_root_scope_type
    FROM public.scope_type_registry r
   WHERE r.entity_table IS NULL
     AND r.is_enabled = TRUE
   ORDER BY r.scope_type ASC
   LIMIT 1;

  IF v_root_scope_type IS NULL THEN
    RAISE EXCEPTION 'scope_type_registry missing root scope_type (entity_table IS NULL)'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.child_scope_type = v_root_scope_type THEN
    RAISE EXCEPTION 'scope_ladder_edges cannot have root child_scope_type: %', NEW.child_scope_type
      USING ERRCODE = '23514';
  END IF;

  IF NEW.parent_scope_type = v_root_scope_type THEN
    RAISE EXCEPTION 'scope_ladder_edges cannot target root parent_scope_type: %', NEW.parent_scope_type
      USING ERRCODE = '23514';
  END IF;

  SELECT r.entity_table, r.id_column
    INTO v_child_entity_table, v_child_id_column
    FROM public.scope_type_registry r
   WHERE r.scope_type = NEW.child_scope_type
     AND r.is_enabled = TRUE
   LIMIT 1;

  IF v_child_entity_table IS NULL THEN
    RAISE EXCEPTION 'scope_type_registry child_scope_type has NULL entity_table: %', NEW.child_scope_type
      USING ERRCODE = '23514';
  END IF;

  SELECT r.entity_table
    INTO v_parent_entity_table
    FROM public.scope_type_registry r
   WHERE r.scope_type = NEW.parent_scope_type
     AND r.is_enabled = TRUE
   LIMIT 1;

  IF v_parent_entity_table IS NULL THEN
    RAISE EXCEPTION 'scope_type_registry parent_scope_type has NULL entity_table: %', NEW.parent_scope_type
      USING ERRCODE = '23514';
  END IF;

  IF NEW.child_table IS DISTINCT FROM v_child_entity_table THEN
    RAISE EXCEPTION 'scope_ladder_edges child_table mismatch for % (expected %, got %)',
      NEW.child_scope_type,
      v_child_entity_table::text,
      NEW.child_table::text
      USING ERRCODE = '23514';
  END IF;

  IF NEW.child_id_column IS DISTINCT FROM v_child_id_column THEN
    RAISE EXCEPTION 'scope_ladder_edges child_id_column mismatch for % (expected %, got %)',
      NEW.child_scope_type,
      v_child_id_column,
      NEW.child_id_column
      USING ERRCODE = '23514';
  END IF;

  SELECT n.nspname, c.relname
    INTO v_child_schema, v_child_table
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = NEW.child_table::oid;

  IF v_child_schema IS NULL OR v_child_table IS NULL THEN
    RAISE EXCEPTION 'scope_ladder_edges child_table is invalid: %', NEW.child_table::text
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
    FROM information_schema.columns col
   WHERE col.table_schema = v_child_schema
     AND col.table_name = v_child_table
     AND col.column_name = NEW.child_id_column
     AND col.data_type = 'uuid'
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'scope_ladder_edges child_id_column "%" must exist as uuid on %.%',
      NEW.child_id_column, v_child_schema, v_child_table
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
    FROM information_schema.columns col
   WHERE col.table_schema = v_child_schema
     AND col.table_name = v_child_table
     AND col.column_name = NEW.child_parent_column
     AND col.data_type = 'uuid'
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'scope_ladder_edges child_parent_column "%" must exist as uuid on %.%',
      NEW.child_parent_column, v_child_schema, v_child_table
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_scope_ladder_edges_validate ON public.scope_ladder_edges;
CREATE TRIGGER trg_scope_ladder_edges_validate
BEFORE INSERT OR UPDATE ON public.scope_ladder_edges
FOR EACH ROW EXECUTE FUNCTION public.validate_scope_ladder_edge();

-------------------------------------------------------------------------------
-- 5) Seed core ladder scope types + aliases + edges (row-driven SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.scope_type_registry (
  scope_type,
  description,
  entity_table,
  id_column,
  context_keys,
  is_enabled,
  settings_write_requires_platform_user,
  ladder_rank
)
VALUES
  ('global', 'Global (no scope_id; applies to all)', NULL, 'id', '[]'::jsonb, TRUE, TRUE, 0),
  ('tenant', 'Tenant / organization scope', 'organizations'::regclass, 'id',
    '["organization_id","tenant_id","organizationId","tenantId"]'::jsonb, TRUE, FALSE, 10),
  ('client', 'Client scope', 'clients'::regclass, 'id',
    '["client_id","clientId"]'::jsonb, TRUE, FALSE, 20),
  ('sender', 'Sender scope', 'senders'::regclass, 'id',
    '["sender_id","senderId"]'::jsonb, TRUE, FALSE, 30),
  ('source', 'Webhook source scope', 'webhook_sources'::regclass, 'id',
    '["webhook_source_id","webhookSourceId","source_id","sourceId"]'::jsonb, TRUE, FALSE, 40),
  ('resource', 'Resource scope (provider_id)', 'providers'::regclass, 'id',
    '["provider_id","providerId","resource_id","resourceId"]'::jsonb, TRUE, TRUE, 40)
ON CONFLICT (scope_type) DO UPDATE
SET
  description = EXCLUDED.description,
  entity_table = EXCLUDED.entity_table,
  id_column = EXCLUDED.id_column,
  context_keys = EXCLUDED.context_keys,
  is_enabled = EXCLUDED.is_enabled,
  settings_write_requires_platform_user = EXCLUDED.settings_write_requires_platform_user,
  ladder_rank = EXCLUDED.ladder_rank,
  updated_at = now();

INSERT INTO public.scope_type_aliases (alias, scope_type)
VALUES
  ('organization', 'tenant')
ON CONFLICT (alias) DO UPDATE
SET
  scope_type = EXCLUDED.scope_type,
  updated_at = now();

INSERT INTO public.scope_ladder_edges (
  child_scope_type,
  parent_scope_type,
  child_table,
  child_id_column,
  child_parent_column,
  is_enabled
)
VALUES
  ('sender', 'client', 'senders'::regclass, 'id', 'client_id', TRUE),
  ('client', 'tenant', 'clients'::regclass, 'id', 'organization_id', TRUE),
  ('source', 'sender', 'webhook_sources'::regclass, 'id', 'sender_id', TRUE),
  ('source', 'tenant', 'webhook_sources'::regclass, 'id', 'organization_id', TRUE),
  ('resource', 'tenant', 'providers'::regclass, 'id', 'organization_id', TRUE)
ON CONFLICT (child_scope_type, parent_scope_type) DO UPDATE
SET
  child_table = EXCLUDED.child_table,
  child_id_column = EXCLUDED.child_id_column,
  child_parent_column = EXCLUDED.child_parent_column,
  is_enabled = EXCLUDED.is_enabled,
  updated_at = now();

COMMIT;

