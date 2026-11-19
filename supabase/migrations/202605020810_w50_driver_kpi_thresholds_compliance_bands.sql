-- 202605020800_w50_driver_kpi_thresholds_compliance_bands.sql
-- Backend mirror for the W50 console-v2 closure
-- (apps/console-v2/src/lib/seed-raw/policies.js sv_320 +
-- apps/console-v2/src/modules/operate/fleet/drivers.tsx complianceTone).
--
-- Closes the inline magic-number ladder (90/75/60) in the operator console
-- driver compliance chip by adding a canonical sub-object
-- `compliance_score_bands` to the canonical `driver_kpi_thresholds` policy.
--
-- AGENTS.md alignment:
--   §1 SIMPLE/SCALABLE — adjusting the band thresholds is one settings_versions
--      mutation, no FE source change.
--   §2 ZERO HARDCODING — removes the last inline driver-score tone literal.
--   §3 ROW-DRIVEN — values are rows, not literals.
--   §4 SSOT — three-way alignment: this file ↔ FE seed mirror ↔ module.
--   §5 APPEND-ONLY — additive jsonb merge; W17 / W43 / W48 untouched.

-- ---------------------------------------------------------------------------
-- 1. settings_versions — additive merge of compliance_score_bands sub-object
-- ---------------------------------------------------------------------------
-- Use jsonb_set so prior keys (docs_expiring_*, score_oos_threshold,
-- on_time_pct_*, rating_*, application_pending_*) survive the upgrade. The
-- `true` create-if-missing flag means we still seed bands when the parent
-- key is absent (defensive against partial seeds).

UPDATE public.settings_versions
SET
  value = jsonb_set(
    value,
    '{compliance_score_bands}',
    '{"good_min":90,"warn_min":75,"danger_max":60}'::jsonb,
    TRUE
  )
WHERE category = 'driver_kpi_thresholds'
  AND scope_type = 'global'
  AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND effective_until IS NULL
  AND approved_at IS NOT NULL
  AND (value -> 'compliance_score_bands') IS NULL;

-- ---------------------------------------------------------------------------
-- 2. settings — refresh the cached resolved row from the updated version
-- ---------------------------------------------------------------------------
-- Mirror of W48 pattern: the settings cache holds the resolved value for
-- (category, scope_type, scope_id). We re-pull from settings_versions so
-- the resolver returns the newly merged sub-object on the next call.

UPDATE public.settings AS s
SET
  cached_value = sv.value,
  settings_version_id = sv.id,
  last_updated = now()
FROM public.settings_versions AS sv
WHERE s.category = 'driver_kpi_thresholds'
  AND s.scope_type = 'global'
  AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND sv.category = s.category
  AND sv.scope_type = s.scope_type
  AND sv.scope_hash = s.scope_hash
  AND sv.effective_until IS NULL
  AND sv.approved_at IS NOT NULL;
