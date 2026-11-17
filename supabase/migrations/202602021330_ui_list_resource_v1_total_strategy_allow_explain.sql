-- Migration: ui_list_resource_v1 total_strategy uses EXPLAIN; requires VOLATILE (Postgres disallows EXPLAIN in STABLE/IMMUTABLE functions)
BEGIN;
SELECT pg_advisory_lock(hashtext('202602021330_ui_list_resource_v1_total_strategy_allow_explain'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER FUNCTION public.ui_list_resource_v1(TEXT, JSONB, INT, INT, JSONB) VOLATILE;

COMMIT;
