-- Migration: UI security resources (audit logs + provider auth + token rotation)
BEGIN;
SELECT pg_advisory_lock(hashtext('202601052030_ui_security_resources'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1) RLS: allow capability-gated reads for security resources
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS provider_auth_configs_select ON public.provider_auth_configs;
CREATE POLICY provider_auth_configs_select
  ON public.provider_auth_configs
  FOR SELECT
  USING (
    user_has_resource_capability_v1('provider_auth_configs'::text, 'read'::text)
    AND (
      is_platform_user()
      OR EXISTS (
        SELECT 1
        FROM public.providers p
        WHERE p.id = provider_auth_configs.provider_id
          AND p.organization_id = current_user_org_id()
      )
    )
  );

DROP POLICY IF EXISTS audit_table_changes_select ON public.audit_table_changes;
CREATE POLICY audit_table_changes_select
  ON public.audit_table_changes
  FOR SELECT
  USING (
    user_has_resource_capability_v1('audit_table_changes'::text, 'read'::text)
    AND (is_platform_user() OR organization_id = current_user_org_id())
  );

-- ---------------------------------------------------------------------------
-- 2) ui_read_registry: add provider auth + audit logs + token rotation requests
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_candidate JSONB;
  v_new JSONB := jsonb_build_array(
    jsonb_build_object(
      'key','provider_auth_configs',
      'label','Provider auth',
      'relation','public.provider_auth_configs',
      'id_column','id',
      'capability_read','provider_auth.read',
      'select', jsonb_build_array(
        'id','provider_id','auth_type','expires_at','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','provider_id','column','provider_id','op','eq'),
        jsonb_build_object('key','auth_type','column','auth_type','op','eq')
      ),
      'default_sort', jsonb_build_object('column','updated_at','direction','desc')
    ),
    jsonb_build_object(
      'key','audit_table_changes',
      'label','Audit table changes',
      'relation','public.audit_table_changes',
      'id_column','id',
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'capability_read','audit_log.read',
      'select', jsonb_build_array(
        'id','organization_id','schema_name','table_name','op','pk','row_old','row_new',
        'changed_by','correlation_id','request_context','created_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','table_name','column','table_name','op','eq'),
        jsonb_build_object('key','op','column','op','op','eq'),
        jsonb_build_object('key','changed_by','column','changed_by','op','ilike'),
        jsonb_build_object('key','correlation_id','column','correlation_id','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key','token_rotation_requests',
      'label','Token rotation requests',
      'relation','public.domain_events',
      'id_column','id',
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'capability_read','token_rotation.read',
      'select', jsonb_build_array(
        'id','organization_id','event_type','resource_type','resource_id',
        'workflow_run_id','correlation_id','status','created_at','processed_at','error_reason'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','event_type','column','event_type','op','ilike'),
        jsonb_build_object('key','status','column','status','op','eq'),
        jsonb_build_object('key','resource_type','column','resource_type','op','eq'),
        jsonb_build_object('key','resource_id','column','resource_id','op','eq'),
        jsonb_build_object('key','workflow_run_id','column','workflow_run_id','op','eq'),
        jsonb_build_object('key','correlation_id','column','correlation_id','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    )
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
  FOR v_candidate IN SELECT * FROM jsonb_array_elements(v_new) LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_resources) AS item
      WHERE item->>'key' = v_candidate->>'key'
    ) THEN
      v_resources := v_resources || jsonb_build_array(v_candidate);
    END IF;
  END LOOP;

  v_current := jsonb_set(v_current, '{resources}', v_resources, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Add UI security resources',
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
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

-- ---------------------------------------------------------------------------
-- 3) access_control_policy resource_map: align new resources to capabilities
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_current JSONB;
  v_resource_map JSONB := '{}'::jsonb;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'access_control_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'access_control_policy global settings missing';
  END IF;

  v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);
  IF NOT (v_resource_map ? 'provider_auth_configs') THEN
    v_resource_map := jsonb_set(
      v_resource_map,
      '{provider_auth_configs}',
      jsonb_build_object('read','provider_auth.read'),
      true
    );
  END IF;
  IF NOT (v_resource_map ? 'audit_table_changes') THEN
    v_resource_map := jsonb_set(
      v_resource_map,
      '{audit_table_changes}',
      jsonb_build_object('read','audit_log.read'),
      true
    );
  END IF;
  IF NOT (v_resource_map ? 'token_rotation_requests') THEN
    v_resource_map := jsonb_set(
      v_resource_map,
      '{token_rotation_requests}',
      jsonb_build_object('read','token_rotation.read'),
      true
    );
  END IF;

  v_current := jsonb_set(v_current, '{resource_map}', v_resource_map, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'access_control_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Add UI security resources to access_control_policy',
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
   WHERE s.category = 'access_control_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202601052030_ui_security_resources'));
COMMIT;

