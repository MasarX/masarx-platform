-- Plan: PLAN-202601-schema-prod-finalization / Step: S04
-- Migration: Remove redundant indexes/constraints (zero redundancy).
-- Notes:
--   - Redundant non-unique indexes duplicating an equivalent UNIQUE/PK index add write overhead without benefit.
--   - Duplicate uniqueness constraints on the same key are confusing and can cause unnecessary locking/work.
--   - This is a safe, idempotent fixup (DROP ... IF EXISTS).

BEGIN;

SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) Drop redundant duplicate indexes (exact same access path)
-------------------------------------------------------------------------------

-- Unique constraint already creates a btree index on the same columns.
DROP INDEX IF EXISTS public.idx_address_code_registry_lookup;

-- Duplicate GIN indexes created by separate migrations (same column, same method).
DROP INDEX IF EXISTS public.idx_canonical_cities_alt_gin;
DROP INDEX IF EXISTS public.idx_canonical_districts_alt_gin;

-- Unique constraint already creates a btree index on the same column(s).
DROP INDEX IF EXISTS public.idx_lookup_definitions_category;
DROP INDEX IF EXISTS public.idx_mapping_configs_type_key;
DROP INDEX IF EXISTS public.idx_partitioning_config_table;
DROP INDEX IF EXISTS public.idx_shipment_boxes_barcode;
DROP INDEX IF EXISTS public.idx_workflow_templates_name;
DROP INDEX IF EXISTS public.idx_zone_districts_district;

-------------------------------------------------------------------------------
-- 2) Drop redundant uniqueness constraints
-------------------------------------------------------------------------------

-- Duplicate of PK (id, scope_hash).
ALTER TABLE public.settings_versions
  DROP CONSTRAINT IF EXISTS settings_versions_id_scope_hash_unique;

-- Keep the NULLS NOT DISTINCT bucket uniqueness; drop the legacy duplicate.
ALTER TABLE public.provider_usage_tracking
  DROP CONSTRAINT IF EXISTS provider_usage_tracking_organization_id_client_id_sender_id_key;

COMMIT;

