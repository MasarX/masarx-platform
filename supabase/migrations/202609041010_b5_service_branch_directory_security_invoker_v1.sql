-- Expose the branch directory through a narrow security-invoker API projection.
BEGIN;

SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('202609041010_b5_service_branch_directory_security_invoker_v1'));

CREATE OR REPLACE VIEW api.service_branch_directory
WITH (security_invoker = true) AS
SELECT
  branch.id,
  branch.organization_id,
  branch.code,
  branch.name,
  branch.is_active
FROM public.branches branch
WHERE public.request_role_is_service_v1()
   OR public.is_platform_user()
   OR branch.organization_id = public.current_user_org_id();

CREATE OR REPLACE VIEW api.service_level_directory
WITH (security_invoker = true) AS
SELECT directory.*
FROM public.service_level_directory directory
WHERE public.request_role_is_service_v1()
   OR public.is_platform_user()
   OR directory.organization_id = public.current_user_org_id();

CREATE OR REPLACE VIEW api.service_offering_directory
WITH (security_invoker = true) AS
SELECT directory.*
FROM public.service_offering_directory directory
WHERE public.request_role_is_service_v1()
   OR public.is_platform_user()
   OR directory.organization_id = public.current_user_org_id();

REVOKE ALL ON api.service_branch_directory FROM PUBLIC, anon, authenticated;
GRANT SELECT ON api.service_branch_directory TO service_role;
REVOKE ALL ON public.service_level_directory FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.service_offering_directory FROM PUBLIC, anon, authenticated;
REVOKE ALL ON api.service_level_directory FROM PUBLIC, anon, authenticated;
REVOKE ALL ON api.service_offering_directory FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.service_level_directory TO service_role;
GRANT SELECT ON public.service_offering_directory TO service_role;
GRANT SELECT ON api.service_level_directory TO service_role;
GRANT SELECT ON api.service_offering_directory TO service_role;

DO $registry$
DECLARE
  v_row RECORD;
  v_resource JSONB;
  v_version_resource JSONB;
  v_cache_resource JSONB;
  v_version_resources JSONB;
  v_version_next JSONB;
  v_version_matches INT;
  v_cache_matches INT;
  v_pairs_seen INT := 0;
