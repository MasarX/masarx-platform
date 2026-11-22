-- Plan: PLAN-202604-production-readiness-coverage-closure / Step: local certification stabilization
-- Purpose:
--   - Keep address inline-node import review aligned with the canonical raw address aliases.
--   - Apply the alias contract at registry read time so scoped registries do not drift from global settings history.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('20261122029009_ui_registry_address_raw_input_alias_restore_v1'));
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_read_registry_apply_required_import_contracts_v1(
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
  v_resource_key TEXT;
  v_relation TEXT;
  v_relation_schema TEXT;
  v_relation_table TEXT;
  v_scope_columns JSONB;
  v_column_key TEXT;
  v_column_import JSONB;
  v_column_meta JSONB;
  v_meta_entry JSONB;
  v_required BOOLEAN := FALSE;
  v_aliases JSONB;
BEGIN
  IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
    RETURN v_current;
  END IF;

  FOR v_resource IN
    SELECT value
    FROM jsonb_array_elements(v_resources) AS value
  LOOP
    v_resource_key := NULLIF(btrim(COALESCE(v_resource->>'key', '')), '');
    v_relation := NULLIF(btrim(COALESCE(v_resource->>'relation', '')), '');
    v_relation_schema := split_part(COALESCE(v_relation, ''), '.', 1);
    v_relation_table := split_part(COALESCE(v_relation, ''), '.', 2);
    IF NULLIF(btrim(COALESCE(v_relation_table, '')), '') IS NULL THEN
      v_relation_table := v_relation_schema;
      v_relation_schema := 'public';
    END IF;

    v_scope_columns := COALESCE(v_resource->'scope_columns', '{}'::jsonb);
    v_columns := COALESCE(v_resource->'columns', '[]'::jsonb);

    IF jsonb_typeof(v_columns) IS DISTINCT FROM 'array' OR v_relation IS NULL THEN
      v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
      CONTINUE;
    END IF;

    SELECT COALESCE(
             jsonb_object_agg(
               cols.column_name,
               jsonb_build_object(
                 'is_nullable', cols.is_nullable,
                 'column_default', cols.column_default
               )
             ),
             '{}'::jsonb
           )
      INTO v_column_meta
      FROM information_schema.columns cols
     WHERE cols.table_schema = v_relation_schema
       AND cols.table_name = v_relation_table;

    v_updated_columns := '[]'::jsonb;

    FOR v_column IN
      SELECT value
      FROM jsonb_array_elements(v_columns) AS value
    LOOP
      v_column_key := NULLIF(btrim(COALESCE(v_column->>'key', '')), '');
      IF v_column_key IS NULL THEN
        v_updated_columns := v_updated_columns || jsonb_build_array(v_column);
        CONTINUE;
      END IF;

      v_column_import := COALESCE(v_column->'import', '{}'::jsonb);
      IF jsonb_typeof(v_column_import) IS DISTINCT FROM 'object' THEN
        v_column_import := '{}'::jsonb;
      END IF;

      BEGIN
        v_required := COALESCE(NULLIF(v_column_import->>'required', '')::boolean, FALSE);
      EXCEPTION
        WHEN OTHERS THEN
          v_required := FALSE;
      END;

      IF v_required IS DISTINCT FROM TRUE THEN
        v_meta_entry := COALESCE(v_column_meta->v_column_key, '{}'::jsonb);
        IF jsonb_typeof(v_meta_entry) = 'object'
           AND COALESCE(v_meta_entry->>'is_nullable', 'YES') = 'NO'
           AND COALESCE(v_meta_entry->>'column_default', '') = ''
           AND v_column_key <> COALESCE(NULLIF(btrim(COALESCE(v_resource->>'id_column', '')), ''), 'id')
           AND v_column_key NOT IN ('created_at', 'updated_at')
           AND NOT EXISTS (
             SELECT 1
             FROM jsonb_each_text(v_scope_columns) AS scope_entry(key, value)
             WHERE NULLIF(btrim(scope_entry.value), '') = v_column_key
           )
        THEN
          v_required := TRUE;
        END IF;
      END IF;

      v_column_import := jsonb_set(
        v_column_import,
        '{required}',
        to_jsonb(v_required),
        TRUE
      );

      IF v_resource_key = 'addresses' AND v_column_key = 'raw_input' THEN
        v_aliases := CASE
          WHEN jsonb_typeof(v_column_import->'aliases') = 'array' THEN v_column_import->'aliases'
          ELSE '[]'::jsonb
        END;
        v_aliases := v_aliases
          || jsonb_build_array('address', 'address_line_1', 'address_line1', 'line1', 'street', 'raw_address');

        SELECT COALESCE(jsonb_agg(to_jsonb(value) ORDER BY min_ord), '[]'::jsonb)
          INTO v_aliases
          FROM (
            SELECT value, MIN(ord) AS min_ord
            FROM jsonb_array_elements_text(v_aliases) WITH ORDINALITY AS entry(value, ord)
            WHERE NULLIF(btrim(value), '') IS NOT NULL
            GROUP BY value
          ) dedup;

        v_column_import := jsonb_set(v_column_import, '{aliases}', COALESCE(v_aliases, '[]'::jsonb), TRUE);
      END IF;

      v_updated_columns := v_updated_columns || jsonb_build_array(
        jsonb_set(v_column, '{import}', v_column_import, TRUE)
      );
    END LOOP;

    v_updated_resources := v_updated_resources || jsonb_build_array(
      jsonb_set(v_resource, '{columns}', COALESCE(v_updated_columns, '[]'::jsonb), TRUE)
    );
  END LOOP;

  RETURN jsonb_set(v_current, '{resources}', COALESCE(v_updated_resources, '[]'::jsonb), TRUE);
END;
$function$;

COMMENT ON FUNCTION public.ui_read_registry_apply_required_import_contracts_v1(JSONB)
  IS 'Apply live required-field metadata and canonical address raw-input aliases to ui_read_registry import contracts.';



COMMIT;
