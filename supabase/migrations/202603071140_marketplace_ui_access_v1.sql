-- Plan: PLAN-202603-marketplace-network-v1 / Step: S04
-- Migration: Marketplace UI registry + navigation + access control wiring

BEGIN;
SELECT pg_advisory_lock(hashtext('202603071140_marketplace_ui_access_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) access_control_policy capabilities + role wiring
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_current JSONB;
  v_next JSONB;
  v_capabilities JSONB := '[]'::jsonb;
  v_roles JSONB := '[]'::jsonb;
  v_updated_roles JSONB := '[]'::jsonb;
  v_entry JSONB;
  v_role_key TEXT;
  v_keys JSONB;
  v_capability JSONB;
  v_capability_key TEXT;
  v_new_capabilities JSONB := jsonb_build_array(
    jsonb_build_object('key', 'marketplace_requests.read', 'label', 'Marketplace requests read', 'category', 'marketplace'),
    jsonb_build_object('key', 'marketplace_requests.write', 'label', 'Marketplace requests write', 'category', 'marketplace'),
    jsonb_build_object('key', 'marketplace_offers.read', 'label', 'Marketplace offers read', 'category', 'marketplace'),
    jsonb_build_object('key', 'marketplace_offers.write', 'label', 'Marketplace offers write', 'category', 'marketplace'),
    jsonb_build_object('key', 'marketplace_awards.read', 'label', 'Marketplace awards read', 'category', 'marketplace'),
    jsonb_build_object('key', 'marketplace_awards.write', 'label', 'Marketplace awards write', 'category', 'marketplace'),
    jsonb_build_object('key', 'marketplace_contracts.read', 'label', 'Marketplace contracts read', 'category', 'marketplace'),
    jsonb_build_object('key', 'marketplace_contracts.write', 'label', 'Marketplace contracts write', 'category', 'marketplace'),
    jsonb_build_object('key', 'marketplace_work_packages.read', 'label', 'Marketplace work packages read', 'category', 'marketplace'),
    jsonb_build_object('key', 'marketplace_work_packages.write', 'label', 'Marketplace work packages write', 'category', 'marketplace'),
    jsonb_build_object('key', 'marketplace_participants.read', 'label', 'Marketplace participants read', 'category', 'marketplace'),
    jsonb_build_object('key', 'marketplace_participants.write', 'label', 'Marketplace participants write', 'category', 'marketplace'),
    jsonb_build_object('key', 'marketplace_participant_requests.read', 'label', 'Marketplace participant requests read', 'category', 'marketplace'),
    jsonb_build_object('key', 'marketplace_participant_requests.review', 'label', 'Marketplace participant requests review', 'category', 'marketplace'),
    jsonb_build_object('key', 'marketplace_verification_records.read', 'label', 'Marketplace verification read', 'category', 'marketplace'),
    jsonb_build_object('key', 'marketplace_verification_records.write', 'label', 'Marketplace verification write', 'category', 'marketplace'),
    jsonb_build_object('key', 'marketplace_disputes.read', 'label', 'Marketplace disputes read', 'category', 'marketplace'),
    jsonb_build_object('key', 'marketplace_disputes.write', 'label', 'Marketplace disputes write', 'category', 'marketplace'),
    jsonb_build_object('key', 'marketplace_reputation_snapshots.read', 'label', 'Marketplace reputation read', 'category', 'marketplace')
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'access_control_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'access_control_policy global settings missing';
  END IF;

  v_capabilities := COALESCE(v_current->'capabilities', '[]'::jsonb);
  FOR v_capability IN SELECT * FROM jsonb_array_elements(v_new_capabilities) LOOP
    v_capability_key := NULLIF(v_capability->>'key', '');
    IF v_capability_key IS NULL THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_capabilities) AS item
       WHERE item->>'key' = v_capability_key
    ) THEN
      v_capabilities := v_capabilities || jsonb_build_array(v_capability);
    END IF;
  END LOOP;

  v_roles := COALESCE(v_current->'roles', '[]'::jsonb);
  FOR v_entry IN SELECT * FROM jsonb_array_elements(v_roles) LOOP
    v_role_key := NULLIF(v_entry->>'key', '');
    v_keys := COALESCE(v_entry->'capability_keys', '[]'::jsonb);
    IF jsonb_typeof(v_keys) <> 'array' THEN
      v_keys := '[]'::jsonb;
    END IF;

    IF v_role_key IN ('ops_admin', 'account_manager', 'fleet_manager') THEN
      FOR v_capability_key IN
        SELECT value
          FROM jsonb_array_elements_text(
            '[
              "marketplace_requests.read",
              "marketplace_requests.write",
              "marketplace_offers.read",
              "marketplace_offers.write",
              "marketplace_awards.read",
              "marketplace_awards.write",
              "marketplace_contracts.read",
              "marketplace_contracts.write",
              "marketplace_work_packages.read",
              "marketplace_work_packages.write",
              "marketplace_participants.read",
              "marketplace_participants.write",
              "marketplace_participant_requests.read",
              "marketplace_participant_requests.review",
              "marketplace_verification_records.read",
              "marketplace_verification_records.write",
              "marketplace_disputes.read",
              "marketplace_disputes.write",
              "marketplace_reputation_snapshots.read"
            ]'::jsonb
          ) AS cap(value)
      LOOP
        IF NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(v_keys) AS value
          WHERE value IN (v_capability_key, '*')
        ) THEN
          v_keys := v_keys || jsonb_build_array(v_capability_key);
        END IF;
      END LOOP;
      v_entry := jsonb_set(v_entry, '{capability_keys}', v_keys, TRUE);
    ELSIF v_role_key = 'driver' THEN
      FOR v_capability_key IN
        SELECT value
          FROM jsonb_array_elements_text(
            '[
              "marketplace_requests.read",
              "marketplace_offers.read",
              "marketplace_offers.write",
              "marketplace_awards.read",
              "marketplace_awards.write",
              "marketplace_contracts.read",
              "marketplace_work_packages.read",
              "marketplace_reputation_snapshots.read",
              "marketplace_participants.read"
            ]'::jsonb
          ) AS cap(value)
      LOOP
        IF NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(v_keys) AS value
          WHERE value IN (v_capability_key, '*')
        ) THEN
          v_keys := v_keys || jsonb_build_array(v_capability_key);
        END IF;
      END LOOP;
      v_entry := jsonb_set(v_entry, '{capability_keys}', v_keys, TRUE);
    END IF;

    v_updated_roles := v_updated_roles || jsonb_build_array(v_entry);
  END LOOP;

  v_next := v_current;
  v_next := jsonb_set(v_next, '{capabilities}', v_capabilities, TRUE);
  v_next := jsonb_set(v_next, '{roles}', v_updated_roles, TRUE);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'access_control_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_next,
           version = current.version + 1,
           change_reason = 'Add marketplace capabilities and role defaults',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_next IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.category = 'access_control_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

