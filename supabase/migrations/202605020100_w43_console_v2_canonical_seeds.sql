-- Spec-Issue: W43 console-v2 100% production-readiness — backend canonical seed
-- Step: W43-CANONICAL-SEEDS
-- Migration: Seed FE-resolved policy + lookup categories so the console-v2
--   frontend's `useResolveSettings(<category>)` and lookup chip resolvers
--   never have to fall back to inline TS constants.
--
-- Problem (zero-hardcoding objective):
--   Console-v2 currently carries fallback constants for several policy
--   categories (billing_policy, cod_policy, bank_recon_policy,
--   settlement_policy, dispute_resolution_policy, planning_os_config) and
--   for several FE-only lookup chip categories (workflow_binding_event,
--   settlement_scope_type, approval_policy, owner_role,
--   support_case_status, support_case_priority,
--   support_case_event_type, support_message_channel). These fallbacks
--   exist because the canonical settings_category_registry +
--   schema_registry + settings_versions + settings rows (and the
--   matching lookup_definitions + lookup_values rows) are not yet
--   seeded for those categories. The frontend's resolver hook then
--   returns null and the module hardcodes the value.
--
-- FE consumers (SSOT trace for future audits):
--   - billing_policy:               apps/console-v2/src/modules/finance/billing.tsx
--                                   (DEFAULT_INVOICE_AGING_SLA_HOURS = 24*14)
--   - cod_policy:                   apps/console-v2/src/modules/finance/cod.tsx
--                                   (DEFAULT_COD_HANDOVER_SLA_HOURS = 48,
--                                    DEFAULT_COD_VARIANCE_TOLERANCE_SAR = 0)
--   - bank_recon_policy:            apps/console-v2/src/modules/finance/bank-recon.tsx
--                                   (DEFAULT_BANK_RECON_POLICY_FALLBACK)
--   - settlement_policy:            apps/console-v2/src/modules/finance/settlements.tsx
--                                   (DEFAULT_LOCK_APPROVAL_SLA_HOURS = 24,
--                                    DEFAULT_VARIANCE_THRESHOLD_SAR = 0)
--   - dispute_resolution_policy:    apps/console-v2/src/modules/finance/disputes.tsx
--                                   (DEFAULT_DISPUTE_SLA_HOURS = 72)
--   - planning_os_config:           apps/console-v2/src/modules/platform/planning-os.tsx
--                                   (STAGES_FALLBACK, GH_REPO_FALLBACK,
--                                    GH_PROJECT_URL_FALLBACK)
--   - workflow_binding_event:       apps/console-v2/src/lib/seed-raw/decisions.js
--                                   (event_type values: shipment.created,
--                                    shipment.amended, route_run.assigned, ...)
--   - settlement_scope_type:        apps/console-v2/src/lib/seed-raw/lookups.js
--                                   (driver_shift, branch_day, client_cycle,
--                                    accounting_period)
--   - approval_policy:              apps/console-v2/src/lib/seed-raw/lookups.js
--                                   (tier_1, tier_2, tier_3 — used in lookup
--                                    governance metadata seed)
--   - owner_role:                   apps/console-v2/src/lib/seed-raw/lookups.js
--                                   (operations, engineering, finance, product)
--   - support_case_status:          apps/console-v2/src/modules/support/cases.tsx
--                                   + apps/console-v2/src/lib/seed-raw/support.js
--   - support_case_priority:        apps/console-v2/src/lib/seed-raw/support.js
--   - support_case_event_type:      apps/console-v2/src/lib/seed-raw/support.js
--   - support_message_channel:      apps/console-v2/src/lib/seed-raw/support.js
--                                   (W19-2 added 'api' channel)
--
-- Strategy:
--   * Seed everything via UPSERT (ON CONFLICT DO UPDATE / DO NOTHING) so
--     the migration is idempotent and re-runnable.
--   * For settings categories, follow the canonical pattern from
--     supabase/migrations/202601212830_finance_events_ledger_foundation.sql
--     and supabase/migrations/202601221120_bank_accounts_and_bank_reconciliation_policy_v1.sql:
--         settings_category_registry  ->  schema_registry (active=TRUE)
--                                      ->  settings_versions (global, approved)
--                                      ->  settings (cached_value at global)
--     `requires_schema=TRUE`, `requires_global_default=TRUE`,
--     `safe_missing_behavior='skip'` matches the in-tree contract for
--     comparable financial/operational policies; the
--     `settings_category_registry_safe_missing_behavior_ck` constraint
--     does not include 'fallback_to_global' so we use 'skip' (the W43
--     spec note explicitly allows matching the existing canonical pattern).
--   * For lookup categories, follow the canonical pattern from
--     supabase/migrations/202601311720_support_cases_foundation_v1.sql:
--         lookup_definitions  ->  lookup_values (with metadata jsonb for
--                                  tone / sort_order / requires_scope_id)
--   * For categories already partially seeded (cod_policy,
--     settlement_policy, support_case_status, support_case_priority,
--     support_message_channel, settlement_scope_type), this migration
--     ADDS missing rows and UPDATES tone/metadata to match the FE
--     contract; it never deletes existing rows.
--   * cod_policy default value preserves the existing nested
--     `handover.window_hours` shape consumed by cod.tsx (the W43 spec's
--     flat `handover_sla_hours = 48` maps onto `handover.window_hours`)
--     and adds a top-level `handover_sla_hours` key for forward-compat.
--   * settlement_policy default similarly preserves existing
--     `locking.max_variance_amount` shape and adds top-level
--     `lock_approval_sla_hours` and `variance_threshold_sar` for the
--     W43 contract.
--   * bank_recon_policy is a NEW category alias for the FE contract
--     (the existing `bank_reconciliation_policy` category remains
--     authoritative for the matcher); this migration seeds the
--     console-v2 FE category name so the FE resolver can hit a row
--     directly without translating category names. Both rows resolve to
--     the same shape; future fixup migrations can collapse them once
--     the FE consumer lands on a single canonical name.
--
-- AGENTS.md objectives honored:
--   §1 (SCALABLE/DYNAMIC):    seeds use VALUES + WHERE-EXISTS so no
--                             hardcoded UUIDs; idempotent re-run safe.
--   §2 (ZERO REDUNDANCY):     reuses canonical settings_category_registry,
--                             schema_registry, settings_versions, settings,
--                             lookup_definitions, lookup_values; introduces
--                             zero new tables, zero new RPCs.
--   §3 (ROW-DRIVEN / SSOT):   FE categories now have canonical DB rows;
--                             FE fallbacks become unreachable in production
--                             once these rows exist for the active scope.
--   §5 (APPEND-ONLY):         no edits to historical migrations; new
--                             timestamped fixup file with INSERT/UPSERT only.
--   §6 (RLS POSTURE):         this migration touches only existing tables
--                             that already have correct RLS + service-role
--                             policies; no new objects.
--   §10 (NO WORKAROUNDS):     no flag-driven seeds, no temporary
--                             categories, no shadow tables; the rows
--                             written here are the canonical SSOT.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605020100_w43_console_v2_canonical_seeds'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1) Settings categories: register + schema + global default settings rows
-- ---------------------------------------------------------------------------

