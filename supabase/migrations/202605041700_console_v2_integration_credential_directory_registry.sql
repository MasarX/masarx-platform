-- Migration: Console V2 integration credential directory live-read registry
-- Purpose:
--   Console V2 credentials supervision reads the redacted
--   v_integration_credential_directory projection alongside the raw
--   provider_auth_configs write surface. Register the projection in
--   ui_read_registry so live Console V2 does not fall back to seed data.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605041700_console_v2_integration_credential_directory_registry'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.v_integration_credential_directory
  WITH (security_invoker = true)
  AS
SELECT
  pac.id,
  pac.provider_id,
  pac.auth_type,
  pac.auth_type AS auth_type_label,
  pac.expires_at,
  pac.created_at,
  pac.created_at AS last_rotated_at,
  CASE
    WHEN pac.expires_at IS NULL THEN 'active'
    WHEN pac.expires_at <= now() THEN 'expired'
    WHEN pac.expires_at <= now() + INTERVAL '30 days' THEN 'expiring'
    ELSE 'active'
  END AS status,
  CASE
    WHEN pac.expires_at IS NULL THEN NULL
    ELSE EXTRACT(DAY FROM (pac.expires_at - now()))::INTEGER
  END AS days_until_expiry,
  p.name AS provider_label,
  p.provider_type AS provider_kind,
  p.metadata->>'vendor' AS provider_vendor,
  (
    pac.expires_at IS NOT NULL
    AND pac.expires_at > now()
    AND pac.expires_at <= now() + INTERVAL '30 days'
  ) AS is_expiring,
  (pac.expires_at IS NOT NULL AND pac.expires_at <= now()) AS is_expired,
  (pac.expires_at IS NULL OR pac.expires_at > now() + INTERVAL '30 days') AS is_active,
  TRUE AS mask_state,
  p.organization_id
FROM public.provider_auth_configs pac
LEFT JOIN public.providers p ON p.id = pac.provider_id;

COMMENT ON VIEW public.v_integration_credential_directory IS
  'FE-friendly tenant-scoped projection of provider_auth_configs. Excludes credentials JSONB and appends provider organization_id solely for ui_read_registry tenant scoping.';

REVOKE ALL ON public.v_integration_credential_directory FROM PUBLIC;
REVOKE ALL ON public.v_integration_credential_directory FROM anon;
GRANT SELECT ON public.v_integration_credential_directory TO authenticated;
GRANT SELECT ON public.v_integration_credential_directory TO service_role;

DO $do$
DECLARE
  v_resource JSONB := jsonb_build_object(
    'key', 'integration_credential_directory',
    'label', 'Integration credential directory',
    'relation', 'public.v_integration_credential_directory',
    'allow_view_relation', TRUE,
    'id_column', 'id',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'capability_read', 'integrations.read',
    'select', jsonb_build_array(
      'id',
      'organization_id',
      'provider_id',
      'auth_type',
      'auth_type_label',
      'expires_at',
      'created_at',
      'last_rotated_at',
      'status',
      'days_until_expiry',
      'provider_label',
      'provider_kind',
      'provider_vendor',
      'is_expiring',
      'is_expired',
      'is_active',
      'mask_state'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'provider_id', 'column', 'provider_id', 'op', 'eq'),
      jsonb_build_object('key', 'auth_type', 'column', 'auth_type', 'op', 'eq'),
      jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
      jsonb_build_object('key', 'is_expiring', 'column', 'is_expiring', 'op', 'eq'),
      jsonb_build_object('key', 'is_expired', 'column', 'is_expired', 'op', 'eq'),
      jsonb_build_object('key', 'provider_label', 'column', 'provider_label', 'op', 'ilike')
    ),
    'default_sort', jsonb_build_object('column', 'expires_at', 'direction', 'asc')
  );
  v_setting RECORD;
  v_current JSONB;
  v_next JSONB;
  v_resources JSONB;
  v_updated_resources JSONB;
  v_item JSONB;
BEGIN
  FOR v_setting IN
    SELECT s.id,
           s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
  LOOP
    v_current := v_setting.value;
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    v_updated_resources := '[]'::jsonb;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_resources)
    LOOP
      IF v_item->>'key' = 'integration_credential_directory' THEN
        v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
      ELSE
        v_updated_resources := v_updated_resources || jsonb_build_array(v_item);
      END IF;
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_resources) AS item
      WHERE item->>'key' = 'integration_credential_directory'
    ) THEN
      v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
    END IF;

    v_next := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_setting.version + 1,
             change_reason = 'Add Console V2 integration credential directory read projection',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_setting.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_setting.id;
    END IF;
  END LOOP;
END;
$do$;

DO $do$
DECLARE
  v_setting RECORD;
  v_current JSONB;
  v_next JSONB;
  v_resource_map JSONB;
BEGIN
  FOR v_setting IN
    SELECT s.id,
           s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'access_control_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
  LOOP
    v_current := v_setting.value;
    v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);
    v_resource_map := jsonb_set(
      v_resource_map,
      '{integration_credential_directory}',
      jsonb_build_object('read', 'integrations.read'),
      TRUE
    );
    v_next := jsonb_set(v_current, '{resource_map}', v_resource_map, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_setting.version + 1,
             change_reason = 'Map Console V2 integration credential directory capability',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_setting.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_setting.id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605041700_console_v2_integration_credential_directory_registry'));

COMMIT;
