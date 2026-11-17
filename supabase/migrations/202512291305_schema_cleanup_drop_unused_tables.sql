-- Migration: Schema cleanup - drop unused tables (pre-production)
-- Purpose:
--   - Reduce schema surface area and maintenance burden by removing tables that
--     are not referenced by runtime code/tests.
--   - Keep the system SIMPLE, SCALABLE, and DYNAMIC by avoiding dead contracts.
-- Notes:
--   - These tables can be reintroduced later via new migrations when actually implemented.
--   - Verified unused via repo-wide search (excluding docs/archives).
BEGIN;
SELECT pg_advisory_lock(hashtext('202512291305_schema_cleanup_drop_unused_tables'));
SET search_path TO public, pg_temp;

DROP TABLE IF EXISTS public.webhook_rules;
DROP TABLE IF EXISTS public.settings_approval_queue;
DROP TABLE IF EXISTS public.settings_change_log;
DROP TABLE IF EXISTS public.rate_limits;
DROP TABLE IF EXISTS public.provider_pricing;
DROP TABLE IF EXISTS public.provider_health_metrics;

SELECT pg_advisory_unlock(hashtext('202512291305_schema_cleanup_drop_unused_tables'));

COMMIT;
