-- Spec-Issue: W31 CATALOG gap closure (paired projection views)
-- Step: W31-VIEW-1
-- Migration: Canonical projection view public.v_service_offering_directory.
-- Capability: agreements.read (read-only; underlying RLS enforced via security_invoker)
--
-- Purpose:
--   Project per-offering derived joins + counters used by
--   `apps/console-v2/src/modules/catalog/service-offerings.tsx`
--   (ServiceOfferingsModule cards + drawer):
--     - level_key / level_name / level_is_active : derived from service_levels join
--     - tenant_label                              : derived from organizations.name
--                                                     via service_levels.organization_id
--     - branch_name                               : derived from branches.name join
--     - zone_label                                : derived from zones.name (when zone_id)
--     - display_name / display_slug               : derived projection
--                                                     (metadata.display.name/slug)
--     - effective_status                          : derived projection
--                                                     (metadata.display.status, fallback to
--                                                      is_active → 'active' / 'archived')
--     - base_price / currency                     : derived projection
--                                                     (metadata.base_price /
--                                                      metadata.currency)
--     - max_weight_kg                             : derived projection
--                                                     (metadata.max_weight_kg)
--     - active_subscription_count                 : derived COUNT(subscriptions WHERE
--                                                     status='active' AND
--                                                     metadata.service_offering_id=id)
--     - is_active_window                          : derived flag (now() within
--                                                     [effective_from, effective_to))
--     - is_archived / is_draft                    : derived flags from
--                                                     effective_status
--     - age_seconds / age_hours                   : derived from created_at vs now()
--     - last_updated_at                           : alias of updated_at
--                                                     (FE display vocabulary)
--
--   The FE `ServiceOfferingRow` interface at
--   apps/console-v2/src/modules/catalog/service-offerings.tsx remains a clean
--   1:1 mirror of the canonical `service_offerings` table; this view layers
--   the derived joins and computed counters on top so the FE can drop ad-hoc
--   in-component joins (subscriptions filter, branches/zones lookup) and
--   read them through the canonical projection seam.
--
-- Notes:
--   * SSOT remains public.service_offerings; this view is read-only.
--   * RLS enforced via `security_invoker = true` (caller's grants on
--     service_offerings + service_levels + branches + zones + organizations +
--     subscriptions are honoured).
--   * Service-role + authenticated SELECT.
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302900_v_service_offering_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_service_offering_directory;

CREATE VIEW public.v_service_offering_directory
  WITH (security_invoker = true)
  AS
SELECT
  so.id,
  so.service_level_id,
  so.branch_id,
  so.zone_id,
  so.effective_from,
  so.effective_to,
  so.priority,
  so.is_active,
  so.metadata,
  so.created_at,
  so.updated_at,
  -- Derived: service_levels join
  sl.organization_id,
  sl.key            AS level_key,
  sl.name           AS level_name,
  sl.is_active      AS level_is_active,
  -- Derived: tenant_label (organizations.name via service_levels.organization_id)
  org.name          AS tenant_label,
  -- Derived: branch_name (branches.name)
  br.name           AS branch_name,
  -- Derived: zone_label (zones.name; NULL when offering is branch-wide)
  zn.name           AS zone_label,
  -- Derived: display projection from canonical metadata jsonb
  so.metadata->'display'->>'name'        AS display_name,
  so.metadata->'display'->>'slug'        AS display_slug,
  -- Derived: effective_status with metadata.display.status precedence,
  -- falling back to is_active → 'active' / 'archived'.
  COALESCE(
    so.metadata->'display'->>'status',
    CASE WHEN so.is_active THEN 'active' ELSE 'archived' END
  ) AS effective_status,
  -- Derived: pricing facets (canonical metadata jsonb)
  CASE
    WHEN so.metadata ? 'base_price' AND jsonb_typeof(so.metadata->'base_price') = 'number'
      THEN (so.metadata->>'base_price')::numeric
    ELSE NULL
  END                                  AS base_price,
  so.metadata->>'currency'              AS currency,
  CASE
    WHEN so.metadata ? 'max_weight_kg' AND jsonb_typeof(so.metadata->'max_weight_kg') = 'number'
      THEN (so.metadata->>'max_weight_kg')::numeric
    ELSE NULL
  END                                  AS max_weight_kg,
  -- Derived: subscriptions counter (active subscriptions referencing this
  -- offering via canonical metadata.service_offering_id pointer; W17-1).
  COALESCE(sub_agg.active_subscription_count, 0) AS active_subscription_count,
  -- Derived: status flags
  (
    so.is_active
    AND now() >= so.effective_from
    AND (so.effective_to IS NULL OR now() < so.effective_to)
  )                                    AS is_active_window,
  (
    COALESCE(
      so.metadata->'display'->>'status',
      CASE WHEN so.is_active THEN 'active' ELSE 'archived' END
    ) = 'archived'
  )                                    AS is_archived,
  (
    COALESCE(
      so.metadata->'display'->>'status',
      CASE WHEN so.is_active THEN 'active' ELSE 'archived' END
    ) = 'draft'
  )                                    AS is_draft,
  -- Derived: temporal projections (age_seconds, age_hours, last_updated_at)
  GREATEST(0, EXTRACT(EPOCH FROM (now() - so.created_at))::bigint) AS age_seconds,
  GREATEST(0, EXTRACT(EPOCH FROM (now() - so.created_at))::bigint / 3600) AS age_hours,
  so.updated_at                                   AS last_updated_at
FROM public.service_offerings so
JOIN public.service_levels sl ON sl.id = so.service_level_id
LEFT JOIN public.organizations org ON org.id = sl.organization_id
LEFT JOIN public.branches br ON br.id = so.branch_id
LEFT JOIN public.zones zn ON zn.id = so.zone_id
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE s.status = 'active') AS active_subscription_count
    FROM public.subscriptions s
   WHERE s.metadata->>'service_offering_id' = so.id::text
) sub_agg ON TRUE;

COMMENT ON VIEW public.v_service_offering_directory IS
  'FE-friendly projection of service_offerings with derived joins (tenant_label via organizations, level_key/level_name/level_is_active via service_levels, branch_name via branches, zone_label via zones), derived display projection (display_name/display_slug/effective_status from metadata.display.* with is_active fallback), pricing facets (base_price/currency/max_weight_kg from canonical metadata jsonb), active_subscription_count (subscriptions filtered by metadata.service_offering_id pointer per W17-1), and status/temporal flags (is_active_window from effective_from/effective_to, is_archived/is_draft from effective_status, age_seconds/age_hours/last_updated_at). SSOT remains service_offerings; mutations go through service_offering_create_v1 / service_offering_update_v1 / service_offering_archive_v1 / service_offering_toggle_v1 (Phase B6 RPCs).';

REVOKE ALL ON public.v_service_offering_directory FROM PUBLIC;
REVOKE ALL ON public.v_service_offering_directory FROM anon;
GRANT SELECT ON public.v_service_offering_directory TO authenticated;
GRANT SELECT ON public.v_service_offering_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302900_v_service_offering_directory'));
COMMIT;
