-- 202605020700_w49_ui_presentation_policy.sql
-- Backend mirror for the W33 FE seed expansion: ui_presentation_policy
-- (apps/console-v2/src/lib/seed-raw/policies.js).
--
-- Closes the last residual P3 UX-library defaults the operator's strict
-- "no fallbacks" reading flagged: toast duration + tone-to-icon mapping,
-- expiry threshold ladder (warn/danger days), task snooze picker default,
-- and timeline-log bucket labels + ordering. Each consumer now reads
-- strictly from this canonical row; missing canonical row renders a
-- danger-toned `(missing)` indicator rather than a silent FE default.
--
-- AGENTS.md alignment:
--   §1 SIMPLE/SCALABLE — adding/changing a UX default is one row mutation.
--   §2 ZERO HARDCODING — every UX-presentation default the FE consumes
--      now reads from a canonical settings row.
--   §3 ROW-DRIVEN — values are rows, not literals.
--   §4 SSOT — three-way alignment: this file ↔ FE seed mirror ↔ modules.
--   §5 APPEND-ONLY — new file; W17 / W43 / W46 / W47 / W48 untouched.

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  safe_missing_behavior,
  allowed_scopes
)
VALUES
  ('ui_presentation_policy',
   'Canonical UX-presentation defaults (toast duration + icon-for-tone, expiry threshold ladder, task snooze picker default, timeline-log bucket labels + ordering). Consumed by Toast / ExpiryChip / TimelineLog / review-queue surfaces with strict consumption (no FE fallback).',
   FALSE, TRUE, 'skip', '["global"]'::jsonb)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  updated_at = now();

INSERT INTO public.settings_versions (
  category,
  scope_type,
  scope_id,
  version,
  value,
  schema_version,
  change_reason,
  approved_at,
  effective_from
)
SELECT
  'ui_presentation_policy',
  'global',
  NULL::uuid,
  1,
  '{
     "toast":{"duration_ms":3200,"icon_for_tone":{"good":"check","warn":"bell","danger":"warn","info":"bell"}},
     "expiry_thresholds":{"warn_days":30,"danger_days":7},
     "task_snooze":{"default_key":"1h"},
     "timeline_buckets":{"labels":{"today":"Today","yesterday":"Yesterday","this_week":"This week","earlier":"Earlier"},"order":["today","yesterday","this_week","earlier"]}
   }'::jsonb,
  1,
  'W49 canonical Console V2 UI presentation policy seed',
  now(),
  now()
WHERE NOT EXISTS (
  SELECT 1
  FROM public.settings_versions sv
  WHERE sv.category = 'ui_presentation_policy'
    AND sv.scope_type = 'global'
    AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    AND sv.effective_until IS NULL
    AND sv.approved_at IS NOT NULL
);

INSERT INTO public.settings (
  category,
  scope_type,
  scope_id,
  scope_hash,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  sv.category,
  sv.scope_type,
  sv.scope_id,
  sv.scope_hash,
  sv.id,
  sv.value,
  now()
FROM public.settings_versions sv
WHERE sv.category = 'ui_presentation_policy'
  AND sv.scope_type = 'global'
  AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND sv.effective_until IS NULL
  AND sv.approved_at IS NOT NULL
ORDER BY sv.version DESC, sv.created_at DESC
LIMIT 1
ON CONFLICT ON CONSTRAINT settings_scope_hash_unique
DO UPDATE SET
  settings_version_id = EXCLUDED.settings_version_id,
  cached_value = EXCLUDED.cached_value,
  last_updated = EXCLUDED.last_updated;
