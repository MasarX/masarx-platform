-- Migration: ui_list_resource_v1 must be VOLATILE because estimate totals execute EXPLAIN
BEGIN;
SELECT pg_advisory_lock(hashtext('202604171120_ui_list_resource_total_strategy_volatility_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER FUNCTION public.ui_list_resource_v1(TEXT, JSONB, INT, INT, JSONB) VOLATILE;

SELECT pg_advisory_unlock(hashtext('202604171120_ui_list_resource_total_strategy_volatility_v1'));
COMMIT;