-------------------------------------------------------------------------------
-- 2) ui_read_registry marketplace resources
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_item JSONB;
  v_updated JSONB := '[]'::jsonb;
  v_new_resources JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'marketplace_participant_requests',
      'label', 'Marketplace participant requests',
      'relation', 'public.marketplace_participant_requests',
      'id_column', 'id',
      'capability_read', 'marketplace_participant_requests.read',
      'capability_write', 'marketplace_participant_requests.review',
      'select', jsonb_build_array('id','status','review_decision','requested_participant_type_key','email','full_name','organization_name','organization_slug','created_at','reviewed_at','reviewed_by','review_reason','invite_redirect_to','approved_organization_id','approved_participant_profile_id','last_error_code','last_error_message'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'requested_participant_type_key', 'column', 'requested_participant_type_key', 'op', 'eq'),
        jsonb_build_object('key', 'email', 'column', 'email', 'op', 'ilike'),
        jsonb_build_object('key', 'organization_name', 'column', 'organization_name', 'op', 'ilike')
      ),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
    ),
    jsonb_build_object(
      'key', 'marketplace_participants',
      'label', 'Marketplace participants',
      'relation', 'public.marketplace_participant_profiles',
      'id_column', 'id',
      'capability_read', 'marketplace_participants.read',
      'capability_write', 'marketplace_participants.write',
      'select', jsonb_build_array('id','organization_id','participant_type_key','status','listing_status','compliance_state','display_name','legal_name','contact_email','rating_overall','rating_count','last_verified_at','suspended_at','created_at','updated_at'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'participant_type_key', 'column', 'participant_type_key', 'op', 'eq'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'listing_status', 'column', 'listing_status', 'op', 'eq'),
        jsonb_build_object('key', 'display_name', 'column', 'display_name', 'op', 'ilike')
      ),
      'default_sort', jsonb_build_object('column', 'updated_at', 'direction', 'desc')
    ),
    jsonb_build_object(
      'key', 'marketplace_verification_records',
      'label', 'Marketplace verification records',
      'relation', 'public.marketplace_verification_records',
      'id_column', 'id',
      'capability_read', 'marketplace_verification_records.read',
      'capability_write', 'marketplace_verification_records.write',
      'select', jsonb_build_array('id','participant_profile_id','document_type_key','status','document_ref','issued_at','expires_at','reviewed_at','reviewed_by','reviewer_notes','created_at','updated_at'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'participant_profile_id', 'column', 'participant_profile_id', 'op', 'eq'),
        jsonb_build_object('key', 'document_type_key', 'column', 'document_type_key', 'op', 'eq'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'updated_at', 'direction', 'desc')
    ),
    jsonb_build_object(
      'key', 'marketplace_requests',
      'label', 'Marketplace requests',
      'relation', 'public.marketplace_requests',
      'id_column', 'id',
      'capability_read', 'marketplace_requests.read',
      'capability_write', 'marketplace_requests.write',
      'select', jsonb_build_array('id','requester_organization_id','request_kind_key','status','release_state','title','summary','visibility_mode_key','pricing_mode_key','negotiation_mode_key','ownership_mode_key','settlement_mode_key','tracking_display_mode_key','published_at','expires_at','closed_at','awarded_offer_id','created_at','updated_at'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'request_kind_key', 'column', 'request_kind_key', 'op', 'eq'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'release_state', 'column', 'release_state', 'op', 'eq'),
        jsonb_build_object('key', 'title', 'column', 'title', 'op', 'ilike')
      ),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
    ),
    jsonb_build_object(
      'key', 'marketplace_offers',
      'label', 'Marketplace offers',
      'relation', 'public.marketplace_offers',
      'id_column', 'id',
      'capability_read', 'marketplace_offers.read',
      'capability_write', 'marketplace_offers.write',
      'select', jsonb_build_array('id','request_id','supplier_participant_profile_id','supplier_organization_id','status','message','submitted_at','responded_at','expires_at','withdrawn_at','created_at','updated_at'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'request_id', 'column', 'request_id', 'op', 'eq'),
        jsonb_build_object('key', 'supplier_organization_id', 'column', 'supplier_organization_id', 'op', 'eq'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'submitted_at', 'direction', 'desc')
    ),
    jsonb_build_object(
      'key', 'marketplace_awards',
      'label', 'Marketplace awards',
      'relation', 'public.marketplace_awards',
      'id_column', 'id',
      'capability_read', 'marketplace_awards.read',
      'capability_write', 'marketplace_awards.write',
      'select', jsonb_build_array('id','request_id','offer_id','requester_organization_id','supplier_organization_id','supplier_participant_profile_id','status','awarded_by_user_id','award_reason','accepted_at','rejected_at','expires_at','created_at','updated_at'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'request_id', 'column', 'request_id', 'op', 'eq'),
        jsonb_build_object('key', 'supplier_organization_id', 'column', 'supplier_organization_id', 'op', 'eq'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
    ),
    jsonb_build_object(
      'key', 'marketplace_contracts',
      'label', 'Marketplace contracts',
      'relation', 'public.marketplace_contracts',
      'id_column', 'id',
      'capability_read', 'marketplace_contracts.read',
      'capability_write', 'marketplace_contracts.write',
      'select', jsonb_build_array('id','award_id','request_id','requester_organization_id','supplier_organization_id','supplier_participant_profile_id','status','ownership_mode_key','settlement_mode_key','activated_at','completed_at','cancelled_at','created_at','updated_at'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'request_id', 'column', 'request_id', 'op', 'eq'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'supplier_organization_id', 'column', 'supplier_organization_id', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
    ),
    jsonb_build_object(
      'key', 'marketplace_work_packages',
      'label', 'Marketplace work packages',
      'relation', 'public.marketplace_work_packages',
      'id_column', 'id',
      'capability_read', 'marketplace_work_packages.read',
      'capability_write', 'marketplace_work_packages.write',
      'select', jsonb_build_array('id','contract_id','award_id','request_id','requester_organization_id','supplier_organization_id','supplier_participant_profile_id','materializer_key','status','materialization_state','materialized_at','completed_at','cancelled_at','created_at','updated_at'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'request_id', 'column', 'request_id', 'op', 'eq'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'materialization_state', 'column', 'materialization_state', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
    ),
    jsonb_build_object(
      'key', 'marketplace_disputes',
      'label', 'Marketplace disputes',
      'relation', 'public.marketplace_disputes',
      'id_column', 'id',
      'capability_read', 'marketplace_disputes.read',
      'capability_write', 'marketplace_disputes.write',
      'select', jsonb_build_array('id','request_id','contract_id','work_package_id','opened_by_organization_id','counterparty_organization_id','status','category','title','resolved_at','resolved_by_user_id','created_at','updated_at'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'category', 'column', 'category', 'op', 'eq'),
        jsonb_build_object('key', 'title', 'column', 'title', 'op', 'ilike')
      ),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
    ),
    jsonb_build_object(
      'key', 'marketplace_reputation_snapshots',
      'label', 'Marketplace reputation snapshots',
      'relation', 'public.marketplace_reputation_snapshots',
      'id_column', 'participant_profile_id',
      'capability_read', 'marketplace_reputation_snapshots.read',
      'select', jsonb_build_array('participant_profile_id','organization_id','score','event_count','completion_rate','cancellation_rate','dispute_rate','document_freshness','feedback_score','updated_at'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'updated_at', 'direction', 'desc')
    )
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

  FOR v_resource IN SELECT * FROM jsonb_array_elements(v_new_resources) LOOP
    v_updated := '[]'::jsonb;
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_resources) LOOP
      IF v_item->>'key' = v_resource->>'key' THEN
        v_item := v_resource;
      END IF;
      v_updated := v_updated || jsonb_build_array(v_item);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_resources) AS item
       WHERE item->>'key' = v_resource->>'key'
    ) THEN
      v_updated := v_updated || jsonb_build_array(v_resource);
    END IF;

    v_resources := v_updated;
  END LOOP;

  v_current := jsonb_set(v_current, '{resources}', v_resources, TRUE);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Add marketplace resources to ui_read_registry',
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
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

