BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20261026180000_provider_auth_safe_readback_v1'));

-- Detail reads select every relation column; the registry select list only bounds list reads.
CREATE VIEW public.provider_auth_configs_visible_v1
WITH (security_invoker = true, security_barrier = true) AS
SELECT pac.id, pac.provider_id, pac.auth_type, pac.expires_at, pac.created_at, pac.updated_at
FROM public.provider_auth_configs pac
JOIN public.providers p ON p.id = pac.provider_id
WHERE public.user_has_resource_capability_v1('provider_auth_configs', 'read')
  AND (public.is_platform_user() OR p.organization_id = public.current_user_org_id());

COMMENT ON VIEW public.provider_auth_configs_visible_v1
  IS 'Capability- and organization-scoped provider credential metadata without credentials or Vault references.';
REVOKE ALL ON public.provider_auth_configs_visible_v1 FROM PUBLIC, anon;
GRANT SELECT ON public.provider_auth_configs_visible_v1 TO authenticated, service_role;

DO $registry$
DECLARE
  v_row RECORD;
  v_value JSONB;
  v_seen INTEGER := 0;
BEGIN
  FOR v_row IN
    SELECT s.scope_type, s.scope_id, sv.value, sv.schema_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
    WHERE s.category = 'ui_read_registry'
    ORDER BY s.id
    FOR UPDATE OF s, sv
  LOOP
    IF jsonb_typeof(v_row.value->'resources') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'ui_read_registry resources must be an array';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_row.value->'resources') resource
                   WHERE resource->>'key' = 'provider_auth_configs') THEN
      CONTINUE;
    END IF;
    v_seen := v_seen + 1;
    SELECT jsonb_set(v_row.value, '{resources}', jsonb_agg(
      CASE WHEN resource->>'key' = 'provider_auth_configs' THEN
        jsonb_set(resource, '{relation}', '"public.provider_auth_configs_visible_v1"'::JSONB)
      ELSE resource END ORDER BY ordinal))
    INTO v_value
    FROM jsonb_array_elements(v_row.value->'resources') WITH ORDINALITY AS entries(resource, ordinal);

    IF v_value IS DISTINCT FROM v_row.value THEN
      PERFORM 1 FROM public.upsert_settings_value_v1(
        'ui_read_registry', v_row.scope_type, v_row.scope_id, v_value, v_row.schema_version,
        'Route provider credential reads through secret-safe metadata projection');
    END IF;
  END LOOP;
  IF v_seen = 0 THEN
    RAISE EXCEPTION 'ui_read_registry has no provider_auth_configs resource';
  END IF;
END;
$registry$;

DELETE FROM public.settings_cache
WHERE cache_key LIKE 'ui_read_registry:%'
   OR cache_key LIKE 'ui_list_resource:%provider_auth_configs%'
   OR cache_key LIKE 'ui_get_resource:%provider_auth_configs%'
   OR cache_key LIKE 'ui_resource_metrics:%provider_auth_configs%'
   OR cache_key LIKE 'ui_filter_distinct_values:%provider_auth_configs%';
COMMIT;
