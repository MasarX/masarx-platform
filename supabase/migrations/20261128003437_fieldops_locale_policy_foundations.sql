BEGIN;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'prayer_time_policy', 'Optional display preferences for prayer windows.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'prayer_time_policy', 1, jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Prayer Time Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object(
        'type', 'boolean'
      ),
      'windows', jsonb_build_object(
        'type', 'array',
        'minItems', 1,
        'items', jsonb_build_object(
          'type', 'object',
          'properties', jsonb_build_object(
            'key', jsonb_build_object(
              'type', 'string',
              'enum', jsonb_build_array('fajr','dhuhr','asr','maghrib','isha','jumuah')
            ),
            'label_en', jsonb_build_object('type', 'string', 'minLength', 1),
            'label_ar', jsonb_build_object('type', 'string', 'minLength', 1),
            'suppress_dispatch', jsonb_build_object(
              'type', 'boolean'
            ),
            'suppression_minutes', jsonb_build_object(
              'type', 'integer',
              'minimum', 0
            ),
            'weekday_only', jsonb_build_object(
              'type', 'integer',
              'minimum', 0,
              'maximum', 6
            )
          ),
          'required', jsonb_build_array('key','label_en','label_ar','suppress_dispatch','suppression_minutes')
        )
      ),
      'pre_window_warning_minutes', jsonb_build_object(
        'type', 'integer',
        'minimum', 0
      ),
      'respect_critical_only', jsonb_build_object(
        'type', 'boolean'
      )
    ),
    'required', jsonb_build_array('version','enabled','windows','pre_window_warning_minutes','respect_critical_only')
  ),
  'Optional display preferences for prayer windows.', '[]'::jsonb, TRUE
);

WITH default_value AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', FALSE,
    'windows', jsonb_build_array(
      jsonb_build_object('key','fajr',    'label_en','Fajr',    'label_ar','الفجر',  'suppress_dispatch', TRUE, 'suppression_minutes', 30),
      jsonb_build_object('key','dhuhr',   'label_en','Dhuhr',   'label_ar','الظهر',  'suppress_dispatch', TRUE, 'suppression_minutes', 30),
      jsonb_build_object('key','asr',     'label_en','Asr',     'label_ar','العصر',  'suppress_dispatch', TRUE, 'suppression_minutes', 20),
      jsonb_build_object('key','maghrib', 'label_en','Maghrib', 'label_ar','المغرب', 'suppress_dispatch', TRUE, 'suppression_minutes', 20),
      jsonb_build_object('key','isha',    'label_en','Isha',    'label_ar','العشاء', 'suppress_dispatch', TRUE, 'suppression_minutes', 30),
      jsonb_build_object('key','jumuah',  'label_en','Jumu''ah','label_ar','الجمعة', 'suppress_dispatch', TRUE, 'suppression_minutes', 90, 'weekday_only', 5)
    ),
    'pre_window_warning_minutes', 5,
    'respect_critical_only', TRUE
  ) AS value
), inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'prayer_time_policy', 'global', NULL, 1, value, 1, clock_timestamp() FROM default_value
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'prayer_time_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_prayer_time_policy()
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'prayer_time_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_prayer_time_policy() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_prayer_time_policy() TO authenticated;

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'ramadan_mode_policy', 'Optional calendar preferences for Ramadan.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'ramadan_mode_policy', 1, jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Ramadan Mode Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object(
        'type', 'boolean'
      ),
      'active_window', jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'from_hijri_year', jsonb_build_object('type', 'integer', 'minimum', 1300),
          'to_hijri_year', jsonb_build_object('type', 'integer', 'minimum', 1300)
        ),
        'required', jsonb_build_array('from_hijri_year','to_hijri_year')
      ),
      'eta_inflation', jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'iftar_hour', jsonb_build_object(
            'type', 'object',
            'properties', jsonb_build_object(
              'start_local_offset_min_before_maghrib', jsonb_build_object('type', 'integer', 'minimum', 0),
              'end_local_offset_min_after_maghrib', jsonb_build_object('type', 'integer', 'minimum', 0),
              'multiplier_pct', jsonb_build_object('type', 'integer', 'minimum', 100, 'maximum', 300)
            ),
            'required', jsonb_build_array('start_local_offset_min_before_maghrib','end_local_offset_min_after_maghrib','multiplier_pct')
          ),
          'general', jsonb_build_object(
            'type', 'object',
            'properties', jsonb_build_object(
              'multiplier_pct', jsonb_build_object('type', 'integer', 'minimum', 100, 'maximum', 300)
            ),
            'required', jsonb_build_array('multiplier_pct')
          )
        ),
        'required', jsonb_build_array('iftar_hour','general')
      ),
      'shift_overrides', jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'iftar_break_minutes', jsonb_build_object('type', 'integer', 'minimum', 0, 'maximum', 240),
          'suhoor_shift_start_local', jsonb_build_object('type', 'string', 'pattern', '^[0-2][0-9]:[0-5][0-9]$'),
          'suhoor_shift_end_local', jsonb_build_object('type', 'string', 'pattern', '^[0-2][0-9]:[0-5][0-9]$')
        ),
        'required', jsonb_build_array('iftar_break_minutes','suhoor_shift_start_local','suhoor_shift_end_local')
      ),
      'bonuses', jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'iftar_completion_pct', jsonb_build_object('type', 'integer', 'minimum', 0, 'maximum', 100),
          'suhoor_completion_pct', jsonb_build_object('type', 'integer', 'minimum', 0, 'maximum', 100)
        ),
        'required', jsonb_build_array('iftar_completion_pct','suhoor_completion_pct')
      )
    ),
    'required', jsonb_build_array('version','enabled','active_window','eta_inflation','shift_overrides','bonuses')
  ),
  'Optional calendar preferences for Ramadan.', '[]'::jsonb, TRUE
);