-------------------------------------------------------------------------------
-- 3) ui_navigation marketplace sections (portal, console, mobile)
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_current JSONB;
  v_apps JSONB := '{}'::jsonb;
  v_app_key TEXT;
  v_app JSONB;
  v_sections JSONB;
  v_new_sections JSONB;
  v_section JSONB;
  v_marketplace_section JSONB;
  v_found BOOLEAN;
BEGIN
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

  FOREACH v_app_key IN ARRAY ARRAY['portal', 'console', 'mobile']
  LOOP
    v_app := COALESCE(v_apps->v_app_key, '{}'::jsonb);
    v_sections := COALESCE(v_app->'sections', '[]'::jsonb);
    v_new_sections := '[]'::jsonb;
    v_found := FALSE;

    IF v_app_key = 'portal' THEN
      v_marketplace_section := jsonb_build_object(
        'id', 'marketplace',
        'label', 'Marketplace',
        'items', jsonb_build_array(
          jsonb_build_object('id', 'portal-marketplace-requests', 'label', 'Requests', 'href', '/portal/marketplace/requests', 'resource', 'marketplace_requests', 'capability', 'marketplace_requests.read'),
          jsonb_build_object('id', 'portal-marketplace-new-request', 'label', 'New request', 'href', '/portal/marketplace/requests/new', 'capability', 'marketplace_requests.write'),
          jsonb_build_object('id', 'portal-marketplace-contracts', 'label', 'Contracts', 'href', '/portal/marketplace/contracts', 'resource', 'marketplace_contracts', 'capability', 'marketplace_contracts.read'),
          jsonb_build_object('id', 'portal-marketplace-network', 'label', 'Network', 'href', '/portal/marketplace/network', 'resource', 'marketplace_participants', 'capability', 'marketplace_participants.read'),
          jsonb_build_object('id', 'portal-marketplace-work-packages', 'label', 'Work packages', 'href', '/portal/marketplace/work-packages', 'resource', 'marketplace_work_packages', 'capability', 'marketplace_work_packages.read')
        )
      );
    ELSIF v_app_key = 'console' THEN
      v_marketplace_section := jsonb_build_object(
        'id', 'marketplace',
        'label', 'Marketplace',
        'items', jsonb_build_array(
          jsonb_build_object('id', 'console-marketplace-reviews', 'label', 'Reviews', 'href', '/console/marketplace/reviews', 'resource', 'marketplace_participant_requests', 'capability', 'marketplace_participant_requests.read'),
          jsonb_build_object('id', 'console-marketplace-participants', 'label', 'Participants', 'href', '/console/marketplace/participants', 'resource', 'marketplace_participants', 'capability', 'marketplace_participants.read'),
          jsonb_build_object('id', 'console-marketplace-disputes', 'label', 'Disputes', 'href', '/console/marketplace/disputes', 'resource', 'marketplace_disputes', 'capability', 'marketplace_disputes.read')
        )
      );
    ELSE
      v_marketplace_section := jsonb_build_object(
        'id', 'marketplace',
        'label', 'Marketplace',
        'items', jsonb_build_array(
          jsonb_build_object('id', 'mobile-marketplace-available', 'label', 'Available work', 'href', '/mobile/resources/marketplace_requests', 'resource', 'marketplace_requests', 'capability', 'marketplace_requests.read'),
          jsonb_build_object('id', 'mobile-marketplace-offers', 'label', 'My offers', 'href', '/mobile/resources/marketplace_offers', 'resource', 'marketplace_offers', 'capability', 'marketplace_offers.read'),
          jsonb_build_object('id', 'mobile-marketplace-awards', 'label', 'My awards', 'href', '/mobile/resources/marketplace_awards', 'resource', 'marketplace_awards', 'capability', 'marketplace_awards.read'),
          jsonb_build_object('id', 'mobile-marketplace-work-packages', 'label', 'Work packages', 'href', '/mobile/resources/marketplace_work_packages', 'resource', 'marketplace_work_packages', 'capability', 'marketplace_work_packages.read')
        )
      );
    END IF;

    FOR v_section IN SELECT * FROM jsonb_array_elements(v_sections) LOOP
      IF v_section->>'id' = 'marketplace' THEN
        v_found := TRUE;
        v_section := v_marketplace_section;
      END IF;
      v_new_sections := v_new_sections || jsonb_build_array(v_section);
    END LOOP;

    IF NOT v_found THEN
      v_new_sections := v_new_sections || jsonb_build_array(v_marketplace_section);
    END IF;

    v_app := jsonb_set(v_app, '{sections}', v_new_sections, TRUE);
    v_apps := jsonb_set(v_apps, ARRAY[v_app_key], v_app, TRUE);
  END LOOP;

  v_current := jsonb_set(v_current, '{apps}', v_apps, TRUE);

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
           change_reason = 'Add marketplace sections to portal, console, and mobile navigation',
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

