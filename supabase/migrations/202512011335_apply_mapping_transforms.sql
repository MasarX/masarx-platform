-- Migration: Extend apply_mapping_config to honor mapping_config.transforms for nested objects
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
    v_key TEXT;
    v_path TEXT;
    v_value JSONB;
    v_temp JSONB;
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
        FOR v_key, v_temp IN
            SELECT key, value
            FROM jsonb_each(v_config.mapping_config->'transforms')
        LOOP
            v_value := '{}'::jsonb;
            IF jsonb_typeof(v_temp) = 'object' THEN
                FOR v_path, v_key IN
                    SELECT value::TEXT, key FROM jsonb_each_text(v_temp)
                LOOP
                    BEGIN
                        v_result := v_result; -- no-op to satisfy plpgsql scoping
                    EXCEPTION
                        WHEN OTHERS THEN NULL;
                    END;
                END LOOP;
                -- Re-loop to build object (preserve key scoping)
                v_value := '{}'::jsonb;
                FOR v_path, v_key IN
                    SELECT value::TEXT, key FROM jsonb_each_text(v_temp)
                LOOP
                    BEGIN
                        v_temp := jsonb_path_query_first(p_source, v_path::JSONPATH);
                    EXCEPTION
                        WHEN OTHERS THEN
                            v_temp := NULL;
                    END;
                    IF v_temp IS NULL THEN
                        v_temp := 'null'::jsonb;
                    END IF;
                    v_value := jsonb_set(v_value, ARRAY[v_key], v_temp, TRUE);
                END LOOP;
                v_result := jsonb_set(v_result, ARRAY[v_key], v_value, TRUE);
            END IF;
        END LOOP;
        RETURN v_result;
    END IF;

    RETURN p_source;
END;
$$;

COMMIT;
