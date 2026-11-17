-- Migration: UI navigation portal tracking and approvals
BEGIN;
SELECT pg_advisory_lock(hashtext('202601050900_ui_navigation_portal_tracking'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_sections JSONB := '[]'::jsonb;
  v_base JSONB;
  v_section JSONB;
  v_items JSONB;
  v_candidate JSONB;
  v_has_shipments BOOLEAN := FALSE;
  v_has_approvals BOOLEAN := FALSE;
  v_shipments_seed JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'portal-shipments',
      'label', 'Shipments',
      'href', '/portal/resources/shipments',
      'resource', 'shipments',
      'capability', 'shipments.read'
    ),
    jsonb_build_object(
      'id', 'portal-labels',
      'label', 'Labels',
      'href', '/portal/resources/labels',
      'resource', 'labels',
      'capability', 'labels.download'
    ),
    jsonb_build_object(
      'id', 'portal-label-jobs',
      'label', 'Label jobs',
      'href', '/portal/resources/label_jobs',
      'resource', 'label_jobs',
      'capability', 'labels.read'
    ),
    jsonb_build_object(
      'id', 'portal-tracking',
      'label', 'Tracking',
      'href', '/portal/tracking',
      'capability', 'shipments.read'
    )
  );
  v_shipments_additions JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'portal-label-jobs',
      'label', 'Label jobs',
      'href', '/portal/resources/label_jobs',
      'resource', 'label_jobs',
      'capability', 'labels.read'
    ),
    jsonb_build_object(
      'id', 'portal-tracking',
      'label', 'Tracking',
      'href', '/portal/tracking',
      'capability', 'shipments.read'
    )
  );
  v_approvals_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'portal-approvals',
      'label', 'Approvals',
      'href', '/portal/resources/manual_review_tasks',
      'resource', 'manual_review_tasks',
      'capability', 'manual_review.read'
    )
  );
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

  v_base := COALESCE(v_current#>'{apps,portal,sections}', '[]'::jsonb);

  FOR v_section IN SELECT * FROM jsonb_array_elements(v_base) LOOP
    IF v_section->>'id' = 'shipments' THEN
      v_has_shipments := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      FOR v_candidate IN SELECT * FROM jsonb_array_elements(v_shipments_additions) LOOP
        IF NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_items) AS item
          WHERE item->>'id' = v_candidate->>'id'
        ) THEN
          v_items := v_items || jsonb_build_array(v_candidate);
        END IF;
      END LOOP;
      v_section := jsonb_set(v_section, '{items}', v_items, true);
    END IF;

    IF v_section->>'id' = 'approvals' THEN
      v_has_approvals := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      FOR v_candidate IN SELECT * FROM jsonb_array_elements(v_approvals_items) LOOP
        IF NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_items) AS item
          WHERE item->>'id' = v_candidate->>'id'
        ) THEN
          v_items := v_items || jsonb_build_array(v_candidate);
        END IF;
      END LOOP;
      v_section := jsonb_set(v_section, '{items}', v_items, true);
    END IF;

    v_sections := v_sections || jsonb_build_array(v_section);
  END LOOP;

  IF v_has_shipments IS FALSE THEN
    v_sections := v_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'shipments',
        'label', 'Shipments',
        'items', v_shipments_seed
      )
    );
  END IF;

  IF v_has_approvals IS FALSE THEN
    v_sections := v_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'approvals',
        'label', 'Approvals',
        'items', v_approvals_items
      )
    );
  END IF;

  v_current := jsonb_set(v_current, '{apps,portal,sections}', v_sections, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
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
        change_reason = 'Add portal tracking and approvals navigation',
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

SELECT pg_advisory_unlock(hashtext('202601050900_ui_navigation_portal_tracking'));
COMMIT;
