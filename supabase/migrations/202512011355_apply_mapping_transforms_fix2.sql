-- Migration: Correct apply_mapping_config transforms evaluation (use separate value holder)
-- Date: 2025-12-01

BEGIN;

CREATE OR REPLACE FUNCTION public.apply_mapping_config(
    p_source JSONB,
    p_mapping_config_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO 'public, pg_temp'
AS $$
DECLARE
    v_config RECORD;
    v_result JSONB := '{}'::JSONB;
    v_target TEXT;
    v_spec JSONB;
    v_field_key TEXT;
    v_path TEXT;
    v_field_val JSONB;
    v_object JSONB;
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
                FOR v_field_key, v_path IN
                    SELECT key, value::TEXT FROM jsonb_each_text(v_spec)
                LOOP
                    BEGIN
                        v_field_val := jsonb_path_query_first(p_source, v_path::JSONPATH);
                    EXCEPTION
                        WHEN OTHERS THEN
                            v_field_val := NULL;
                    END;
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
$$;

COMMIT;
