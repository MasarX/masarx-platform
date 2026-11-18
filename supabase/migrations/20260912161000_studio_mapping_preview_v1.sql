BEGIN;
-- SSOT evaluator: extract runtime behavior without changing stored-map selection or RLS.
CREATE OR REPLACE FUNCTION public.evaluate_mapping_config_v1(
  p_source JSONB,
  p_mapping_config JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result JSONB := '{}'::JSONB;
  v_target TEXT;
  v_spec JSONB;
  v_field_key TEXT;
  v_field_spec JSONB;
  v_path TEXT;
  v_jsonpath TEXT;
  v_field_val JSONB;
  v_object JSONB;
  v_candidate_paths TEXT[];
BEGIN
  IF p_source IS NULL OR p_mapping_config IS NULL THEN RETURN p_source; END IF;
  IF p_mapping_config ? 'field_mappings' THEN
    RETURN public.jsonb_extract_fields(p_source, p_mapping_config->'field_mappings');
  END IF;
  IF p_mapping_config ? 'transforms' THEN
    v_result := '{}'::jsonb;
    FOR v_target, v_spec IN SELECT key, value FROM jsonb_each(p_mapping_config->'transforms') LOOP
      IF jsonb_typeof(v_spec) = 'object' THEN
        v_object := '{}'::jsonb;
        FOR v_field_key, v_field_spec IN SELECT key, value FROM jsonb_each(v_spec) LOOP
          SELECT COALESCE(array_agg(btrim(elem)) FILTER (WHERE btrim(elem) <> ''), ARRAY[]::text[])
          INTO v_candidate_paths
          FROM unnest(
            CASE
              WHEN jsonb_typeof(v_field_spec) = 'string'
                THEN regexp_split_to_array(v_field_spec #>> '{}', '\s*\|\s*')
              WHEN jsonb_typeof(v_field_spec) = 'array'
                THEN ARRAY(SELECT jsonb_array_elements_text(v_field_spec))
              ELSE ARRAY[]::text[]
            END
          ) AS elem;
          v_field_val := NULL;
          FOREACH v_path IN ARRAY v_candidate_paths LOOP
            v_jsonpath := public.normalize_jsonpath(v_path);
            BEGIN
              v_field_val := CASE WHEN v_jsonpath IS NULL THEN NULL
                ELSE jsonb_path_query_first(p_source, v_jsonpath::JSONPATH) END;
            EXCEPTION WHEN OTHERS THEN
              v_field_val := NULL;
            END;
            IF v_field_val IS NOT NULL AND v_field_val <> 'null'::jsonb THEN EXIT; END IF;
            v_field_val := NULL;
          END LOOP;
          v_object := jsonb_set(
            v_object,
            ARRAY[v_field_key],
            COALESCE(v_field_val, 'null'::jsonb),
            TRUE
          );
        END LOOP;
        v_result := jsonb_set(v_result, ARRAY[v_target], v_object, TRUE);
      END IF;
    END LOOP;
    RETURN v_result;
  END IF;
  RETURN p_source;
END;
$$;


CREATE OR REPLACE FUNCTION public.apply_mapping_config(p_source JSONB, p_mapping_config_id UUID)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_config JSONB;
BEGIN
  IF p_source IS NULL OR p_mapping_config_id IS NULL THEN RETURN p_source; END IF;
  SELECT mapping_config INTO v_config FROM public.mapping_configs WHERE id = p_mapping_config_id;
  IF NOT FOUND OR v_config IS NULL THEN RETURN p_source; END IF;
  RETURN public.evaluate_mapping_config_v1(p_source, v_config);
END;
$$;

-- The wrapper remains invoker, so mirror its existing callable-role set onto
-- the pure helper. No new role gains runtime mapping-row visibility.
REVOKE ALL ON FUNCTION public.evaluate_mapping_config_v1(JSONB, JSONB) FROM PUBLIC;
DO $acl$
DECLARE grant_row RECORD;
BEGIN
  FOR grant_row IN
    SELECT a.grantee, bool_or(a.is_grantable) AS is_grantable
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = 'public.apply_mapping_config(jsonb,uuid)'::regprocedure
      AND a.privilege_type = 'EXECUTE'
    GROUP BY a.grantee
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.evaluate_mapping_config_v1(JSONB, JSONB) TO %s%s',
      CASE WHEN grant_row.grantee = 0 THEN 'PUBLIC'
           ELSE quote_ident(pg_get_userbyid(grant_row.grantee)) END,
      CASE WHEN grant_row.is_grantable AND grant_row.grantee <> 0 THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END;
$acl$;
GRANT EXECUTE ON FUNCTION public.evaluate_mapping_config_v1(JSONB, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION api.integration_studio_preview_mapping_v1(p_source JSONB, p_mapping_config JSONB)
RETURNS JSONB LANGUAGE sql SET search_path = public, pg_temp
AS $$ SELECT public.evaluate_mapping_config_v1(p_source, p_mapping_config); $$;
REVOKE ALL ON FUNCTION api.integration_studio_preview_mapping_v1(JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION api.integration_studio_preview_mapping_v1(JSONB, JSONB) TO service_role;
COMMIT;
