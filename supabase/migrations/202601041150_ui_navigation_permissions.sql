-- Migration: UI navigation access + users links
BEGIN;
SELECT pg_advisory_lock(hashtext('202601041150_ui_navigation_permissions'));
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
  v_has_access BOOLEAN := FALSE;
  v_new_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'console-access-overview',
      'label', 'Access overview',
      'href', '/console/access'
    ),
    jsonb_build_object(
      'id', 'console-access-policy',
      'label', 'Access policy',
      'href', '/console/access-policy',
      'capability', 'access_policy.read'
    ),
    jsonb_build_object(
      'id', 'console-access-policy-request',
      'label', 'Request access policy',
      'href', '/console/access-policy/request',
      'capability', 'access_policy.request'
    ),
    jsonb_build_object(
      'id', 'console-access-requests',
      'label', 'Access requests',
      'href', '/console/resources/manual_review_tasks?task_type=settings_approval',
      'resource', 'manual_review_tasks',
      'capability', 'manual_review.read'
    ),
    jsonb_build_object(
      'id', 'console-users',
      'label', 'Users',
      'href', '/console/resources/users',
      'resource', 'users',
      'capability', 'users.read'
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

  v_base := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);

  FOR v_section IN SELECT * FROM jsonb_array_elements(v_base) LOOP
    IF v_section->>'id' = 'access' THEN
      v_has_access := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      FOR v_candidate IN SELECT * FROM jsonb_array_elements(v_new_items) LOOP
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

  IF v_has_access IS FALSE THEN
    v_sections := v_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'access',
        'label', 'Access',
        'items', v_new_items
      )
    );
  END IF;

  v_current := jsonb_set(v_current, '{apps,console,sections}', v_sections, true);

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
        change_reason = 'Add access overview, requests, and users links',
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

SELECT pg_advisory_unlock(hashtext('202601041150_ui_navigation_permissions'));
COMMIT;
