-- Keep tabular-import resource resolution bounded without changing registry output.
BEGIN;

SELECT pg_advisory_lock(hashtext('202609021000_tabular_import_targeted_registry_v1'));

CREATE OR REPLACE FUNCTION public.ui_read_registry_apply_runtime_patches_v1(
  p_registry JSONB
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  WITH registry AS (
    SELECT COALESCE(p_registry, '{}'::jsonb) AS value
  ), resources AS (
    SELECT resource, ordinal
      FROM registry,
        jsonb_array_elements(COALESCE(value->'resources', '[]'::jsonb))
          WITH ORDINALITY AS r(resource, ordinal)
  ), patched AS (
    SELECT ordinal,
      CASE WHEN resource->>'key' <> 'shipments' THEN resource ELSE
        jsonb_set(
          resource,
          '{columns}',
          COALESCE((
            SELECT jsonb_agg(
              CASE WHEN column_value->>'key' = 'sender_id' THEN
                jsonb_set(column_value, '{import,reference}', jsonb_build_object(
                  'label', 'Senders',
                  'relation', 'public.senders',
                  'resource', 'senders',
                  'id_column', 'id',
                  'label_column', 'name',
                  'display_columns', jsonb_build_array('name', 'status')
                ), TRUE)
              ELSE column_value END
              ORDER BY column_ordinal
            )
              FROM jsonb_array_elements(COALESCE(resource->'columns', '[]'::jsonb))
                WITH ORDINALITY AS c(column_value, column_ordinal)
          ), '[]'::jsonb),
          TRUE
        )
      END AS resource
      FROM resources
  )
  SELECT jsonb_set(
    registry.value,
    '{resources}',
    COALESCE((SELECT jsonb_agg(resource ORDER BY ordinal) FROM patched), '[]'::jsonb),
    TRUE
  )
    FROM registry
$$;

COMMENT ON FUNCTION public.ui_read_registry_apply_runtime_patches_v1(JSONB)
  IS 'Apply current runtime registry patches to either the full registry or a bounded resource slice.';

CREATE OR REPLACE FUNCTION public.ui_read_registry_v1()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT public.ui_read_registry_apply_runtime_patches_v1(
    public.ui_read_registry_v1_base_202608161850()
  )
$$;

CREATE OR REPLACE FUNCTION public.tabular_import_resolve_resource_v1(
  p_resource_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged(
    'ui_read_registry',
    v_scope_type,
    v_scope_id
  );
  v_resource JSONB;
BEGIN
  SELECT value
    INTO v_resource
    FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS value
   WHERE value->>'key' = COALESCE(p_resource_key, '')
   LIMIT 1;

  IF v_resource IS NULL THEN
    RETURN NULL;
  END IF;

  v_registry := jsonb_set(
    v_registry,
    '{resources}',
    jsonb_build_array(v_resource),
    TRUE
  );
  v_registry := public.ui_read_registry_apply_runtime_patches_v1(
    public.ui_read_registry_enrich_inline_related_node_import_v1(
      public.ui_read_registry_enrich_reference_import_v1(
        public.ui_read_registry_enrich_lookup_import_v1(
          public.ui_read_registry_apply_required_import_contracts_v1(
            public.normalize_ui_read_registry_import_v1(v_registry)
          )
        )
      )
    )
  );

  SELECT value
    INTO v_resource
    FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS value
   WHERE value->>'key' = COALESCE(p_resource_key, '')
   LIMIT 1;

  RETURN v_resource;
END;
$function$;

COMMENT ON FUNCTION public.tabular_import_resolve_resource_v1(TEXT)
  IS 'Resolve one canonical import resource through the same registry enrichment pipeline without walking unrelated resources.';

REVOKE ALL ON FUNCTION public.ui_read_registry_apply_runtime_patches_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_read_registry_apply_runtime_patches_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ui_read_registry_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_read_registry_v1() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.tabular_import_resolve_resource_v1(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_resolve_resource_v1(TEXT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202609021000_tabular_import_targeted_registry_v1'));

COMMIT;
