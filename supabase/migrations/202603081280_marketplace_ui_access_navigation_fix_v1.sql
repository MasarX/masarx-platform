-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S05
-- Migration: Marketplace UI access and navigation product-complete fixup

BEGIN;
SELECT pg_advisory_lock(hashtext('202603081280_marketplace_ui_access_navigation_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Extend driver defaults for provider-facing marketplace execution
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_row RECORD;
  v_next JSONB;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
  LOOP
    v_next := jsonb_set(
      v_row.value,
      '{roles}',
      COALESCE(
        (
          SELECT jsonb_agg(
                   CASE
                     WHEN item->>'key' = 'driver' THEN
                       jsonb_set(
                         item,
                         '{capability_keys}',
                         COALESCE(
                           (
                             SELECT jsonb_agg(to_jsonb(capability_key))
                             FROM (
                               SELECT DISTINCT capability_key
                               FROM (
                                 SELECT value AS capability_key
                                 FROM jsonb_array_elements_text(COALESCE(item->'capability_keys', '[]'::jsonb))
                                 UNION ALL
                                 SELECT 'marketplace_participants.write'
                                 UNION ALL
                                 SELECT 'marketplace_work_packages.write'
                               ) capability_union
                               WHERE NULLIF(btrim(capability_key), '') IS NOT NULL
                               ORDER BY capability_key
                             ) capability_list
                           ),
                           '[]'::jsonb
                         ),
                         TRUE
                       )
                     ELSE item
                   END
                 )
          FROM jsonb_array_elements(COALESCE(v_row.value->'roles', '[]'::jsonb)) AS item
        ),
        '[]'::jsonb
      ),
      TRUE
    );

    IF v_next IS DISTINCT FROM v_row.value THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = COALESCE(v_row.version, 0) + 1,
             change_reason = 'Extend driver marketplace execution capabilities for product-complete phase',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END $$;

-------------------------------------------------------------------------------
-- 2) Fix product-complete marketplace navigation under apps.portal|console|mobile
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_next JSONB;
  v_apps JSONB;
  v_app_key TEXT;
  v_app JSONB;
  v_sections JSONB;
  v_new_sections JSONB;
  v_section JSONB;
  v_marketplace_section JSONB;
  v_found BOOLEAN;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    v_apps := COALESCE(v_current->'apps', '{}'::jsonb);

    FOREACH v_app_key IN ARRAY ARRAY['portal', 'console', 'mobile']
    LOOP
      v_app := COALESCE(v_apps->v_app_key, '{}'::jsonb);
      v_sections := COALESCE(v_app->'sections', '[]'::jsonb);
      IF jsonb_typeof(v_sections) IS DISTINCT FROM 'array' THEN
        v_sections := '[]'::jsonb;
      END IF;

      IF v_app_key = 'portal' THEN
        v_marketplace_section := jsonb_build_object(
          'id', 'marketplace',
          'label', 'Marketplace',
          'items', jsonb_build_array(
            jsonb_build_object('id', 'portal-marketplace-requests', 'label', 'Requests', 'href', '/portal/marketplace/requests', 'resource', 'marketplace_requests', 'capability', 'marketplace_requests.read'),
            jsonb_build_object('id', 'portal-marketplace-new-request', 'label', 'New request', 'href', '/portal/marketplace/requests/new', 'capability', 'marketplace_requests.write'),
            jsonb_build_object('id', 'portal-marketplace-provider', 'label', 'Provider workboard', 'href', '/portal/marketplace/provider', 'capability', 'marketplace_offers.read'),
            jsonb_build_object('id', 'portal-marketplace-contracts', 'label', 'Contracts', 'href', '/portal/marketplace/contracts', 'resource', 'marketplace_contracts', 'capability', 'marketplace_contracts.read'),
            jsonb_build_object('id', 'portal-marketplace-private-pools', 'label', 'Private pools', 'href', '/portal/marketplace/private-pools', 'resource', 'marketplace_private_pools', 'capability', 'marketplace_requests.read'),
            jsonb_build_object('id', 'portal-marketplace-settlements', 'label', 'Settlements', 'href', '/portal/marketplace/settlements', 'resource', 'marketplace_settlement_batches', 'capability', 'marketplace_contracts.read'),
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
            jsonb_build_object('id', 'console-marketplace-disputes', 'label', 'Disputes', 'href', '/console/marketplace/disputes', 'resource', 'marketplace_disputes', 'capability', 'marketplace_disputes.read'),
            jsonb_build_object('id', 'console-marketplace-contracts', 'label', 'Contracts', 'href', '/console/marketplace/contracts', 'resource', 'marketplace_contracts', 'capability', 'marketplace_contracts.read'),
            jsonb_build_object('id', 'console-marketplace-settlements', 'label', 'Settlements', 'href', '/console/marketplace/settlements', 'resource', 'marketplace_settlement_batches', 'capability', 'marketplace_contracts.read')
          )
        );
      ELSE
        v_marketplace_section := jsonb_build_object(
          'id', 'marketplace',
          'label', 'Marketplace',
          'items', jsonb_build_array(
            jsonb_build_object('id', 'mobile-marketplace-availability', 'label', 'Availability', 'href', '/mobile/resources/marketplace_availability_windows', 'resource', 'marketplace_availability_windows', 'capability', 'marketplace_participants.read'),
            jsonb_build_object('id', 'mobile-marketplace-available', 'label', 'Available work', 'href', '/mobile/resources/marketplace_requests', 'resource', 'marketplace_requests', 'capability', 'marketplace_requests.read'),
            jsonb_build_object('id', 'mobile-marketplace-offers', 'label', 'My offers', 'href', '/mobile/resources/marketplace_offers', 'resource', 'marketplace_offers', 'capability', 'marketplace_offers.read'),
            jsonb_build_object('id', 'mobile-marketplace-awards', 'label', 'My awards', 'href', '/mobile/resources/marketplace_awards', 'resource', 'marketplace_awards', 'capability', 'marketplace_awards.read'),
            jsonb_build_object('id', 'mobile-marketplace-contracts', 'label', 'Contract summary', 'href', '/mobile/resources/marketplace_contracts', 'resource', 'marketplace_contracts', 'capability', 'marketplace_contracts.read'),
            jsonb_build_object('id', 'mobile-marketplace-work-packages', 'label', 'Work packages', 'href', '/mobile/resources/marketplace_work_packages', 'resource', 'marketplace_work_packages', 'capability', 'marketplace_work_packages.read')
          )
        );
      END IF;

      v_new_sections := '[]'::jsonb;
      v_found := FALSE;

      FOR v_section IN SELECT * FROM jsonb_array_elements(v_sections)
      LOOP
        IF v_section->>'id' = 'marketplace' THEN
          v_new_sections := v_new_sections || jsonb_build_array(v_marketplace_section);
          v_found := TRUE;
        ELSE
          v_new_sections := v_new_sections || jsonb_build_array(v_section);
        END IF;
      END LOOP;

      IF NOT v_found THEN
        v_new_sections := v_new_sections || jsonb_build_array(v_marketplace_section);
      END IF;

      v_app := jsonb_set(v_app, '{sections}', v_new_sections, TRUE);
      v_apps := jsonb_set(v_apps, ARRAY[v_app_key], v_app, TRUE);
    END LOOP;

    v_next := jsonb_set(v_current, '{apps}', v_apps, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = COALESCE(v_row.version, 0) + 1,
             change_reason = 'Fix marketplace navigation under app-scoped ui_navigation entries',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END $$;

SELECT pg_advisory_unlock(hashtext('202603081280_marketplace_ui_access_navigation_fix_v1'));
COMMIT;