WITH default_value AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', FALSE,
    'active_window', jsonb_build_object('from_hijri_year', 1447, 'to_hijri_year', 1447),
    'eta_inflation', jsonb_build_object(
      'iftar_hour', jsonb_build_object(
        'start_local_offset_min_before_maghrib', 30,
        'end_local_offset_min_after_maghrib', 30,
        'multiplier_pct', 130
      ),
      'general', jsonb_build_object('multiplier_pct', 110)
    ),
    'shift_overrides', jsonb_build_object(
      'iftar_break_minutes', 45,
      'suhoor_shift_start_local', '21:00',
      'suhoor_shift_end_local', '03:00'
    ),
    'bonuses', jsonb_build_object(
      'iftar_completion_pct', 25,
      'suhoor_completion_pct', 15
    )
  ) AS value
), inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'ramadan_mode_policy', 'global', NULL, 1, value, 1, clock_timestamp() FROM default_value
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'ramadan_mode_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_ramadan_mode_policy()
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'ramadan_mode_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_ramadan_mode_policy() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_ramadan_mode_policy() TO authenticated;

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'currency_precision_policy', 'Currency presentation preferences without changing accounting precision.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'currency_precision_policy', 1, jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Currency Precision Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'currencies', jsonb_build_object(
        'type', 'object',
        'additionalProperties', jsonb_build_object(
          'type', 'object',
          'properties', jsonb_build_object(
            'decimals', jsonb_build_object(
              'type', 'integer',
              'minimum', 0,
              'maximum', 4
            ),
            'symbol', jsonb_build_object('type', 'string', 'minLength', 1),
            'code', jsonb_build_object('type', 'string', 'minLength', 3, 'maxLength', 3),
            'symbol_position', jsonb_build_object(
              'type', 'string',
              'enum', jsonb_build_array('before', 'after')
            )
          ),
          'required', jsonb_build_array('decimals','symbol','code','symbol_position')
        )
      ),
      'default_currency', jsonb_build_object(
        'type', 'string',
        'minLength', 3,
        'maxLength', 3
      )
    ),
    'required', jsonb_build_array('version','currencies','default_currency')
  ),
  'Currency presentation preferences without changing accounting precision.', '[]'::jsonb, TRUE
);

