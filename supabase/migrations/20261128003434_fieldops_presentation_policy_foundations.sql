BEGIN;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'priority_display_policy', 'Presentation bands for FieldOps task priorities.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'priority_display_policy', 1, jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Priority Display Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'buckets', jsonb_build_object(
        'type', 'array',
        'minItems', 1,
        'items', jsonb_build_object(
          'type', 'object',
          'properties', jsonb_build_object(
            'min_inclusive', jsonb_build_object('type', 'integer', 'minimum', 0, 'maximum', 100),
            'label_en', jsonb_build_object('type', 'string', 'minLength', 1),
            'label_ar', jsonb_build_object('type', 'string', 'minLength', 1),
            'tone', jsonb_build_object(
              'type', 'string',
              'enum', jsonb_build_array('info','success','warning','danger','neutral')
            )
          ),
          'required', jsonb_build_array('min_inclusive','label_en','label_ar','tone')
        )
      )
    ),
    'required', jsonb_build_array('version','buckets')
  ),
  'Presentation bands for FieldOps task priorities.', '[]'::jsonb, TRUE
);

WITH default_value AS (
  SELECT jsonb_build_object(
    'version', 1,
    'buckets', jsonb_build_array(
      jsonb_build_object('min_inclusive', 80, 'label_en', 'Urgent', 'label_ar', 'عاجل',   'tone', 'danger'),
      jsonb_build_object('min_inclusive', 60, 'label_en', 'High',   'label_ar', 'مرتفع',  'tone', 'warning'),
      jsonb_build_object('min_inclusive', 40, 'label_en', 'Normal', 'label_ar', 'عادي',   'tone', 'info'),
      jsonb_build_object('min_inclusive', 0,  'label_en', 'Low',    'label_ar', 'منخفض', 'tone', 'neutral')
    )
  ) AS value
), inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'priority_display_policy', 'global', NULL, 1, value, 1, clock_timestamp() FROM default_value
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'priority_display_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_priority_display_policy()
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'priority_display_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_priority_display_policy() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_priority_display_policy() TO authenticated;

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'list_filter_policy', 'Filter choices for FieldOps task lists.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'list_filter_policy', 1, jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'List Filter Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'filters', jsonb_build_object(
        'type', 'array',
        'minItems', 1,
        'items', jsonb_build_object(
          'type', 'object',
          'properties', jsonb_build_object(
            'key', jsonb_build_object('type', 'string', 'minLength', 1),
            'label_en', jsonb_build_object('type', 'string', 'minLength', 1),
            'label_ar', jsonb_build_object('type', 'string', 'minLength', 1),
            'default', jsonb_build_object('type', 'boolean'),
            'predicate', jsonb_build_object(
              'type', 'object',
              'additionalProperties', TRUE,
              'properties', jsonb_build_object(
                'status_in', jsonb_build_object(
                  'type', 'array',
                  'items', jsonb_build_object('type', 'string')
                )
              )
            )
          ),
          'required', jsonb_build_array('key','label_en','label_ar')
        )
      )
    ),
    'required', jsonb_build_array('version','filters')
  ),
  'Filter choices for FieldOps task lists.', '[]'::jsonb, TRUE
);

