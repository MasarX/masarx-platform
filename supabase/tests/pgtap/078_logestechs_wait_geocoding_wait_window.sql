-- Test Suite: Logestechs geocode-first workflow wait window is long enough
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(1);

SET search_path TO public, pgtap, extensions;

SELECT cmp_ok(
  COALESCE(
    (
      SELECT NULLIF(wts.metadata->>'max_wait_seconds', '')::INT
      FROM public.workflow_templates wt
      JOIN public.workflow_template_steps wts
        ON wts.workflow_template_id = wt.id
      WHERE wt.name = 'api_gateway_logestechs_v2_create_geocode_first_v1'
        AND wt.status = 'active'
        AND wts.operation_name = 'wait_geocoding'
        AND wts.handler_key = 'wait_workflow'
      ORDER BY wt.updated_at DESC
      LIMIT 1
    ),
    0
  ),
  '>=',
  600,
  'wait_geocoding max_wait_seconds is >= 600s (cloud latency safe)'
);

SELECT finish();

ROLLBACK;