BEGIN
  FOR v_row IN
    SELECT s.id AS settings_id, s.settings_version_id, s.category,
           s.scope_type, s.scope_id, s.scope_hash, s.cached_value,
           sv.schema_version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv
        ON sv.id = s.settings_version_id
       AND sv.scope_hash = s.scope_hash
     WHERE s.category = 'ui_read_registry'
  LOOP
    IF jsonb_typeof(v_row.value) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_row.value->'resources') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'ui_read_registry settings version % has invalid resources',
        v_row.settings_version_id;
    END IF;
    IF jsonb_typeof(v_row.cached_value) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_row.cached_value->'resources') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'ui_read_registry settings cache % has invalid resources',
        v_row.settings_id;
    END IF;

    SELECT COUNT(*), (jsonb_agg(resource ORDER BY ordinality)->0)
      INTO v_version_matches, v_version_resource
      FROM jsonb_array_elements(v_row.value->'resources')
           WITH ORDINALITY AS entries(resource, ordinality)
     WHERE resource->>'key' = 'service_branch_directory';
    SELECT COUNT(*), (jsonb_agg(resource ORDER BY ordinality)->0)
      INTO v_cache_matches, v_cache_resource
      FROM jsonb_array_elements(v_row.cached_value->'resources')
           WITH ORDINALITY AS entries(resource, ordinality)
     WHERE resource->>'key' = 'service_branch_directory';

    IF v_version_matches > 1 OR v_cache_matches > 1 THEN
      RAISE EXCEPTION 'service_branch_directory is duplicated in settings pair %/%',
        v_row.settings_id, v_row.settings_version_id;
    ELSIF v_version_matches = 0 AND v_cache_matches = 0 THEN
      CONTINUE;
    END IF;

    v_pairs_seen := v_pairs_seen + 1;
    v_resource := COALESCE(v_version_resource, v_cache_resource)
      || jsonb_build_object(
        'relation', 'api.service_branch_directory',
        'select', jsonb_build_array('id', 'organization_id', 'code', 'name', 'is_active'),
        'capability_read', 'agreements.read',
        'capability_write', 'agreements.write',
        'allow_view_relation', TRUE,
        'strict_columns', TRUE
      );

    SELECT COALESCE(
      jsonb_agg(
        CASE WHEN resource->>'key' = 'service_branch_directory'
          THEN v_resource ELSE resource END ORDER BY ordinality
      ), '[]'::jsonb
    )
      INTO v_version_resources
      FROM jsonb_array_elements(v_row.value->'resources')
           WITH ORDINALITY AS entries(resource, ordinality);
    IF v_version_matches = 0 THEN
      v_version_resources := v_version_resources || jsonb_build_array(v_resource);
    END IF;

    v_version_next := jsonb_set(v_row.value, '{resources}', v_version_resources, TRUE);

    IF v_row.value IS DISTINCT FROM v_version_next THEN
      WITH closed AS (
        UPDATE public.settings_versions
           SET effective_until = GREATEST(
                 clock_timestamp(),
                 effective_from + INTERVAL '1 microsecond'
               ),
               updated_at = clock_timestamp()
         WHERE id = v_row.settings_version_id
           AND scope_hash = v_row.scope_hash
           AND effective_until IS NULL
        RETURNING id
      ), inserted AS (
        INSERT INTO public.settings_versions (
          id, category, scope_type, scope_id, scope_hash, version, value,
          schema_version, change_reason, approved_at, effective_from
        )
        SELECT
          gen_random_uuid(), v_row.category, v_row.scope_type, v_row.scope_id,
          v_row.scope_hash,
          (
            SELECT COALESCE(MAX(candidate.version), 0) + 1
              FROM public.settings_versions candidate
             WHERE candidate.category = v_row.category
               AND candidate.scope_type = v_row.scope_type
               AND candidate.scope_hash = v_row.scope_hash
          ),
          v_version_next, v_row.schema_version,
          'Route service branch reads through the governed API projection',
          clock_timestamp(), clock_timestamp()
          FROM closed
        RETURNING id, value
      )
      UPDATE public.settings s
         SET settings_version_id = inserted.id,
             cached_value = inserted.value,
             last_updated = clock_timestamp()
        FROM inserted
       WHERE s.id = v_row.settings_id
         AND s.settings_version_id = v_row.settings_version_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'failed to promote ui_read_registry settings pair %/%',
          v_row.settings_id, v_row.settings_version_id;
      END IF;
    ELSIF v_row.cached_value IS DISTINCT FROM v_row.value THEN
      UPDATE public.settings
         SET cached_value = v_row.value,
             last_updated = clock_timestamp()
       WHERE id = v_row.settings_id
         AND settings_version_id = v_row.settings_version_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'settings cache repair lost pointer CAS for pair %/%',
          v_row.settings_id, v_row.settings_version_id;
      END IF;
    END IF;
  END LOOP;

  IF v_pairs_seen = 0 THEN
    RAISE EXCEPTION 'service_branch_directory is missing from current ui_read_registry settings pairs';
  END IF;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_read_registry:%'
      OR cache_key LIKE 'ui_list_resource:%service_branch_directory%'
      OR cache_key LIKE 'ui_get_resource:%service_branch_directory%'
      OR cache_key LIKE 'ui_resource_metrics:%service_branch_directory%'
      OR cache_key LIKE 'ui_filter_distinct_values:%service_branch_directory%';
END;
$registry$;

DO $policy$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_next JSONB;
  v_capabilities JSONB;
  v_roles JSONB;
  v_role JSONB;
  v_role_caps JSONB;
  v_required_key TEXT;
  v_required_keys TEXT[] := ARRAY['agreements.read', 'agreements.write'];
  v_pairs_seen INT := 0;
  v_new_capabilities JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'agreements.read',
      'label', 'Agreements read',
      'category', 'commercial',
      'description', 'Read commercial agreements and service catalog configuration.'
    ),
    jsonb_build_object(
      'key', 'agreements.write',
      'label', 'Agreements write',
      'category', 'commercial',
      'description', 'Manage commercial agreements and service catalog configuration.'
    )
  );
