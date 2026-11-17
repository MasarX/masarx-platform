-- Plan: PLAN-202603-go-live-readiness-remediation-v4 / Step: S95
-- Purpose: ensure active global label_print_policy default remains schema-compliant.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

CREATE TEMP TABLE _global_label_print_policy AS
SELECT sv.value->>'poll_interval_seconds' AS poll_interval_seconds_text
FROM public.settings s
JOIN public.settings_versions sv
  ON sv.id = s.settings_version_id
WHERE s.category = 'label_print_policy'
  AND s.scope_type = 'global'
  AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
ORDER BY s.last_updated DESC
LIMIT 1;

SELECT is(
  (SELECT COUNT(*) FROM _global_label_print_policy),
  1::bigint,
  'active global label_print_policy row exists'
);

SELECT ok(
  COALESCE(
    (SELECT poll_interval_seconds_text ~ '^[0-9]+$' FROM _global_label_print_policy),
    false
  ),
  'active global label_print_policy poll_interval_seconds is numeric'
);

SELECT cmp_ok(
  COALESCE(
    (SELECT poll_interval_seconds_text::int FROM _global_label_print_policy),
    0
  ),
  '>=',
  5,
  'active global label_print_policy poll_interval_seconds >= 5'
);

SELECT * FROM finish();

ROLLBACK;
