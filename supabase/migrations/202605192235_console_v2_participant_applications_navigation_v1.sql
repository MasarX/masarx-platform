-- Migration: Console V2 participant applications navigation discoverability
-- Purpose:
--   Keep the backend-driven Console navigation aligned with the Network
--   participant review queue so operators can reach Participant applications
--   from the shell and command palette without relying on direct URLs.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605192235_console_v2_participant_applications_navigation_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes,
  request_capability
)
VALUES (
  'marketplace_participant_application_filter',
  'Console V2 participant applications lens filter. Keeps driver applications in the Fleet review surface.',
  FALSE,
  TRUE,
  FALSE,
  'return_null',
  '["global", "tenant"]'::jsonb,
  'settings.write'
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    requires_schema = EXCLUDED.requires_schema,
    requires_global_default = EXCLUDED.requires_global_default,
    side_effecting = EXCLUDED.side_effecting,
    safe_missing_behavior = EXCLUDED.safe_missing_behavior,
    allowed_scopes = EXCLUDED.allowed_scopes,
    request_capability = EXCLUDED.request_capability,
    updated_at = now();

DO $filter$
DECLARE
  v_current_id UUID;
  v_current_value JSONB;
  v_next_value JSONB := '{"excluded_type_keys":["freelancer_driver"]}'::jsonb;
  v_next_version INTEGER;
  v_new_id UUID;
BEGIN
  SELECT s.settings_version_id, COALESCE(sv.value, s.cached_value, '{}'::jsonb)
    INTO v_current_id, v_current_value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'marketplace_participant_application_filter'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current_id IS NULL THEN
    INSERT INTO public.settings_versions (
      category,
      scope_type,
      scope_id,
      version,
      value,
      schema_version,
      change_reason,
      approved_at
    )
    VALUES (
      'marketplace_participant_application_filter',
      'global',
      NULL,
      1,
      v_next_value,
      1,
      'Seed Console V2 participant application type filter',
      now()
    )
    RETURNING id INTO v_new_id;

    INSERT INTO public.settings (
      category,
      scope_type,
      scope_id,
      settings_version_id,
      cached_value,
      last_updated
    )
    VALUES (
      'marketplace_participant_application_filter',
      'global',
      NULL,
      v_new_id,
      v_next_value,
      now()
    );
  ELSIF v_current_value IS DISTINCT FROM v_next_value THEN
    UPDATE public.settings_versions
       SET effective_until = CASE
             WHEN now() <= effective_from THEN effective_from + interval '1 microsecond'
             ELSE now()
           END
     WHERE id = v_current_id;

    SELECT COALESCE(MAX(version), 0) + 1
      INTO v_next_version
      FROM public.settings_versions
     WHERE category = 'marketplace_participant_application_filter'
       AND scope_type = 'global'
       AND scope_id IS NULL;

    INSERT INTO public.settings_versions (
      category,
      scope_type,
      scope_id,
      version,
      value,
      schema_version,
      change_reason,
      approved_at
    )
    VALUES (
      'marketplace_participant_application_filter',
      'global',
      NULL,
      v_next_version,
      v_next_value,
      1,
      'Align Console V2 participant application type filter',
      now()
    )
    RETURNING id INTO v_new_id;

    UPDATE public.settings
       SET settings_version_id = v_new_id,
           cached_value = v_next_value,
           last_updated = now()
     WHERE category = 'marketplace_participant_application_filter'
       AND scope_type = 'global'
       AND scope_id IS NULL;
  END IF;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'marketplace_participant_application_filter:%';
END;
$filter$;

DO $navigation$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_next JSONB;
  v_sections JSONB;
  v_updated_sections JSONB;
  v_section JSONB;
  v_items JSONB;
  v_clean_items JSONB;
  v_section_id TEXT;
  v_has_network BOOLEAN;
  v_participant_item JSONB := jsonb_build_object(
    'id', 'network-participant-applications',
    'key', 'network-participant-applications',
    'label', 'Participant applications',
    'href', '/network/participant-applications',
    'route', '/network/participant-applications',
    'resource', 'marketplace_participant_requests',
    'capability', 'marketplace_participant_requests.read',
    'icon', 'user'
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      COALESCE(sv.value, s.cached_value, '{}'::jsonb) AS value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_sections) IS DISTINCT FROM 'array' THEN
      v_sections := '[]'::jsonb;
    END IF;

    v_updated_sections := '[]'::jsonb;
    v_has_network := FALSE;

    FOR v_section IN
      SELECT value
      FROM jsonb_array_elements(v_sections) AS value
    LOOP
      v_section_id := COALESCE(v_section->>'id', '');
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
        v_items := '[]'::jsonb;
      END IF;

      SELECT COALESCE(jsonb_agg(item.value ORDER BY item.ordinality), '[]'::jsonb)
        INTO v_clean_items
        FROM jsonb_array_elements(v_items) WITH ORDINALITY AS item(value, ordinality)
       WHERE COALESCE(item.value->>'id', item.value->>'key', '') NOT IN (
               'network-participant-applications',
               'participant-applications'
             )
         AND COALESCE(item.value->>'resource', '') <> 'marketplace_participant_requests'
         AND COALESCE(item.value->>'route', item.value->>'href', '') NOT IN (
               '/network/participant-applications',
               '/network/marketplace/participant-applications',
               '/console/resources/marketplace_participant_requests'
             );

      IF v_section_id = 'network' THEN
        v_has_network := TRUE;
        v_section := jsonb_set(
          v_section || jsonb_build_object('id', 'network', 'label', COALESCE(v_section->>'label', 'Network')),
          '{items}',
          v_clean_items || jsonb_build_array(v_participant_item),
          TRUE
        );
      ELSE
        v_section := jsonb_set(v_section, '{items}', v_clean_items, TRUE);
      END IF;

      v_updated_sections := v_updated_sections || jsonb_build_array(v_section);
    END LOOP;

    IF NOT v_has_network THEN
      v_updated_sections := v_updated_sections || jsonb_build_array(
        jsonb_build_object(
          'id', 'network',
          'label', 'Network',
          'items', jsonb_build_array(v_participant_item)
        )
      );
    END IF;

    v_next := jsonb_set(v_current, '{apps,console,sections}', v_updated_sections, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose Console V2 participant applications in live navigation',
             approved_at = now(),
             effective_from = now(),
             updated_at = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_navigation:%';
END;
$navigation$;

SELECT pg_advisory_unlock(hashtext('202605192235_console_v2_participant_applications_navigation_v1'));

COMMIT;
