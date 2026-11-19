BEGIN;

SELECT plan(8);

SELECT isnt_empty(
  $$
    SELECT 1
      FROM public.settings_versions
     WHERE category = 'driver_safety_policy'
       AND value->'hos_limits'->'daily'->>'driving' = '660'
       AND value->'hos_limits'->'daily'->>'on_duty' = '840'
       AND value->'hos_limits'->'weekly'->>'driving' = '4200'
       AND value->'hos_limits'->'weekly'->>'on_duty' = '4800'
       AND value->>'hos_warn_pct' = '80'
  $$,
  'driver_safety_policy settings_versions include HOS limits and warning threshold'
);

SELECT is_empty(
  $$
    SELECT 1
      FROM public.settings_versions
     WHERE category = 'driver_safety_policy'
       AND (
         value->'hos_limits' IS NULL
         OR value->'hos_limits'->'daily' IS NULL
         OR value->'hos_limits'->'weekly' IS NULL
         OR value->'hos_limits'->'daily'->>'driving' IS NULL
         OR value->'hos_limits'->'daily'->>'on_duty' IS NULL
         OR value->'hos_limits'->'weekly'->>'driving' IS NULL
         OR value->'hos_limits'->'weekly'->>'on_duty' IS NULL
         OR value->'hos_warn_pct' IS NULL
       )
  $$,
  'no driver_safety_policy settings_versions row shadows HOS limits'
);

SELECT is_empty(
  $$
    SELECT 1
      FROM public.settings
     WHERE category = 'driver_safety_policy'
       AND (
         cached_value->'hos_limits' IS NULL
         OR cached_value->'hos_limits'->'daily' IS NULL
         OR cached_value->'hos_limits'->'weekly' IS NULL
         OR cached_value->'hos_limits'->'daily'->>'driving' IS NULL
         OR cached_value->'hos_limits'->'daily'->>'on_duty' IS NULL
         OR cached_value->'hos_limits'->'weekly'->>'driving' IS NULL
         OR cached_value->'hos_limits'->'weekly'->>'on_duty' IS NULL
         OR cached_value->'hos_warn_pct' IS NULL
       )
  $$,
  'no driver_safety_policy settings cache row shadows HOS limits'
);

SELECT isnt_empty(
  $$
    SELECT 1
      FROM public.resolve_settings_row_from_policy_context_v1(
        'driver_safety_policy',
        jsonb_build_object('organization_id', '08d59e17-82ae-47c4-b54a-4a6b86213dc4')
      ) resolved
     WHERE resolved.value->'hos_limits'->'daily'->>'driving' = '660'
       AND resolved.value->'hos_limits'->'daily'->>'on_duty' = '840'
       AND resolved.value->'hos_limits'->'weekly'->>'driving' = '4200'
       AND resolved.value->'hos_limits'->'weekly'->>'on_duty' = '4800'
       AND resolved.value->>'hos_warn_pct' = '80'
  $$,
  'first tenant resolves driver_safety_policy with Console HOS limits'
);

SELECT isnt_empty(
  $$
    SELECT 1
      FROM public.schema_registry
     WHERE category = 'driver_safety_policy'
       AND version = 1
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(examples, '[]'::jsonb)) AS example(value)
          WHERE example.value ? 'hos_limits'
            AND example.value ? 'hos_warn_pct'
       )
  $$,
  'driver_safety_policy schema examples include HOS fields'
);

SELECT isnt_empty(
  $$
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'hours_of_service_duty_status'
       AND lv.value IN ('off_duty', 'on_duty', 'driving', 'sleeper')
     GROUP BY ld.category
    HAVING COUNT(DISTINCT lv.value) = 4
  $$,
  'HOS duty status lookup retains all canonical statuses'
);

SELECT has_function(
  'public',
  'record_hours_of_service_segment_v1',
  ARRAY['jsonb'],
  'record_hours_of_service_segment_v1 remains available for Console HOS logging'
);

SELECT is(
  (
    WITH original AS (
      SELECT jsonb_build_object(
        'hos_limits',
        jsonb_build_object(
          'daily',
          jsonb_build_object('driving', 700),
          'weekly',
          jsonb_build_object('driving', 4300)
        ),
        'hos_warn_pct',
        85
      ) AS value
    ),
    patched AS (
      SELECT jsonb_set(
               jsonb_set(
                 jsonb_set(
                   jsonb_set(
                     jsonb_set(
                       jsonb_set(
                         jsonb_set(
                           jsonb_set(
                             COALESCE(value, '{}'::jsonb),
                             '{hos_limits}',
                             COALESCE(value->'hos_limits', '{}'::jsonb),
                             true
                           ),
                           '{hos_limits,daily}',
                           COALESCE(value#>'{hos_limits,daily}', '{}'::jsonb),
                           true
                         ),
                         '{hos_limits,weekly}',
                         COALESCE(value#>'{hos_limits,weekly}', '{}'::jsonb),
                         true
                       ),
                       '{hos_limits,daily,driving}',
                       COALESCE(value#>'{hos_limits,daily,driving}', '660'::jsonb),
                       true
                     ),
                     '{hos_limits,daily,on_duty}',
                     COALESCE(value#>'{hos_limits,daily,on_duty}', '840'::jsonb),
                     true
                   ),
                   '{hos_limits,weekly,driving}',
                   COALESCE(value#>'{hos_limits,weekly,driving}', '4200'::jsonb),
                   true
                 ),
                 '{hos_limits,weekly,on_duty}',
                 COALESCE(value#>'{hos_limits,weekly,on_duty}', '4800'::jsonb),
                 true
               ),
               '{hos_warn_pct}',
               COALESCE(value->'hos_warn_pct', '80'::jsonb),
               true
             ) AS value
        FROM original
    )
    SELECT concat_ws(
      '|',
      value#>>'{hos_limits,daily,driving}',
      value#>>'{hos_limits,daily,on_duty}',
      value#>>'{hos_limits,weekly,driving}',
      value#>>'{hos_limits,weekly,on_duty}',
      value->>'hos_warn_pct'
    )
      FROM patched
  ),
  '700|840|4300|4800|85',
  'HOS policy deep-fill preserves existing custom nested values while adding missing defaults'
);

SELECT * FROM finish();

ROLLBACK;
