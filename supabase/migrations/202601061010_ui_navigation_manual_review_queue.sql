-- Migration: UI navigation manual review queue routes
BEGIN;
SELECT pg_advisory_lock(hashtext('202601061010_ui_navigation_manual_review_queue'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_sections JSONB := '[]'::jsonb;
  v_base JSONB;
  v_section JSONB;
  v_items JSONB := '[]'::jsonb;
  v_item JSONB;
  v_has_workflows BOOLEAN := FALSE;
  v_queue_item JSONB := jsonb_build_object(
    'id', 'manual-review',
    'label', 'Manual review queue',
    'href', '/console/workflows/queue',
    'resource', 'manual_review_tasks',
    'capability', 'manual_review.read'
  );
  v_my_tasks_item JSONB := jsonb_build_object(
    'id', 'manual-review-tasks',
    'label', 'My tasks',
    'href', '/console/workflows/tasks',
    'resource', 'manual_review_tasks',
    'capability', 'manual_review.read'
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
    IF v_section->>'id' = 'workflows' THEN
      v_has_workflows := TRUE;
      v_items := '[]'::jsonb;
      FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(v_section->'items', '[]'::jsonb)) LOOP
        IF v_item->>'id' = 'manual-review' THEN
          v_item := jsonb_set(v_item, '{label}', to_jsonb('Manual review queue'::text), true);
          v_item := jsonb_set(v_item, '{href}', to_jsonb('/console/workflows/queue'::text), true);
          v_item := jsonb_set(v_item, '{resource}', to_jsonb('manual_review_tasks'::text), true);
          v_item := jsonb_set(v_item, '{capability}', to_jsonb('manual_review.read'::text), true);
        END IF;
        v_items := v_items || jsonb_build_array(v_item);
      END LOOP;

      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_items) AS item
        WHERE item->>'id' = 'manual-review'
      ) THEN
        v_items := v_items || jsonb_build_array(v_queue_item);
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_items) AS item
        WHERE item->>'id' = 'manual-review-tasks'
      ) THEN
        v_items := v_items || jsonb_build_array(v_my_tasks_item);
      END IF;

      v_section := jsonb_set(v_section, '{items}', v_items, true);
    END IF;
    v_sections := v_sections || jsonb_build_array(v_section);
  END LOOP;

  IF v_has_workflows IS FALSE THEN
    v_sections := v_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'workflows',
        'label', 'Workflows',
        'items', jsonb_build_array(v_queue_item, v_my_tasks_item)
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
        change_reason = 'Update manual review workflow navigation',
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

SELECT pg_advisory_unlock(hashtext('202601061010_ui_navigation_manual_review_queue'));
COMMIT;