-- 1a) Upsert settings_category_registry rows.
INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES
  ('billing_policy',
   'Billing/invoice policy (aging SLA bucket for invoice overdue tone, payment terms).',
   TRUE, TRUE, FALSE, 'skip',
   '["global","tenant","client","sender","source","resource"]'::jsonb),
  ('bank_recon_policy',
   'Bank reconciliation policy (suspense aging SLA + bank statement matching window/tolerance/uniqueness).',
   TRUE, TRUE, FALSE, 'skip',
   '["global","tenant","client","sender","source","resource"]'::jsonb),
  ('dispute_resolution_policy',
   'Dispute resolution policy (tenant SLA for dispute aging + chip tone bucket).',
   TRUE, TRUE, FALSE, 'skip',
   '["global","tenant","client","sender","source","resource"]'::jsonb),
  ('planning_os_config',
   'Planning OS config (kanban stages, GitHub repo + project URL for the planning mirror).',
   TRUE, TRUE, FALSE, 'skip',
   '["global","tenant","client","sender","source","resource"]'::jsonb)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  updated_at = now();

-- 1b) Upsert active schema_registry rows.
WITH category_seed(category, description, schema_doc, example_doc) AS (
  VALUES
    ('billing_policy',
     'Billing/invoice policy (aging SLA bucket for invoice overdue tone, payment terms).',
     '{
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "Billing Policy",
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "version": { "type": "integer", "minimum": 1 },
          "aging_sla_hours": { "type": ["integer", "null"], "minimum": 0 },
          "invoice_aging": {
            "type": ["object", "null"],
            "additionalProperties": true,
            "properties": {
              "window_days": { "type": ["integer", "null"], "minimum": 0 }
            }
          }
        }
      }'::jsonb,
     '[
        { "version": 1, "aging_sla_hours": 336, "invoice_aging": { "window_days": 14 } }
      ]'::jsonb),
    ('bank_recon_policy',
     'Bank reconciliation policy (suspense aging SLA + bank statement matching window/tolerance/uniqueness).',
     '{
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "Bank Recon Policy",
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "version": { "type": "integer", "minimum": 1 },
          "suspense_aging_sla_hours": { "type": ["integer", "null"], "minimum": 0 },
          "match": {
            "type": ["object", "null"],
            "additionalProperties": true,
            "properties": {
              "window_days_before": { "type": ["integer", "null"], "minimum": 0 },
              "window_days_after": { "type": ["integer", "null"], "minimum": 0 },
              "amount_tolerance": { "type": ["number", "null"], "minimum": 0 },
              "require_unique": { "type": ["boolean", "null"] }
            }
          }
        }
      }'::jsonb,
     '[
        { "version": 1, "suspense_aging_sla_hours": 24,
          "match": { "window_days_before": 2, "window_days_after": 2, "amount_tolerance": 0, "require_unique": true } }
      ]'::jsonb),
    ('dispute_resolution_policy',
     'Dispute resolution policy (tenant SLA for dispute aging + chip tone bucket).',
     '{
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "Dispute Resolution Policy",
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "version": { "type": "integer", "minimum": 1 },
          "sla_hours": { "type": ["integer", "null"], "minimum": 0 }
        }
      }'::jsonb,
     '[ { "version": 1, "sla_hours": 72 } ]'::jsonb),
    ('planning_os_config',
     'Planning OS config (kanban stages, GitHub repo + project URL for the planning mirror).',
     '{
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "Planning OS Config",
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "version": { "type": "integer", "minimum": 1 },
          "stages": { "type": ["array", "null"], "items": { "type": "string" } },
          "github_repo": { "type": ["string", "null"] },
          "github_project_url": { "type": ["string", "null"] }
        }
      }'::jsonb,
     '[
        {
          "version": 1,
          "stages": ["Draft", "Triaged", "Ready for Execution", "In Progress", "Done", "Audit Pending"],
          "github_repo": "MasarX/MasarX",
          "github_project_url": "https://github.com/orgs/example-org/projects/1"
        }
      ]'::jsonb)
)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
SELECT cs.category, 1, cs.schema_doc, cs.description, cs.example_doc, TRUE
FROM category_seed cs
ON CONFLICT (category, version) DO NOTHING;

