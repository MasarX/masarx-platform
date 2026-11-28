BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SELECT plan(12);

SELECT is(
  (SELECT cached_value->'enabled' FROM public.settings WHERE category = policy AND scope_type = 'global' AND scope_id IS NULL),
  'false'::jsonb,
  policy || ' defaults to disabled'
)
FROM unnest(ARRAY['voice_pod_policy', 'vision_pod_policy', 'dual_sign_policy']) AS policies(policy);

SELECT ok(has_function_privilege('authenticated', 'api.resolve_' || policy || '()', 'EXECUTE'),
  policy || ' is readable through the scoped authenticated resolver')
FROM unnest(ARRAY['voice_pod_policy', 'vision_pod_policy', 'dual_sign_policy']) AS policies(policy);

SELECT ok(NOT has_function_privilege('anon', 'api.resolve_' || policy || '()', 'EXECUTE'),
  policy || ' cannot be queried anonymously')
FROM unnest(ARRAY['voice_pod_policy', 'vision_pod_policy', 'dual_sign_policy']) AS policies(policy);

SELECT is(
  (SELECT cached_value #>> '{speech_recognizer,min_confidence}' FROM public.settings WHERE category = 'voice_pod_policy' AND scope_type = 'global' AND scope_id IS NULL),
  '0.75', 'voice confirmation uses the seeded confidence threshold'
);
SELECT is(
  (SELECT (cached_value #>> '{quality_gates,max_motion_blur}')::numeric FROM public.settings WHERE category = 'vision_pod_policy' AND scope_type = 'global' AND scope_id IS NULL),
  0.30::numeric, 'photo quality uses the seeded blur threshold'
);
SELECT is(
  (SELECT cached_value->>'signing_order' FROM public.settings WHERE category = 'dual_sign_policy' AND scope_type = 'global' AND scope_id IS NULL),
  'driver_first', 'dual signatures default to the driver signing first'
);

SELECT * FROM finish();
ROLLBACK;
