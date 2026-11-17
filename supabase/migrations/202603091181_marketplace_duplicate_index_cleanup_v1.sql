-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S04
-- Migration: Drop redundant marketplace indexes superseded by unique constraint indexes

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091181_marketplace_duplicate_index_cleanup_v1'));
SET search_path TO public, extensions, pg_temp;

DROP INDEX IF EXISTS public.idx_marketplace_participant_capabilities_profile;
DROP INDEX IF EXISTS public.idx_marketplace_participant_profiles_org;

SELECT pg_advisory_unlock(hashtext('202603091181_marketplace_duplicate_index_cleanup_v1'));
COMMIT;
