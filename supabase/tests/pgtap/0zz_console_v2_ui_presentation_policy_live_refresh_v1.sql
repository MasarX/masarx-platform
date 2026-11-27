BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(18);

CREATE TEMP TABLE live_refresh_policy_fixture AS
SELECT s.id, s.settings_version_id, s.cached_value
  FROM public.settings s
 WHERE s.category = 'ui_presentation_policy'
   AND s.scope_type = 'global'
   AND s.scope_id IS NULL;

SELECT is(
  (SELECT value->'live_refresh'
     FROM public.resolve_settings_row_from_policy_context_v1('ui_presentation_policy', '{}'::jsonb)
    WHERE scope_type = 'global'),
  '{"poll_interval_ms":30000,"offline_after_ms":60000,"max_reconnects":3,"refetch_interval_ms":10000}'::jsonb,
  'global settings resolution returns all live refresh defaults'
);

SELECT ok(EXISTS (
  SELECT 1
    FROM live_refresh_policy_fixture f
    JOIN public.settings_versions seeded ON seeded.id = f.settings_version_id
    JOIN public.settings_versions previous
      ON previous.category = seeded.category
     AND previous.scope_type = seeded.scope_type
     AND previous.scope_id IS NULL
     AND previous.approved_at IS NOT NULL
     AND previous.effective_until IS NOT NULL
     AND previous.version < seeded.version
   WHERE seeded.approved_at IS NOT NULL
     AND seeded.effective_until IS NULL
     AND seeded.change_reason LIKE 'Seed Console V2 live refresh defaults (migration actor: %)'
     AND seeded.value = f.cached_value
     AND NOT (previous.value ? 'live_refresh')
     AND seeded.value - 'live_refresh' = previous.value
), 'seed appends an audited version and preserves the previous policy value');

SELECT lives_ok(
  format('UPDATE public.settings_versions SET value = %L::jsonb WHERE id = %L',
         cached_value || jsonb_build_object('live_refresh', bounds.value), settings_version_id),
  'live refresh accepts ' || bounds.label
)
FROM live_refresh_policy_fixture
CROSS JOIN (VALUES
  ('the inclusive minimums', '{"poll_interval_ms":5000,"offline_after_ms":15000,"max_reconnects":1,"refetch_interval_ms":2000}'::jsonb),
  ('the inclusive maximums', '{"poll_interval_ms":300000,"offline_after_ms":600000,"max_reconnects":10,"refetch_interval_ms":60000}'::jsonb)
) AS bounds(label, value);

SELECT lives_ok(
  format('UPDATE public.settings_versions SET value = %L::jsonb WHERE id = %L',
         cached_value - 'live_refresh', settings_version_id),
  'the live refresh object remains optional'
)
FROM live_refresh_policy_fixture;

SELECT throws_ok(
  format('UPDATE public.settings_versions SET value = %L::jsonb WHERE id = %L',
         jsonb_set(cached_value, ARRAY['live_refresh', bad.key], bad.value), settings_version_id),
  '23514',
  format('ui_presentation_policy row %s: invalid live_refresh.%s', settings_version_id, bad.key),
  format('live refresh rejects %s for %s and identifies the version row', bad.value, bad.key)
)
FROM live_refresh_policy_fixture
CROSS JOIN (VALUES
  ('poll_interval_ms', '4999'::jsonb),
  ('poll_interval_ms', '300001'::jsonb),
  ('offline_after_ms', '14999'::jsonb),
  ('offline_after_ms', '600001'::jsonb),
  ('max_reconnects', '0'::jsonb),
  ('max_reconnects', '11'::jsonb),
  ('refetch_interval_ms', '1999'::jsonb),
  ('refetch_interval_ms', '60001'::jsonb),
  ('max_reconnects', '1.5'::jsonb),
  ('max_reconnects', '"3"'::jsonb)
) AS bad(key, value);

SELECT throws_ok(
  format('UPDATE public.settings_versions SET value = %L::jsonb WHERE id = %L',
         cached_value #- '{live_refresh,max_reconnects}', settings_version_id),
  '23514',
  format('ui_presentation_policy row %s: invalid live_refresh.max_reconnects', settings_version_id),
  'live refresh requires all four keys when the object is present'
)
FROM live_refresh_policy_fixture;

SELECT throws_ok(
  format('UPDATE public.settings_versions SET value = %L::jsonb WHERE id = %L',
         jsonb_set(cached_value, '{live_refresh}', 'null'::jsonb), settings_version_id),
  '23514',
  format('ui_presentation_policy row %s: live_refresh must be an object', settings_version_id),
  'live refresh rejects a non-object value and identifies the version row'
)
FROM live_refresh_policy_fixture;

SELECT throws_ok(
  format('UPDATE public.settings SET cached_value = %L::jsonb WHERE id = %L',
         jsonb_set(cached_value, '{live_refresh,max_reconnects}', '11'::jsonb), id),
  '23514',
  format('ui_presentation_policy row %s: invalid live_refresh.max_reconnects', id),
  'direct cache writes enforce the same bounds and identify the cache row'
)
FROM live_refresh_policy_fixture;

SELECT * FROM finish();

ROLLBACK;