BEGIN
  FOR v_row IN
    SELECT s.id AS settings_id, s.settings_version_id, s.category,
           s.scope_type, s.scope_id, s.scope_hash, s.cached_value,
           sv.schema_version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv
        ON sv.id = s.settings_version_id
       AND sv.scope_hash = s.scope_hash
     WHERE s.category = 'access_control_policy'
  LOOP
    v_current := v_row.value;
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_current->'roles') IS DISTINCT FROM 'array'
       OR NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(v_current->'roles') role
          WHERE lower(COALESCE(role->>'key', '')) = 'ops_admin'
       ) THEN
      CONTINUE;
    END IF;

    v_pairs_seen := v_pairs_seen + 1;
    v_capabilities := COALESCE(v_current->'capabilities', '[]'::jsonb);
    IF jsonb_typeof(v_capabilities) IS DISTINCT FROM 'array' THEN
      v_capabilities := '[]'::jsonb;
    END IF;
    SELECT v_capabilities || COALESCE(jsonb_agg(required_capability), '[]'::jsonb)
      INTO v_capabilities
      FROM jsonb_array_elements(v_new_capabilities) required_capability
     WHERE NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(v_capabilities) existing_capability
        WHERE existing_capability->>'key' = required_capability->>'key'
     );

    v_roles := '[]'::jsonb;
    FOR v_role IN
      SELECT value
        FROM jsonb_array_elements(v_current->'roles')
    LOOP
      IF lower(COALESCE(v_role->>'key', '')) = 'ops_admin' THEN
        v_role_caps := COALESCE(v_role->'capability_keys', '[]'::jsonb);
        IF jsonb_typeof(v_role_caps) IS DISTINCT FROM 'array' THEN
          v_role_caps := '[]'::jsonb;
        END IF;
        FOREACH v_required_key IN ARRAY v_required_keys
        LOOP
          IF NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(v_role_caps) capability_key
             WHERE capability_key IN (v_required_key, '*')
          ) THEN
            v_role_caps := v_role_caps || jsonb_build_array(v_required_key);
          END IF;
        END LOOP;
        v_role := jsonb_set(v_role, '{capability_keys}', v_role_caps, TRUE);
      END IF;
      v_roles := v_roles || jsonb_build_array(v_role);
    END LOOP;

    v_next := jsonb_set(v_current, '{capabilities}', v_capabilities, TRUE);
    v_next := jsonb_set(v_next, '{roles}', v_roles, TRUE);

    IF v_row.value IS DISTINCT FROM v_next THEN
      WITH closed AS (
        UPDATE public.settings_versions
           SET effective_until = GREATEST(
                 clock_timestamp(),
                 effective_from + INTERVAL '1 microsecond'
               ),
               updated_at = clock_timestamp()
         WHERE id = v_row.settings_version_id
           AND scope_hash = v_row.scope_hash
           AND effective_until IS NULL
        RETURNING id
      ), inserted AS (
        INSERT INTO public.settings_versions (
          id, category, scope_type, scope_id, scope_hash, version, value,
          schema_version, change_reason, approved_at, effective_from
        )
        SELECT
          gen_random_uuid(), v_row.category, v_row.scope_type, v_row.scope_id,
          v_row.scope_hash,
          (
            SELECT COALESCE(MAX(candidate.version), 0) + 1
              FROM public.settings_versions candidate
             WHERE candidate.category = v_row.category
               AND candidate.scope_type = v_row.scope_type
               AND candidate.scope_hash = v_row.scope_hash
          ),
          v_next, v_row.schema_version,
          'Align service directory access with agreements capabilities',
          clock_timestamp(), clock_timestamp()
          FROM closed
        RETURNING id, value
      )
      UPDATE public.settings s
         SET settings_version_id = inserted.id,
             cached_value = inserted.value,
             last_updated = clock_timestamp()
        FROM inserted
       WHERE s.id = v_row.settings_id
         AND s.settings_version_id = v_row.settings_version_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'failed to promote access_control_policy settings pair %/%',
          v_row.settings_id, v_row.settings_version_id;
      END IF;
    ELSIF v_row.cached_value IS DISTINCT FROM v_row.value THEN
      UPDATE public.settings
         SET cached_value = v_row.value,
             last_updated = clock_timestamp()
       WHERE id = v_row.settings_id
         AND settings_version_id = v_row.settings_version_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'settings cache repair lost pointer CAS for pair %/%',
          v_row.settings_id, v_row.settings_version_id;
      END IF;
    END IF;
  END LOOP;

  IF v_pairs_seen = 0 THEN
    RAISE EXCEPTION 'access_control_policy has no explicit ops_admin role to align';
  END IF;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'access_control_policy:%';
