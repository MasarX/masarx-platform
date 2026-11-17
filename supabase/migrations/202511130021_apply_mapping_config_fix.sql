-- Migration: apply_mapping_config qualification fix

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

    IF v_config.mapping_config ? 'field_mappings' THEN
        v_result := jsonb_extract_fields(
            p_source,
            v_config.mapping_config->'field_mappings'
        );
    ELSE
        v_result := p_source;
    END IF;

    RETURN v_result;
END;
$$;

COMMIT;