WITH default_value AS (
  SELECT jsonb_build_object(
    'version', 1,
    'filters', jsonb_build_array(
      jsonb_build_object(
        'key', 'all',
        'label_en', 'All',
        'label_ar', 'الكل',
        'default', TRUE
      ),
      jsonb_build_object(
        'key', 'open',
        'label_en', 'Open',
        'label_ar', 'مفتوحة',
        'predicate', jsonb_build_object('status_in', jsonb_build_array('open','assigned','queued'))
      ),
      jsonb_build_object(
        'key', 'in_progress',
        'label_en', 'In progress',
        'label_ar', 'جاري',
        'predicate', jsonb_build_object('status_in', jsonb_build_array('in_progress','en_route','arrived'))
      ),
      jsonb_build_object(
        'key', 'done',
        'label_en', 'Done',
        'label_ar', 'تم',
        'predicate', jsonb_build_object('status_in', jsonb_build_array('completed','done','closed'))
      ),
      jsonb_build_object(
        'key', 'failed',
        'label_en', 'Failed',
        'label_ar', 'فشل',
        'predicate', jsonb_build_object('status_in', jsonb_build_array('failed','exception','rejected'))
      )
    )
  ) AS value
), inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'list_filter_policy', 'global', NULL, 1, value, 1, clock_timestamp() FROM default_value
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'list_filter_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_list_filter_policy()
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'list_filter_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_list_filter_policy() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_list_filter_policy() TO authenticated;

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'list_sort_policy', 'Sort choices for FieldOps task lists.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'list_sort_policy', 1, jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'List Sort Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'default_sort_key', jsonb_build_object(
        'type', 'string'
      ),
      'sorts', jsonb_build_object(
        'type', 'array',
        'minItems', 1,
        'items', jsonb_build_object(
          'type', 'object',
          'properties', jsonb_build_object(
            'key', jsonb_build_object('type', 'string', 'minLength', 1),
            'label_en', jsonb_build_object('type', 'string', 'minLength', 1),
            'label_ar', jsonb_build_object('type', 'string', 'minLength', 1),
            'field', jsonb_build_object('type', 'string', 'minLength', 1),
            'direction', jsonb_build_object(
              'type', 'string',
              'enum', jsonb_build_array('asc','desc')
            )
          ),
          'required', jsonb_build_array('key','label_en','label_ar','field','direction')
        )
      )
    ),
    'required', jsonb_build_array('version','default_sort_key','sorts')
  ),
  'Sort choices for FieldOps task lists.', '[]'::jsonb, TRUE
);

WITH default_value AS (
  SELECT jsonb_build_object(
    'version', 1,
    'default_sort_key', 'due_asc',
    'sorts', jsonb_build_array(
      jsonb_build_object('key','due_asc',       'label_en','Due ↑',      'label_ar','الاستحقاق ↑', 'field','due_at',     'direction','asc'),
      jsonb_build_object('key','due_desc',      'label_en','Due ↓',      'label_ar','الاستحقاق ↓', 'field','due_at',     'direction','desc'),
      jsonb_build_object('key','priority_desc', 'label_en','Priority ↓', 'label_ar','الأولوية ↓',  'field','priority',   'direction','desc'),
      jsonb_build_object('key','distance_asc',  'label_en','Distance ↑', 'label_ar','المسافة ↑',   'field','distance_m', 'direction','asc')
    )
  ) AS value
), inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'list_sort_policy', 'global', NULL, 1, value, 1, clock_timestamp() FROM default_value
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'list_sort_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_list_sort_policy()
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'list_sort_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_list_sort_policy() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_list_sort_policy() TO authenticated;

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'motion_token_policy', 'Animation timing and reduced-motion preferences.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'motion_token_policy', 1, jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Motion Token Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'duration', jsonb_build_object(
        'type', 'object',
        'additionalProperties', jsonb_build_object('type', 'integer', 'minimum', 0),
        'properties', jsonb_build_object(
          'instant', jsonb_build_object('type', 'integer', 'minimum', 0),
          'micro',   jsonb_build_object('type', 'integer', 'minimum', 0),
          'short',   jsonb_build_object('type', 'integer', 'minimum', 0),
          'medium',  jsonb_build_object('type', 'integer', 'minimum', 0),
          'long',    jsonb_build_object('type', 'integer', 'minimum', 0),
          'hero',    jsonb_build_object('type', 'integer', 'minimum', 0)
        ),
        'required', jsonb_build_array('instant','micro','short','medium','long','hero')
      ),
      'easing', jsonb_build_object(
        'type', 'object',
        'additionalProperties', jsonb_build_object('type', 'string', 'minLength', 1),
        'properties', jsonb_build_object(
          'linear',     jsonb_build_object('type', 'string', 'minLength', 1),
          'standard',   jsonb_build_object('type', 'string', 'minLength', 1),
          'decelerate', jsonb_build_object('type', 'string', 'minLength', 1),
          'accelerate', jsonb_build_object('type', 'string', 'minLength', 1),
          'emphasis',   jsonb_build_object('type', 'string', 'minLength', 1),
          'expressive', jsonb_build_object('type', 'string', 'minLength', 1)
        ),
        'required', jsonb_build_array('linear','standard','decelerate','accelerate','emphasis','expressive')
      ),
      'reduce_motion_strategy', jsonb_build_object(
        'type', 'string',
        'enum', jsonb_build_array('disable_loops','respect','ignore')
      )
    ),
    'required', jsonb_build_array('version','duration','easing','reduce_motion_strategy')
  ),
  'Animation timing and reduced-motion preferences.', '[]'::jsonb, TRUE
);

