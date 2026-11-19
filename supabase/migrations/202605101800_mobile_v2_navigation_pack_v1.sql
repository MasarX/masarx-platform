-- Migration: Mobile V2 navigation pack — register all V2 routes in
--            ui_navigation.apps.mobile (SSOT).
-- Date: 2026-05-10
-- Spec: FieldOps V2 production-readiness. Adds three new sections that the
--       Claude Design handoff bundle requires:
--         v2-home          — Tasks (default home for every role) + per-role
--                            homes (loader-today, rider-today, supervisor-today)
--                            visible only to that role.
--         v2-network-ops   — pickups, trips, sortation, lookup, returns,
--                            hub-pickup, hold, cash-drop, wallet, eor, trip-nav.
--         v2-onboarding    — kyc-id, kyc-vehicle, kyc-vehicle-photos, cleaning,
--                            pre-shift.
--
-- Each item carries the canonical {id, label, href, capability} contract from
-- 202602051000_ui_navigation_mobile_tools_v1, plus additive optional fields:
--   icon          — MobileV2IconName from mobile-v2-icon-specs
--   default_home  — boolean; only `mobile-tasks` sets this true
--   roles         — array; restricts visibility to the listed roles
--
-- The migration is fully idempotent: re-running it does not duplicate
-- sections or items. Items in existing sections are not modified.
-- Capability strings reference cap keys that may be added in a later access-
-- control-policy migration; until then they degrade safely (frontend filters
-- by capability match against the user's resolved cap set).

BEGIN;
SELECT pg_advisory_lock(hashtext('202605101800_mobile_v2_navigation_pack_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_apps JSONB := '{}'::jsonb;
  v_mobile JSONB;
  v_sections JSONB := '[]'::jsonb;
  v_new_sections JSONB := '[]'::jsonb;
  v_section JSONB;
  v_existing_section_ids TEXT[] := ARRAY[]::TEXT[];

  -- v2-home items
  v_tasks_item JSONB := jsonb_build_object(
    'id', 'mobile-tasks',
    'label', 'Tasks',
    'href', '/mobile/tasks',
    'capability', 'tasks.read',
    'icon', 'list',
    'default_home', TRUE
  );
  v_loader_today_item JSONB := jsonb_build_object(
    'id', 'mobile-loader-today',
    'label', 'Loader Home',
    'href', '/mobile/loader-today',
    'capability', 'loader.home.read',
    'icon', 'package',
    'roles', jsonb_build_array('loader')
  );
  v_rider_today_item JSONB := jsonb_build_object(
    'id', 'mobile-rider-today',
    'label', 'Rider Home',
    'href', '/mobile/rider-today',
    'capability', 'rider.home.read',
    'icon', 'bike',
    'roles', jsonb_build_array('rider')
  );
  v_supervisor_today_item JSONB := jsonb_build_object(
    'id', 'mobile-supervisor-today',
    'label', 'Supervisor Home',
    'href', '/mobile/supervisor-today',
    'capability', 'supervisor.home.read',
    'icon', 'shield',
    'roles', jsonb_build_array('supervisor')
  );

  -- v2-network-ops items
  v_pickups_item JSONB := jsonb_build_object(
    'id', 'mobile-pickups',
    'label', 'Pickups',
    'href', '/mobile/pickups',
    'capability', 'pickups.read',
    'icon', 'box'
  );
  v_trips_item JSONB := jsonb_build_object(
    'id', 'mobile-trips',
    'label', 'Trips',
    'href', '/mobile/trips',
    'capability', 'trips.read',
    'icon', 'truck'
  );
  v_sortation_item JSONB := jsonb_build_object(
    'id', 'mobile-sortation',
    'label', 'Sortation',
    'href', '/mobile/sortation',
    'capability', 'sortation.read',
    'icon', 'split'
  );
  v_lookup_item JSONB := jsonb_build_object(
    'id', 'mobile-lookup',
    'label', 'Lookup',
    'href', '/mobile/lookup',
    'capability', 'shipments.read',
    'icon', 'search'
  );
  v_returns_item JSONB := jsonb_build_object(
    'id', 'mobile-returns',
    'label', 'Returns',
    'href', '/mobile/returns',
    'capability', 'returns.read',
    'icon', 'package'
  );
  v_hub_pickup_item JSONB := jsonb_build_object(
    'id', 'mobile-hub-pickup',
    'label', 'Hub Pickup',
    'href', '/mobile/hub-pickup',
    'capability', 'hub_pickup.read',
    'icon', 'user'
  );
  v_hold_item JSONB := jsonb_build_object(
    'id', 'mobile-hold',
    'label', 'Hold Queue',
    'href', '/mobile/hold',
    'capability', 'hold.read',
    'icon', 'alert'
  );
  v_cash_drop_item JSONB := jsonb_build_object(
    'id', 'mobile-cash-drop',
    'label', 'Cash Drop',
    'href', '/mobile/cash-drop',
    'capability', 'cash_drop.write',
    'icon', 'cash'
  );
  v_wallet_item JSONB := jsonb_build_object(
    'id', 'mobile-wallet',
    'label', 'Wallet',
    'href', '/mobile/wallet',
    'capability', 'wallet.read',
    'icon', 'cash'
  );
  v_eor_item JSONB := jsonb_build_object(
    'id', 'mobile-eor',
    'label', 'End of Route',
    'href', '/mobile/eor',
    'capability', 'tasks.complete',
    'icon', 'flag'
  );
  v_trip_nav_item JSONB := jsonb_build_object(
    'id', 'mobile-trip-nav',
    'label', 'Trip Nav',
    'href', '/mobile/trip-nav',
    'capability', 'trips.read',
    'icon', 'navigate'
  );

  -- v2-onboarding items
  v_kyc_id_item JSONB := jsonb_build_object(
    'id', 'mobile-kyc-id',
    'label', 'ID Documents',
    'href', '/mobile/kyc-id',
    'capability', 'kyc.write',
    'icon', 'id'
  );
  v_kyc_vehicle_item JSONB := jsonb_build_object(
    'id', 'mobile-kyc-vehicle',
    'label', 'Vehicle Registration',
    'href', '/mobile/kyc-vehicle',
    'capability', 'kyc.write',
    'icon', 'doc'
  );
  v_kyc_vehicle_photos_item JSONB := jsonb_build_object(
    'id', 'mobile-kyc-vehicle-photos',
    'label', 'Vehicle Photos',
    'href', '/mobile/kyc-vehicle-photos',
    'capability', 'kyc.write',
    'icon', 'camera'
  );
  v_cleaning_item JSONB := jsonb_build_object(
    'id', 'mobile-cleaning',
    'label', 'Cleaning Check',
    'href', '/mobile/cleaning',
    'capability', 'kyc.write',
    'icon', 'check-double'
  );
  v_pre_shift_item JSONB := jsonb_build_object(
    'id', 'mobile-pre-shift',
    'label', 'Pre-Shift',
    'href', '/mobile/pre-shift',
    'capability', 'tasks.read',
    'icon', 'shield'
  );

  v_v2_home_section JSONB;
  v_v2_network_ops_section JSONB;
  v_v2_onboarding_section JSONB;
BEGIN
  -- Build the three V2 sections
  v_v2_home_section := jsonb_build_object(
    'id', 'v2-home',
    'label', 'Home',
    'items', jsonb_build_array(
      v_tasks_item,
      v_loader_today_item,
      v_rider_today_item,
      v_supervisor_today_item
    )
  );
  v_v2_network_ops_section := jsonb_build_object(
    'id', 'v2-network-ops',
    'label', 'Network Operations',
    'items', jsonb_build_array(
      v_pickups_item,
      v_trips_item,
      v_sortation_item,
      v_lookup_item,
      v_returns_item,
      v_hub_pickup_item,
      v_hold_item,
      v_cash_drop_item,
      v_wallet_item,
      v_eor_item,
      v_trip_nav_item
    )
  );
  v_v2_onboarding_section := jsonb_build_object(
    'id', 'v2-onboarding',
    'label', 'Onboarding & Compliance',
    'items', jsonb_build_array(
      v_kyc_id_item,
      v_kyc_vehicle_item,
      v_kyc_vehicle_photos_item,
      v_cleaning_item,
      v_pre_shift_item
    )
  );

  -- Read current ui_navigation
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_navigation global settings missing';
  END IF;

  v_apps := COALESCE(v_current->'apps', '{}'::jsonb);
  v_mobile := COALESCE(v_apps->'mobile', jsonb_build_object('sections', '[]'::jsonb));
  v_sections := COALESCE(v_mobile->'sections', '[]'::jsonb);

  -- Walk existing sections, preserving each. If a V2 section already exists,
  -- we leave it alone (idempotent re-run); otherwise we add it after the loop.
  FOR v_section IN SELECT * FROM jsonb_array_elements(v_sections) LOOP
    v_existing_section_ids := array_append(v_existing_section_ids, v_section->>'id');
    v_new_sections := v_new_sections || jsonb_build_array(v_section);
  END LOOP;

  IF NOT ('v2-home' = ANY(v_existing_section_ids)) THEN
    v_new_sections := v_new_sections || jsonb_build_array(v_v2_home_section);
  END IF;
  IF NOT ('v2-network-ops' = ANY(v_existing_section_ids)) THEN
    v_new_sections := v_new_sections || jsonb_build_array(v_v2_network_ops_section);
  END IF;
  IF NOT ('v2-onboarding' = ANY(v_existing_section_ids)) THEN
    v_new_sections := v_new_sections || jsonb_build_array(v_v2_onboarding_section);
  END IF;

  v_mobile := jsonb_set(v_mobile, '{sections}', v_new_sections, true);
  v_apps := jsonb_set(v_apps, '{mobile}', v_mobile, true);
  v_current := jsonb_set(v_current, '{apps}', v_apps, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Mobile V2 navigation pack: register v2-home + v2-network-ops + v2-onboarding sections (FieldOps V2 design handoff)',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202605101800_mobile_v2_navigation_pack_v1'));
COMMIT;
