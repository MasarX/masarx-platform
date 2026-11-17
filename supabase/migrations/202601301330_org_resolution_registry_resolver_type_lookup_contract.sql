-- Plan: PLAN-202601-ladder-phase6-remaining-ladder-hardcoding-ssot / Step: S04
-- Migration: Replace literal enum CHECK for organization_resolution_registry.resolver_type with lookup contracts (SSOT)
-- Objective: ZERO HARD CODING. Enum-like domains must be row-driven via lookup_values + lookup_column_contracts.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) Register lookup category + seed allowed values
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES (
  'organization_resolution_resolver_type',
  'Resolver type for organization resolution registry entries',
  'engineering',
  'tier_1',
  false
)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, v.value, v.label, v.sort_order, v.is_default, 'active'
FROM public.lookup_definitions d
JOIN (
  VALUES
    ('organization_resolution_resolver_type', 'scope_context', 'Scope Context', 10, true),
    ('organization_resolution_resolver_type', 'outbound_call_target', 'Outbound Call Target', 20, false)
) v(category, value, label, sort_order, is_default)
  ON d.category = v.category
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Map the governed column to the category and attach enforcement trigger
-------------------------------------------------------------------------------

INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category)
VALUES ('public', 'organization_resolution_registry', 'resolver_type', 'organization_resolution_resolver_type')
ON CONFLICT ON CONSTRAINT lookup_column_contracts_unique DO NOTHING;

SELECT public.apply_lookup_column_contracts('public');

-------------------------------------------------------------------------------
-- 3) Drop redundant literal allowlist CHECK constraints (column-driven; no name hardcoding)
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_table REGCLASS;
  v_attnum SMALLINT;
  r record;
BEGIN
  v_table := to_regclass('public.organization_resolution_registry');
  IF v_table IS NULL THEN
    RETURN;
  END IF;

  SELECT a.attnum
  INTO v_attnum
  FROM pg_attribute a
  WHERE a.attrelid = v_table
    AND a.attname = 'resolver_type'
    AND a.attisdropped = false;

  IF v_attnum IS NULL THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = v_table
      AND c.contype = 'c'
      AND v_attnum = ANY (c.conkey)
      AND (
        pg_get_constraintdef(c.oid) ILIKE '% IN (%'
        OR pg_get_constraintdef(c.oid) ILIKE '% IN(%'
        OR pg_get_constraintdef(c.oid) ILIKE '%ANY (ARRAY[%'
      )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', v_table::text, r.conname);
  END LOOP;
END;
$$;

COMMIT;

