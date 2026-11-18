-- Plan: PLAN-202605-console-v2-first-tenant-readiness
-- Step: Keep shipment import defaults row-driven for operator-friendly CSV intake.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605161201_ui_registry_import_lookup_defaults_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH target_definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'address_validation_status'
   LIMIT 1
)
UPDATE public.lookup_values AS value
   SET is_default = value.value = 'pending',
       updated_at = now()
  FROM target_definition
 WHERE value.lookup_definition_id = target_definition.id;

INSERT INTO public.lookup_column_contracts (
  table_schema,
  table_name,
  column_name,
  lookup_category,
  allow_inactive,
  allowed_values
)
VALUES (
  'public',
  'addresses',
  'validation_status',
  'address_validation_status',
  FALSE,
  NULL
)
ON CONFLICT (table_schema, table_name, column_name) DO UPDATE
   SET lookup_category = EXCLUDED.lookup_category,
       allow_inactive = EXCLUDED.allow_inactive,
       allowed_values = EXCLUDED.allowed_values,
       updated_at = now();

CREATE OR REPLACE FUNCTION public.ui_read_registry_enrich_lookup_defaults_v1(
  p_value JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_current JSONB := COALESCE(p_value, '{}'::jsonb);
  v_resources JSONB := COALESCE(v_current->'resources', '[]'::jsonb);
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_columns JSONB;
  v_updated_columns JSONB;
  v_column JSONB;
  v_column_import JSONB;
  v_lookup_category TEXT;
  v_default_value TEXT;
BEGIN
  IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
    RETURN v_current;
  END IF;

  FOR v_resource IN
    SELECT value
      FROM jsonb_array_elements(v_resources) AS value
  LOOP
    v_columns := COALESCE(v_resource->'columns', '[]'::jsonb);
    IF jsonb_typeof(v_columns) IS DISTINCT FROM 'array' THEN
      v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
      CONTINUE;
    END IF;

    v_updated_columns := '[]'::jsonb;

    FOR v_column IN
      SELECT value
        FROM jsonb_array_elements(v_columns) AS value
    LOOP
      v_column_import := COALESCE(v_column->'import', '{}'::jsonb);
      IF jsonb_typeof(v_column_import) IS DISTINCT FROM 'object' THEN
        v_column_import := '{}'::jsonb;
      END IF;

      v_lookup_category := NULLIF(btrim(COALESCE(v_column_import#>>'{lookup,category}', '')), '');

      IF v_lookup_category IS NOT NULL
         AND NOT (v_column_import ? 'default_value') THEN
        SELECT lv.value
          INTO v_default_value
          FROM public.lookup_values AS lv
          JOIN public.lookup_definitions AS ld
            ON ld.id = lv.lookup_definition_id
         WHERE ld.category = v_lookup_category
           AND lv.status = 'active'
           AND lv.is_default IS TRUE
         ORDER BY lv.sort_order NULLS LAST, lv.value
         LIMIT 1;

        IF v_default_value IS NOT NULL THEN
          v_column_import := jsonb_set(v_column_import, '{default_value}', to_jsonb(v_default_value), TRUE);
          v_column_import := jsonb_set(v_column_import, '{default_source}', to_jsonb('lookup_default'::text), TRUE);
        END IF;
      END IF;

      v_updated_columns := v_updated_columns || jsonb_build_array(
        jsonb_set(v_column, '{import}', v_column_import, TRUE)
      );
      v_default_value := NULL;
    END LOOP;

    v_updated_resources := v_updated_resources || jsonb_build_array(
      jsonb_set(v_resource, '{columns}', v_updated_columns, TRUE)
    );
  END LOOP;

  RETURN jsonb_set(v_current, '{resources}', COALESCE(v_updated_resources, '[]'::jsonb), TRUE);
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
            public.normalize_ui_read_registry_import_v1(v_registry)
          )
        )
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_read_registry_enrich_lookup_defaults_v1(JSONB)
  IS 'Adds row-driven lookup default values to import metadata so Console import inference can materialize fixed required defaults without hardcoded frontend values.';

COMMENT ON FUNCTION public.ui_read_registry_v1()
  IS 'Returns the Console UI read registry with normalized import metadata, lookup/default enrichment, references, and inline related-node import contracts.';

REVOKE ALL ON FUNCTION public.ui_read_registry_enrich_lookup_defaults_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_read_registry_enrich_lookup_defaults_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ui_read_registry_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_read_registry_v1() TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605161201_ui_registry_import_lookup_defaults_v1'));
COMMIT;