-------------------------------------------------------------------------------
-- 4) ui_command_registry marketplace commands
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_current JSONB;
  v_commands JSONB := '[]'::jsonb;
  v_command JSONB;
  v_new_commands JSONB := jsonb_build_array(
    jsonb_build_object('key', 'marketplace.approve', 'label', 'Approve participant', 'capability', 'marketplace_participant_requests.review', 'execution', jsonb_build_object('type', 'rpc', 'rpc', 'marketplace_participant_request_review_apply_v1')),
    jsonb_build_object('key', 'marketplace.quote', 'label', 'Submit offer', 'capability', 'marketplace_offers.write', 'execution', jsonb_build_object('type', 'rpc', 'rpc', 'marketplace_offer_submit_v1')),
    jsonb_build_object('key', 'marketplace.award', 'label', 'Award offer', 'capability', 'marketplace_awards.write', 'execution', jsonb_build_object('type', 'rpc', 'rpc', 'marketplace_award_offer_v1')),
    jsonb_build_object('key', 'marketplace.dispute', 'label', 'Open dispute', 'capability', 'marketplace_disputes.write', 'execution', jsonb_build_object('type', 'rpc', 'rpc', 'marketplace_dispute_open_v1')),
    jsonb_build_object('key', 'marketplace.settle', 'label', 'Materialize work package', 'capability', 'marketplace_work_packages.write', 'execution', jsonb_build_object('type', 'rpc', 'rpc', 'marketplace_work_package_materialize_v1'))
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_command_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_command_registry global settings missing';
  END IF;

  v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
  FOR v_command IN SELECT * FROM jsonb_array_elements(v_new_commands) LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_commands) AS item
       WHERE item->>'key' = v_command->>'key'
    ) THEN
      v_commands := v_commands || jsonb_build_array(v_command);
    END IF;
  END LOOP;

  v_current := jsonb_set(v_current, '{commands}', v_commands, TRUE);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Add marketplace UI command registry entries',
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
   WHERE s.category = 'ui_command_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202603071140_marketplace_ui_access_v1'));
COMMIT;
