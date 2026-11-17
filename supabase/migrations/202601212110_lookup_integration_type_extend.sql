-- Plan: PLAN-202601-schema-audit-improvements / Step: S95
-- Migration: Extend integration_type lookup values for webhook ingest contracts
-- Purpose:
--   - lookup_column_contracts enforces webhook_sources.provider_type + webhook_inbox.provider_type via integration_type.
--   - Ensure enterprise-grade SSOT coverage for known integrations used in tests/runtime.
-- Date: 2026-01-21

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, status)
SELECT
  d.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  FALSE,
  'active'
FROM public.lookup_definitions d
JOIN (
  VALUES
    ('logestechs_3pl', 'Logestechs 3PL', 'Logestechs 3PL webhook/integration type', 120),
    ('observability', 'Observability', 'Internal observability/test webhook provider type', 900)
) AS v(value, label, description, sort_order)
  ON d.category = 'integration_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

