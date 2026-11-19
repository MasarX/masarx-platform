-- Console V2 organization registry must never expose cross-tenant rows through
-- the shared security-definer list RPC. Tenant-scoped operators may read their
-- own organization profile, while platform reviewers keep the full registry.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605102320_console_v2_organization_registry_scope_guard_v1'));
SET LOCAL lock_timeout = '30s';
SET LOCAL search_path = public, extensions, pg_temp;

DO $$
DECLARE
  v_setting RECORD;
  v_current JSONB;
  v_resources JSONB;
BEGIN
  FOR v_setting IN
    SELECT s.id AS setting_id,
           s.settings_version_id,
           COALESCE(s.cached_value, sv.value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := v_setting.value;

    SELECT COALESCE(
             jsonb_agg(
               CASE
                 WHEN resource->>'key' = 'organizations' THEN
                   jsonb_set(
                     resource,
                     '{scope_columns}',
                     COALESCE(resource->'scope_columns', '{}'::jsonb)
                       || jsonb_build_object('tenant', 'id'),
                     true
                   )
                 ELSE resource
               END
               ORDER BY ordinality
             ),
             '[]'::jsonb
           )
      INTO v_resources
      FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb))
           WITH ORDINALITY AS r(resource, ordinality);

    IF NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_resources) AS r(resource)
       WHERE resource->>'key' = 'organizations'
         AND resource#>>'{scope_columns,tenant}' = 'id'
    ) THEN
      RAISE EXCEPTION 'ui_read_registry organizations resource missing tenant scope guard';
    END IF;

    v_current := jsonb_set(v_current, '{resources}', v_resources, true);

    UPDATE public.settings_versions
       SET value = v_current,
           updated_at = now(),
           change_reason = 'Console V2: scope organizations registry reads to active tenant'
     WHERE id = v_setting.settings_version_id
       AND value IS DISTINCT FROM v_current;

    UPDATE public.settings
       SET cached_value = v_current,
           last_updated = now()
     WHERE id = v_setting.setting_id
       AND cached_value IS DISTINCT FROM v_current;
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_read_registry:%'
      OR cache_key LIKE 'ui_list_resource:%organizations%';
END $$;

SELECT pg_advisory_unlock(hashtext('202605102320_console_v2_organization_registry_scope_guard_v1'));

COMMIT;
