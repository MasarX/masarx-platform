-- Plan: PLAN-202601-schema-audit-improvements / Step: S95
-- Migration: Add missing integration_type value used by API gateway sources
-- Notes:
-- - webhook_sources.provider_type is governed by lookup category integration_type via lookup_column_contracts.
-- - api_gateway is a first-class internal source type (used by tests and workflows) and must be an allowed value.

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'api_gateway', 'API Gateway', 12, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'integration_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

