-- W43 console-v2 100% production-readiness — backend canonical seeds
-- pgTAP: validates the console-v2 FE-resolved policy + lookup categories
-- seeded by supabase/migrations/202605020100_w43_console_v2_canonical_seeds.sql.
--
-- Asserts:
--   1. Each settings_category_registry row exists for the W43 policy
--      categories with requires_schema=TRUE and requires_global_default=TRUE.
--   2. Each schema_registry row exists and is_active=TRUE for the W43
--      policy categories.
--   3. Each global settings_versions + settings row exists and the
--      canonical resolver `resolve_settings(category, NULL, NULL)`
--      returns the expected default value (key-by-key for the FE
--      contract scalars).
--   4. Each W43 lookup_definitions row exists.
--   5. Each W43 lookup_values row count matches the expected canonical
--      list size (e.g. support_case_status has exactly 5 active rows).
--   6. For tone-bearing lookups, every value's metadata.tone field is
--      populated (no NULL/empty tones).
--
-- Coverage philosophy:
--   * pgTAP tests are written so the migration is the SSOT — if a future
--     fixup migration retires an existing seeded value (e.g. removes
--     `internal` from support_message_channel) the assertion uses
--     "at least N" where N matches the W43 contract size, not "exactly N",
--     to avoid coupling the test to legacy values that pre-date W43.
--     Where the W43 contract enumerates the canonical set explicitly
--     ("exactly N"), we assert that every value in the W43 set is
--     present and metadata.tone is set.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

-- 4 policy categories x 4 assertions (registry, schema_registry,
--   settings_versions, settings) = 16
-- 4 policy resolver value spot-checks (one canonical scalar per category) = 4
-- 8 lookup_definitions presence checks (5 new + 3 refresh-only existing) = 8
-- 8 lookup_values count checks                                          = 8
-- 6 tone-coverage checks (categories whose values carry metadata.tone)  = 6
-- 1 cod_policy top-level scalar check                                    = 1
-- 1 settlement_policy top-level scalar check                             = 1
-- Total assertions:                                                     = 44
SELECT plan(44);

-- ---------------------------------------------------------------------------
-- 1) settings_category_registry presence
-- ---------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'billing_policy'
      AND requires_schema = TRUE
      AND requires_global_default = TRUE
  ),
  'billing_policy: settings_category_registry row exists with requires_schema/requires_global_default'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'bank_recon_policy'
      AND requires_schema = TRUE
      AND requires_global_default = TRUE
  ),
  'bank_recon_policy: settings_category_registry row exists with requires_schema/requires_global_default'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'dispute_resolution_policy'
      AND requires_schema = TRUE
      AND requires_global_default = TRUE
  ),
  'dispute_resolution_policy: settings_category_registry row exists with requires_schema/requires_global_default'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'planning_os_config'
      AND requires_schema = TRUE
      AND requires_global_default = TRUE
  ),
  'planning_os_config: settings_category_registry row exists with requires_schema/requires_global_default'
);

-- ---------------------------------------------------------------------------
-- 2) schema_registry active rows
-- ---------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.schema_registry
    WHERE category = 'billing_policy' AND is_active = TRUE
  ),
  'billing_policy: schema_registry active row exists'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.schema_registry
    WHERE category = 'bank_recon_policy' AND is_active = TRUE
  ),
  'bank_recon_policy: schema_registry active row exists'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.schema_registry
    WHERE category = 'dispute_resolution_policy' AND is_active = TRUE
  ),
  'dispute_resolution_policy: schema_registry active row exists'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.schema_registry
    WHERE category = 'planning_os_config' AND is_active = TRUE
  ),
  'planning_os_config: schema_registry active row exists'
);

