-- Migration: ui_related_resources_v1 supports composite FKs
BEGIN;
SELECT pg_advisory_lock(hashtext('202601201040_ui_related_resources_v1_composite_fk'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_related_resources_v1(
  p_resource TEXT,
  p_limit INT DEFAULT 12
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_read_registry', v_scope_type, v_scope_id);
  v_resource JSONB;
  v_relation TEXT;
  v_schema TEXT;
  v_table TEXT;
  v_reg REGCLASS;
  v_capability TEXT;
  v_default_limit INT := 25;
  v_result JSONB;
BEGIN
  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_related_resources_v1 requires resource key';
  END IF;

  SELECT value INTO v_resource
    FROM jsonb_array_elements(v_registry->'resources') AS value
   WHERE value->>'key' = p_resource
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_related_resources_v1 unknown resource %', p_resource;
  END IF;

  v_relation := v_resource->>'relation';
  v_capability := NULLIF(v_resource->>'capability_read', '');

  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  IF v_relation IS NULL OR btrim(v_relation) = '' THEN
    RAISE EXCEPTION 'ui_related_resources_v1 resource missing relation';
  END IF;

  v_schema := split_part(v_relation, '.', 1);
  v_table := split_part(v_relation, '.', 2);
  IF v_table IS NULL OR v_table = '' THEN
    v_schema := 'public';
    v_table := v_relation;
  END IF;

  v_reg := to_regclass(format('%I.%I', v_schema, v_table));
  IF v_reg IS NULL THEN
    RAISE EXCEPTION 'ui_related_resources_v1 relation not found: %', v_relation;
  END IF;

  v_result := (
    WITH registry_resources AS (
      SELECT
        value->>'key' AS resource_key,
        COALESCE(NULLIF(value->>'label', ''), value->>'key') AS resource_label,
        value->>'relation' AS relation
      FROM jsonb_array_elements(v_registry->'resources') AS value
      WHERE value ? 'key' AND value ? 'relation'
    ),
    normalized_resources AS (
      SELECT
        resource_key,
        resource_label,
        CASE
          WHEN position('.' IN relation) > 0 THEN split_part(relation, '.', 1)
          ELSE 'public'
        END AS schema_name,
        CASE
          WHEN position('.' IN relation) > 0 THEN split_part(relation, '.', 2)
          ELSE relation
        END AS table_name
      FROM registry_resources
      WHERE relation IS NOT NULL AND btrim(relation) <> ''
    ),
    fks AS (
      SELECT
        n.nspname AS fk_schema,
        c.relname AS fk_table,
        array_agg(fk_col.attname::text ORDER BY conkey.ord) AS fk_columns,
        array_agg(pk_col.attname::text ORDER BY conkey.ord) AS pk_columns
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS conkey(attnum, ord) ON TRUE
      JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS confkey(attnum, ord) ON confkey.ord = conkey.ord
      JOIN pg_attribute fk_col ON fk_col.attrelid = con.conrelid AND fk_col.attnum = conkey.attnum
      JOIN pg_attribute pk_col ON pk_col.attrelid = con.confrelid AND pk_col.attnum = confkey.attnum
      WHERE con.contype = 'f'
        AND con.confrelid = v_reg
        AND c.relkind IN ('r','p')
        AND c.relrowsecurity IS TRUE
      GROUP BY n.nspname, c.relname
    ),
    matches AS (
      SELECT
        nr.resource_key AS resource,
        nr.resource_label AS label,
        fks.fk_columns AS filter_keys,
        fks.pk_columns AS from_keys
      FROM fks
      JOIN normalized_resources nr
        ON nr.schema_name = fks.fk_schema
       AND nr.table_name = fks.fk_table
      WHERE nr.resource_key <> p_resource
    ),
    dedup AS (
      SELECT DISTINCT ON (resource) resource, label, filter_keys, from_keys
      FROM matches
      ORDER BY resource
    ),
    limited AS (
      SELECT *
      FROM dedup
      ORDER BY resource
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 12), 0), 50)
    )
    SELECT COALESCE(
      jsonb_agg(
        jsonb_strip_nulls(
          jsonb_build_object(
            'resource', resource,
            'label', label,
            'filter_key',
              CASE
                WHEN array_length(filter_keys, 1) = 1 THEN filter_keys[1]
                ELSE to_jsonb(filter_keys)
              END,
            'from',
              CASE
                WHEN array_length(from_keys, 1) = 1 THEN from_keys[1]
                ELSE to_jsonb(from_keys)
              END,
            'limit', v_default_limit
          )
        )
      ),
      '[]'::jsonb
    )
    FROM limited
  );

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.ui_related_resources_v1(TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_related_resources_v1(TEXT, INT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601201040_ui_related_resources_v1_composite_fk'));
COMMIT;

