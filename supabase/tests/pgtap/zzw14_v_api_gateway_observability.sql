-- pgTAP: public.v_api_gateway_observability + v_api_gateway_rate_limits_summary
-- projection contract — W14-2.
-- Closes INSIGHTS api_gateway FE-shape gap (W7 audit + W10-5 + W11/W13 deferred).
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(20);

-- ---------------------------------------------------------------------------
-- v_api_gateway_observability
-- ---------------------------------------------------------------------------

-- 1) View exists
SELECT has_view(
  'public', 'v_api_gateway_observability',
  'public.v_api_gateway_observability view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_api_gateway_observability',
  ARRAY[
    'id', 'request_id', 'organization_id', 'provider_id', 'operation',
    'method', 'url', 'path',
    'request_headers', 'response_status', 'status_code',
    'response_headers', 'response_body', 'response_body_sample',
    'response_size_bytes', 'duration_ms', 'error_message', 'error_code',
    'circuit_breaker_state', 'timestamp', 'occurred_at',
    'route_id', 'route_pack_id', 'source_id', 'source_label', 'source_org_id'
  ],
  'v_api_gateway_observability exposes canonical + derived FE-projection columns'
);

-- 3) Underlying base table remains SSOT (regular partitioned table, not view)
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'api_call_log'
       AND c.relkind IN ('r', 'p')  -- regular or partitioned
  ),
  'public.api_call_log remains a base/partitioned table (SSOT preserved)'
);

-- 4) Service-role has SELECT
SELECT ok(
  has_table_privilege('service_role', 'public.v_api_gateway_observability', 'SELECT'),
  'service_role has SELECT on v_api_gateway_observability'
);

-- 5) anon has NO SELECT (canonical api_call_log is service-role only)
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_api_gateway_observability', 'SELECT'),
  'anon has NO SELECT on v_api_gateway_observability'
);

-- 6) authenticated has NO SELECT
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.v_api_gateway_observability', 'SELECT'),
  'authenticated has NO SELECT on v_api_gateway_observability (service-role gated)'
);

-- ---------------------------------------------------------------------------
-- Field projection: error_code derivation + path strip + response_size_bytes
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_org      UUID := '00000000-0000-0000-0000-00000014a201';
  v_provider UUID := '00000000-0000-0000-0000-00000014a202';
  v_call_429 UUID := '00000000-0000-0000-0000-00000014a203';
  v_call_500 UUID := '00000000-0000-0000-0000-00000014a204';
  v_call_200 UUID := '00000000-0000-0000-0000-00000014a205';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W14-2 ApiGw View Org', 'w14-agv-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  -- 429 → 'rate_limited' + path strip from url+query
  INSERT INTO public.api_call_log (
    id, organization_id, provider_id, operation, method, url,
    response_status, response_body, duration_ms, timestamp
  )
  VALUES (
    v_call_429, v_org, v_provider, 'pickup_create', 'POST',
    '/v1/pickups?source=test',
    429,
    '{"error":"rate_limited"}'::jsonb,
    180,
    now()
  )
  ON CONFLICT DO NOTHING;

  -- 502 → 'upstream_error' + body sample
  INSERT INTO public.api_call_log (
    id, organization_id, provider_id, operation, method, url,
    response_status, response_body, duration_ms, timestamp
  )
  VALUES (
    v_call_500, v_org, v_provider, 'shipment_create', 'POST',
    '/v1/shipments',
    502,
    '{"error":"upstream_error","message":"bad gateway"}'::jsonb,
    1800,
    now()
  )
  ON CONFLICT DO NOTHING;

  -- 200 → NULL error_code
  INSERT INTO public.api_call_log (
    id, organization_id, provider_id, operation, method, url,
    response_status, response_body, duration_ms, timestamp
  )
  VALUES (
    v_call_200, v_org, v_provider, 'shipment_get', 'GET',
    '/v1/shipments/abc',
    200,
    '{"ok":true}'::jsonb,
    120,
    now()
  )
  ON CONFLICT DO NOTHING;

  PERFORM set_config('test.w14_call_429', v_call_429::text, true);
  PERFORM set_config('test.w14_call_500', v_call_500::text, true);
  PERFORM set_config('test.w14_call_200', v_call_200::text, true);
  PERFORM set_config('test.w14_org',      v_org::text,      true);

  EXECUTE 'RESET ROLE';
END $$;

-- 7) error_code derives 'rate_limited' from response_status=429
SELECT is(
  (SELECT error_code FROM public.v_api_gateway_observability
    WHERE id = current_setting('test.w14_call_429')::uuid),
  'rate_limited',
  'v_api_gateway_observability derives error_code=rate_limited from 429'
);

-- 8) error_code derives 'upstream_error' from response_status=502
SELECT is(
  (SELECT error_code FROM public.v_api_gateway_observability
    WHERE id = current_setting('test.w14_call_500')::uuid),
  'upstream_error',
  'v_api_gateway_observability derives error_code=upstream_error from 502'
);

-- 9) error_code is NULL for response_status=200
SELECT is(
  (SELECT error_code FROM public.v_api_gateway_observability
    WHERE id = current_setting('test.w14_call_200')::uuid),
  NULL::text,
  'v_api_gateway_observability returns NULL error_code for 2xx'
);

-- 10) path strips query string from url
SELECT is(
  (SELECT path FROM public.v_api_gateway_observability
    WHERE id = current_setting('test.w14_call_429')::uuid),
  '/v1/pickups',
  'v_api_gateway_observability projects path with query string stripped'
);

