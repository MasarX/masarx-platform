-- Ensure Console/Fleet HOS meters can render from row-driven driver_safety_policy.
-- Earlier policy rows only carried mobile driving-mode fields; scoped overrides
-- therefore shadowed the global HOS defaults consumed by Console V2.

DO $$
BEGIN
  UPDATE public.settings_versions
     SET value = jsonb_set(
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
                 ),
         change_reason = COALESCE(change_reason, 'driver_safety_policy_hos_limits_v1'),
         updated_at = now()
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
     );

  UPDATE public.settings
     SET cached_value = jsonb_set(
                          jsonb_set(
                            jsonb_set(
                              jsonb_set(
                                jsonb_set(
                                  jsonb_set(
                                    jsonb_set(
                                      jsonb_set(
                                        COALESCE(cached_value, '{}'::jsonb),
                                        '{hos_limits}',
                                        COALESCE(cached_value->'hos_limits', '{}'::jsonb),
                                        true
                                      ),
                                      '{hos_limits,daily}',
                                      COALESCE(cached_value#>'{hos_limits,daily}', '{}'::jsonb),
                                      true
                                    ),
                                    '{hos_limits,weekly}',
                                    COALESCE(cached_value#>'{hos_limits,weekly}', '{}'::jsonb),
                                    true
                                  ),
                                  '{hos_limits,daily,driving}',
                                  COALESCE(cached_value#>'{hos_limits,daily,driving}', '660'::jsonb),
                                  true
                                ),
                                '{hos_limits,daily,on_duty}',
                                COALESCE(cached_value#>'{hos_limits,daily,on_duty}', '840'::jsonb),
                                true
                              ),
                              '{hos_limits,weekly,driving}',
                              COALESCE(cached_value#>'{hos_limits,weekly,driving}', '4200'::jsonb),
                              true
                            ),
                            '{hos_limits,weekly,on_duty}',
                            COALESCE(cached_value#>'{hos_limits,weekly,on_duty}', '4800'::jsonb),
                            true
                          ),
                          '{hos_warn_pct}',
                          COALESCE(cached_value->'hos_warn_pct', '80'::jsonb),
                          true
                        ),
         last_updated = now()
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
     );
END $$;

UPDATE public.schema_registry
   SET examples = COALESCE(examples, '[]'::jsonb)
       || jsonb_build_array(
            jsonb_build_object(
              'version', 1,
              'driving_mode',
              jsonb_build_object(
                'enabled', false,
                'lock_when_moving', true,
                'lock_threshold_kph', 8,
                'allowed_nav_keys_while_moving', jsonb_build_array('route'),
                'max_single_glance_sec', 2,
                'max_total_glance_sec', 12
              ),
              'hos_limits',
              jsonb_build_object(
                'daily',
                jsonb_build_object('driving', 660, 'on_duty', 840),
                'weekly',
                jsonb_build_object('driving', 4200, 'on_duty', 4800)
              ),
              'hos_warn_pct',
              80
            )
          )
 WHERE category = 'driver_safety_policy'
   AND version = 1
   AND NOT EXISTS (
     SELECT 1
       FROM jsonb_array_elements(COALESCE(examples, '[]'::jsonb)) AS example(value)
      WHERE example.value ? 'hos_limits'
        AND example.value ? 'hos_warn_pct'
   );
