-- 202605020500_w47_workflow_vehicle_integrations_lookup_seeds.sql
-- Backend mirror for the W28a FE seed expansion
-- (apps/console-v2/src/lib/seed-raw/lookups.js).
--
-- Adds 5 new canonical lookup categories and extends 2 existing ones with
-- previously-missing values, so every chip-toned status the FE renders has
-- its tone declared in `lookup_values.metadata.tone` — no FE inline
-- `Record<string, ...>` tone map ever masks a missing canonical row.
--
-- AGENTS.md alignment:
--   §2 ZERO HARDCODING — every tone the FE consumes for these enums
--      now reads from a canonical row.
--   §4 SSOT — three-way alignment: this file ↔ FE seed-raw/lookups.js ↔
--      console-v2 modules.
--   §5 APPEND-ONLY — new file; W17 / W24c (202605020100, 202605020400)
--      untouched.
--   §10 NO WORKAROUNDS — strict canonical row → visible gap on missing.

-- ---------------------------------------------------------------------------
-- 1. lookup_definitions — system-scope, append-only catalog
-- ---------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (
  category, description, owner_role, approval_policy, is_mutable,
  organization_id, scope_type
)
VALUES
  ('workflow_step_kind',
   'Workflow template step kind taxonomy (trigger/transform/guard/action/error/manual).',
   'engineering', 'tier_2', TRUE, NULL, 'global'),
  ('maintenance_window_status',
   'Vehicle maintenance window status (mirrors `public.vehicle_maintenance_windows.status` CHECK enum).',
   'operations', 'tier_2', TRUE, NULL, 'global'),
  ('vehicle_event_type',
   'Vehicle event type taxonomy (incident/maintenance/fuel/odometer).',
   'operations', 'tier_2', TRUE, NULL, 'global'),
  ('provider_auth_status',
   'Provider auth lifecycle status (active/pending/rotating/revoked/expired).',
   'engineering', 'tier_2', TRUE, NULL, 'global'),
  ('marketing_decision',
   'Marketing intake decision outcomes (mirrors marketing_demo_intake_policy decision tokens).',
   'operations', 'tier_2', TRUE, NULL, 'global'),
  ('mapping_type',
   'Mapping artifact type taxonomy (mirrors `public.mapping_configs.mapping_type` CHECK enum).',
   'engineering', 'tier_2', TRUE, NULL, 'global')
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
-- Pattern mirrors W17/W24c: CROSS JOIN against lookup_definitions, never
-- hardcode lookup_definition_id UUIDs.

-- workflow_step_kind
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('trigger',   'Trigger',   10, '{"tone":"info"}'),
  ('transform', 'Transform', 20, '{"tone":"neutral"}'),
  ('guard',     'Guard',     30, '{"tone":"warn"}'),
  ('action',    'Action',    40, '{"tone":"good"}'),
  ('error',     'Error',     50, '{"tone":"danger"}'),
  ('manual',    'Manual',    60, '{"tone":"warn"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'workflow_step_kind'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- maintenance_window_status
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('scheduled',   'Scheduled',   10, '{"tone":"neutral"}'),
  ('in_progress', 'In progress', 20, '{"tone":"warn"}'),
  ('completed',   'Completed',   30, '{"tone":"good"}'),
  ('cancelled',   'Cancelled',   40, '{"tone":"neutral"}'),
  ('planned',     'Planned',     50, '{"tone":"neutral"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'maintenance_window_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- vehicle_event_type
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('incident',    'Incident',    10, '{"tone":"danger"}'),
  ('maintenance', 'Maintenance', 20, '{"tone":"good"}'),
  ('fuel',        'Fuel',        30, '{"tone":"neutral"}'),
  ('odometer',    'Odometer',    40, '{"tone":"neutral"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'vehicle_event_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- provider_auth_status
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('active',   'Active',   10, '{"tone":"good"}'),
  ('pending',  'Pending',  20, '{"tone":"info"}'),
  ('rotating', 'Rotating', 30, '{"tone":"warn"}'),
  ('revoked',  'Revoked',  40, '{"tone":"danger"}'),
  ('expired',  'Expired',  50, '{"tone":"danger"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'provider_auth_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- marketing_decision
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('accepted',          'Accepted',          10, '{"tone":"good"}'),
  ('verified',          'Verified',          20, '{"tone":"good"}'),
  ('rate_limited',      'Rate limited',      30, '{"tone":"warn"}'),
  ('turnstile_failed',  'Turnstile failed',  40, '{"tone":"danger"}'),
  ('dedupe_dropped',    'Dedupe dropped',    50, '{"tone":"neutral"}'),
  ('rejected',          'Rejected',          60, '{"tone":"danger"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'marketing_decision'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- mapping_type
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('webhook_inbound',   'Webhook inbound',   10, '{"tone":"info"}'),
  ('webhook_outbound',  'Webhook outbound',  20, '{"tone":"info"}'),
  ('webhook_response',  'Webhook response',  30, '{"tone":"neutral"}'),
  ('provider_response', 'Provider response', 40, '{"tone":"neutral"}'),
  ('event_extraction',  'Event extraction',  50, '{"tone":"good"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'mapping_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---------------------------------------------------------------------------
-- 3. Extend existing categories — add missing values consumed by FE modules
-- ---------------------------------------------------------------------------

-- task_status: + snoozed, rejected (consumed by workflows/review-queue.tsx).
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('snoozed',  'Snoozed',  35, '{"tone":"neutral"}'),
  ('rejected', 'Rejected', 45, '{"tone":"danger"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'task_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- workflow_run_status: + skipped, timed_out (consumed by workflows/runs.tsx).
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('skipped',   'Skipped',   55, '{"tone":"neutral"}'),
  ('timed_out', 'Timed out', 65, '{"tone":"warn"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'workflow_run_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();