END;
$policy$;

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'api'
       AND c.relname = 'service_branch_directory'
       AND c.relkind = 'v'
       AND COALESCE(c.reloptions, ARRAY[]::TEXT[]) @> ARRAY['security_invoker=true']
  ) THEN
    RAISE EXCEPTION 'api.service_branch_directory must remain a security_invoker view';
  END IF;

  IF (
    SELECT array_agg(column_name::TEXT ORDER BY ordinal_position)
      FROM information_schema.columns
     WHERE table_schema = 'api'
       AND table_name = 'service_branch_directory'
  ) IS DISTINCT FROM ARRAY[
    'id', 'organization_id', 'code', 'name', 'is_active'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'api.service_branch_directory column identity drifted';
  END IF;

  IF has_table_privilege('anon', 'api.service_branch_directory', 'SELECT')
     OR has_table_privilege('authenticated', 'api.service_branch_directory', 'SELECT')
     OR NOT has_table_privilege('service_role', 'api.service_branch_directory', 'SELECT') THEN
    RAISE EXCEPTION 'api.service_branch_directory privilege boundary drifted';
  END IF;

  IF has_table_privilege('authenticated', 'public.service_level_directory', 'SELECT')
     OR has_table_privilege('authenticated', 'public.service_offering_directory', 'SELECT')
     OR has_table_privilege('authenticated', 'api.service_level_directory', 'SELECT')
     OR has_table_privilege('authenticated', 'api.service_offering_directory', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.service_level_directory', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.service_offering_directory', 'SELECT')
     OR NOT has_table_privilege('service_role', 'api.service_level_directory', 'SELECT')
     OR NOT has_table_privilege('service_role', 'api.service_offering_directory', 'SELECT') THEN
    RAISE EXCEPTION 'service level/offering directory privilege boundary drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv
        ON sv.id = s.settings_version_id
       AND sv.scope_hash = s.scope_hash
     WHERE s.category = 'ui_read_registry'
       AND (
         EXISTS (
           SELECT 1 FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) resource
            WHERE resource->>'key' = 'service_branch_directory'
         )
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) resource
            WHERE resource->>'key' = 'service_branch_directory'
         )
       )
  ) OR EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv
        ON sv.id = s.settings_version_id
       AND sv.scope_hash = s.scope_hash
      CROSS JOIN LATERAL (
        SELECT COUNT(*) AS count, (jsonb_agg(resource ORDER BY ordinality)->0) AS resource
          FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb))
               WITH ORDINALITY AS entries(resource, ordinality)
         WHERE resource->>'key' = 'service_branch_directory'
      ) version_entry
      CROSS JOIN LATERAL (
        SELECT COUNT(*) AS count, (jsonb_agg(resource ORDER BY ordinality)->0) AS resource
          FROM jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb))
               WITH ORDINALITY AS entries(resource, ordinality)
         WHERE resource->>'key' = 'service_branch_directory'
      ) cache_entry
     WHERE s.category = 'ui_read_registry'
       AND (version_entry.count > 0 OR cache_entry.count > 0)
       AND (
         version_entry.count <> 1
         OR cache_entry.count <> 1
         OR version_entry.resource IS DISTINCT FROM cache_entry.resource
         OR version_entry.resource->>'relation' IS DISTINCT FROM 'api.service_branch_directory'
         OR version_entry.resource->'select' IS DISTINCT FROM '["id","organization_id","code","name","is_active"]'::jsonb
         OR version_entry.resource->>'capability_read' IS DISTINCT FROM 'agreements.read'
         OR version_entry.resource->>'capability_write' IS DISTINCT FROM 'agreements.write'
         OR version_entry.resource->>'allow_view_relation' IS DISTINCT FROM 'true'
         OR version_entry.resource->>'strict_columns' IS DISTINCT FROM 'true'
       )
  ) THEN
    RAISE EXCEPTION 'service_branch_directory registry settings/cache parity drifted';
  END IF;
END;
$assert$;

COMMIT;