-- 1c) Seed global settings_versions + settings rows. The unique partial
-- index `idx_settings_versions_current_hash` ensures only one current
-- (effective_until IS NULL AND approved_at IS NOT NULL) row per
-- (category, scope_type, scope_hash). `ON CONFLICT DO NOTHING` makes the
-- INSERT idempotent across re-runs. The settings projection follows.
WITH default_payload(category, body) AS (
  VALUES
    ('billing_policy', jsonb_build_object(
      'version', 1,
      'aging_sla_hours', 336,
      'invoice_aging', jsonb_build_object('window_days', 14)
    )),
    ('bank_recon_policy', jsonb_build_object(
      'version', 1,
      'suspense_aging_sla_hours', 24,
      'match', jsonb_build_object(
        'window_days_before', 2,
        'window_days_after', 2,
        'amount_tolerance', 0,
        'require_unique', true
      )
    )),
    ('dispute_resolution_policy', jsonb_build_object(
      'version', 1,
      'sla_hours', 72
    )),
    ('planning_os_config', jsonb_build_object(
      'version', 1,
      'stages', jsonb_build_array(
        'Draft', 'Triaged', 'Ready for Execution', 'In Progress', 'Done', 'Audit Pending'
      ),
      'github_repo', 'MasarX/MasarX',
      'github_project_url', 'https://github.com/orgs/example-org/projects/1'
    ))
),
inserted_versions AS (
  INSERT INTO public.settings_versions (
    category, scope_type, scope_id, version, value, schema_version, approved_at
  )
  SELECT dp.category, 'global', NULL::uuid, 1, dp.body, 1, now()
  FROM default_payload dp
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = dp.category
      AND sv.scope_type = 'global'
      AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND sv.effective_until IS NULL
      AND sv.approved_at IS NOT NULL
  )
  RETURNING category, scope_type, scope_id, id, value
)
INSERT INTO public.settings (
  category, scope_type, scope_id, settings_version_id, cached_value, last_updated
)
SELECT iv.category, iv.scope_type, iv.scope_id, iv.id, iv.value, now()
FROM inserted_versions iv
WHERE NOT EXISTS (
  SELECT 1
  FROM public.settings s
  WHERE s.category = iv.category
    AND s.scope_type = iv.scope_type
    AND s.scope_id IS NULL
);

