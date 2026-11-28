BEGIN;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'voice_pod_policy', 'Optional voice policy for FieldOps delivery proof.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'voice_pod_policy', 1, jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Voice POD Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object(
        'type', 'boolean',
        'description', 'Master toggle. When false, voice POD is fully off and the recognizer is never armed. Default false at the global seed (opt-in per tenant once platform-native binding ships).'
      ),
      'wakewords', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'en', jsonb_build_object(
            'type', 'array',
            'items', jsonb_build_object('type', 'string', 'minLength', 1)
          ),
          'ar', jsonb_build_object(
            'type', 'array',
            'items', jsonb_build_object('type', 'string', 'minLength', 1)
          )
        ),
        'required', jsonb_build_array('en')
      ),
      'speech_recognizer', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'engine', jsonb_build_object('type', 'string', 'minLength', 1),
          'min_confidence', jsonb_build_object('type', 'number', 'minimum', 0, 'maximum', 1),
          'max_listen_seconds', jsonb_build_object('type', 'integer', 'minimum', 1, 'maximum', 60),
          'ambient_speech_filter', jsonb_build_object('type', 'boolean')
        ),
        'required', jsonb_build_array('engine','min_confidence','max_listen_seconds','ambient_speech_filter')
      ),
      'confirmation', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'require_readback', jsonb_build_object('type', 'boolean'),
          'readback_template_en', jsonb_build_object('type', 'string', 'minLength', 1),
          'readback_template_ar', jsonb_build_object('type', 'string', 'minLength', 1),
          'haptic_pattern_on_accept', jsonb_build_object('type', 'string', 'minLength', 1),
          'cancel_window_seconds', jsonb_build_object('type', 'integer', 'minimum', 0, 'maximum', 60)
        ),
        'required', jsonb_build_array('require_readback','readback_template_en','readback_template_ar','haptic_pattern_on_accept','cancel_window_seconds')
      ),
      'respect_driving_lock', jsonb_build_object(
        'type', 'boolean',
        'description', 'When true, voice POD is suppressed unless the driving lock is active (stage C). When false (default), voice POD is available across stages once enabled — letting drivers opt into hands-free completion at any time.'
      ),
      'driving_lock_required_stage', jsonb_build_object(
        'type', 'string',
        'minLength', 1,
        'description', 'Canonical name of the driver_safety_policy stage at which the voice path becomes the *primary* completion path (i.e. the action UI is suppressed and only voice can complete). Default "voice" mirrors stage C in driver_safety_policy.'
      )
    ),
    'required', jsonb_build_array('version','enabled','wakewords','speech_recognizer','confirmation','respect_driving_lock','driving_lock_required_stage')
  ),
  'Optional voice policy for FieldOps delivery proof.', '[]'::jsonb, TRUE
);

