-- 202605020800_w50_console_v2_status_filter_lookup_seeds.sql
-- Backend mirror for the W50 FE no-fallback closure
-- (apps/console-v2/src/lib/seed-raw/lookups.js).
--
-- Closes the last 4 hardcoded inline status-filter chip arrays in the
-- console-v2 platform + insights modules by promoting them to canonical
-- lookup categories with `metadata.tone`. After this migration the FE
-- modules resolve filter chips through `getLookups(category)` and the
-- chip toolbar renders a `<StateView kind="error"/>` instead of a
-- degraded chip set when a canonical row is missing.
--
-- Categories added (3 new + 1 metadata extension):
--   * mobile_attestation_status   (NEW) — platform/mobile-policy.tsx
--   * label_render_job_status     (NEW) — platform/labels.tsx
--   * kpi_group                   (NEW) — insights/reporting.tsx
--   * tenant_signup_request_status (extend) — platform/organizations.tsx
--     adds metadata.tone to the existing W17 rows
--     (supabase/migrations/202602211145_tenant_signup_lookup_contracts_status_decision_v1.sql)
--
-- AGENTS.md alignment:
--   §2 ZERO HARDCODING — every tone the FE consumes for these enums
--      now reads from a canonical row.
--   §4 SSOT — three-way alignment: this file ↔ FE seed-raw/lookups.js ↔
--      console-v2 modules.
--   §5 APPEND-ONLY — new file; W17 / W24c / W47 / W48 untouched.
--   §10 NO WORKAROUNDS — strict canonical row → visible gap on missing.

-- ---------------------------------------------------------------------------
-- 1. lookup_definitions — system-scope, append-only catalog
-- ---------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (
  category, description, owner_role, approval_policy, is_mutable,
  organization_id, scope_type
)
VALUES
  ('mobile_attestation_status',
   'Mobile device attestation lifecycle (mirrors public.user_devices.metadata->''attestation''->>''status''; projected by v_user_device_summary.attestation_status). Values: trusted/pending/failed/revoked.',
   'engineering', 'tier_1', FALSE, NULL, 'global'),
  ('label_render_job_status',
   'Label render job pipeline state consumed by platform/labels.tsx print-queue chips. Values: queued/rendering/completed/failed. Distinct from canonical label_job_status (pending/in_progress/succeeded/failed) which mirrors the public.label_jobs CHECK enum.',
   'engineering', 'tier_1', FALSE, NULL, 'global'),
  ('kpi_group',
   'KPI grouping taxonomy mirroring kpi_definitions.definition.group (operations/marketplace/integrations/workflows). Consumed by insights/reporting.tsx for section eyebrow labels.',
   'product', 'tier_1', FALSE, NULL, 'global')
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  is_mutable = EXCLUDED.is_mutable,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 2. lookup_values — one upsert per category
-- ---------------------------------------------------------------------------
-- Pattern mirrors W17/W24c/W47: CROSS JOIN against lookup_definitions, never
-- hardcode lookup_definition_id UUIDs.

-- mobile_attestation_status
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('trusted', 'Trusted', 10, '{"tone":"good"}'),
  ('pending', 'Pending', 20, '{"tone":"info"}'),
  ('failed',  'Failed',  30, '{"tone":"danger"}'),
  ('revoked', 'Revoked', 40, '{"tone":"neutral"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'mobile_attestation_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- label_render_job_status
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('queued',    'Queued',    10, '{"tone":"info"}'),
  ('rendering', 'Rendering', 20, '{"tone":"warn"}'),
  ('completed', 'Completed', 30, '{"tone":"good"}'),
  ('failed',    'Failed',    40, '{"tone":"danger"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'label_render_job_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- kpi_group
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('operations',   'Operations',   10, '{"tone":"info"}'),
  ('marketplace',  'Marketplace',  20, '{"tone":"good"}'),
  ('integrations', 'Integrations', 30, '{"tone":"neutral"}'),
  ('workflows',    'Workflows',    40, '{"tone":"warn"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'kpi_group'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---------------------------------------------------------------------------
-- 3. tenant_signup_request_status — extend existing rows with metadata.tone
-- ---------------------------------------------------------------------------
-- The W17 migration (202602211145_tenant_signup_lookup_contracts_status_decision_v1.sql)
-- registered the category with default metadata. W50 promotes the chip tones
-- onto the canonical rows so platform/organizations.tsx no longer needs an
-- inline tone palette for the signup-queue filter chips.

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('pending',  'Pending',  10, '{"tone":"warn"}'),
  ('approved', 'Approved', 20, '{"tone":"good"}'),
  ('rejected', 'Rejected', 30, '{"tone":"danger"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'tenant_signup_request_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata,
    updated_at = now();