-- 1d) Augment existing global cod_policy default value to also expose
-- the W43 top-level keys (handover_sla_hours, variance_tolerance_sar)
-- alongside the existing nested handover.window_hours /
-- handover.variance_tolerance_amount keys consumed by cod.tsx. This
-- preserves the FE consumer's resolved-pill chip semantics and adds
-- forward-compat scalars without breaking the existing schema_registry
-- contract (additionalProperties: true).
UPDATE public.settings_versions sv
SET value = jsonb_set(
              jsonb_set(
                COALESCE(sv.value, '{}'::jsonb),
                '{handover_sla_hours}',
                to_jsonb(48),
                true
              ),
              '{variance_tolerance_sar}',
              to_jsonb(0),
              true
            )
WHERE sv.category = 'cod_policy'
  AND sv.scope_type = 'global'
  AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND sv.effective_until IS NULL
  AND sv.approved_at IS NOT NULL
  AND (
    (sv.value->>'handover_sla_hours') IS DISTINCT FROM '48'
    OR (sv.value->>'variance_tolerance_sar') IS DISTINCT FROM '0'
  );

UPDATE public.settings s
SET cached_value = sv.value,
    last_updated = now()
FROM public.settings_versions sv
WHERE s.category = 'cod_policy'
  AND s.scope_type = 'global'
  AND s.scope_id IS NULL
  AND sv.id = s.settings_version_id
  AND (s.cached_value IS DISTINCT FROM sv.value);

-- 1e) Augment existing global settlement_policy default value to expose
-- the W43 top-level keys (lock_approval_sla_hours, variance_threshold_sar)
-- alongside the existing nested locking.max_variance_amount key.
UPDATE public.settings_versions sv
SET value = jsonb_set(
              jsonb_set(
                COALESCE(sv.value, '{}'::jsonb),
                '{lock_approval_sla_hours}',
                to_jsonb(24),
                true
              ),
              '{variance_threshold_sar}',
              to_jsonb(0),
              true
            )
WHERE sv.category = 'settlement_policy'
  AND sv.scope_type = 'global'
  AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND sv.effective_until IS NULL
  AND sv.approved_at IS NOT NULL
  AND (
    (sv.value->>'lock_approval_sla_hours') IS DISTINCT FROM '24'
    OR (sv.value->>'variance_threshold_sar') IS DISTINCT FROM '0'
  );

