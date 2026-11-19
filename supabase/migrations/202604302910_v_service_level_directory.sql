-- Spec-Issue: W31 CATALOG gap closure (paired projection views)
-- Step: W31-VIEW-2
-- Migration: Canonical projection view public.v_service_level_directory.
-- Capability: agreements.read (read-only; underlying RLS enforced via security_invoker)
--
-- Purpose:
--   Project per-level derived joins + counters used by
--   `apps/console-v2/src/modules/catalog/service-offerings.tsx`
--   (Manage tiers admin sub-section + drawer SLA tab + level chip rendering):
--     - tenant_label                : derived from organizations.name
--     - tier                        : derived projection (metadata.tier)
--     - priority_rank               : derived projection (metadata.priority_rank)
--     - sla_minutes / sla_label     : derived projection (metadata.sla_minutes /
--                                      metadata.sla_label)
--     - color_token                 : derived projection (metadata.color_token)
--     - offering_count              : derived COUNT(service_offerings WHERE
--                                      service_level_id = sl.id)
--     - active_offering_count       : derived COUNT(service_offerings WHERE
--                                      service_level_id = sl.id AND is_active)
--     - active_subscription_count   : derived COUNT(subscriptions WHERE
--                                      plan_key = sl.key AND status = 'active')
--                                      (canonical join: subscriptions.plan_key
--                                       === service_levels.key per W17-1)
--     - age_seconds / age_hours     : derived from created_at vs now()
--     - last_updated_at             : alias of updated_at
--
--   The FE `ServiceLevelRow` interface remains a clean 1:1 mirror of canonical
--   service_levels (per __audit__/SCHEMA-DRIFT/CATALOG.md §3 — ZERO drift).
--   This view layers tenant + tier + counter derivations on top so the FE can
--   drop ad-hoc in-component metadata extraction and render through a
--   canonical projection seam.
--
-- Notes:
--   * SSOT remains public.service_levels; this view is read-only.
--   * RLS enforced via `security_invoker = true`.
--   * Service-role + authenticated SELECT.
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302910_v_service_level_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_service_level_directory;

CREATE VIEW public.v_service_level_directory
  WITH (security_invoker = true)
  AS
SELECT
  sl.id,
  sl.organization_id,
  sl.key,
  sl.name,
  sl.description,
  sl.is_active,
  sl.metadata,
  sl.created_at,
  sl.updated_at,
  -- Derived: tenant_label (organizations.name)
  org.name                              AS tenant_label,
  -- Derived: tier projection from canonical metadata jsonb
  sl.metadata->>'tier'                  AS tier,
  CASE
    WHEN sl.metadata ? 'priority_rank' AND jsonb_typeof(sl.metadata->'priority_rank') = 'number'
      THEN (sl.metadata->>'priority_rank')::int
    ELSE NULL
  END                                   AS priority_rank,
  CASE
    WHEN sl.metadata ? 'sla_minutes' AND jsonb_typeof(sl.metadata->'sla_minutes') = 'number'
      THEN (sl.metadata->>'sla_minutes')::int
    ELSE NULL
  END                                   AS sla_minutes,
  sl.metadata->>'sla_label'             AS sla_label,
  sl.metadata->>'color_token'           AS color_token,
  -- Derived: offerings counters
  COALESCE(off_agg.offering_count, 0)         AS offering_count,
  COALESCE(off_agg.active_offering_count, 0)  AS active_offering_count,
  -- Derived: subscriptions counter (canonical plan_key join per W17-1)
  COALESCE(sub_agg.active_subscription_count, 0) AS active_subscription_count,
  -- Derived: temporal projections
  GREATEST(0, EXTRACT(EPOCH FROM (now() - sl.created_at))::bigint) AS age_seconds,
  GREATEST(0, EXTRACT(EPOCH FROM (now() - sl.created_at))::bigint / 3600) AS age_hours,
  sl.updated_at                              AS last_updated_at
FROM public.service_levels sl
LEFT JOIN public.organizations org ON org.id = sl.organization_id
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) AS offering_count,
    COUNT(*) FILTER (WHERE so.is_active) AS active_offering_count
    FROM public.service_offerings so
   WHERE so.service_level_id = sl.id
) off_agg ON TRUE
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE s.status = 'active') AS active_subscription_count
    FROM public.subscriptions s
   WHERE s.plan_key = sl.key
     AND s.organization_id = sl.organization_id
) sub_agg ON TRUE;

COMMENT ON VIEW public.v_service_level_directory IS
  'FE-friendly projection of service_levels with derived joins (tenant_label via organizations), derived metadata projections (tier/priority_rank/sla_minutes/sla_label/color_token from canonical metadata jsonb), offering counters (offering_count + active_offering_count via service_offerings), active_subscription_count (subscriptions joined on plan_key + organization_id per W17-1), and temporal projections (age_seconds/age_hours/last_updated_at). SSOT remains service_levels; mutations go through service_level_create_v1 / service_level_update_v1 (Phase B6 RPCs).';

REVOKE ALL ON public.v_service_level_directory FROM PUBLIC;
REVOKE ALL ON public.v_service_level_directory FROM anon;
GRANT SELECT ON public.v_service_level_directory TO authenticated;
GRANT SELECT ON public.v_service_level_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302910_v_service_level_directory'));
COMMIT;