WITH default_value AS (
  SELECT jsonb_build_object(
    'version', 1,
    'duration', jsonb_build_object(
      'instant', 0,
      'micro',   120,
      'short',   200,
      'medium',  320,
      'long',    480,
      'hero',    640
    ),
    'easing', jsonb_build_object(
      'linear',     'linear',
      'standard',   'cubic-bezier(0.2,0,0,1)',
      'decelerate', 'cubic-bezier(0,0,0,1)',
      'accelerate', 'cubic-bezier(0.3,0,1,1)',
      'emphasis',   'cubic-bezier(0.2,0,0,1)',
      'expressive', 'cubic-bezier(0.34,1.56,0.64,1)'
    ),
    'reduce_motion_strategy', 'disable_loops'
  ) AS value
), inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'motion_token_policy', 'global', NULL, 1, value, 1, clock_timestamp() FROM default_value
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'motion_token_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_motion_token_policy()
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'motion_token_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_motion_token_policy() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_motion_token_policy() TO authenticated;

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'haptic_event_policy', 'Haptic preferences for FieldOps events.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'haptic_event_policy', 1, jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Haptic Event Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'events', jsonb_build_object(
        'type', 'object',
        'additionalProperties', jsonb_build_object(
          'type', 'object',
          'properties', jsonb_build_object(
            'pattern', jsonb_build_object(
              'type', 'string',
              'enum', jsonb_build_array('light','medium','heavy','success','warning','error','selection','off')
            ),
            'audio', jsonb_build_object(
              'type', 'string'
            ),
            'respect_driving_lock', jsonb_build_object(
              'type', 'boolean'
            )
          ),
          'required', jsonb_build_array('pattern','respect_driving_lock')
        )
      )
    ),
    'required', jsonb_build_array('version','events')
  ),
  'Haptic preferences for FieldOps events.', '[]'::jsonb, TRUE
);

WITH default_value AS (
  SELECT jsonb_build_object(
    'version', 1,
    'events', jsonb_build_object(
      'scan.success',         jsonb_build_object('pattern','light',     'respect_driving_lock', TRUE),
      'scan.failure',         jsonb_build_object('pattern','warning',   'respect_driving_lock', TRUE),
      'pod.completed',        jsonb_build_object('pattern','medium',    'audio','chime',   'respect_driving_lock', TRUE),
      'outbox.synced',        jsonb_build_object('pattern','success',   'respect_driving_lock', TRUE),
      'driving_lock.engaged', jsonb_build_object('pattern','heavy',     'audio','warning', 'respect_driving_lock', FALSE),
      'geofence.arrival',     jsonb_build_object('pattern','medium',    'respect_driving_lock', TRUE),
      'swipe.threshold',      jsonb_build_object('pattern','light',     'respect_driving_lock', TRUE),
      'swipe.commit',         jsonb_build_object('pattern','medium',    'respect_driving_lock', TRUE),
      'selection',            jsonb_build_object('pattern','selection', 'respect_driving_lock', TRUE),
      'error',                jsonb_build_object('pattern','error',     'respect_driving_lock', FALSE)
    )
  ) AS value
), inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'haptic_event_policy', 'global', NULL, 1, value, 1, clock_timestamp() FROM default_value
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'haptic_event_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_haptic_event_policy()
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'haptic_event_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_haptic_event_policy() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_haptic_event_policy() TO authenticated;

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'audio_cue_policy', 'Audio preferences for FieldOps events.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'audio_cue_policy', 1, jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Audio Cue Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'cues', jsonb_build_object(
        'type', 'object',
        'additionalProperties', jsonb_build_object(
          'type', 'object',
          'properties', jsonb_build_object(
            'asset', jsonb_build_object('type', 'string', 'minLength', 1),
            'critical', jsonb_build_object('type', 'boolean'),
            'locale_aware', jsonb_build_object('type', 'boolean'),
            'respect_adhan_window', jsonb_build_object(
              'type', 'boolean'
            )
          ),
          'required', jsonb_build_array('asset')
        )
      ),
      'adhan_window_suppression', jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'enabled', jsonb_build_object('type', 'boolean'),
          'non_critical_only', jsonb_build_object('type', 'boolean')
        ),
        'required', jsonb_build_array('enabled')
      )
    ),
    'required', jsonb_build_array('version','cues','adhan_window_suppression')
  ),
  'Audio preferences for FieldOps events.', '[]'::jsonb, TRUE
);

