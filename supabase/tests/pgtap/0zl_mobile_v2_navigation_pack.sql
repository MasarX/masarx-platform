-- Test Suite: Mobile V2 navigation pack
-- Validates that 202605101800_mobile_v2_navigation_pack_v1 has registered:
--   (a) the three new sections (v2-home, v2-network-ops, v2-onboarding) in
--       ui_navigation.apps.mobile
--   (b) every required item under each section with the canonical contract
--       {id, label, href, capability}
--   (c) mobile-tasks carries default_home=true (post-login default home)
--   (d) per-role homes (loader-today, rider-today, supervisor-today) carry
--       a roles array with the matching role
--   (e) idempotency: existing sections (tools, route, settlements, etc.) are
--       preserved and not duplicated
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(37);

-- ----------------------------------------------------------------------------
-- (a) Three V2 sections registered in ui_navigation.apps.mobile.sections
-- ----------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND section->>'id' = 'v2-home'
  ),
  'v2-home section is registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND section->>'id' = 'v2-network-ops'
  ),
  'v2-network-ops section is registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND section->>'id' = 'v2-onboarding'
  ),
  'v2-onboarding section is registered'
);

-- ----------------------------------------------------------------------------
-- (b) Every required item is registered with canonical contract.
--     Helper macro via subqueries: each item must have id, label, href,
--     capability set to non-empty values.
-- ----------------------------------------------------------------------------

-- v2-home items
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND section->>'id' = 'v2-home'
       AND item->>'id' = 'mobile-tasks'
       AND item->>'href' = '/mobile/tasks'
       AND length(item->>'label') > 0
       AND length(item->>'capability') > 0
  ),
  'v2-home: mobile-tasks registered with full contract'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND section->>'id' = 'v2-home'
       AND item->>'id' = 'mobile-loader-today'
  ),
  'v2-home: mobile-loader-today registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND section->>'id' = 'v2-home'
       AND item->>'id' = 'mobile-rider-today'
  ),
  'v2-home: mobile-rider-today registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND section->>'id' = 'v2-home'
       AND item->>'id' = 'mobile-supervisor-today'
  ),
  'v2-home: mobile-supervisor-today registered'
);

-- v2-network-ops items (12 items)
SELECT ok(
  (
    SELECT count(DISTINCT item->>'id')
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND section->>'id' = 'v2-network-ops'
       AND item->>'id' IN (
         'mobile-pickups', 'mobile-trips', 'mobile-sortation', 'mobile-lookup',
         'mobile-returns', 'mobile-hub-pickup', 'mobile-hold', 'mobile-cash-drop',
         'mobile-cod-ledger', 'mobile-wallet', 'mobile-eor', 'mobile-trip-nav'
       )
  ) = 12,
  'v2-network-ops: all 12 routes registered (pickups/trips/sortation/lookup/returns/hub-pickup/hold/cash-drop/cod-ledger/wallet/eor/trip-nav)'
);

-- Spot-check 4 individual hrefs in network-ops to catch typos
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND section->>'id' = 'v2-network-ops'
       AND item->>'id' = 'mobile-pickups'
       AND item->>'href' = '/mobile/pickups'
       AND item->>'capability' = 'pickups.read'
  ),
  'v2-network-ops: mobile-pickups href and capability correct'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND section->>'id' = 'v2-network-ops'
       AND item->>'id' = 'mobile-cash-drop'
       AND item->>'href' = '/mobile/cash-drop'
       AND item->>'capability' = 'cash_drop.write'
  ),
  'v2-network-ops: mobile-cash-drop href and capability correct'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND section->>'id' = 'v2-network-ops'
       AND item->>'id' = 'mobile-cod-ledger'
       AND item->>'href' = '/mobile/cod-ledger'
       AND item->>'capability' = 'cash_drop.write'
  ),
  'v2-network-ops: mobile-cod-ledger href and capability correct'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND section->>'id' = 'v2-network-ops'
       AND item->>'id' = 'mobile-trip-nav'
       AND item->>'href' = '/mobile/trip-nav'
  ),
  'v2-network-ops: mobile-trip-nav href correct'
);

-- v2-onboarding items (5 items)
SELECT ok(
  (
    SELECT count(DISTINCT item->>'id')
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND section->>'id' = 'v2-onboarding'
       AND item->>'id' IN (
         'mobile-kyc-id', 'mobile-kyc-vehicle', 'mobile-kyc-vehicle-photos',
         'mobile-cleaning', 'mobile-pre-shift'
       )
  ) = 5,
  'v2-onboarding: all 5 routes registered'
);

-- ----------------------------------------------------------------------------
-- (c) mobile-tasks carries default_home=true
-- ----------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND section->>'id' = 'v2-home'
       AND item->>'id' = 'mobile-tasks'
       AND (item->>'default_home')::boolean = TRUE
  ),
  'mobile-tasks is default_home (post-login default for every role)'
);

-- And no other route has default_home=true
SELECT ok(
  (
    SELECT count(*)
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND (item->>'default_home')::boolean = TRUE
  ) = 1,
  'exactly one route is marked default_home (mobile-tasks)'
);

