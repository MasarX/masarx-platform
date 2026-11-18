-- Spec-Issue: CATALOG D3 close-out (W9-5) — formalize service_offering_status
-- and service_level_tier lookup categories
-- Step: W9-5
-- Capability: lookups governed by the existing
--   `lookup_definitions` / `lookup_values` ladder (see
--   202510110003_mapping_lookup.sql lines 12-66).
--
-- Why: __audit__/CROSSWALK/CATALOG.md flags these two categories as P3 gaps
-- because they live only in the FE seed (`apps/console-v2/src/lib/seed-raw/
-- catalog-offerings.js:48-60`) without canonical `lookup_definitions` rows.
-- This means the Lookups module shows the categories without owner/approval
-- metadata, and downstream policy/registry consumers cannot reference them
-- as governed enums. Formalizing here so:
--   1. Catalog operators see consistent owner_role / approval_policy chips.
--   2. The `service_offerings.is_active`-display semantics map to a row-
--      driven status enum (mirrors operator chip tones in the FE).
--   3. Service-level tier metadata (`service_levels.metadata->'tier'`)
--      becomes governed instead of FE-only.
--
-- Idempotent: ON CONFLICT (category) / ON CONFLICT DO NOTHING for value
-- inserts so reapplication leaves the table untouched. Append-only —
-- existing rows in either category are preserved.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604301300_catalog_lookup_canonicalization_v1'));
SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) Ensure canonical lookup_definitions rows exist
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('service_offering_status',
   'Service offering display status (mirrors service_offerings.is_active + archived/draft tones)',
   'operations',
   'tier_1',
   false),
  ('service_level_tier',
   'Service level tier name (mirrors service_levels.metadata->>tier; drives priority_rank tone)',
   'operations',
   'tier_1',
   false)
ON CONFLICT (category) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Seed canonical baseline lookup_values for both categories
-------------------------------------------------------------------------------
-- Values mirror the FE seed (`catalog-offerings.js:48-60`). Tones are kept
-- inside lookup_values.metadata.tone so the FE Lookups editor reads the same
-- chip palette — keeps the editor row-driven without inventing new columns.

INSERT INTO public.lookup_values (
  lookup_definition_id, value, label, sort_order, is_default, status, metadata
)
SELECT d.id, v.value, v.label, v.sort_order, v.is_default, 'active', v.metadata
FROM public.lookup_definitions d
JOIN (
  VALUES
    -- service_offering_status (mirrors FE seed lines 48-52)
    ('service_offering_status', 'active',   'Active',   10, TRUE,  jsonb_build_object('tone','good')),
    ('service_offering_status', 'draft',    'Draft',    20, FALSE, jsonb_build_object('tone','info')),
    ('service_offering_status', 'archived', 'Archived', 30, FALSE, jsonb_build_object('tone','neutral')),

    -- service_level_tier (mirrors FE seed lines 53-59)
    ('service_level_tier', 'economy',     'Economy',     10, FALSE, jsonb_build_object('tone','neutral')),
    ('service_level_tier', 'standard',    'Standard',    20, FALSE, jsonb_build_object('tone','info')),
    ('service_level_tier', 'express',     'Express',     30, FALSE, jsonb_build_object('tone','good')),
    ('service_level_tier', 'same_day',    'Same day',    40, FALSE, jsonb_build_object('tone','warn')),
    ('service_level_tier', 'white_glove', 'White glove', 50, FALSE, jsonb_build_object('tone','danger'))
) AS v(category, value, label, sort_order, is_default, metadata)
  ON v.category = d.category
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

SELECT pg_advisory_unlock(hashtext('202604301300_catalog_lookup_canonicalization_v1'));

COMMIT;
