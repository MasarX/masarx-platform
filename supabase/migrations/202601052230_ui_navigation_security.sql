-- Migration: UI navigation security + provider auth links
BEGIN;
SELECT pg_advisory_lock(hashtext('202601052230_ui_navigation_security'));
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
  v_has_integrations BOOLEAN := FALSE;
  v_has_security BOOLEAN := FALSE;
  v_provider_auth JSONB := jsonb_build_object(
    'id', 'console-provider-auth',
    'label', 'Provider auth',
    'href', '/console/integrations/provider-auth',
    'resource', 'provider_auth_configs',
    'capability', 'provider_auth.read'
  );
  v_security_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'console-audit-logs',
      'label', 'Audit logs',
      'href', '/console/security/audit-logs',
      'resource', 'audit_table_changes',
      'capability', 'audit_log.read'
    ),
    jsonb_build_object(
      'id', 'console-token-rotations',
      'label', 'Token rotations',
      'href', '/console/security/token-rotation',
      'resource', 'token_rotation_requests',
      'capability', 'token_rotation.read'
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
    IF v_section->>'id' = 'integrations' THEN
      v_has_integrations := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_items) AS item
        WHERE item->>'id' = v_provider_auth->>'id'
      ) THEN
        v_items := v_items || jsonb_build_array(v_provider_auth);
      END IF;
      v_section := jsonb_set(v_section, '{items}', v_items, true);
    END IF;

    IF v_section->>'id' = 'security' THEN
      v_has_security := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      FOR v_candidate IN SELECT * FROM jsonb_array_elements(v_security_items) LOOP
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

  IF v_has_integrations IS FALSE THEN
    v_sections := v_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'integrations',
        'label', 'Integrations',
        'items', jsonb_build_array(v_provider_auth)
      )
    );
  END IF;

  IF v_has_security IS FALSE THEN
    v_sections := v_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'security',
        'label', 'Security',
        'items', v_security_items
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
           change_reason = 'Add security + provider auth navigation',
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

SELECT pg_advisory_unlock(hashtext('202601052230_ui_navigation_security'));
COMMIT;