-- ----------------------------------------------------------------------------
-- (d) Per-role home items carry the matching role in their roles array
-- ----------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND section->>'id' = 'v2-home'
       AND item->>'id' = 'mobile-loader-today'
       AND item -> 'roles' ? 'loader'
  ),
  'mobile-loader-today carries roles=[loader]'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND section->>'id' = 'v2-home'
       AND item->>'id' = 'mobile-rider-today'
       AND item -> 'roles' ? 'rider'
  ),
  'mobile-rider-today carries roles=[rider]'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND section->>'id' = 'v2-home'
       AND item->>'id' = 'mobile-supervisor-today'
       AND item -> 'roles' ? 'supervisor'
  ),
  'mobile-supervisor-today carries roles=[supervisor]'
);

-- mobile-tasks must NOT have a roles filter (visible to every role)
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND section->>'id' = 'v2-home'
       AND item->>'id' = 'mobile-tasks'
       AND NOT (item ? 'roles')
  ),
  'mobile-tasks has no roles filter (post-login default for every role)'
);

-- ----------------------------------------------------------------------------
-- (e) Idempotency / preservation: existing sections still present
-- ----------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND section->>'id' = 'tools'
  ),
  'pre-existing tools section is preserved (no clobbering)'
);

-- Tools section still has the original entries (sample 3)
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND section->>'id' = 'tools'
       AND item->>'id' = 'mobile-outbox'
  ),
  'tools.mobile-outbox preserved'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND section->>'id' = 'tools'
       AND item->>'id' = 'mobile-scan'
  ),
  'tools.mobile-scan preserved'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND section->>'id' = 'tools'
       AND item->>'id' = 'mobile-route'
  ),
  'tools.mobile-route preserved'
);

-- Total V2 items registered: 4 + 12 + 5 = 21
SELECT ok(
  (
    SELECT count(*)
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND section->>'id' IN ('v2-home', 'v2-network-ops', 'v2-onboarding')
  ) = 21,
  'exactly 21 V2 items registered across the three new sections (4 + 12 + 5)'
);

-- ----------------------------------------------------------------------------
-- Icon assignment — every V2 item carries an icon name (so the renderer
-- never falls back to a placeholder).
-- ----------------------------------------------------------------------------

SELECT ok(
  (
    SELECT count(*)
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND section->>'id' IN ('v2-home', 'v2-network-ops', 'v2-onboarding')
       AND length(COALESCE(item->>'icon', '')) > 0
  ) = 21,
  'every V2 item carries an icon name (no missing icons)'
);

-- Spot-check icon values land on canonical names
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND item->>'id' = 'mobile-tasks'
       AND item->>'icon' = 'list'
  ),
  'mobile-tasks icon = list'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND item->>'id' = 'mobile-trips'
       AND item->>'icon' = 'truck'
  ),
  'mobile-trips icon = truck'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND item->>'id' = 'mobile-cash-drop'
       AND item->>'icon' = 'cash'
  ),
  'mobile-cash-drop icon = cash'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND item->>'id' = 'mobile-kyc-id'
       AND item->>'icon' = 'id'
  ),
  'mobile-kyc-id icon = id'
);

-- ----------------------------------------------------------------------------
-- Capability completeness — no V2 item has an empty capability string
-- ----------------------------------------------------------------------------

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND section->>'id' IN ('v2-home', 'v2-network-ops', 'v2-onboarding')
       AND COALESCE(length(item->>'capability'), 0) = 0
  ),
  'no V2 item has an empty / missing capability'
);

-- ----------------------------------------------------------------------------
-- Section ordering: V2 sections appear AFTER the existing sections
-- (so navigation reorders deterministically when the migration applies)
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_value JSONB;
  v_sections JSONB;
  v_index INT := 0;
  v_v2_home_idx INT := -1;
  v_tools_idx INT := -1;
  v_section JSONB;
BEGIN
  SELECT sv.value INTO v_value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;
  v_sections := v_value -> 'apps' -> 'mobile' -> 'sections';
  FOR v_section IN SELECT * FROM jsonb_array_elements(v_sections) LOOP
    IF v_section->>'id' = 'v2-home' THEN v_v2_home_idx := v_index; END IF;
    IF v_section->>'id' = 'tools' THEN v_tools_idx := v_index; END IF;
    v_index := v_index + 1;
  END LOOP;
  PERFORM ok(
    v_tools_idx >= 0 AND v_v2_home_idx > v_tools_idx,
    'v2-home section is ordered after the legacy tools section'
  );
END $$;

-- Item count assertions per section
SELECT ok(
  (
    SELECT count(*)
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND section->>'id' = 'v2-home'
  ) = 4,
  'v2-home contains exactly 4 items (tasks + 3 role homes)'
);

SELECT ok(
  (
    SELECT count(*)
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND section->>'id' = 'v2-network-ops'
  ) = 12,
  'v2-network-ops contains exactly 12 items'
);

SELECT ok(
  (
    SELECT count(*)
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'apps' -> 'mobile' -> 'sections') AS section,
           jsonb_array_elements(section -> 'items') AS item
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND section->>'id' = 'v2-onboarding'
  ) = 5,
  'v2-onboarding contains exactly 5 items'
);

-- Version increment — settings_versions for ui_navigation should be > 1
SELECT ok(
  (
    SELECT max(sv.version)
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
  ) >= 2,
  'ui_navigation version was incremented (>=2) after V2 pack applied'
);

-- Settings cached_value matches versioned value
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND s.cached_value = sv.value
  ),
  'ui_navigation settings.cached_value matches settings_versions.value'
);

-- approved_at + change_reason are populated on the active version
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND sv.approved_at IS NOT NULL
       AND length(sv.change_reason) > 0
  ),
  'ui_navigation active version is approved with a change_reason'
);

SELECT * FROM finish();
ROLLBACK;
