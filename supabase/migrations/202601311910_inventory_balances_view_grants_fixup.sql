-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: Inventory balances view grants fixup (api inventory balances must be invoker-readable)
-- Date: 2026-01-31
--
-- Notes:
--   - api.inventory_balances_v1 is security_invoker and selects from public.inventory_balances_v1.
--   - Therefore authenticated must have SELECT on public.inventory_balances_v1 for the api view to work.
BEGIN;
SELECT pg_advisory_lock(hashtext('202601311910_inventory_balances_view_grants_fixup'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

GRANT SELECT ON public.inventory_balances_v1 TO authenticated;

SELECT pg_advisory_unlock(hashtext('202601311910_inventory_balances_view_grants_fixup'));
COMMIT;

