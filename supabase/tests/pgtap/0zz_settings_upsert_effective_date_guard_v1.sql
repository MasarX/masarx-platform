BEGIN;
SELECT plan(5);

CREATE TEMP TABLE _settings_upsert_guard_org AS
WITH created_org AS (
  INSERT INTO public.organizations (name, slug, timezone, locale, billing_status, default_settings)
  VALUES (
    'Settings Upsert Guard Org',
    format('settings-upsert-guard-%s', substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
    'Asia/Riyadh',
    'en-US',
    'active',
    '{}'::jsonb
  )
  RETURNING id
)
SELECT id FROM created_org;

CREATE TEMP TABLE _settings_upsert_guard_initial AS
SELECT *
  FROM public.upsert_settings_value_v1(
    'integration_plugin_baseline_policy',
    'tenant',
    (SELECT id FROM _settings_upsert_guard_org),
    jsonb_build_object(
      'version', 1,
      'profiles', jsonb_build_object(
        'standard_operations',
        jsonb_build_object(
          'key', 'standard_operations',
          'plugins', jsonb_build_array()
        )
      )
    ),
    1,
    'pgTAP seed for future-dated open settings rows'
  );

CREATE TEMP TABLE _settings_upsert_guard_future_row AS
WITH future_row AS (
  UPDATE public.settings_versions
     SET effective_from = now() + INTERVAL '1 day'
   WHERE category = 'integration_plugin_baseline_policy'
     AND scope_type = 'tenant'
     AND scope_id = (SELECT id FROM _settings_upsert_guard_org)
     AND effective_until IS NULL
  RETURNING id, scope_id, effective_from
)
SELECT * FROM future_row;

CREATE TEMP TABLE _settings_upsert_guard_upserted AS
SELECT *
  FROM public.upsert_settings_value_v1(
    'integration_plugin_baseline_policy',
    'tenant',
    (SELECT id FROM _settings_upsert_guard_org),
    jsonb_build_object(
      'version', 1,
      'profiles', jsonb_build_object(
        'standard_operations',
        jsonb_build_object(
          'key', 'standard_operations',
          'plugins', jsonb_build_array()
        )
      )
    ),
    1,
    'pgTAP regression for future-dated open settings rows'
  );

SELECT ok(
  (SELECT count(*) = 1 FROM _settings_upsert_guard_future_row),
  'future-dated open settings row prepared for regression test'
);

SELECT ok(
  (SELECT count(*) = 1 FROM _settings_upsert_guard_upserted),
  'upsert_settings_value_v1 succeeds when current row is future-dated'
);

SELECT cmp_ok(
  (
    SELECT effective_until
      FROM public.settings_versions
     WHERE id = (SELECT id FROM _settings_upsert_guard_future_row)
  ),
  '>',
  (
    SELECT effective_from
      FROM public.settings_versions
     WHERE id = (SELECT id FROM _settings_upsert_guard_future_row)
  ),
  'closing the prior row preserves effective_until > effective_from'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_versions
     WHERE category = 'integration_plugin_baseline_policy'
       AND scope_type = 'tenant'
       AND scope_id = (SELECT id FROM _settings_upsert_guard_org)
       AND effective_until IS NULL
       AND change_reason = 'pgTAP regression for future-dated open settings rows'
  ),
  'upsert_settings_value_v1 creates the new current settings version'
);

SELECT is(
  (
    SELECT cached_value #>> '{profiles,standard_operations,key}'
      FROM public.settings
     WHERE category = 'integration_plugin_baseline_policy'
       AND scope_type = 'tenant'
       AND scope_id = (SELECT id FROM _settings_upsert_guard_org)
     LIMIT 1
  ),
  'standard_operations',
  'settings cache points at the new current settings version'
);

SELECT * FROM finish();
ROLLBACK;