-- 11) status_code aliases response_status
SELECT is(
  (SELECT status_code FROM public.v_api_gateway_observability
    WHERE id = current_setting('test.w14_call_429')::uuid),
  429,
  'v_api_gateway_observability aliases status_code = response_status'
);

-- 12) occurred_at aliases timestamp
SELECT ok(
  (SELECT occurred_at = timestamp FROM public.v_api_gateway_observability
    WHERE id = current_setting('test.w14_call_429')::uuid),
  'v_api_gateway_observability aliases occurred_at = timestamp'
);

-- 13) response_size_bytes derives from response_body length
SELECT ok(
  (SELECT response_size_bytes > 0 FROM public.v_api_gateway_observability
    WHERE id = current_setting('test.w14_call_200')::uuid),
  'v_api_gateway_observability derives response_size_bytes > 0 for non-null body'
);

-- ---------------------------------------------------------------------------
-- v_api_gateway_rate_limits_summary
-- ---------------------------------------------------------------------------

-- 14) View exists
SELECT has_view(
  'public', 'v_api_gateway_rate_limits_summary',
  'public.v_api_gateway_rate_limits_summary view exists'
);

-- 15) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_api_gateway_rate_limits_summary',
  ARRAY[
    'id', 'source_id', 'source_label', 'source_org_id',
    'limit_per_hour', 'limit_per_min',
    'request_count', 'current_usage', 'saturated',
    'window_start', 'updated_at'
  ],
  'v_api_gateway_rate_limits_summary exposes joined + derived columns'
);

-- 16) Service-role has SELECT
SELECT ok(
  has_table_privilege('service_role', 'public.v_api_gateway_rate_limits_summary', 'SELECT'),
  'service_role has SELECT on v_api_gateway_rate_limits_summary'
);

-- 17) anon has NO SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_api_gateway_rate_limits_summary', 'SELECT'),
  'anon has NO SELECT on v_api_gateway_rate_limits_summary'
);

-- 18) authenticated has NO SELECT
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.v_api_gateway_rate_limits_summary', 'SELECT'),
  'authenticated has NO SELECT on v_api_gateway_rate_limits_summary'
);

-- ---------------------------------------------------------------------------
-- Field projection: limit_per_min derivation + saturated derivation
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_org       UUID := '00000000-0000-0000-0000-00000014a301';
  v_mc        UUID;
  v_src_lo    UUID := '00000000-0000-0000-0000-00000014a303';
  v_src_hi    UUID := '00000000-0000-0000-0000-00000014a304';
  v_rl_lo     UUID := '00000000-0000-0000-0000-00000014a305';
  v_rl_hi     UUID := '00000000-0000-0000-0000-00000014a306';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W14-2 RateLimit View Org', 'w14-rlv-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  -- Reuse an existing mapping_config or create one (mapping_configs is FK-required).
  SELECT id INTO v_mc FROM public.mapping_configs LIMIT 1;
  IF v_mc IS NULL THEN
    INSERT INTO public.mapping_configs (mapping_type, mapping_key, mapping_config, mapping_version)
    VALUES ('webhook_inbound', 'w14-rlv-mc-' || left(v_org::text, 8), '{}'::jsonb, 1)
    RETURNING id INTO v_mc;
  END IF;

  -- source_lo: 60/hour ⇒ 1/min, request_count=30 ⇒ NOT saturated
  INSERT INTO public.webhook_sources (
    id, organization_id, source_identifier, name, provider_type,
    auth_token, mapping_config_id, rate_limit_per_hour, enabled
  )
  VALUES (
    v_src_lo, v_org,
    'w14-rlv-src-lo-' || left(v_src_lo::text, 8),
    'W14-2 RL Lo Source', 'generic',
    'tok-w14-rlv-lo-' || left(v_src_lo::text, 8),
    v_mc, 60, TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  -- source_hi: 120/hour ⇒ 2/min, request_count=200 ⇒ SATURATED
  INSERT INTO public.webhook_sources (
    id, organization_id, source_identifier, name, provider_type,
    auth_token, mapping_config_id, rate_limit_per_hour, enabled
  )
  VALUES (
    v_src_hi, v_org,
    'w14-rlv-src-hi-' || left(v_src_hi::text, 8),
    'W14-2 RL Hi Source', 'generic',
    'tok-w14-rlv-hi-' || left(v_src_hi::text, 8),
    v_mc, 120, TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.api_gateway_rate_limits (id, source_id, window_start, request_count)
  VALUES (v_rl_lo, v_src_lo, date_trunc('hour', now()), 30)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.api_gateway_rate_limits (id, source_id, window_start, request_count)
  VALUES (v_rl_hi, v_src_hi, date_trunc('hour', now()), 200)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.w14_rl_lo', v_rl_lo::text, true);
  PERFORM set_config('test.w14_rl_hi', v_rl_hi::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 19) limit_per_min derives from rate_limit_per_hour / 60 (60/hour ⇒ 1/min)
SELECT is(
  (SELECT limit_per_min FROM public.v_api_gateway_rate_limits_summary
    WHERE id = current_setting('test.w14_rl_lo')::uuid),
  1,
  'v_api_gateway_rate_limits_summary computes limit_per_min = floor(rate_limit_per_hour/60) for 60/hour'
);

-- 20) saturated=TRUE when request_count >= rate_limit_per_hour (200>=120)
SELECT ok(
  (SELECT saturated FROM public.v_api_gateway_rate_limits_summary
    WHERE id = current_setting('test.w14_rl_hi')::uuid),
  'v_api_gateway_rate_limits_summary derives saturated=TRUE when request_count >= rate_limit_per_hour'
);

SELECT * FROM finish();
ROLLBACK;
