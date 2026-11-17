-- Plan: PLAN-202603-resource-import-related-node-graph / Step: S04
-- Migration: Preserve canonical reference import contracts through scoped ui_read_registry merges

BEGIN;

SELECT pg_advisory_lock(hashtext('202603111120_ui_read_registry_reference_survival_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_read_registry_enrich_reference_import_v1(
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
  v_canonical_registry JSONB := COALESCE(
    public.resolve_settings_merged('ui_read_registry', 'global', NULL),
    '{}'::jsonb
  );
  v_canonical_resources JSONB := COALESCE(v_canonical_registry->'resources', '[]'::jsonb);
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_canonical_resource JSONB;
  v_columns JSONB;
  v_updated_columns JSONB;
  v_column JSONB;
  v_canonical_column JSONB;
  v_relation TEXT;
  v_relation_schema TEXT;
  v_relation_table TEXT;
  v_column_key TEXT;
  v_column_import JSONB;
  v_existing_reference JSONB;
  v_canonical_import JSONB;
  v_canonical_reference JSONB;
  v_reference JSONB;
  v_ref_schema TEXT;
  v_ref_table TEXT;
  v_ref_column TEXT;
  v_target_resource JSONB;
  v_target_resource_key TEXT;
  v_target_relation TEXT;
  v_target_id_column TEXT;
  v_target_scope_columns JSONB;
  v_display_columns JSONB;
  v_label_column TEXT;
  v_scope_type TEXT;
BEGIN
  IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
    RETURN v_current;
  END IF;

  IF jsonb_typeof(v_canonical_resources) IS DISTINCT FROM 'array' THEN
    v_canonical_resources := '[]'::jsonb;
  END IF;

  FOR v_resource IN
    SELECT value
    FROM jsonb_array_elements(v_resources) AS value
  LOOP
    v_relation := NULLIF(btrim(COALESCE(v_resource->>'relation', '')), '');
    v_relation_schema := split_part(COALESCE(v_relation, ''), '.', 1);
    v_relation_table := split_part(COALESCE(v_relation, ''), '.', 2);
    IF NULLIF(btrim(COALESCE(v_relation_table, '')), '') IS NULL THEN
      v_relation_table := v_relation_schema;
      v_relation_schema := 'public';
    END IF;

    SELECT value
      INTO v_canonical_resource
      FROM jsonb_array_elements(v_canonical_resources) AS value
     WHERE NULLIF(btrim(COALESCE(value->>'key', '')), '') = NULLIF(btrim(COALESCE(v_resource->>'key', '')), '')
        OR NULLIF(btrim(COALESCE(value->>'relation', '')), '') = v_relation
     LIMIT 1;

    v_columns := COALESCE(v_resource->'columns', '[]'::jsonb);
    IF jsonb_typeof(v_columns) IS DISTINCT FROM 'array' OR v_relation IS NULL THEN
      v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
      CONTINUE;
    END IF;

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

      v_existing_reference := COALESCE(v_column_import->'reference', '{}'::jsonb);
      IF jsonb_typeof(v_existing_reference) IS DISTINCT FROM 'object' THEN
        v_existing_reference := '{}'::jsonb;
      END IF;

      v_canonical_column := NULL;
      IF v_canonical_resource IS NOT NULL THEN
        SELECT value
          INTO v_canonical_column
          FROM jsonb_array_elements(COALESCE(v_canonical_resource->'columns', '[]'::jsonb)) AS value
         WHERE NULLIF(btrim(COALESCE(value->>'key', '')), '') = v_column_key
         LIMIT 1;
      END IF;

      v_canonical_import := COALESCE(v_canonical_column->'import', '{}'::jsonb);
      IF jsonb_typeof(v_canonical_import) IS DISTINCT FROM 'object' THEN
        v_canonical_import := '{}'::jsonb;
      END IF;

      v_canonical_reference := COALESCE(v_canonical_import->'reference', '{}'::jsonb);
      IF jsonb_typeof(v_canonical_reference) IS DISTINCT FROM 'object' THEN
        v_canonical_reference := '{}'::jsonb;
      END IF;

      v_ref_schema := NULL;
      v_ref_table := NULL;
      v_ref_column := NULL;
      v_scope_type := NULL;

      SELECT ref_ns.nspname,
             ref_cls.relname,
             ref_att.attname
        INTO v_ref_schema,
             v_ref_table,
             v_ref_column
        FROM pg_constraint con
        JOIN pg_class src_cls
          ON src_cls.oid = con.conrelid
        JOIN pg_namespace src_ns
          ON src_ns.oid = src_cls.relnamespace
        JOIN pg_class ref_cls
          ON ref_cls.oid = con.confrelid
        JOIN pg_namespace ref_ns
          ON ref_ns.oid = ref_cls.relnamespace
        JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS src_key(attnum, ordinality)
          ON TRUE
        JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS ref_key(attnum, ordinality)
          ON ref_key.ordinality = src_key.ordinality
        JOIN pg_attribute src_att
          ON src_att.attrelid = src_cls.oid
         AND src_att.attnum = src_key.attnum
        JOIN pg_attribute ref_att
          ON ref_att.attrelid = ref_cls.oid
         AND ref_att.attnum = ref_key.attnum
       WHERE con.contype = 'f'
         AND src_ns.nspname = v_relation_schema
         AND src_cls.relname = v_relation_table
         AND array_length(con.conkey, 1) = 1
         AND src_att.attname = v_column_key
       LIMIT 1;

      IF v_ref_table IS NULL THEN
        SELECT scope_entry.key
          INTO v_scope_type
          FROM jsonb_each_text(COALESCE(v_resource->'scope_columns', '{}'::jsonb)) AS scope_entry(key, value)
         WHERE NULLIF(btrim(scope_entry.value), '') = v_column_key
         LIMIT 1;

        IF v_scope_type IS NOT NULL THEN
          SELECT ref_ns.nspname,
                 ref_cls.relname,
                 NULLIF(btrim(COALESCE(reg.id_column, '')), '')
            INTO v_ref_schema,
                 v_ref_table,
                 v_ref_column
            FROM public.scope_type_registry reg
            JOIN pg_class ref_cls
              ON ref_cls.oid = reg.entity_table
            JOIN pg_namespace ref_ns
              ON ref_ns.oid = ref_cls.relnamespace
           WHERE reg.scope_type = v_scope_type
             AND reg.entity_table IS NOT NULL
             AND reg.is_enabled = TRUE
           LIMIT 1;
        END IF;
      END IF;

      IF v_ref_table IS NULL THEN
        IF v_canonical_reference <> '{}'::jsonb THEN
          v_column_import := jsonb_set(
            v_column_import,
            '{reference}',
            jsonb_strip_nulls(v_canonical_reference || v_existing_reference),
            TRUE
          );
          v_updated_columns := v_updated_columns || jsonb_build_array(
            jsonb_set(v_column, '{import}', v_column_import, TRUE)
          );
        ELSE
          v_updated_columns := v_updated_columns || jsonb_build_array(v_column);
        END IF;
        CONTINUE;
      END IF;

      v_target_resource := NULL;
      v_target_relation := format('%s.%s', v_ref_schema, v_ref_table);

      SELECT value
        INTO v_target_resource
        FROM jsonb_array_elements(v_resources) AS value
       WHERE COALESCE(value->>'relation', '') = v_target_relation
       LIMIT 1;

      IF v_target_resource IS NULL THEN
        SELECT value
          INTO v_target_resource
          FROM jsonb_array_elements(v_canonical_resources) AS value
         WHERE COALESCE(value->>'relation', '') = v_target_relation
            OR NULLIF(btrim(COALESCE(value->>'key', '')), '') = NULLIF(btrim(COALESCE(v_canonical_reference->>'resource', '')), '')
         LIMIT 1;
      END IF;

      v_target_resource_key := COALESCE(
        NULLIF(btrim(COALESCE(v_target_resource->>'key', '')), ''),
        NULLIF(btrim(COALESCE(v_canonical_reference->>'resource', '')), '')
      );

      v_target_id_column := COALESCE(
        NULLIF(btrim(COALESCE(v_ref_column, '')), ''),
        NULLIF(btrim(COALESCE(v_target_resource->>'id_column', '')), ''),
        NULLIF(btrim(COALESCE(v_canonical_reference->>'id_column', '')), ''),
        'id'
      );
      v_target_scope_columns := COALESCE(v_target_resource->'scope_columns', '{}'::jsonb);

      IF v_target_resource IS NOT NULL THEN
        SELECT COALESCE(jsonb_agg(to_jsonb(display_key) ORDER BY sort_order), '[]'::jsonb)
          INTO v_display_columns
          FROM (
            SELECT display_key, min(sort_order) AS sort_order
            FROM (
              SELECT NULLIF(btrim(value), '') AS display_key, ordinality AS sort_order
              FROM jsonb_array_elements_text(COALESCE(v_target_resource->'select', '[]'::jsonb)) WITH ORDINALITY AS select_columns(value, ordinality)
              UNION ALL
              SELECT NULLIF(btrim(COALESCE(column_value.value->>'key', '')), '') AS display_key, 1000 + ordinality AS sort_order
              FROM jsonb_array_elements(COALESCE(v_target_resource->'columns', '[]'::jsonb)) WITH ORDINALITY AS column_value(value, ordinality)
            ) candidates
            WHERE display_key IS NOT NULL
              AND display_key <> v_target_id_column
              AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_scope_columns->>'tenant', '')), ''), '__none__')
              AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_scope_columns->>'client', '')), ''), '__none__')
              AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_scope_columns->>'sender', '')), ''), '__none__')
              AND display_key NOT IN ('created_at', 'updated_at')
            GROUP BY display_key
            ORDER BY min(sort_order)
            LIMIT 3
          ) ranked;

        SELECT ranked.display_key
          INTO v_label_column
          FROM (
            SELECT display_key, min(sort_order) AS sort_order
            FROM (
              SELECT NULLIF(btrim(value), '') AS display_key, ordinality AS sort_order
              FROM jsonb_array_elements_text(COALESCE(v_target_resource->'select', '[]'::jsonb)) WITH ORDINALITY AS select_columns(value, ordinality)
              UNION ALL
              SELECT NULLIF(btrim(COALESCE(column_value.value->>'key', '')), '') AS display_key, 1000 + ordinality AS sort_order
              FROM jsonb_array_elements(COALESCE(v_target_resource->'columns', '[]'::jsonb)) WITH ORDINALITY AS column_value(value, ordinality)
            ) candidates
            WHERE display_key IS NOT NULL
              AND display_key <> v_target_id_column
              AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_scope_columns->>'tenant', '')), ''), '__none__')
              AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_scope_columns->>'client', '')), ''), '__none__')
              AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_scope_columns->>'sender', '')), ''), '__none__')
              AND display_key NOT IN ('created_at', 'updated_at')
            GROUP BY display_key
            ORDER BY min(sort_order)
            LIMIT 1
          ) ranked;
      ELSE
        v_display_columns := COALESCE(v_canonical_reference->'display_columns', '[]'::jsonb);
        v_label_column := NULLIF(btrim(COALESCE(v_canonical_reference->>'label_column', '')), '');
      END IF;

      v_reference := jsonb_strip_nulls(
        jsonb_build_object(
          'resource', v_target_resource_key,
          'relation', COALESCE(
            NULLIF(btrim(COALESCE(v_target_relation, '')), ''),
            NULLIF(btrim(COALESCE(v_canonical_reference->>'relation', '')), '')
          ),
          'id_column', v_target_id_column,
          'label', COALESCE(
            NULLIF(btrim(COALESCE(v_target_resource->>'label', '')), ''),
            NULLIF(btrim(COALESCE(v_canonical_reference->>'label', '')), '')
          ),
          'label_column', COALESCE(
            NULLIF(btrim(COALESCE(v_label_column, '')), ''),
            NULLIF(btrim(COALESCE(v_canonical_reference->>'label_column', '')), '')
          ),
          'display_columns', CASE
            WHEN jsonb_typeof(v_display_columns) = 'array' AND jsonb_array_length(v_display_columns) > 0
              THEN v_display_columns
            WHEN jsonb_typeof(v_canonical_reference->'display_columns') = 'array'
                 AND jsonb_array_length(v_canonical_reference->'display_columns') > 0
              THEN v_canonical_reference->'display_columns'
            ELSE NULL
          END
        )
      ) || v_canonical_reference || v_existing_reference;

      v_column_import := jsonb_set(v_column_import, '{reference}', jsonb_strip_nulls(v_reference), TRUE);

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

COMMENT ON FUNCTION public.ui_read_registry_enrich_reference_import_v1(JSONB)
  IS 'Enrich ui_read_registry import metadata with FK-backed, scope-backed, and canonical reference contracts so scoped registry merges do not drop reusable import references or inline node graph metadata.';

SELECT pg_advisory_unlock(hashtext('202603111120_ui_read_registry_reference_survival_v1'));

COMMIT;