WITH default_value AS (
  SELECT jsonb_build_object(
    'version', 1,
    'currencies', jsonb_build_object(
      'SAR', jsonb_build_object('decimals', 2, 'symbol', '﷼',   'code', 'SAR', 'symbol_position', 'after'),
      'AED', jsonb_build_object('decimals', 2, 'symbol', 'د.إ',  'code', 'AED', 'symbol_position', 'after'),
      'KWD', jsonb_build_object('decimals', 3, 'symbol', 'د.ك',  'code', 'KWD', 'symbol_position', 'after'),
      'BHD', jsonb_build_object('decimals', 3, 'symbol', 'د.ب',  'code', 'BHD', 'symbol_position', 'after'),
      'OMR', jsonb_build_object('decimals', 3, 'symbol', 'ر.ع',  'code', 'OMR', 'symbol_position', 'after'),
      'QAR', jsonb_build_object('decimals', 2, 'symbol', 'ر.ق',  'code', 'QAR', 'symbol_position', 'after'),
      'JOD', jsonb_build_object('decimals', 3, 'symbol', 'د.أ',  'code', 'JOD', 'symbol_position', 'after'),
      'EGP', jsonb_build_object('decimals', 2, 'symbol', 'ج.م',  'code', 'EGP', 'symbol_position', 'after'),
      'USD', jsonb_build_object('decimals', 2, 'symbol', '$',    'code', 'USD', 'symbol_position', 'before'),
      'EUR', jsonb_build_object('decimals', 2, 'symbol', '€',    'code', 'EUR', 'symbol_position', 'before'),
      'GBP', jsonb_build_object('decimals', 2, 'symbol', '£',    'code', 'GBP', 'symbol_position', 'before'),
      'JPY', jsonb_build_object('decimals', 0, 'symbol', '¥',    'code', 'JPY', 'symbol_position', 'before')
    ),
    'default_currency', 'SAR'
  ) AS value
), inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'currency_precision_policy', 'global', NULL, 1, value, 1, clock_timestamp() FROM default_value
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'currency_precision_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_currency_precision_policy()
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'currency_precision_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_currency_precision_policy() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_currency_precision_policy() TO authenticated;

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'hijri_calendar_policy', 'Optional Hijri dates in FieldOps.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'hijri_calendar_policy', 1, jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Hijri Calendar Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object(
        'type', 'boolean'
      ),
      'display_mode', jsonb_build_object(
        'type', 'string',
        'enum', jsonb_build_array('dual','hijri_only','gregorian_only')
      ),
      'calendar_system', jsonb_build_object(
        'type', 'string',
        'enum', jsonb_build_array('umm_al_qura','islamic','islamic_civil','islamic_tbla')
      ),
      'show_in_route_headers', jsonb_build_object(
        'type', 'boolean'
      ),
      'show_in_settlement_dates', jsonb_build_object(
        'type', 'boolean'
      )
    ),
    'required', jsonb_build_array('version','enabled','display_mode','calendar_system','show_in_route_headers','show_in_settlement_dates')
  ),
  'Optional Hijri dates in FieldOps.', '[]'::jsonb, TRUE
);

WITH default_value AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', false,
    'display_mode', 'dual',
    'calendar_system', 'umm_al_qura',
    'show_in_route_headers', true,
    'show_in_settlement_dates', true
  ) AS value
), inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'hijri_calendar_policy', 'global', NULL, 1, value, 1, clock_timestamp() FROM default_value
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'hijri_calendar_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_hijri_calendar_policy()
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'hijri_calendar_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_hijri_calendar_policy() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_hijri_calendar_policy() TO authenticated;

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'weekend_calendar_policy', 'Local weekend calendars for FieldOps display.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'weekend_calendar_policy', 1, jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Weekend Calendar Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'weekend_days', jsonb_build_object(
        'type', 'array',
        'minItems', 0,
        'maxItems', 7,
        'items', jsonb_build_object('type', 'integer', 'minimum', 0, 'maximum', 6),
        'uniqueItems', TRUE
      ),
      'calendar_overrides', jsonb_build_object(
        'type', 'object',
        'additionalProperties', jsonb_build_object(
          'type', 'array',
          'minItems', 0,
          'maxItems', 7,
          'items', jsonb_build_object('type', 'integer', 'minimum', 0, 'maximum', 6),
          'uniqueItems', TRUE
        )
      )
    ),
    'required', jsonb_build_array('version','weekend_days','calendar_overrides')
  ),
  'Local weekend calendars for FieldOps display.', '[]'::jsonb, TRUE
);

