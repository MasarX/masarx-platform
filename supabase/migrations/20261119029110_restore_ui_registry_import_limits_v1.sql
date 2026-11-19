-- Restore row-driven import limits while retaining the current registry projections.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.normalize_settings_value_v1(
  p_category TEXT,
  p_value JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;

  IF lower(COALESCE(btrim(p_category), '')) = 'ui_read_registry' THEN
    RETURN public.ui_read_registry_preserve_import_policy_limits_v1(
      p_value,
      public.normalize_ui_read_registry_import_v1(p_value)
    );
  END IF;

  IF lower(COALESCE(btrim(p_category), '')) = 'label_print_policy' THEN
    RETURN public.normalize_label_print_policy_v1(p_value);
  END IF;

  IF lower(COALESCE(btrim(p_category), '')) = 'webhook_ingest_policy' THEN
    RETURN public.normalize_webhook_ingest_policy_workflow_bindings_v1(p_value);
  END IF;

  RETURN p_value;
END;
$function$;

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
    (
      SELECT jsonb_agg(value ORDER BY ordinal)
      FROM jsonb_array_elements(v_registry->'resources') WITH ORDINALITY AS resource(value, ordinal)
      WHERE value->>'key' = p_resource_key
         OR (p_resource_key = 'shipments' AND value->>'key' IN ('recipients', 'addresses'))
         OR (p_resource_key = 'recipients' AND value->>'key' = 'addresses')
    ),
    TRUE
  );
  v_registry := public.ui_read_registry_apply_runtime_patches_v1(
    public.ui_read_registry_enrich_lookup_defaults_v1(
      public.ui_read_registry_enrich_inline_related_node_import_v1(
        public.ui_read_registry_enrich_reference_import_v1(
          public.ui_read_registry_enrich_lookup_import_v1(
            public.ui_read_registry_apply_required_import_contracts_v1(
              public.normalize_settings_value_v1('ui_read_registry', v_registry)
            )
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

-- Recover the existing shipment import defaults when an earlier registry write dropped them.
DO $backfill$
DECLARE
  v_row RECORD;
  v_next JSONB;
BEGIN
  FOR v_row IN
    SELECT s.scope_type, s.scope_id, sv.value, sv.schema_version
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
     WHERE s.category = 'ui_read_registry'
       AND jsonb_typeof(sv.value->'resources') = 'array'
     ORDER BY s.id
     FOR UPDATE OF s, sv
  LOOP
    SELECT jsonb_set(v_row.value, '{resources}', jsonb_agg(
      CASE WHEN resource->>'key' = 'shipments' AND jsonb_typeof(resource->'import') = 'object'
        THEN jsonb_set(resource, '{import}',
          '{"max_file_bytes":10485760,"max_rows":10000}'::jsonb || (resource->'import'))
        ELSE resource END
      ORDER BY ordinal
    )) INTO v_next
    FROM jsonb_array_elements(v_row.value->'resources') WITH ORDINALITY AS r(resource, ordinal);

    IF v_next IS NOT NULL AND v_next IS DISTINCT FROM v_row.value THEN
      PERFORM public.upsert_settings_value_v1(
        'ui_read_registry', v_row.scope_type, v_row.scope_id, v_next, v_row.schema_version,
        'Restore row-driven shipment import limits');
    END IF;
  END LOOP;
END;
$backfill$;

DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%';
COMMIT;