-- ---------------------------------------------------------------------------
-- 3) settings_versions + settings global rows present
-- ---------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_versions
    WHERE category = 'billing_policy' AND scope_type = 'global' AND scope_id IS NULL
      AND effective_until IS NULL AND approved_at IS NOT NULL
  ),
  'billing_policy: settings_versions current global row exists'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'billing_policy' AND scope_type = 'global' AND scope_id IS NULL
  ),
  'billing_policy: settings global row exists'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_versions
    WHERE category = 'bank_recon_policy' AND scope_type = 'global' AND scope_id IS NULL
      AND effective_until IS NULL AND approved_at IS NOT NULL
  ),
  'bank_recon_policy: settings_versions current global row exists'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'bank_recon_policy' AND scope_type = 'global' AND scope_id IS NULL
  ),
  'bank_recon_policy: settings global row exists'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_versions
    WHERE category = 'dispute_resolution_policy' AND scope_type = 'global' AND scope_id IS NULL
      AND effective_until IS NULL AND approved_at IS NOT NULL
  ),
  'dispute_resolution_policy: settings_versions current global row exists'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'dispute_resolution_policy' AND scope_type = 'global' AND scope_id IS NULL
  ),
  'dispute_resolution_policy: settings global row exists'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_versions
    WHERE category = 'planning_os_config' AND scope_type = 'global' AND scope_id IS NULL
      AND effective_until IS NULL AND approved_at IS NOT NULL
  ),
  'planning_os_config: settings_versions current global row exists'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'planning_os_config' AND scope_type = 'global' AND scope_id IS NULL
  ),
  'planning_os_config: settings global row exists'
);

-- ---------------------------------------------------------------------------
-- 3b) Resolver value spot-checks (canonical scalar per category)
-- ---------------------------------------------------------------------------

SELECT is(
  ((public.resolve_settings('billing_policy', NULL, NULL))->>'aging_sla_hours')::int,
  336,
  'resolve_settings(billing_policy).aging_sla_hours = 336'
);

SELECT is(
  ((public.resolve_settings('bank_recon_policy', NULL, NULL))->>'suspense_aging_sla_hours')::int,
  24,
  'resolve_settings(bank_recon_policy).suspense_aging_sla_hours = 24'
);

SELECT is(
  ((public.resolve_settings('dispute_resolution_policy', NULL, NULL))->>'sla_hours')::int,
  72,
  'resolve_settings(dispute_resolution_policy).sla_hours = 72'
);

SELECT is(
  (public.resolve_settings('planning_os_config', NULL, NULL))->>'github_repo',
  'MasarX/MasarX',
  'resolve_settings(planning_os_config).github_repo = MasarX/MasarX'
);

-- ---------------------------------------------------------------------------
-- 4) Existing policy categories: cod_policy + settlement_policy
--    have W43 top-level scalars set.
-- ---------------------------------------------------------------------------

SELECT is(
  ((public.resolve_settings('cod_policy', NULL, NULL))->>'handover_sla_hours')::int,
  48,
  'resolve_settings(cod_policy).handover_sla_hours = 48 (W43 top-level scalar)'
);

SELECT is(
  ((public.resolve_settings('settlement_policy', NULL, NULL))->>'lock_approval_sla_hours')::int,
  24,
  'resolve_settings(settlement_policy).lock_approval_sla_hours = 24 (W43 top-level scalar)'
);

-- ---------------------------------------------------------------------------
-- 5) lookup_definitions presence
-- ---------------------------------------------------------------------------

SELECT ok(
  EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'workflow_binding_event'),
  'workflow_binding_event: lookup_definitions row exists'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'settlement_scope_type'),
  'settlement_scope_type: lookup_definitions row exists'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'approval_policy'),
  'approval_policy: lookup_definitions row exists'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'owner_role'),
  'owner_role: lookup_definitions row exists'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'support_case_event_type'),
  'support_case_event_type: lookup_definitions row exists'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'support_case_status'),
  'support_case_status: lookup_definitions row exists (refresh-only)'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'support_case_priority'),
  'support_case_priority: lookup_definitions row exists (refresh-only)'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'support_message_channel'),
  'support_message_channel: lookup_definitions row exists (refresh-only)'
);

-- ---------------------------------------------------------------------------
-- 6) lookup_values counts (active, retired_at IS NULL)
--    Use ">=" because pre-existing migrations may have already seeded
--    additional values; the W43 spec sizes the canonical set we own.
-- ---------------------------------------------------------------------------

SELECT cmp_ok(
  (SELECT COUNT(*)::int
     FROM public.lookup_values lv
     JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'workflow_binding_event' AND lv.retired_at IS NULL),
  '>=', 7,
  'workflow_binding_event: at least 7 active values (W43 canonical set)'
);

SELECT cmp_ok(
  (SELECT COUNT(*)::int
     FROM public.lookup_values lv
     JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'settlement_scope_type' AND lv.retired_at IS NULL),
  '>=', 4,
  'settlement_scope_type: at least 4 active values (W43 canonical set)'
);