WITH default_value AS (
  SELECT jsonb_build_object(
    'version', 1,
    'weekend_days', jsonb_build_array(5, 6),
    'calendar_overrides', jsonb_build_object(
      'SA', jsonb_build_array(5, 6),
      'AE', jsonb_build_array(6, 0),
      'KW', jsonb_build_array(5, 6),
      'BH', jsonb_build_array(5, 6),
      'QA', jsonb_build_array(5, 6),
      'OM', jsonb_build_array(5, 6),
      'JO', jsonb_build_array(5, 6),
      'EG', jsonb_build_array(5, 6),
      'US', jsonb_build_array(6, 0),
      'GB', jsonb_build_array(6, 0)
    )
  ) AS value
), inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'weekend_calendar_policy', 'global', NULL, 1, value, 1, clock_timestamp() FROM default_value
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'weekend_calendar_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_weekend_calendar_policy()
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'weekend_calendar_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_weekend_calendar_policy() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_weekend_calendar_policy() TO authenticated;

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'address_landmark_policy', 'Optional FieldOps address landmark metadata.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'address_landmark_policy', 1, jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Address Landmark + SPL Validation Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'spl_validation', jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'enabled', jsonb_build_object('type', 'boolean'),
          'required_for_market', jsonb_build_object(
            'type', 'array',
            'items', jsonb_build_object('type', 'string', 'pattern', '^[A-Z]{2}$')
          ),
          'format_regex', jsonb_build_object('type', 'string'),
          'weak_validation_only', jsonb_build_object('type', 'boolean')
        ),
        'required', jsonb_build_array('enabled','required_for_market','format_regex','weak_validation_only')
      ),
      'landmark_capture', jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'enabled', jsonb_build_object('type', 'boolean'),
          'fields', jsonb_build_object(
            'type', 'array',
            'items', jsonb_build_object(
              'type', 'object',
              'properties', jsonb_build_object(
                'key',        jsonb_build_object('type', 'string', 'pattern', '^[a-z][a-z0-9_]{0,63}$'),
                'label_en',   jsonb_build_object('type', 'string', 'minLength', 1, 'maxLength', 80),
                'label_ar',   jsonb_build_object('type', 'string', 'minLength', 1, 'maxLength', 80),
                'max_length', jsonb_build_object('type', 'integer', 'minimum', 1, 'maximum', 1000),
                'required',   jsonb_build_object('type', 'boolean')
              ),
              'required', jsonb_build_array('key','label_en','label_ar','max_length','required')
            )
          )
        ),
        'required', jsonb_build_array('enabled','fields')
      )
    ),
    'required', jsonb_build_array('version','spl_validation','landmark_capture')
  ),
  'Optional FieldOps address landmark metadata.', '[]'::jsonb, TRUE
);

