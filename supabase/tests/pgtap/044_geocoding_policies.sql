-- Test Suite: Geocoding policy configuration (provider priority & workflow wiring)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

WITH policy AS (
  SELECT resolve_settings('geocoding_policy', 'global', NULL) AS cfg
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM policy, LATERAL jsonb_array_elements_text(policy.cfg->'provider_priority') AS provider(name)
    WHERE provider.name = 'here_geocoding'
  ),
  'Global geocoding policy includes HERE provider'
);

WITH policy AS (
  SELECT resolve_settings('geocoding_policy', 'global', NULL) AS cfg
),
priority AS (
  SELECT
    MIN(CASE WHEN provider.name = 'here_geocoding' THEN ordinality END) AS here_index,
    MIN(CASE WHEN provider.name = 'google_maps' THEN ordinality END) AS google_index
  FROM policy,
  LATERAL jsonb_array_elements_text(policy.cfg->'provider_priority') WITH ORDINALITY AS provider(name, ordinality)
)
SELECT ok(
  here_index IS NOT NULL
  AND google_index IS NOT NULL
  AND here_index < google_index,
  'HERE provider is prioritized before Google Maps in global geocoding policy'
)
FROM priority;

WITH policy AS (
  SELECT resolve_settings('geocoding_policy', 'global', NULL) AS cfg
)
SELECT is(
  policy.cfg->>'decision_workflow_id',
  'workflow_geocoding_standard',
  'Global geocoding policy routes through workflow_geocoding_standard'
)
FROM policy;

WITH steps AS (
  SELECT metadata
  FROM workflow_template_steps
  WHERE workflow_template_id = (
    SELECT id
    FROM workflow_templates
    WHERE name = 'workflow_geocoding_standard'
    LIMIT 1
  )
    AND operation_name = 'dispatch_provider'
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM steps
    WHERE metadata->>'provider_key' = 'here_geocoding'
  ),
  'workflow_geocoding_standard dispatch step derives provider_key=here_geocoding from metadata'
);

SELECT finish();

ROLLBACK;
