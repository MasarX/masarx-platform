-- Plan: PLAN-202602-landing-page-live / Step: S04
-- Migration: Marketing demo intake (policy + SSOT) v1
-- Purpose:
--   - Add marketing_demo_intake_policy settings category (row-driven toggles/rate limits)
--   - Create public.marketing_demo_requests as the SSOT for inbound demo requests (RLS)
--   - Add marketing_demo_request_create_v1 RPC for edge intake (least privilege)
BEGIN;
SET search_path TO public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 1) Category registry metadata (SSOT)
-- ---------------------------------------------------------------------------
INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES (
  'marketing_demo_intake_policy',
  'Public marketing demo intake policy (Turnstile requirement + rate limits).',
  TRUE,
  TRUE,
  TRUE,
  'hard_fail',
  '["global"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 2) Schema registry contract
-- ---------------------------------------------------------------------------
INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
VALUES (
  'marketing_demo_intake_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object('type', 'boolean'),
      'turnstile', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'required', jsonb_build_object('type', 'boolean')
        )
      ),
      'rate_limit', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'window_seconds', jsonb_build_object('type', 'integer', 'minimum', 1),
          'max_requests', jsonb_build_object('type', 'integer', 'minimum', 0)
        )
      ),
      'dedupe', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'window_seconds', jsonb_build_object('type', 'integer', 'minimum', 0)
        )
      )
    )
  ),
  'Row-driven controls for public demo request intake (Turnstile requirement, throttling, dedupe).',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'enabled', TRUE,
      'turnstile', jsonb_build_object('required', TRUE),
      'rate_limit', jsonb_build_object('window_seconds', 60, 'max_requests', 15),
      'dedupe', jsonb_build_object('window_seconds', 3600)
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 3) SSOT table: marketing_demo_requests
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketing_demo_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  email TEXT NOT NULL,
  company TEXT NOT NULL,
  volume TEXT,
  role TEXT,
  notes TEXT,
  locale TEXT,
  page_url TEXT,
  referrer TEXT,
  origin TEXT,
  marketing JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_hash TEXT,
  turnstile_verified BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_marketing_demo_requests_created_at
  ON public.marketing_demo_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_demo_requests_email_created_at
  ON public.marketing_demo_requests(email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_demo_requests_ip_hash_created_at
  ON public.marketing_demo_requests(ip_hash, created_at DESC)
  WHERE ip_hash IS NOT NULL;

COMMENT ON TABLE public.marketing_demo_requests IS 'SSOT for public marketing demo requests (inserted via edge intake).';

-- RLS: service-only table; public intake uses SECURITY DEFINER RPC.
ALTER TABLE public.marketing_demo_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.marketing_demo_requests FROM PUBLIC;
REVOKE ALL ON TABLE public.marketing_demo_requests FROM anon;
REVOKE ALL ON TABLE public.marketing_demo_requests FROM authenticated;

DROP POLICY IF EXISTS marketing_demo_requests_service_policy ON public.marketing_demo_requests;
CREATE POLICY marketing_demo_requests_service_policy
  ON public.marketing_demo_requests
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- ---------------------------------------------------------------------------
-- 4) Intake RPC (least privilege): marketing_demo_request_create_v1
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.marketing_demo_request_create_v1(
  p_email TEXT,
  p_company TEXT,
  p_volume TEXT DEFAULT NULL,
  p_role TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_locale TEXT DEFAULT NULL,
  p_page_url TEXT DEFAULT NULL,
  p_referrer TEXT DEFAULT NULL,
  p_origin TEXT DEFAULT NULL,
  p_marketing JSONB DEFAULT '{}'::jsonb,
  p_ip_hash TEXT DEFAULT NULL,
  p_turnstile_verified BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_policy JSONB;
  v_enabled BOOLEAN;
  v_turnstile_required BOOLEAN;
  v_window_seconds INT;
  v_max_requests INT;
  v_dedupe_seconds INT;
  v_now TIMESTAMPTZ := now();
  v_id UUID := gen_random_uuid();
  v_email TEXT := btrim(COALESCE(p_email, ''));
  v_company TEXT := btrim(COALESCE(p_company, ''));
  v_ip_hash TEXT := NULLIF(btrim(COALESCE(p_ip_hash, '')), '');
  v_recent_count INT := 0;
BEGIN
  v_policy := public.resolve_settings_merged('marketing_demo_intake_policy', 'global', NULL::uuid);

  v_enabled := COALESCE(NULLIF(v_policy->>'enabled', '')::BOOLEAN, FALSE);
  IF NOT v_enabled THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'disabled'));
  END IF;

  v_turnstile_required := COALESCE(NULLIF(v_policy#>>'{turnstile,required}', '')::BOOLEAN, TRUE);
  IF v_turnstile_required AND NOT COALESCE(p_turnstile_verified, FALSE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'turnstile_required'));
  END IF;

  IF v_email = '' OR position('@' IN v_email) = 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_email'));
  END IF;

  IF v_company = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'company_required'));
  END IF;

  v_window_seconds := COALESCE(NULLIF(v_policy#>>'{rate_limit,window_seconds}', '')::INT, 60);
  v_max_requests := COALESCE(NULLIF(v_policy#>>'{rate_limit,max_requests}', '')::INT, 15);
  IF v_ip_hash IS NOT NULL AND v_max_requests > 0 THEN
    SELECT COUNT(*)
      INTO v_recent_count
      FROM public.marketing_demo_requests r
     WHERE r.ip_hash = v_ip_hash
       AND r.created_at >= (v_now - (v_window_seconds || ' seconds')::interval);

    IF v_recent_count >= v_max_requests THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'rate_limited'));
    END IF;
  END IF;

  v_dedupe_seconds := COALESCE(NULLIF(v_policy#>>'{dedupe,window_seconds}', '')::INT, 3600);
  IF v_dedupe_seconds > 0 THEN
    IF EXISTS (
      SELECT 1
        FROM public.marketing_demo_requests r
       WHERE r.email = v_email
         AND r.created_at >= (v_now - (v_dedupe_seconds || ' seconds')::interval)
       LIMIT 1
    ) THEN
      RETURN jsonb_build_object('ok', TRUE, 'deduped', TRUE);
    END IF;
  END IF;

  INSERT INTO public.marketing_demo_requests (
    id,
    created_at,
    email,
    company,
    volume,
    role,
    notes,
    locale,
    page_url,
    referrer,
    origin,
    marketing,
    ip_hash,
    turnstile_verified
  ) VALUES (
    v_id,
    v_now,
    v_email,
    v_company,
    NULLIF(btrim(COALESCE(p_volume, '')), ''),
    NULLIF(btrim(COALESCE(p_role, '')), ''),
    NULLIF(btrim(COALESCE(p_notes, '')), ''),
    NULLIF(btrim(COALESCE(p_locale, '')), ''),
    NULLIF(btrim(COALESCE(p_page_url, '')), ''),
    NULLIF(btrim(COALESCE(p_referrer, '')), ''),
    NULLIF(btrim(COALESCE(p_origin, '')), ''),
    COALESCE(p_marketing, '{}'::jsonb),
    v_ip_hash,
    COALESCE(p_turnstile_verified, FALSE)
  );

  RETURN jsonb_build_object('ok', TRUE, 'id', v_id);
END;
$$;

COMMENT ON FUNCTION public.marketing_demo_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN)
  IS 'Public demo intake RPC (policy-driven via settings): validates, rate limits, stores request, returns {ok,id}.';

REVOKE EXECUTE ON FUNCTION public.marketing_demo_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.marketing_demo_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM anon;
REVOKE EXECUTE ON FUNCTION public.marketing_demo_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_gateway_role') THEN
    GRANT EXECUTE ON FUNCTION public.marketing_demo_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN)
      TO edge_api_gateway_role;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5) Seed global default (idempotent; from schema_registry.examples[0])
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_existing RECORD;
  v_value JSONB;
  v_sv_id UUID := gen_random_uuid();
BEGIN
  SELECT *
    INTO v_existing
    FROM public.settings
   WHERE category = 'marketing_demo_intake_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL
   LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT (examples->0)
    INTO v_value
    FROM public.schema_registry
   WHERE category = 'marketing_demo_intake_policy'
     AND version = 1
   LIMIT 1;

  v_value := COALESCE(v_value, jsonb_build_object('version', 1, 'enabled', TRUE));

  INSERT INTO public.settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  ) VALUES (
    v_sv_id,
    'marketing_demo_intake_policy',
    'global',
    NULL::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    1,
    v_value,
    1,
    'seed marketing_demo_intake_policy global default',
    now(),
    now()
  );

  INSERT INTO public.settings (
    category,
    scope_type,
    scope_id,
    settings_version_id,
    cached_value,
    last_updated
  ) VALUES (
    'marketing_demo_intake_policy',
    'global',
    NULL::uuid,
    v_sv_id,
    v_value,
    now()
  )
  ON CONFLICT (category, scope_type, scope_id)
  DO UPDATE SET
    settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = now();
END;
$$;

COMMIT;
