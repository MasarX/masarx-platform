-- Plan: Wave 6 / W6-6 schema-drift remediation (PLATFORM §4)
-- Spec-Issue: console-v2 SCHEMA-DRIFT/PLATFORM.md
--
-- Purpose:
--   Expose a canonical FE-friendly projection over `public.feature_flags` that
--   matches the FE `FeatureFlag` row shape used in
--   apps/console-v2/src/modules/platform/feature-flags.tsx:78. The FE expects
--   `key/label/status/targeting/kill_switch/owners/last_updated_at` while the
--   backend stores `name/enabled/conditions/rollout_percentage/updated_at`.
--
--   This view is additive and read-only. It does not change the canonical
--   table; SSOT remains `public.feature_flags`. Mutations continue to go
--   through `toggle_feature_flag_v1` and `bulk_toggle_feature_flags_v1`
--   (existing RPCs as of 202604280090 / 202604280130).
--
-- Field projection contract:
--   key                      = feature_flags.name
--   label                    = humanized feature_flags.name (initcap, _ → space)
--   description              = feature_flags.description
--   status                   = derived ('on' | 'off' | 'percentage')
--                              ('on' when enabled AND rollout_percentage = 100,
--                               'off' when NOT enabled,
--                               'percentage' when enabled AND rollout < 100)
--   rollout_percentage       = feature_flags.rollout_percentage
--   targeting                = jsonb_build_object(
--                                'summary', '<n scopes>',
--                                'scopes', conditions->'scopes' (or [])
--                              )
--   scope_type               = feature_flags.scope_type
--   scope_id                 = feature_flags.scope_id
--   kill_switch              = NOT enabled (canonical: enabled=false IS the kill)
--   owners                   = conditions->'owners' (or [])
--   last_updated_at          = feature_flags.updated_at
--   last_updated_by_user_id  = conditions->>'last_updated_by_user_id' (NULL until audit-resolution lands)
--
-- Cross-references:
--   - SSOT inventory: apps/console-v2/__audit__/SCHEMA-DRIFT/PLATFORM.md §4
--   - FE shape: apps/console-v2/src/modules/platform/feature-flags.tsx:78
--   - Canonical table: 202512301155_feature_flags_ensure_exists.sql

BEGIN;
SET search_path TO public, extensions, pg_temp;

DROP VIEW IF EXISTS public.v_feature_flag_summary;

CREATE VIEW public.v_feature_flag_summary AS
SELECT
  ff.id,
  ff.name AS key,
  -- Humanize underscore-delimited keys for FE display
  initcap(replace(ff.name, '_', ' ')) AS label,
  ff.description,
  CASE
    WHEN NOT ff.enabled THEN 'off'
    WHEN ff.enabled AND ff.rollout_percentage >= 100 THEN 'on'
    ELSE 'percentage'
  END AS status,
  ff.rollout_percentage,
  jsonb_build_object(
    'summary',
    CASE
      WHEN ff.conditions ? 'scopes'
        AND jsonb_typeof(ff.conditions->'scopes') = 'array'
      THEN
        (jsonb_array_length(ff.conditions->'scopes'))::text || ' scopes'
      ELSE 'no overrides'
    END,
    'scopes',
    COALESCE(ff.conditions->'scopes', '[]'::jsonb)
  ) AS targeting,
  ff.scope_type,
  ff.scope_id,
  -- kill_switch is the inverse of `enabled` per FE contract; canonical
  -- semantics: setting `enabled=false` IS the operational kill action.
  (NOT ff.enabled) AS kill_switch,
  COALESCE(ff.conditions->'owners', '[]'::jsonb) AS owners,
  ff.updated_at AS last_updated_at,
  -- Last-updated user is not on `feature_flags` (would require audit_table_changes
  -- join); G1 may resolve via that path. Surface from `conditions` as a stop-gap.
  (ff.conditions->>'last_updated_by_user_id') AS last_updated_by_user_id,
  ff.created_at,
  ff.updated_at
FROM public.feature_flags ff;

COMMENT ON VIEW public.v_feature_flag_summary IS
  'FE-friendly projection of feature_flags (Wave 6 / W6-6 PLATFORM drift remediation).
   Maps canonical name/enabled/rollout_percentage/conditions onto FE-shaped
   key/label/status/targeting/kill_switch/owners. SSOT remains public.feature_flags;
   mutations go through toggle_feature_flag_v1 and bulk_toggle_feature_flags_v1.';

-- Read access mirrors the underlying table: service_role only by default.
-- FE access is via the `useResourceList` registry seam which uses service-role
-- impersonation in dev seed mode and JWT-scoped reads in production.
REVOKE ALL ON public.v_feature_flag_summary FROM PUBLIC;
REVOKE ALL ON public.v_feature_flag_summary FROM anon;
REVOKE ALL ON public.v_feature_flag_summary FROM authenticated;
GRANT SELECT ON public.v_feature_flag_summary TO service_role;

COMMIT;
