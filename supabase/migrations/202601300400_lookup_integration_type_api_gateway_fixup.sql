-- Plan: PLAN-202601-schema-audit-improvements / Step: S95
-- Migration: Fix missing integration_type value used by API gateway sources
-- Notes:
-- - Some environments may have applied an older 202601211830 migration variant that did not
--   seed the required lookup value; this fixup is idempotent and safe to re-run.

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'api_gateway', 'API Gateway', 12, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'integration_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

