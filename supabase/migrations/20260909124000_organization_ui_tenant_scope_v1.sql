-- Restore tenant isolation in registry-driven SECURITY DEFINER UI readers.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20260909124000_organization_ui_tenant_scope_v1'));

DO $repair$
DECLARE
  v_settings RECORD;
  v_resources JSONB;
BEGIN
  FOR v_settings IN
    SELECT s.scope_type, s.scope_id, sv.value, sv.schema_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
      AND sv.value->'resources' @> '[{"key":"organizations"}]'::jsonb
  LOOP
    SELECT jsonb_agg(
      CASE WHEN resource->>'key' = 'organizations'
        AND COALESCE(NULLIF(btrim(resource->>'read_relation'), ''), resource->>'relation')
          IN ('public.organizations', 'organizations')
        AND NULLIF(resource#>>'{scope_columns,tenant}', '') IS NULL THEN
        jsonb_set(resource, '{scope_columns}',
          COALESCE(resource->'scope_columns', '{}'::jsonb)
            || jsonb_build_object('tenant', 'id'), true)
      ELSE resource END ORDER BY ordinal
    ) INTO v_resources
    FROM jsonb_array_elements(v_settings.value->'resources')
      WITH ORDINALITY AS resources(resource, ordinal);

    IF v_resources IS DISTINCT FROM v_settings.value->'resources' THEN
      PERFORM public.upsert_settings_value_v1(
        'ui_read_registry', v_settings.scope_type, v_settings.scope_id,
        jsonb_set(v_settings.value, '{resources}', v_resources),
        v_settings.schema_version,
        'Enforce organization tenant scope through canonical UI readers'
      );
    END IF;
  END LOOP;
END;
$repair$;

COMMIT;