WITH default_value AS (
  SELECT jsonb_build_object(
    'version', 1,
    'cues', jsonb_build_object(
      'pod.completed',         jsonb_build_object('asset', 'chime',        'critical', FALSE, 'locale_aware', TRUE),
      'scan.success',          jsonb_build_object('asset', 'tick',         'critical', FALSE),
      'scan.failure',          jsonb_build_object('asset', 'buzz',         'critical', FALSE),
      'outbox.synced',         jsonb_build_object('asset', 'soft_chime',   'critical', FALSE),
      'driving_lock.engaged',  jsonb_build_object('asset', 'warning',      'critical', TRUE,  'respect_adhan_window', FALSE),
      'geofence.arrival',      jsonb_build_object('asset', 'ping',         'critical', FALSE),
      'shift.start',           jsonb_build_object('asset', 'shift_start',  'critical', FALSE)
    ),
    'adhan_window_suppression', jsonb_build_object(
      'enabled', TRUE,
      'non_critical_only', TRUE
    )
  ) AS value
), inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'audio_cue_policy', 'global', NULL, 1, value, 1, clock_timestamp() FROM default_value
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'audio_cue_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_audio_cue_policy()
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'audio_cue_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_audio_cue_policy() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_audio_cue_policy() TO authenticated;

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'primary_module_order_policy', 'Ordering preferences for available FieldOps modules.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'primary_module_order_policy', 1, jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Primary Module Order Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'order', jsonb_build_object(
        'type', 'array',
        'minItems', 1,
        'items', jsonb_build_object('type', 'string', 'minLength', 1),
        'uniqueItems', TRUE
      ),
      'order_with_settlements', jsonb_build_object(
        'type', 'array',
        'minItems', 1,
        'items', jsonb_build_object('type', 'string', 'minLength', 1),
        'uniqueItems', TRUE
      )
    ),
    'required', jsonb_build_array('version','order','order_with_settlements')
  ),
  'Ordering preferences for available FieldOps modules.', '[]'::jsonb, TRUE
);

