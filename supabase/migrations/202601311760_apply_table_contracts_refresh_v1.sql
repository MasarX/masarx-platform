-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: apply_table_contracts refresh v1 (ensure audit/timestamp triggers after new contract rows)
-- Date: 2026-01-31
--
-- Purpose:
--   - Ensure new/updated public.table_contracts rows are enforced (timestamps + audit triggers)
--     after adding new enterprise modules.
--   - This is a fixup migration to satisfy the table_contracts audit/timestamp contract tests.
BEGIN;
SELECT pg_advisory_lock(hashtext('202601311760_apply_table_contracts_refresh_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

SELECT * FROM public.apply_table_contracts('public');

SELECT pg_advisory_unlock(hashtext('202601311760_apply_table_contracts_refresh_v1'));
COMMIT;

