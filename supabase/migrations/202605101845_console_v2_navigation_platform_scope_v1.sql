-- Console V2 Organizations review navigation must be platform-scoped.
-- The route can be discovered by platform reviewers with either organizations
-- read or tenant-signup review read, but tenant-scoped account managers must
-- see it as gated instead of receiving a misleading clickable module link.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605101845_console_v2_navigation_platform_scope_v1'));

DO $$
DECLARE
  v_scope RECORD;
  v_current JSONB;
  v_sections JSONB;
  v_new_sections JSONB;
  v_section JSONB;
  v_items JSONB;
  v_new_items JSONB;
  v_item JSONB;
  v_path TEXT;
BEGIN
  FOR v_scope IN
    SELECT s.scope_type,
           s.scope_id,
           s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_scope.value, '{}'::jsonb);
    v_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
    v_new_sections := '[]'::jsonb;

    FOR v_section IN SELECT * FROM jsonb_array_elements(v_sections) LOOP
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      v_new_items := '[]'::jsonb;

      FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
        v_path := COALESCE(v_item->>'route', v_item->>'href');

        IF v_path IN ('/platform/organizations', '/console/organizations/requests')
           OR v_item->>'id' IN ('platform-organizations', 'console-organization-requests')
           OR v_item->>'key' IN ('organizations', 'platform-organizations', 'console-organization-requests') THEN
          v_item := jsonb_set(v_item, '{capability}', to_jsonb('organizations.read'::text), true);
          v_item := jsonb_set(
            v_item,
            '{capabilities}',
            jsonb_build_array('organizations.read', 'tenant_signup_requests.read'),
            true
          );
          v_item := jsonb_set(v_item, '{required_scope_type}', to_jsonb('platform'::text), true);
        END IF;

        v_new_items := v_new_items || jsonb_build_array(v_item);
      END LOOP;

      v_new_sections := v_new_sections || jsonb_build_array(jsonb_set(v_section, '{items}', v_new_items, true));
    END LOOP;

    v_current := jsonb_set(v_current, '{apps,console,sections}', v_new_sections, true);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = v_scope.version + 1,
           change_reason = 'Console V2: require platform scope for tenant signup review navigation',
           approved_at = now(),
           effective_from = now()
     WHERE sv.id = v_scope.settings_version_id
       AND v_current IS DISTINCT FROM sv.value;

    UPDATE public.settings s
       SET cached_value = v_current,
           last_updated = now()
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = v_scope.scope_type
       AND s.scope_id IS NOT DISTINCT FROM v_scope.scope_id
       AND s.settings_version_id = v_scope.settings_version_id
       AND v_current IS DISTINCT FROM s.cached_value;
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_navigation:%';
END $$;

SELECT pg_advisory_unlock(hashtext('202605101845_console_v2_navigation_platform_scope_v1'));

COMMIT;