UPDATE public.settings s
SET cached_value = sv.value,
    last_updated = now()
FROM public.settings_versions sv
WHERE s.category = 'settlement_policy'
  AND s.scope_type = 'global'
  AND s.scope_id IS NULL
  AND sv.id = s.settings_version_id
  AND (s.cached_value IS DISTINCT FROM sv.value);

-- ---------------------------------------------------------------------------
-- 2) Lookup categories: definitions + values
-- ---------------------------------------------------------------------------

-- 2a) Upsert lookup_definitions rows. `scope_type='global'` +
--     `organization_id IS NULL` matches the contract from
--     supabase/migrations/202604280200_phase_b6_catalog_identity_foundation_v1.sql
--     (system-seed lookups live at the global scope).
INSERT INTO public.lookup_definitions (
  category, description, owner_role, approval_policy, is_mutable,
  organization_id, scope_type
)
VALUES
  ('workflow_binding_event',
   'Canonical workflow binding event taxonomy (entry-point event names emitted by domain-event publishers).',
   'engineering', 'tier_2', TRUE, NULL, 'global'),
  ('settlement_scope_type',
   'Settlement batch scope type (drives how settlement batches are formed; mirrors settlement_policy.batch_scopes).',
   'finance', 'tier_2', TRUE, NULL, 'global'),
  ('approval_policy',
   'Approval tier taxonomy used by lookup governance (tier_1=light, tier_2=standard, tier_3=high-risk).',
   'engineering', 'tier_1', FALSE, NULL, 'global'),
  ('owner_role',
   'Lookup ownership taxonomy (which team is accountable for changes to a given lookup category).',
   'operations', 'tier_1', FALSE, NULL, 'global'),
  ('support_case_event_type',
   'Support case lifecycle event type (immutable ledger entries on support_case_events).',
   'operations', 'tier_2', TRUE, NULL, 'global')
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  is_mutable = EXCLUDED.is_mutable,
  updated_at = now();

-- For categories already created by earlier migrations we only refresh
-- the ownership/approval metadata (do not flip is_mutable).
UPDATE public.lookup_definitions
SET owner_role = 'operations',
    approval_policy = 'tier_2',
    description = COALESCE(
      NULLIF(description, ''),
      'Support case lifecycle status (projection)'
    ),
    updated_at = now()
WHERE category = 'support_case_status'
  AND (owner_role IS DISTINCT FROM 'operations'
       OR approval_policy IS DISTINCT FROM 'tier_2');

UPDATE public.lookup_definitions
SET owner_role = 'operations',
    approval_policy = 'tier_2',
    description = COALESCE(
      NULLIF(description, ''),
      'Support case priority/urgency'
    ),
    updated_at = now()
WHERE category = 'support_case_priority'
  AND (owner_role IS DISTINCT FROM 'operations'
       OR approval_policy IS DISTINCT FROM 'tier_2');

UPDATE public.lookup_definitions
SET owner_role = 'operations',
    approval_policy = 'tier_2',
    description = COALESCE(
      NULLIF(description, ''),
      'Support message channel taxonomy'
    ),
    updated_at = now()
WHERE category = 'support_message_channel'
  AND (owner_role IS DISTINCT FROM 'operations'
       OR approval_policy IS DISTINCT FROM 'tier_2');

-- 2b) Upsert lookup_values rows. We emit one INSERT per category to keep
-- the migration scannable, and use a CROSS JOIN against
-- lookup_definitions so we never hardcode lookup_definition_id UUIDs.