WITH default_value AS (
  SELECT jsonb_build_object(
    'version', 1,
    'spl_validation', jsonb_build_object(
      'enabled', TRUE,
      'required_for_market', jsonb_build_array('SA'),
      'format_regex', '^[A-Z0-9]{8}$',
      'weak_validation_only', FALSE
    ),
    'landmark_capture', jsonb_build_object(
      'enabled', TRUE,
      'fields', jsonb_build_array(
        jsonb_build_object(
          'key', 'primary_landmark',
          'label_en', 'Primary landmark',
          'label_ar', 'المعلم الأساسي',
          'max_length', 80,
          'required', FALSE
        ),
        jsonb_build_object(
          'key', 'secondary_landmark',
          'label_en', 'Secondary landmark',
          'label_ar', 'المعلم الثانوي',
          'max_length', 80,
          'required', FALSE
        ),
        jsonb_build_object(
          'key', 'delivery_notes',
          'label_en', 'Delivery notes',
          'label_ar', 'ملاحظات التسليم',
          'max_length', 240,
          'required', FALSE
        )
      )
    )
  ) AS value
), inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'address_landmark_policy', 'global', NULL, 1, value, 1, clock_timestamp() FROM default_value
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'address_landmark_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_address_landmark_policy()
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'address_landmark_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_address_landmark_policy() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_address_landmark_policy() TO authenticated;

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'numeral_system_policy', 'Optional FieldOps numeral presentation preferences.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'numeral_system_policy', 1, jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Numeral System Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'default_numbering_system', jsonb_build_object(
        'type', 'string',
        'enum', jsonb_build_array('latn', 'arab', 'arabext')
      ),
      'locale_overrides', jsonb_build_object(
        'type', 'object',
        'additionalProperties', jsonb_build_object(
          'type', 'object',
          'properties', jsonb_build_object(
            'numbering_system', jsonb_build_object(
              'type', 'string',
              'enum', jsonb_build_array('latn', 'arab', 'arabext')
            ),
            'allow_user_toggle', jsonb_build_object('type', 'boolean')
          ),
          'required', jsonb_build_array('numbering_system','allow_user_toggle')
        )
      )
    ),
    'required', jsonb_build_array('version','default_numbering_system','locale_overrides')
  ),
  'Optional FieldOps numeral presentation preferences.', '[]'::jsonb, TRUE
);

WITH default_value AS (
  SELECT jsonb_build_object(
    'version', 1,
    'default_numbering_system', 'latn',
    'locale_overrides', jsonb_build_object(
      'ar',    jsonb_build_object('numbering_system', 'latn',    'allow_user_toggle', TRUE),
      'ar_SA', jsonb_build_object('numbering_system', 'arab',    'allow_user_toggle', TRUE),
      'ar_AE', jsonb_build_object('numbering_system', 'latn',    'allow_user_toggle', TRUE),
      'ar_EG', jsonb_build_object('numbering_system', 'arab',    'allow_user_toggle', TRUE),
      'fa',    jsonb_build_object('numbering_system', 'arabext', 'allow_user_toggle', TRUE)
    )
  ) AS value
), inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'numeral_system_policy', 'global', NULL, 1, value, 1, clock_timestamp() FROM default_value
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'numeral_system_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_numeral_system_policy()
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'numeral_system_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_numeral_system_policy() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_numeral_system_policy() TO authenticated;

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'sunlight_mode_policy', 'Optional FieldOps sunlight display mode.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'sunlight_mode_policy', 1, jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Sunlight Mode Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object(
        'type', 'boolean'
      ),
      'auto_switch', jsonb_build_object(
        'type', 'object',
        'additionalProperties', FALSE,
        'properties', jsonb_build_object(
          'enabled', jsonb_build_object(
            'type', 'boolean'
          ),
          'ambient_lux_threshold', jsonb_build_object(
            'type', 'integer',
            'minimum', 0
          ),
          'user_override_persists_minutes', jsonb_build_object(
            'type', 'integer',
            'minimum', 0
          )
        ),
        'required', jsonb_build_array('enabled','ambient_lux_threshold','user_override_persists_minutes')
      ),
      'user_toggle_visible', jsonb_build_object(
        'type', 'boolean'
      )
    ),
    'required', jsonb_build_array('version','enabled','auto_switch','user_toggle_visible')
  ),
  'Optional FieldOps sunlight display mode.', '[]'::jsonb, TRUE
);

WITH default_value AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', FALSE,
    'auto_switch', jsonb_build_object(
      'enabled', FALSE,
      'ambient_lux_threshold', 50000,
      'user_override_persists_minutes', 30
    ),
    'user_toggle_visible', TRUE
  ) AS value
), inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'sunlight_mode_policy', 'global', NULL, 1, value, 1, clock_timestamp() FROM default_value
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'sunlight_mode_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_sunlight_mode_policy()
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'sunlight_mode_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_sunlight_mode_policy() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_sunlight_mode_policy() TO authenticated;

COMMIT;
