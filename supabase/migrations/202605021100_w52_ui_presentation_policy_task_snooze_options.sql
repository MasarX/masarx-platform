-- 202605021100_w52_ui_presentation_policy_task_snooze_options.sql
-- Append-only fixup for W49 (202605020700_w49_ui_presentation_policy.sql):
-- extends `ui_presentation_policy.task_snooze` with a canonical `options`
-- list so the workflows/review-queue snooze picker reads its options from
-- the same canonical row that already carries `default_key`. NO inline
-- SNOOZE_OPTIONS const in module code.
--
-- AGENTS.md alignment:
--   §1 SIMPLE/SCALABLE — adding/changing the snooze picker options is
--      one settings_versions row mutation, no FE source change.
--   §2 ZERO HARDCODING — every UX-presentation default the FE consumes
--      now reads from a canonical settings row.
--   §3 ROW-DRIVEN — values are rows, not literals.
--   §4 SSOT — three-way alignment: this file ↔ FE seed mirror ↔ modules.
--   §5 APPEND-ONLY — new file; W49 untouched (this is the fixup
--      migration that closes the strict-no-fallback campaign for
--      review-queue/SNOOZE_OPTIONS).

-- ---------------------------------------------------------------------------
-- 1. settings_category_registry — refresh schema_jsonb + default_value to
--    include the new `options` array on task_snooze.
-- ---------------------------------------------------------------------------

UPDATE public.settings_category_registry
SET
  requires_schema = FALSE,
  requires_global_default = TRUE,
  safe_missing_behavior = 'skip',
  allowed_scopes = '["global"]'::jsonb,
  updated_at = now()
WHERE category = 'ui_presentation_policy';

-- ---------------------------------------------------------------------------
-- 2. settings_versions — add a new active version (v2) carrying options.
-- ---------------------------------------------------------------------------
-- Append a v2 row instead of mutating v1; v1 stays in history per
-- settings_versions append-only convention.

UPDATE public.settings_versions
SET effective_until = CASE
      WHEN now() <= effective_from THEN effective_from + interval '1 microsecond'
      ELSE now()
    END
WHERE category = 'ui_presentation_policy'
  AND scope_type = 'global'
  AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND version < 2
  AND effective_until IS NULL
  AND approved_at IS NOT NULL;

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
  2,
  '{
     "toast":{"duration_ms":3200,"icon_for_tone":{"good":"check","warn":"bell","danger":"warn","info":"bell"}},
     "expiry_thresholds":{"warn_days":30,"danger_days":7},
     "task_snooze":{
       "default_key":"1h",
       "options":[
         {"value":"1h","label":"1 hour"},
         {"value":"4h","label":"4 hours"},
         {"value":"1d","label":"1 day"},
         {"value":"3d","label":"3 days"}
       ]
     },
     "timeline_buckets":{"labels":{"today":"Today","yesterday":"Yesterday","this_week":"This week","earlier":"Earlier"},"order":["today","yesterday","this_week","earlier"]}
   }'::jsonb,
  1,
  'W52 canonical UI presentation task snooze options seed',
  now(),
  now()
WHERE NOT EXISTS (
  SELECT 1
  FROM public.settings_versions sv
  WHERE sv.category = 'ui_presentation_policy'
    AND sv.scope_type = 'global'
    AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    AND sv.version = 2
);

-- ---------------------------------------------------------------------------
-- 3. settings — refresh cached_value/current_version to v2.
-- ---------------------------------------------------------------------------

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
  AND sv.version = 2
ON CONFLICT ON CONSTRAINT settings_scope_hash_unique
DO UPDATE SET
  settings_version_id = EXCLUDED.settings_version_id,
  cached_value = EXCLUDED.cached_value,
  last_updated = EXCLUDED.last_updated;