-- workflow_binding_event: one row per canonical entry-point event the
-- console-v2 binding-registry surface lists.
INSERT INTO public.lookup_values (
  lookup_definition_id, value, label, description, sort_order, is_default, metadata
)
SELECT
  ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('shipment.created',          'Shipment created',          'Domain event emitted when a new shipment lands in the platform.',           10, FALSE, '{}'),
  ('shipment.amended',          'Shipment amended',          'Domain event emitted when shipment fields are mutated post-create.',         20, FALSE, '{}'),
  ('shipment.cancelled',        'Shipment cancelled',        'Domain event emitted when a shipment is canceled (terminal).',               30, FALSE, '{}'),
  ('dispatch.exception_recorded','Dispatch exception recorded','Domain event emitted when a dispatch exception (NDR/etc.) is recorded.',    40, FALSE, '{}'),
  ('route_run.assigned',        'Route run assigned',        'Domain event emitted when a route run is assigned to a driver.',             50, FALSE, '{}'),
  ('route_run.completed',       'Route run completed',       'Domain event emitted when a route run is closed out as complete.',           60, FALSE, '{}'),
  ('cod.collected',             'COD collected',             'Domain event emitted when a COD payment is captured at handover.',           70, FALSE, '{}')
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'workflow_binding_event'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  metadata = EXCLUDED.metadata,
  retired_at = NULL,
  updated_at = now();

-- settlement_scope_type
INSERT INTO public.lookup_values (
  lookup_definition_id, value, label, description, sort_order, is_default, metadata
)
SELECT
  ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('driver_shift',      'Driver shift',      'Settlement batch keyed by driver shift / ops session.',          10, TRUE,  '{}'),
  ('branch_day',        'Branch day',        'Settlement batch keyed by branch + business day.',                20, FALSE, '{}'),
  ('client_cycle',      'Client cycle',      'Settlement batch keyed by client billing cycle.',                  30, FALSE, '{}'),
  ('accounting_period', 'Accounting period', 'Settlement batch keyed by accounting period (month/quarter).',     40, FALSE, '{}')
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'settlement_scope_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  metadata = EXCLUDED.metadata,
  retired_at = NULL,
  updated_at = now();

-- approval_policy
INSERT INTO public.lookup_values (
  lookup_definition_id, value, label, description, sort_order, is_default, metadata
)
SELECT
  ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('tier_1', 'Tier 1', 'Light-weight approval (single approver, low blast radius).',                        10, TRUE,  '{}'),
  ('tier_2', 'Tier 2', 'Standard approval (operations/finance dual sign-off, medium blast radius).',         20, FALSE, '{}'),
  ('tier_3', 'Tier 3', 'High-risk approval (platform/security sign-off, high blast radius / irreversible).', 30, FALSE, '{}')
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'approval_policy'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  metadata = EXCLUDED.metadata,
  retired_at = NULL,
  updated_at = now();

-- owner_role
INSERT INTO public.lookup_values (
  lookup_definition_id, value, label, description, sort_order, is_default, metadata
)
SELECT
  ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('operations',  'Operations',  'Operations team owns the lookup category.',           10, TRUE,  '{}'),
  ('engineering', 'Engineering', 'Engineering team owns the lookup category.',          20, FALSE, '{}'),
  ('finance',     'Finance',     'Finance team owns the lookup category.',              30, FALSE, '{}'),
  ('product',     'Product',     'Product team owns the lookup category.',              40, FALSE, '{}')
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'owner_role'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  metadata = EXCLUDED.metadata,
  retired_at = NULL,
  updated_at = now();

-- support_case_status: refresh tone + sort_order metadata so the FE chip
-- resolver matches the W43 contract exactly. Existing values are kept;
-- this UPSERT updates metadata for the canonical 5-value set.
INSERT INTO public.lookup_values (
  lookup_definition_id, value, label, description, sort_order, is_default, metadata
)
SELECT
  ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('open',        'Open',        'Case opened.',                  10, TRUE,  '{"tone":"info","sort_order":10}'),
  ('in_progress', 'In progress', 'Case is being handled.',        20, FALSE, '{"tone":"warn","sort_order":20}'),
  ('resolved',    'Resolved',    'Case resolved (pending close).', 30, FALSE, '{"tone":"good","sort_order":30}'),
  ('closed',      'Closed',      'Case closed.',                  40, FALSE, '{"tone":"neutral","sort_order":40,"is_final":true}'),
  ('canceled',    'Canceled',    'Case canceled / voided.',       50, FALSE, '{"tone":"neutral","sort_order":50,"is_final":true}')
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'support_case_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  metadata = EXCLUDED.metadata,
  retired_at = NULL,
  updated_at = now();

