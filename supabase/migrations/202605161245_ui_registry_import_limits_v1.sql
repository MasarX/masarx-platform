-- Plan: PLAN-202605-console-v2-first-tenant-readiness
-- Step: Keep shipment import size limits row-driven and visible to Console V2.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605161245_ui_registry_import_limits_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_read_registry_preserve_import_policy_limits_v1(
  p_raw JSONB,
  p_normalized JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_raw JSONB := COALESCE(p_raw, '{}'::jsonb);
  v_current JSONB := COALESCE(p_normalized, '{}'::jsonb);
  v_raw_resources JSONB := COALESCE(v_raw->'resources', '[]'::jsonb);
  v_resources JSONB := COALESCE(v_current->'resources', '[]'::jsonb);
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_raw_resource JSONB;
  v_raw_import JSONB;
  v_import JSONB;
  v_limit_key TEXT;
  v_limit_text TEXT;
BEGIN
  IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_raw_resources) IS DISTINCT FROM 'array' THEN
    RETURN v_current;
  END IF;

  FOR v_resource IN SELECT value FROM jsonb_array_elements(v_resources) AS value LOOP
    SELECT value
      INTO v_raw_resource
      FROM jsonb_array_elements(v_raw_resources) AS value
     WHERE value->>'key' = v_resource->>'key'
     LIMIT 1;

    v_raw_import := COALESCE(v_raw_resource->'import', '{}'::jsonb);
    v_import := COALESCE(v_resource->'import', '{}'::jsonb);

    IF jsonb_typeof(v_raw_import) = 'object'
       AND jsonb_typeof(v_import) = 'object' THEN
      FOREACH v_limit_key IN ARRAY ARRAY['max_file_bytes', 'max_rows'] LOOP
        v_limit_text := NULLIF(btrim(COALESCE(v_raw_import->>v_limit_key, '')), '');
        IF v_limit_text ~ '^[0-9]+$' AND v_limit_text::numeric > 0 THEN
          v_import := jsonb_set(v_import, ARRAY[v_limit_key], to_jsonb(v_limit_text::bigint), TRUE);
        END IF;
      END LOOP;

      v_resource := jsonb_set(v_resource, '{import}', v_import, TRUE);
    END IF;

    v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
    v_raw_resource := NULL;
  END LOOP;

  RETURN jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);
END;
$function$;

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

  RETURN p_value;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_read_registry_v1()
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
  v_registry JSONB;
BEGIN
  v_registry := public.resolve_settings_merged('ui_read_registry', v_scope_type, v_scope_id);
  RETURN public.ui_read_registry_enrich_lookup_defaults_v1(
    public.ui_read_registry_enrich_inline_related_node_import_v1(
      public.ui_read_registry_enrich_reference_import_v1(
        public.ui_read_registry_enrich_lookup_import_v1(
          public.ui_read_registry_apply_required_import_contracts_v1(
            public.ui_read_registry_preserve_import_policy_limits_v1(
              v_registry,
              public.normalize_ui_read_registry_import_v1(v_registry)
            )
          )
        )
      )
    )
  );
END;
$function$;

DO $do$
DECLARE
  v_settings RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_updated JSONB;
  v_resource JSONB;
  v_import JSONB;
BEGIN
  FOR v_settings IN
    SELECT s.settings_version_id, s.cached_value
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_settings.cached_value, '{"resources":[]}'::jsonb);
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    v_updated := '[]'::jsonb;

    FOR v_resource IN SELECT value FROM jsonb_array_elements(v_resources) AS value LOOP
      IF v_resource->>'key' = 'shipments' THEN
        v_import := COALESCE(v_resource->'import', '{}'::jsonb);
        IF jsonb_typeof(v_import) IS DISTINCT FROM 'object' THEN
          v_import := '{}'::jsonb;
        END IF;
        v_import := jsonb_set(v_import, '{max_file_bytes}', to_jsonb(10485760), TRUE);
        v_import := jsonb_set(v_import, '{max_rows}', to_jsonb(10000), TRUE);
        v_resource := jsonb_set(v_resource, '{import}', v_import, TRUE);
      END IF;

      v_updated := v_updated || jsonb_build_array(v_resource);
    END LOOP;

    v_current := jsonb_set(v_current, '{resources}', v_updated, TRUE);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = sv.version + 1,
           change_reason = 'Add row-driven Console V2 shipment import limits',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE sv.id = v_settings.settings_version_id
       AND sv.value IS DISTINCT FROM v_current;

    UPDATE public.settings s
       SET cached_value = v_current,
           last_updated = now()
     WHERE s.settings_version_id = v_settings.settings_version_id
       AND s.cached_value IS DISTINCT FROM v_current;
  END LOOP;
END;
$do$;

COMMENT ON FUNCTION public.ui_read_registry_preserve_import_policy_limits_v1(JSONB, JSONB)
  IS 'Preserves row-driven resource import policy limits such as max_file_bytes and max_rows after ui_read_registry normalization.';

COMMENT ON FUNCTION public.normalize_settings_value_v1(TEXT, JSONB)
  IS 'Apply category-specific settings normalization before persistence, preserving row-driven ui_read_registry import policy limits.';

COMMENT ON FUNCTION public.ui_read_registry_v1()
  IS 'Returns the Console UI read registry with normalized import metadata, import limits, lookup/default enrichment, references, and inline related-node import contracts.';

REVOKE ALL ON FUNCTION public.ui_read_registry_preserve_import_policy_limits_v1(JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_read_registry_preserve_import_policy_limits_v1(JSONB, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.normalize_settings_value_v1(TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalize_settings_value_v1(TEXT, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ui_read_registry_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_read_registry_v1() TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605161245_ui_registry_import_limits_v1'));
COMMIT;