WITH default_value AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', FALSE,
    'wakewords', jsonb_build_object(
      'en', jsonb_build_array('mark delivered','mark complete'),
      'ar', jsonb_build_array('تم التسليم')
    ),
    'speech_recognizer', jsonb_build_object(
      'engine', 'platform_native',
      'min_confidence', 0.75,
      'max_listen_seconds', 8,
      'ambient_speech_filter', TRUE
    ),
    'confirmation', jsonb_build_object(
      'require_readback', TRUE,
      'readback_template_en', 'Delivered to ${customer_name} at ${address}. Confirm?',
      'readback_template_ar', 'تم التسليم إلى ${customer_name} في ${address}. تأكيد؟',
      'haptic_pattern_on_accept', 'medium',
      'cancel_window_seconds', 5
    ),
    'respect_driving_lock', FALSE,
    'driving_lock_required_stage', 'voice'
  ) AS value
), inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'voice_pod_policy', 'global', NULL, 1, value, 1, clock_timestamp() FROM default_value
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'voice_pod_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_voice_pod_policy()
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'voice_pod_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_voice_pod_policy() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_voice_pod_policy() TO authenticated;

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'vision_pod_policy', 'Optional image quality policy for FieldOps delivery proof.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'vision_pod_policy', 1, jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Vision POD Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object(
        'type', 'boolean',
        'description', 'Master toggle. When false, on-device vision POD is fully off and the composer must accept POD photos without running the gate evaluator. Default false because real model integration requires asset bundling.'
      ),
      'model', jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'name', jsonb_build_object('type', 'string', 'minLength', 1),
          'version', jsonb_build_object('type', 'string', 'minLength', 1),
          'size_mb', jsonb_build_object('type', 'integer', 'minimum', 1, 'maximum', 200),
          'asset_uri_pattern', jsonb_build_object('type', 'string', 'minLength', 1)
        ),
        'required', jsonb_build_array('name','version','size_mb','asset_uri_pattern')
      ),
      'quality_gates', jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'min_confidence', jsonb_build_object('type', 'number', 'minimum', 0, 'maximum', 1),
          'require_package_in_frame', jsonb_build_object('type', 'boolean'),
          'require_label_legible', jsonb_build_object('type', 'boolean'),
          'require_addressee_visible', jsonb_build_object('type', 'boolean'),
          'min_frame_brightness', jsonb_build_object('type', 'number', 'minimum', 0, 'maximum', 1),
          'max_motion_blur', jsonb_build_object('type', 'number', 'minimum', 0, 'maximum', 1)
        ),
        'required', jsonb_build_array('min_confidence','require_package_in_frame','require_label_legible','require_addressee_visible','min_frame_brightness','max_motion_blur')
      ),
      'user_messaging', jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'package_missing_en', jsonb_build_object('type', 'string'),
          'package_missing_ar', jsonb_build_object('type', 'string'),
          'label_unreadable_en', jsonb_build_object('type', 'string'),
          'label_unreadable_ar', jsonb_build_object('type', 'string'),
          'low_brightness_en', jsonb_build_object('type', 'string'),
          'low_brightness_ar', jsonb_build_object('type', 'string'),
          'motion_blur_en', jsonb_build_object('type', 'string'),
          'motion_blur_ar', jsonb_build_object('type', 'string')
        ),
        'required', jsonb_build_array('package_missing_en','package_missing_ar','label_unreadable_en','label_unreadable_ar','low_brightness_en','low_brightness_ar','motion_blur_en','motion_blur_ar')
      ),
      'fallback_to_manual_after_attempts', jsonb_build_object(
        'type', 'integer',
        'minimum', 1,
        'maximum', 10,
        'description', 'After N failed gate evaluations on the same POD, the composer must surface a manual-submit escape hatch so the driver is never blocked by an over-strict ML gate.'
      )
    ),
    'required', jsonb_build_array('version','enabled','model','quality_gates','user_messaging','fallback_to_manual_after_attempts')
  ),
  'Optional image quality policy for FieldOps delivery proof.', '[]'::jsonb, TRUE
);

