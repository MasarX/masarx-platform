-- Plan: PLAN-202601-demo-speed-here-failfast / Step: S04
-- Purpose: call_api prefers edge dispatch when edge_dispatch_policy is enabled.
BEGIN;
SELECT plan(2);

DO $$
DECLARE
  v_policy JSONB;
  v_version INTEGER;
  v_settings_version_id UUID;
BEGIN
  SELECT resolve_settings('edge_dispatch_policy', 'global', NULL) INTO v_policy;

  IF NULLIF((v_policy->>'endpoint_url')::text, '') IS NULL
     OR v_policy->'enabled' IS DISTINCT FROM 'true'::jsonb THEN
    v_version := COALESCE((
      SELECT MAX(version)
      FROM public.settings_versions
      WHERE category = 'edge_dispatch_policy'
        AND scope_type = 'global'
        AND scope_id IS NULL
    ), 0) + 1;

    v_settings_version_id := gen_random_uuid();
    v_policy := jsonb_build_object(
      'enabled', true,
      'endpoint_url', 'https://edge-dispatch.example.invalid/functions/v1/api-caller',
      'batch_size', 10,
      'dispatch_timeout_ms', 3000
    );

    INSERT INTO public.settings_versions (
      id, category, scope_type, scope_id, version, value, approved_at, change_reason
    )
    VALUES (
      v_settings_version_id,
      'edge_dispatch_policy',
      'global',
      NULL,
      v_version,
      v_policy,
      now(),
      'pgtap fixture: edge dispatch policy'
    );

    INSERT INTO public.settings (
      id, category, scope_type, scope_id, settings_version_id, cached_value, last_updated
    )
    VALUES (
      gen_random_uuid(),
      'edge_dispatch_policy',
      'global',
      NULL,
      v_settings_version_id,
      v_policy,
      now()
    )
    ON CONFLICT (category, scope_type, scope_hash)
    DO UPDATE
      SET settings_version_id = EXCLUDED.settings_version_id,
          cached_value = EXCLUDED.cached_value,
          last_updated = now();
  END IF;
END $$;

WITH policy AS (
  SELECT resolve_settings('edge_dispatch_policy', 'global', NULL) AS value
)
SELECT ok(
  NULLIF((value->>'endpoint_url')::text, '') IS NOT NULL,
  'edge_dispatch_policy endpoint_url configured'
)
FROM policy;

WITH policy AS (
  SELECT resolve_settings('edge_dispatch_policy', 'global', NULL) AS value
)
SELECT CASE
  WHEN NULLIF((value->>'endpoint_url')::text, '') IS NULL THEN
    skip('edge_dispatch_policy missing', 1)
  ELSE
    ok(
      (public.call_api('https://example.com', 'GET', '{}'::jsonb, '{}'::jsonb, 1) ? 'edge_dispatch'),
      'call_api returns edge_dispatch when enabled'
    )
END
FROM policy;

SELECT * FROM finish();
ROLLBACK;