WITH default_value AS (
  SELECT jsonb_build_object(
    'version', 1,
    'order', jsonb_build_array('home','tasks','route','scan','location','outbox','more'),
    'order_with_settlements', jsonb_build_array('home','tasks','route','scan','location','outbox','settlements','more')
  ) AS value
), inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'primary_module_order_policy', 'global', NULL, 1, value, 1, clock_timestamp() FROM default_value
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'primary_module_order_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_primary_module_order_policy()
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'primary_module_order_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_primary_module_order_policy() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_primary_module_order_policy() TO authenticated;

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'brand_hero_policy', 'Optional appearance preferences for FieldOps milestones.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'brand_hero_policy', 1, jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Brand Hero Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'moments', jsonb_build_object(
        'type', 'object',
        'additionalProperties', FALSE,
        'properties', jsonb_build_object(
          'sign_in', jsonb_build_object(
            'type', 'object',
            'additionalProperties', TRUE,
            'properties', jsonb_build_object(
              'enabled', jsonb_build_object('type', 'boolean'),
              'variant', jsonb_build_object('type', 'string', 'minLength', 1),
              'show_biometric_pill', jsonb_build_object('type', 'boolean'),
              'background_animation', jsonb_build_object('type', 'string', 'minLength', 1)
            ),
            'required', jsonb_build_array('enabled','variant','show_biometric_pill','background_animation')
          ),
          'shift_start', jsonb_build_object(
            'type', 'object',
            'additionalProperties', TRUE,
            'properties', jsonb_build_object(
              'enabled', jsonb_build_object('type', 'boolean'),
              'variant', jsonb_build_object('type', 'string', 'minLength', 1),
              'show_earnings_preview', jsonb_build_object('type', 'boolean'),
              'haptic_pattern', jsonb_build_object('type', 'string', 'minLength', 1),
              'duration_ms', jsonb_build_object('type', 'integer', 'minimum', 0, 'maximum', 30000)
            ),
            'required', jsonb_build_array('enabled','variant','show_earnings_preview','haptic_pattern','duration_ms')
          ),
          'shift_end', jsonb_build_object(
            'type', 'object',
            'additionalProperties', TRUE,
            'properties', jsonb_build_object(
              'enabled', jsonb_build_object('type', 'boolean'),
              'variant', jsonb_build_object('type', 'string', 'minLength', 1),
              'show_sparkline', jsonb_build_object('type', 'boolean'),
              'show_thank_you', jsonb_build_object('type', 'boolean'),
              'show_share_export', jsonb_build_object('type', 'boolean')
            ),
            'required', jsonb_build_array('enabled','variant','show_sparkline','show_thank_you','show_share_export')
          ),
          'error_recovery', jsonb_build_object(
            'type', 'object',
            'additionalProperties', TRUE,
            'properties', jsonb_build_object(
              'enabled', jsonb_build_object('type', 'boolean'),
              'variant', jsonb_build_object('type', 'string', 'minLength', 1),
              'show_offline_radar', jsonb_build_object('type', 'boolean'),
              'preserve_last_state', jsonb_build_object('type', 'boolean'),
              'show_retry_cta', jsonb_build_object('type', 'boolean')
            ),
            'required', jsonb_build_array('enabled','variant','show_offline_radar','preserve_last_state','show_retry_cta')
          )
        ),
        'required', jsonb_build_array('sign_in','shift_start','shift_end','error_recovery')
      ),
      'respect_reduce_motion', jsonb_build_object(
        'type', 'boolean'
      ),
      'respect_driving_lock', jsonb_build_object(
        'type', 'boolean'
      )
    ),
    'required', jsonb_build_array('version','moments','respect_reduce_motion','respect_driving_lock')
  ),
  'Optional appearance preferences for FieldOps milestones.', '[]'::jsonb, TRUE
);

WITH default_value AS (
  SELECT jsonb_build_object(
    'version', 1,
    'moments', jsonb_build_object(
      'sign_in', jsonb_build_object(
        'enabled', TRUE,
        'variant', 'tinted_glass',
        'show_biometric_pill', TRUE,
        'background_animation', 'subtle_glow'
      ),
      'shift_start', jsonb_build_object(
        'enabled', TRUE,
        'variant', 'confetti_haptic',
        'show_earnings_preview', TRUE,
        'haptic_pattern', 'success',
        'duration_ms', 2400
      ),
      'shift_end', jsonb_build_object(
        'enabled', TRUE,
        'variant', 'summary_card',
        'show_sparkline', TRUE,
        'show_thank_you', TRUE,
        'show_share_export', TRUE
      ),
      'error_recovery', jsonb_build_object(
        'enabled', TRUE,
        'variant', 'branded_boundary',
        'show_offline_radar', TRUE,
        'preserve_last_state', TRUE,
        'show_retry_cta', TRUE
      )
    ),
    'respect_reduce_motion', TRUE,
    'respect_driving_lock', TRUE
  ) AS value
), inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'brand_hero_policy', 'global', NULL, 1, value, 1, clock_timestamp() FROM default_value
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'brand_hero_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_brand_hero_policy()
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'brand_hero_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_brand_hero_policy() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_brand_hero_policy() TO authenticated;

COMMIT;
