-- Migration: resolve_fieldops_{eor,tasks}_v1 audit fixup
-- Date: 2026-05-12
-- Spec: Closes two audit findings flagged by independent reviewers:
--   - P0 (zero-hardcoding sweep): `resolve_fieldops_eor_v1` baked
--     `'Asia/Riyadh'` into the today-boundary cast. Tenants outside
--     the Riyadh timezone would see EOR summaries with a shifted day
--     boundary (e.g. their 23:30 work shows under tomorrow's date).
--     Now resolves the tenant timezone via settings ladder:
--     localization_policy.timezone → defaults to 'Asia/Riyadh' only when
--     no policy row exists (preserves current behavior for KSA tenants).
--   - P1 (backend contract audit): `resolve_fieldops_tasks_v1` supervisor
--     branch hardcodes `priority := 75` and `tone := 'warning'` for
--     every route_review row. Now derives both from
--     `route_runs.metadata->>'priority_score'` and
--     `fieldops_v2_resolve_tone(...)` matching the driver/loader paths,
--     so a supervisor sees the same priority/tone calibration their
--     drivers see.
--
-- Both functions remain SECURITY DEFINER + STABLE; only the body
-- changes. api.* wrappers are untouched because they just proxy.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605120200_resolve_fieldops_eor_tasks_audit_fixup'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ===========================================================================
-- 1) resolve_fieldops_eor_v1 — TZ from settings instead of hardcoded.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_fieldops_eor_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_delivered INT := 0;
  v_failed INT := 0;
  v_total INT := 0;
  v_tz TEXT := 'Asia/Riyadh'; -- safe default when no policy row
  v_loc JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_eor_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RETURN jsonb_build_object(
      'summary', jsonb_build_object('delivered', 0, 'failed', 0, 'total', 0),
      'checklist', '[]'::jsonb,
      'performance_note', NULL
    );
  END IF;

  -- Resolve tenant timezone via settings ladder. If localization_policy
  -- isn't registered yet or no row exists, fall back to Asia/Riyadh.
  BEGIN
    SELECT public.resolve_settings(
      'localization_policy',
      jsonb_build_object('organization_id', v_org, 'user_id', v_user_id)
    )
    INTO v_loc;
    IF v_loc IS NOT NULL AND (v_loc ? 'timezone') THEN
      v_tz := COALESCE(NULLIF(v_loc->>'timezone', ''), v_tz);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- swallow; keep default
    NULL;
  END;

  -- Compute today's summary from route_stops on the caller's runs.
  SELECT
    COALESCE(SUM(CASE WHEN COALESCE(rs.metadata->>'status', '') = 'done' THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN COALESCE(rs.metadata->>'status', '') = 'failed' THEN 1 ELSE 0 END), 0),
    COUNT(*)
  INTO v_delivered, v_failed, v_total
  FROM public.route_stops rs
  JOIN public.route_runs rr
    ON rr.id = rs.route_run_id
   AND rr.organization_id = rs.organization_id
  WHERE rr.organization_id = v_org
    AND rr.driver_user_id = v_user_id
    AND rr.created_at::date = (now() AT TIME ZONE v_tz)::date;

  RETURN jsonb_build_object(
    'summary', jsonb_build_object(
      'delivered', v_delivered,
      'failed', v_failed,
      'total', v_total
    ),
    'checklist', jsonb_build_array(
      jsonb_build_object('id','parcels','icon','package','label','Returned undelivered parcels','sub', (v_failed + GREATEST(v_total - v_delivered - v_failed, 0))::text || ' parcels in vehicle'),
      jsonb_build_object('id','cash','icon','cash','label','Hand over COD cash','sub','See cash drop'),
      jsonb_build_object('id','devices','icon','shield','label','Plug in handheld + scanner','sub','Battery report uploaded'),
      jsonb_build_object('id','sync','icon','cloud-up','label','Final sync','sub','Outbox check')
    ),
    'performance_note', NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_eor_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_eor_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_eor_v1(TEXT, JSONB) IS
  'Mobile V2 end-of-route hand-back envelope (audit-hardened). Resolves tenant timezone via localization_policy ladder before computing today-boundary; falls back to Asia/Riyadh when no policy is registered.';

-- ===========================================================================
-- 2) resolve_fieldops_tasks_v1 supervisor branch — derive priority + tone.
-- ===========================================================================
--
-- The original migration uses the form `RETURNS TABLE (...) ... UNION ALL ...`.
-- We need to keep that contract intact. Since the function is large, the
-- safest path is to copy-on-write the supervisor SELECT block. We replace
-- only the function body via CREATE OR REPLACE FUNCTION with the
-- audit-fixed supervisor block.
--
-- Source: 202605102200_resolve_fieldops_tasks_v1.sql lines 280-304.

DO $do$
DECLARE
  v_existing_sig TEXT;
BEGIN
  -- Sanity: skip if the priority hardcode is already gone (avoid double
  -- replacement when the migration is reapplied).
  SELECT pg_get_functiondef(p.oid)
  INTO v_existing_sig
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'resolve_fieldops_tasks_v1';

  IF v_existing_sig IS NULL THEN
    RAISE NOTICE 'resolve_fieldops_tasks_v1 not found — skipping supervisor fixup';
    RETURN;
  END IF;

  -- Replace the hardcoded `75 AS priority` with the derived expression
  -- and `'warning' AS tone` with the resolver call. Only the supervisor
  -- branch contains exactly these literals in this surrounding text.
  v_existing_sig := replace(
    v_existing_sig,
    E'      75                                                         AS priority,',
    E'      public.fieldops_v2_priority_int(\n        CASE\n          WHEN rr.metadata ? ''priority_score''\n          THEN (rr.metadata->>''priority_score'')::numeric::int\n          ELSE 50\n        END\n      )                                                          AS priority,'
  );
  v_existing_sig := replace(
    v_existing_sig,
    E'      ''warning''                                                  AS tone,',
    E'      public.fieldops_v2_resolve_tone(\n        public.fieldops_v2_classify_urgency(rr.planned_start_at, v_now),\n        public.fieldops_v2_priority_int(\n          CASE\n            WHEN rr.metadata ? ''priority_score''\n            THEN (rr.metadata->>''priority_score'')::numeric::int\n            ELSE 50\n          END\n        ),\n        rr.planned_start_at,\n        v_now\n      )                                                          AS tone,'
  );

  -- Apply the rewritten definition only if our marker text was found.
  IF position(E'public.fieldops_v2_resolve_tone(' IN v_existing_sig) > 0
     AND position(E'                                                         AS priority,' IN v_existing_sig) = 0
  THEN
    EXECUTE v_existing_sig;
    RAISE NOTICE 'resolve_fieldops_tasks_v1 supervisor branch — priority + tone now derived from data';
  ELSE
    RAISE NOTICE 'resolve_fieldops_tasks_v1 already fixed up or markers missing — no rewrite applied';
  END IF;
END
$do$;

SELECT pg_advisory_unlock(hashtext('202605120200_resolve_fieldops_eor_tasks_audit_fixup'));
COMMIT;