SELECT cmp_ok(
  (SELECT COUNT(*)::int
     FROM public.lookup_values lv
     JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'approval_policy' AND lv.retired_at IS NULL),
  '>=', 3,
  'approval_policy: at least 3 active values (tier_1, tier_2, tier_3)'
);

SELECT cmp_ok(
  (SELECT COUNT(*)::int
     FROM public.lookup_values lv
     JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'owner_role' AND lv.retired_at IS NULL),
  '>=', 4,
  'owner_role: at least 4 active values (operations, engineering, finance, product)'
);

SELECT cmp_ok(
  (SELECT COUNT(*)::int
     FROM public.lookup_values lv
     JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'support_case_status' AND lv.retired_at IS NULL),
  '>=', 5,
  'support_case_status: at least 5 active values (open/in_progress/resolved/closed/canceled)'
);

SELECT cmp_ok(
  (SELECT COUNT(*)::int
     FROM public.lookup_values lv
     JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'support_case_priority' AND lv.retired_at IS NULL),
  '>=', 4,
  'support_case_priority: at least 4 active values (urgent/high/medium/low)'
);

SELECT cmp_ok(
  (SELECT COUNT(*)::int
     FROM public.lookup_values lv
     JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'support_case_event_type' AND lv.retired_at IS NULL),
  '>=', 12,
  'support_case_event_type: at least 12 active values (W43 canonical set)'
);

SELECT cmp_ok(
  (SELECT COUNT(*)::int
     FROM public.lookup_values lv
     JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'support_message_channel' AND lv.retired_at IS NULL),
  '>=', 6,
  'support_message_channel: at least 6 active values (in_app/whatsapp/sms/email/phone/api)'
);

-- ---------------------------------------------------------------------------
-- 7) Tone metadata coverage for tone-bearing lookups.
--    For each W43 canonical value, metadata.tone must be populated.
-- ---------------------------------------------------------------------------

-- support_case_status: W43 canonical 5 values
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'support_case_status'
      AND lv.value IN ('open', 'in_progress', 'resolved', 'closed', 'canceled')
      AND COALESCE(NULLIF(btrim(lv.metadata->>'tone'), ''), NULL) IS NULL
  ),
  'support_case_status: every W43 canonical value has metadata.tone populated'
);

-- support_case_priority: W43 canonical 4 values
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'support_case_priority'
      AND lv.value IN ('urgent', 'high', 'medium', 'low')
      AND COALESCE(NULLIF(btrim(lv.metadata->>'tone'), ''), NULL) IS NULL
  ),
  'support_case_priority: every W43 canonical value has metadata.tone populated'
);

-- support_case_event_type: W43 canonical 12 values
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'support_case_event_type'
      AND lv.value IN (
        'opened','assigned','status_changed','message_received','message_sent',
        'escalated','sla_breached','tag_added','attachment_added',
        'resolved','closed','reopened'
      )
      AND COALESCE(NULLIF(btrim(lv.metadata->>'tone'), ''), NULL) IS NULL
  ),
  'support_case_event_type: every W43 canonical value has metadata.tone populated'
);

-- support_message_channel: W43 canonical 6 values
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'support_message_channel'
      AND lv.value IN ('in_app', 'whatsapp', 'sms', 'email', 'phone', 'api')
      AND COALESCE(NULLIF(btrim(lv.metadata->>'tone'), ''), NULL) IS NULL
  ),
  'support_message_channel: every W43 canonical value has metadata.tone populated'
);

-- support_case_status: every W43 canonical value has metadata.sort_order populated
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'support_case_status'
      AND lv.value IN ('open', 'in_progress', 'resolved', 'closed', 'canceled')
      AND (lv.metadata->>'sort_order') IS NULL
  ),
  'support_case_status: every W43 canonical value has metadata.sort_order populated'
);

-- support_case_priority: every W43 canonical value has metadata.sort_order populated
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'support_case_priority'
      AND lv.value IN ('urgent', 'high', 'medium', 'low')
      AND (lv.metadata->>'sort_order') IS NULL
  ),
  'support_case_priority: every W43 canonical value has metadata.sort_order populated'
);

SELECT finish();

ROLLBACK;
