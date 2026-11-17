-- Plan: PLAN-202602-landing-contact-sales-intake / Step: S04
-- Migration: marketing_demo_intake_policy security hardening v1 (public landing intake)
-- Date: 2026-02-15
--
-- Goals:
--   - Treat the landing contact form as a hostile public surface.
--   - Increase rate limiting window + tighten max_requests.
--   - Extend dedupe window to reduce duplicate follow-up tasks.
--   - Keep Turnstile required (fail closed).
--   - Preserve all existing policy keys (including task routing config).

BEGIN;
SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_current JSONB;
  v_patched JSONB;
  v_turnstile_required BOOLEAN;
  v_rate_window INT;
  v_max_requests INT;
  v_dedupe_seconds INT;
BEGIN
  v_current := public.resolve_settings_merged('marketing_demo_intake_policy', 'global', NULL::uuid);
  v_current := COALESCE(v_current, '{}'::jsonb);

  BEGIN v_turnstile_required := COALESCE(NULLIF(v_current#>>'{turnstile,required}', '')::boolean, TRUE); EXCEPTION WHEN others THEN v_turnstile_required := TRUE; END;
  BEGIN v_rate_window := COALESCE(NULLIF(v_current#>>'{rate_limit,window_seconds}', '')::int, 0); EXCEPTION WHEN others THEN v_rate_window := 0; END;
  BEGIN v_max_requests := COALESCE(NULLIF(v_current#>>'{rate_limit,max_requests}', '')::int, 0); EXCEPTION WHEN others THEN v_max_requests := 0; END;
  BEGIN v_dedupe_seconds := COALESCE(NULLIF(v_current#>>'{dedupe,window_seconds}', '')::int, 0); EXCEPTION WHEN others THEN v_dedupe_seconds := 0; END;

  IF v_turnstile_required IS TRUE
     AND v_rate_window = 600
     AND v_max_requests = 5
     AND v_dedupe_seconds = 21600 THEN
    RAISE NOTICE 'marketing_demo_intake_policy already hardened; skipping upsert.';
    RETURN;
  END IF;

  v_patched := v_current;
  v_patched := jsonb_set(v_patched, '{turnstile,required}', 'true'::jsonb, TRUE);
  v_patched := jsonb_set(v_patched, '{rate_limit,window_seconds}', to_jsonb(600), TRUE);
  v_patched := jsonb_set(v_patched, '{rate_limit,max_requests}', to_jsonb(5), TRUE);
  v_patched := jsonb_set(v_patched, '{dedupe,window_seconds}', to_jsonb(21600), TRUE);

  PERFORM public.upsert_settings_value_v1(
    'marketing_demo_intake_policy',
    'global',
    NULL::uuid,
    v_patched,
    1,
    'hardening public landing intake (strict rate limit + dedupe)'
  );
END;
$$;

COMMIT;