-- support_case_priority
INSERT INTO public.lookup_values (
  lookup_definition_id, value, label, description, sort_order, is_default, metadata
)
SELECT
  ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('urgent', 'Urgent', 'Immediate handling required.',         10, FALSE, '{"tone":"danger","sort_order":10}'),
  ('high',   'High',   'High priority case.',                  20, FALSE, '{"tone":"warn","sort_order":20}'),
  ('medium', 'Medium', 'Standard priority case.',              30, TRUE,  '{"tone":"info","sort_order":30}'),
  ('low',    'Low',    'Low priority case.',                   40, FALSE, '{"tone":"neutral","sort_order":40}')
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'support_case_priority'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  metadata = EXCLUDED.metadata,
  retired_at = NULL,
  updated_at = now();

-- support_case_event_type
INSERT INTO public.lookup_values (
  lookup_definition_id, value, label, description, sort_order, is_default, metadata
)
SELECT
  ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('opened',           'Case opened',          'Case opened.',                                  10, TRUE,  '{"tone":"neutral","sort_order":10}'),
  ('assigned',         'Assigned',             'Case assigned to an operator.',                 20, FALSE, '{"tone":"neutral","sort_order":20}'),
  ('status_changed',   'Status changed',       'Case status transitioned.',                     30, FALSE, '{"tone":"neutral","sort_order":30}'),
  ('message_received', 'Message received',     'Inbound message received from external party.', 40, FALSE, '{"tone":"neutral","sort_order":40}'),
  ('message_sent',     'Operator replied',     'Outbound message sent by operator.',            50, FALSE, '{"tone":"good","sort_order":50}'),
  ('escalated',        'Escalated',            'Case escalated to a higher tier.',              60, FALSE, '{"tone":"warn","sort_order":60}'),
  ('sla_breached',     'SLA breached',         'Case breached its SLA.',                        70, FALSE, '{"tone":"danger","sort_order":70}'),
  ('tag_added',        'Tag added',            'Tag added to the case.',                        80, FALSE, '{"tone":"neutral","sort_order":80}'),
  ('attachment_added', 'Attachment uploaded',  'Attachment added to the case.',                 90, FALSE, '{"tone":"neutral","sort_order":90}'),
  ('resolved',         'Resolved',             'Case marked resolved.',                        100, FALSE, '{"tone":"good","sort_order":100}'),
  ('closed',           'Closed',               'Case closed.',                                 110, FALSE, '{"tone":"neutral","sort_order":110}'),
  ('reopened',         'Reopened',             'Case reopened after being closed/resolved.',   120, FALSE, '{"tone":"warn","sort_order":120}')
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'support_case_event_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  metadata = EXCLUDED.metadata,
  retired_at = NULL,
  updated_at = now();

-- support_message_channel: refresh tone metadata + add 'api' value used
-- by the FE for programmatic ingest.
INSERT INTO public.lookup_values (
  lookup_definition_id, value, label, description, sort_order, is_default, metadata
)
SELECT
  ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('in_app',   'In-app',   'In-app chat or portal.',                    10, TRUE,  '{"tone":"info","sort_order":10}'),
  ('whatsapp', 'WhatsApp', 'WhatsApp message.',                          20, FALSE, '{"tone":"good","sort_order":20}'),
  ('sms',      'SMS',      'SMS message.',                               30, FALSE, '{"tone":"neutral","sort_order":30}'),
  ('email',    'Email',    'Email message.',                             40, FALSE, '{"tone":"info","sort_order":40}'),
  ('phone',    'Phone',    'Phone call summary.',                        50, FALSE, '{"tone":"neutral","sort_order":50}'),
  ('api',      'API',      'Programmatic / webhook-relayed ingest.',     60, FALSE, '{"tone":"neutral","sort_order":60}')
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'support_message_channel'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  metadata = EXCLUDED.metadata,
  retired_at = NULL,
  updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605020100_w43_console_v2_canonical_seeds'));

COMMIT;
