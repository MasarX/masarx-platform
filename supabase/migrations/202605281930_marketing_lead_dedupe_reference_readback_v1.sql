-- Migration: marketing lead dedupe reference readback v1
-- Goal:
--   - Duplicate public marketing lead intake must return the existing lead id.
--   - Landing can only show a backend-backed success/readback state when a real reference is present.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605281930_marketing_lead_dedupe_reference_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  v_existing_id UUID := NULL;
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
    SELECT r.id
      INTO v_existing_id
      FROM public.marketing_demo_requests r
     WHERE r.email = v_email
       AND r.created_at >= (v_now - (v_dedupe_seconds || ' seconds')::interval)
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', TRUE, 'id', v_existing_id, 'deduped', TRUE);
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
  IS 'Public marketing lead intake RPC (policy-driven via settings): validates, rate limits, stores request, and returns {ok,id}; duplicate success returns the existing id with deduped=true.';

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

SELECT pg_advisory_unlock(hashtext('202605281930_marketing_lead_dedupe_reference_readback_v1'));
COMMIT;
