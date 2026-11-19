-- W41 closure of W40 finding F3
-- pgTAP: block_api_gateway_source_v1 RPC + api_gateway capability registration
--
-- Asserts:
--   * public.block_api_gateway_source_v1(jsonb) function exists with the
--     correct return type and grant posture.
--   * api_gateway.read + api_gateway.write capabilities are registered in
--     the active access_control_policy global row (when an active row
--     exists; tolerates the no-active-row case).
--   * settings_versions.schema_version remains INTEGER (regression guard
--     against the F3 root cause TEXT->INTEGER cast failure).
--
-- Evidence link: docs/ops/evidence/2026-04-30/local-verify/migrate-soft.log

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

CREATE OR REPLACE FUNCTION test_w41_block_api_gateway_source_fixup()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_active_value JSONB;
  v_caps JSONB;
  v_keys TEXT[] := ARRAY[]::TEXT[];
  v_idx INT;
  v_has_read BOOLEAN := FALSE;
  v_has_write BOOLEAN := FALSE;
BEGIN
  -- 1) RPC exists.
  RETURN NEXT has_function(
    'public', 'block_api_gateway_source_v1', ARRAY['jsonb'],
    'public.block_api_gateway_source_v1(jsonb) function exists'
  );

  -- 2) RPC returns jsonb.
  RETURN NEXT function_returns(
    'public', 'block_api_gateway_source_v1', ARRAY['jsonb'], 'jsonb',
    'block_api_gateway_source_v1 returns jsonb'
  );

  -- 3) settings_versions.schema_version remains INTEGER (regression guard).
  RETURN NEXT col_type_is(
    'public', 'settings_versions', 'schema_version', 'integer',
    'settings_versions.schema_version remains INTEGER (W41 F3 regression guard)'
  );

  -- 4) When an active access_control_policy row exists, both capabilities
  --    are registered. (Tolerated: no active row means F3 caps step is a
  --    documented no-op.)
  SELECT value
    INTO v_active_value
    FROM public.settings_versions
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL
     AND approved_at IS NOT NULL
     AND effective_until IS NULL
   ORDER BY version DESC
   LIMIT 1;

  IF v_active_value IS NOT NULL THEN
    v_caps := COALESCE(v_active_value->'capabilities', '[]'::jsonb);
    FOR v_idx IN 0 .. jsonb_array_length(v_caps) - 1 LOOP
      v_keys := array_append(v_keys, COALESCE(v_caps->v_idx->>'key', ''));
    END LOOP;
    v_has_read := 'api_gateway.read' = ANY(v_keys);
    v_has_write := 'api_gateway.write' = ANY(v_keys);

    RETURN NEXT ok(
      v_has_read AND v_has_write,
      'api_gateway.read + api_gateway.write are registered'
    );
  ELSE
    RETURN NEXT pass(
      'no active access_control_policy row; F3 cap registration is a no-op (skipped)'
    );
  END IF;

  -- 5) Service-role grant posture.
  RETURN NEXT ok(
    has_function_privilege('service_role', 'public.block_api_gateway_source_v1(jsonb)', 'execute'),
    'service_role has EXECUTE on block_api_gateway_source_v1(jsonb)'
  );
END
$function$;

SELECT * FROM test_w41_block_api_gateway_source_fixup();

ROLLBACK;
