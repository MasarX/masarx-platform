-- Migration: Refresh api contract views after last-mile CX structures (fixup v1)
-- Purpose:
--   - Ensure `api.<table>` contract views exist for all user-facing public tables.
--   - Keeps API surface dynamic/row-driven via SSOT function `public.refresh_api_contract_views_v1()`.
--   - Required for pgTAP `0zz_api_contract_views.sql`.

BEGIN;

SELECT pg_advisory_lock(hashtext('202601311790_refresh_api_contract_views_last_mile_fixup_v1'));

SELECT public.refresh_api_contract_views_v1();

SELECT pg_advisory_unlock(hashtext('202601311790_refresh_api_contract_views_last_mile_fixup_v1'));

COMMIT;

