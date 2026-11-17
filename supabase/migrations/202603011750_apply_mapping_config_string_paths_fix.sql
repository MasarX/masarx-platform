-- Plan: PLAN-202603-go-live-readiness-remediation-a422 / Step: S04
-- Purpose:
--   - Fix apply_mapping_config string transform paths (single-path spec) so they
--     resolve identically to one-item path arrays.
--   - Keep mapping behavior row-driven and backward compatible for existing configs.

BEGIN;

CREATE OR REPLACE FUNCTION public.apply_mapping_config(
    p_source JSONB,
    p_mapping_config_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO 'public, pg_temp'
AS $function$
DECLARE
    v_config RECORD;
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
    IF p_source IS NULL OR p_mapping_config_id IS NULL THEN
        RETURN p_source;
    END IF;

    SELECT mapping_config
      INTO v_config
      FROM public.mapping_configs
     WHERE id = p_mapping_config_id;

    IF NOT FOUND OR v_config.mapping_config IS NULL THEN
        RETURN p_source;
    END IF;

    -- Prefer explicit field_mappings when present.
    IF v_config.mapping_config ? 'field_mappings' THEN
        v_result := public.jsonb_extract_fields(
            p_source,
            v_config.mapping_config->'field_mappings'
        );
        RETURN v_result;
    END IF;

    -- Support nested object transforms (e.g., communication.reply payloads).
    IF v_config.mapping_config ? 'transforms' THEN
        v_result := '{}'::jsonb;
        FOR v_target, v_spec IN
            SELECT key, value
              FROM jsonb_each(v_config.mapping_config->'transforms')
        LOOP
            IF jsonb_typeof(v_spec) = 'object' THEN
                v_object := '{}'::jsonb;
                FOR v_field_key, v_field_spec IN
                    SELECT key, value
                      FROM jsonb_each(v_spec)
                LOOP
                    -- Normalize transform field spec into TEXT[] candidate paths.
                    -- Accept either:
                    --   1) "entry.0.value"
                    --   2) ["entry.0.value", "messages.0.value"]
                    SELECT COALESCE(array_agg(elem), ARRAY[]::text[])
                      INTO v_candidate_paths
                      FROM jsonb_array_elements_text(
                        CASE
                          WHEN jsonb_typeof(v_field_spec) = 'string'
                            THEN jsonb_build_array(v_field_spec)
                          WHEN jsonb_typeof(v_field_spec) = 'array'
                            THEN v_field_spec
                          ELSE '[]'::jsonb
                        END
                      ) AS elem;

                    v_field_val := NULL;
                    FOREACH v_path IN ARRAY v_candidate_paths LOOP
                        v_jsonpath := public.normalize_jsonpath(v_path);
                        BEGIN
                            IF v_jsonpath IS NULL THEN
                                v_field_val := NULL;
                            ELSE
                                v_field_val := jsonb_path_query_first(p_source, v_jsonpath::JSONPATH);
                            END IF;
                        EXCEPTION
                            WHEN OTHERS THEN
                                v_field_val := NULL;
                        END;

                        IF v_field_val IS NULL OR v_field_val = 'null'::jsonb THEN
                            v_field_val := NULL;
                        ELSE
                            EXIT;
                        END IF;
                    END LOOP;

                    IF v_field_val IS NULL THEN
                        v_field_val := 'null'::jsonb;
                    END IF;

                    v_object := jsonb_set(v_object, ARRAY[v_field_key], v_field_val, TRUE);
                END LOOP;
                v_result := jsonb_set(v_result, ARRAY[v_target], v_object, TRUE);
            END IF;
        END LOOP;
        RETURN v_result;
    END IF;

    RETURN p_source;
END;
$function$;

COMMIT;
