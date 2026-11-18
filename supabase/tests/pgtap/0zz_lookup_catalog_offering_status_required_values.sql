-- Test: service_offering_status + service_level_tier governance lookup
-- categories exist (CATALOG D3 close-out W9-5, W57-B owner alignment).
--
-- Migrations:
-- - 202604301300_catalog_lookup_canonicalization_v1.sql seeds the categories.
-- - 202605021400_w57b_console_v2_w54_w56_canonical_pack.sql owns the current
--   product/tier_2 governance metadata for catalog-offering lookups.
--
-- Why: __audit__/CROSSWALK/CATALOG.md flagged these two categories as P3
-- gaps because they only lived in the FE seed (catalog-offerings.js).
-- This test asserts the canonical migration formalizes them as governed
-- lookup_definitions/lookup_values rows.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

-- 1) lookup_definitions row exists for service_offering_status with the
-- expected current ownership + immutability defaults.
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions
    WHERE category = 'service_offering_status'
      AND owner_role = 'product'
      AND approval_policy = 'tier_2'
      AND is_mutable = false
  ),
  'lookup_definitions row exists for service_offering_status (product / tier_2 / immutable)'
);

-- 2) lookup_definitions row exists for service_level_tier with the same shape.
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions
    WHERE category = 'service_level_tier'
      AND owner_role = 'product'
      AND approval_policy = 'tier_2'
      AND is_mutable = false
  ),
  'lookup_definitions row exists for service_level_tier (product / tier_2 / immutable)'
);

-- 3-5) service_offering_status canonical values exist + active.
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values v
    JOIN public.lookup_definitions d ON d.id = v.lookup_definition_id
    WHERE d.category = 'service_offering_status'
      AND v.value = 'active'
      AND v.status = 'active'
      AND v.is_default = true
  ),
  'service_offering_status includes active (default + status=active)'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values v
    JOIN public.lookup_definitions d ON d.id = v.lookup_definition_id
    WHERE d.category = 'service_offering_status'
      AND v.value = 'draft'
      AND v.status = 'active'
  ),
  'service_offering_status includes draft'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values v
    JOIN public.lookup_definitions d ON d.id = v.lookup_definition_id
    WHERE d.category = 'service_offering_status'
      AND v.value = 'archived'
      AND v.status = 'active'
  ),
  'service_offering_status includes archived'
);

-- 6-10) service_level_tier canonical values exist + active.
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values v
    JOIN public.lookup_definitions d ON d.id = v.lookup_definition_id
    WHERE d.category = 'service_level_tier'
      AND v.value = 'economy'
      AND v.status = 'active'
  ),
  'service_level_tier includes economy'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values v
    JOIN public.lookup_definitions d ON d.id = v.lookup_definition_id
    WHERE d.category = 'service_level_tier'
      AND v.value = 'standard'
      AND v.status = 'active'
  ),
  'service_level_tier includes standard'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values v
    JOIN public.lookup_definitions d ON d.id = v.lookup_definition_id
    WHERE d.category = 'service_level_tier'
      AND v.value = 'express'
      AND v.status = 'active'
  ),
  'service_level_tier includes express'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values v
    JOIN public.lookup_definitions d ON d.id = v.lookup_definition_id
    WHERE d.category = 'service_level_tier'
      AND v.value = 'same_day'
      AND v.status = 'active'
  ),
  'service_level_tier includes same_day'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values v
    JOIN public.lookup_definitions d ON d.id = v.lookup_definition_id
    WHERE d.category = 'service_level_tier'
      AND v.value = 'white_glove'
      AND v.status = 'active'
  ),
  'service_level_tier includes white_glove'
);

SELECT * FROM finish();

ROLLBACK;
