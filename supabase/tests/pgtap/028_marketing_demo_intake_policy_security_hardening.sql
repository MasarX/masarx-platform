BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

WITH p AS (
  SELECT public.resolve_settings_merged('marketing_demo_intake_policy', 'global', NULL::uuid) AS policy
)
SELECT ok(
  COALESCE(NULLIF(policy#>>'{turnstile,required}', '')::boolean, TRUE) IS TRUE,
  'marketing_demo_intake_policy.turnstile.required = true'
)
FROM p;

WITH p AS (
  SELECT public.resolve_settings_merged('marketing_demo_intake_policy', 'global', NULL::uuid) AS policy
)
SELECT is(
  COALESCE(NULLIF(policy#>>'{rate_limit,window_seconds}', '')::int, 0),
  600,
  'marketing_demo_intake_policy.rate_limit.window_seconds = 600'
)
FROM p;

WITH p AS (
  SELECT public.resolve_settings_merged('marketing_demo_intake_policy', 'global', NULL::uuid) AS policy
)
SELECT is(
  COALESCE(NULLIF(policy#>>'{rate_limit,max_requests}', '')::int, 0),
  5,
  'marketing_demo_intake_policy.rate_limit.max_requests = 5'
)
FROM p;

WITH p AS (
  SELECT public.resolve_settings_merged('marketing_demo_intake_policy', 'global', NULL::uuid) AS policy
)
SELECT is(
  COALESCE(NULLIF(policy#>>'{dedupe,window_seconds}', '')::int, 0),
  21600,
  'marketing_demo_intake_policy.dedupe.window_seconds = 21600'
)
FROM p;

SELECT finish();

ROLLBACK;

