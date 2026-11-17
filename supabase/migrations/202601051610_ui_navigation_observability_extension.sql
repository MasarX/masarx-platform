BEGIN;
SELECT pg_advisory_lock(hashtext('202601051610_ui_navigation_observability_extension'));
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
  v_has_observability BOOLEAN := FALSE;
  v_new_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'domain-events',
      'label', 'Domain events',
      'href', '/console/observability/domain-events',
      'resource', 'domain_events',
      'capability', 'requests.read'
    ),
    jsonb_build_object(
      'id', 'workflow-runs',
      'label', 'Workflow runs',
      'href', '/console/observability/workflow-runs',
      'resource', 'workflow_runs',
      'capability', 'workflow_runs.read'
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
    IF v_section->>'id' = 'observability' THEN
      v_has_observability := TRUE;
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

  IF v_has_observability IS FALSE THEN
    v_sections := v_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'observability',
        'label', 'Observability',
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
        change_reason = 'Add domain events and workflow runs navigation',
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

SELECT pg_advisory_unlock(hashtext('202601051610_ui_navigation_observability_extension'));
COMMIT;