WITH default_value AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', FALSE,
    'model', jsonb_build_object(
      'name', 'yolov26-n',
      'version', '1.0.0',
      'size_mb', 8,
      'asset_uri_pattern', '${cdn_base}/vision/yolov26-n-${version}.tflite'
    ),
    'quality_gates', jsonb_build_object(
      'min_confidence', 0.65,
      'require_package_in_frame', TRUE,
      'require_label_legible', FALSE,
      'require_addressee_visible', FALSE,
      'min_frame_brightness', 0.15,
      'max_motion_blur', 0.30
    ),
    'user_messaging', jsonb_build_object(
      'package_missing_en', 'Move closer so the package fills the frame',
      'package_missing_ar', 'اقترب أكثر حتى تملأ الطرد الإطار',
      'label_unreadable_en', 'Try again with better lighting on the label',
      'label_unreadable_ar', 'حاول مرة أخرى مع إضاءة أفضل للملصق',
      'low_brightness_en', 'Find a brighter spot',
      'low_brightness_ar', 'ابحث عن مكان أكثر إضاءة',
      'motion_blur_en', 'Hold still and try again',
      'motion_blur_ar', 'اثبت في مكانك وحاول مرة أخرى'
    ),
    'fallback_to_manual_after_attempts', 3
  ) AS value
), inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'vision_pod_policy', 'global', NULL, 1, value, 1, clock_timestamp() FROM default_value
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'vision_pod_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_vision_pod_policy()
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'vision_pod_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_vision_pod_policy() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_vision_pod_policy() TO authenticated;

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'dual_sign_policy', 'Optional two-signature policy for FieldOps delivery proof.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'dual_sign_policy', 1, jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Dual Sign Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object(
        'type', 'boolean',
        'description', 'Master toggle. When false, the dual-sign handover flow is fully off and the driver app must continue with the single-signature POD flow.'
      ),
      'required_for_categories', jsonb_build_object(
        'type', 'array',
        'items', jsonb_build_object('type', 'string'),
        'minItems', 0,
        'uniqueItems', TRUE
      ),
      'signing_order', jsonb_build_object(
        'type', 'string',
        'enum', jsonb_build_array('driver_first','customer_first')
      ),
      'driver_signature', jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'label_en', jsonb_build_object('type', 'string', 'minLength', 1),
          'label_ar', jsonb_build_object('type', 'string', 'minLength', 1),
          'min_strokes', jsonb_build_object('type', 'integer', 'minimum', 0, 'maximum', 50),
          'min_duration_ms', jsonb_build_object('type', 'integer', 'minimum', 0, 'maximum', 10000)
        ),
        'required', jsonb_build_array('label_en','label_ar','min_strokes','min_duration_ms')
      ),
      'customer_signature', jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'label_en', jsonb_build_object('type', 'string', 'minLength', 1),
          'label_ar', jsonb_build_object('type', 'string', 'minLength', 1),
          'min_strokes', jsonb_build_object('type', 'integer', 'minimum', 0, 'maximum', 50),
          'min_duration_ms', jsonb_build_object('type', 'integer', 'minimum', 0, 'maximum', 10000),
          'captured_on_driver_device', jsonb_build_object('type', 'boolean')
        ),
        'required', jsonb_build_array('label_en','label_ar','min_strokes','min_duration_ms','captured_on_driver_device')
      ),
      'auto_advance_after_first_signed', jsonb_build_object(
        'type', 'boolean',
        'description', 'When true, the composer flips from driver_signed to customer_signing state automatically as soon as the first signature is captured. When false, the driver must explicitly tap "next" to advance.'
      ),
      'show_witness_pill', jsonb_build_object(
        'type', 'boolean',
        'description', 'When true, a "witness" pill is surfaced to the customer (or shown on the driver device when handed to the customer) confirming the driver has already attested. Helps with regulated-goods chain-of-custody UX.'
      )
    ),
    'required', jsonb_build_array('version','enabled','required_for_categories','signing_order','driver_signature','customer_signature','auto_advance_after_first_signed','show_witness_pill')
  ),
  'Optional two-signature policy for FieldOps delivery proof.', '[]'::jsonb, TRUE
);

WITH default_value AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', FALSE,
    'required_for_categories', jsonb_build_array('pharma','high_value','controlled_goods'),
    'signing_order', 'driver_first',
    'driver_signature', jsonb_build_object(
      'label_en', 'Driver signature',
      'label_ar', 'توقيع السائق',
      'min_strokes', 3,
      'min_duration_ms', 500
    ),
    'customer_signature', jsonb_build_object(
      'label_en', 'Customer signature',
      'label_ar', 'توقيع العميل',
      'min_strokes', 3,
      'min_duration_ms', 500,
      'captured_on_driver_device', TRUE
    ),
    'auto_advance_after_first_signed', TRUE,
    'show_witness_pill', TRUE
  ) AS value
), inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'dual_sign_policy', 'global', NULL, 1, value, 1, clock_timestamp() FROM default_value
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'dual_sign_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_dual_sign_policy()
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'dual_sign_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_dual_sign_policy() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_dual_sign_policy() TO authenticated;

COMMIT;
