-- Migration: Label template validation hook and basic page/block checks
-- Purpose: Provide validate_label_template() and hook to populate validation_status
--          for new template versions, without hardcoding scope logic.
-- Notes:   Minimal geometry checks (page + block dims and page bounds). Section-aware
--          checks will be added once sectioned templates are seeded (v1.6).

BEGIN;

SET search_path TO public, pg_temp;

-- Basic validator: ensures renderer_config has page + blocks with positive dimensions
-- and that blocks stay within the page box (margin-aware).
CREATE OR REPLACE FUNCTION validate_label_template(
    p_template_id UUID,
    p_organization_id UUID,
    p_validated_by UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_tpl RECORD;
    v_errors JSONB := '[]'::jsonb;
    v_page JSONB;
    v_margin_in NUMERIC := 0;
    v_margin_pts NUMERIC := 0;
    v_page_w_in NUMERIC;
    v_page_h_in NUMERIC;
    v_page_w_pts NUMERIC;
    v_page_h_pts NUMERIC;
    blk JSONB;
    bx NUMERIC;
    b_y NUMERIC;
    bw NUMERIC;
    bh NUMERIC;
BEGIN
    SELECT renderer_config, organization_id
    INTO v_tpl
    FROM label_template_specs
    WHERE id = p_template_id
      AND organization_id = p_organization_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Template % (org %) not found', p_template_id, p_organization_id
            USING ERRCODE = 'P0002';
    END IF;

    v_page := v_tpl.renderer_config -> 'page';
    IF v_page IS NULL THEN
        v_errors := v_errors || jsonb_build_object(
            'code', 'page_missing',
            'message', 'renderer_config.page missing'
        );
    ELSE
        v_page_w_in := NULLIF((v_page ->> 'width_inch')::NUMERIC, 0);
        v_page_h_in := NULLIF((v_page ->> 'height_inch')::NUMERIC, 0);
        v_margin_in := COALESCE((v_page ->> 'margin_inch')::NUMERIC, 0);
        v_margin_pts := v_margin_in * 72;
        IF v_page_w_in IS NULL OR v_page_w_in <= 0 THEN
            v_errors := v_errors || jsonb_build_object(
                'code', 'page_width_invalid',
                'message', 'page width invalid or missing'
            );
        END IF;
        IF v_page_h_in IS NULL OR v_page_h_in <= 0 THEN
            v_errors := v_errors || jsonb_build_object(
                'code', 'page_height_invalid',
                'message', 'page height invalid or missing'
            );
        END IF;
        IF v_errors = '[]'::jsonb THEN
            v_page_w_pts := v_page_w_in * 72;
            v_page_h_pts := v_page_h_in * 72;
        END IF;
    END IF;

    IF v_tpl.renderer_config -> 'blocks' IS NULL THEN
        v_errors := v_errors || jsonb_build_object(
            'code', 'blocks_missing',
            'message', 'renderer_config.blocks missing'
        );
    ELSE
        FOR blk IN SELECT * FROM jsonb_array_elements(v_tpl.renderer_config -> 'blocks')
        LOOP
            bx := (blk ->> 'x')::NUMERIC;
            b_y := (blk ->> 'y')::NUMERIC;
            bw := (blk ->> 'width')::NUMERIC;
            bh := (blk ->> 'height')::NUMERIC;
            IF bw IS NULL OR bw <= 0 OR bh IS NULL OR bh <= 0 THEN
                v_errors := v_errors || jsonb_build_object(
                    'code', 'block_dim_invalid',
                    'message', 'block width/height invalid',
                    'block', blk
                );
            END IF;
            -- Bounds check only when page dims are known
            IF v_page_w_pts IS NOT NULL AND v_page_h_pts IS NOT NULL THEN
                IF bx < v_margin_pts OR b_y < v_margin_pts THEN
                    v_errors := v_errors || jsonb_build_object(
                        'code', 'block_out_of_bounds_top_left',
                        'message', 'block starts before margin',
                        'block', blk
                    );
                END IF;
                IF (bx + bw) > (v_page_w_pts - v_margin_pts) OR (b_y + bh) > (v_page_h_pts - v_margin_pts) THEN
                    v_errors := v_errors || jsonb_build_object(
                        'code', 'block_out_of_bounds_bottom_right',
                        'message', 'block exceeds page bounds',
                        'block', blk
                    );
                END IF;
            END IF;
        END LOOP;
    END IF;

    INSERT INTO label_template_validation AS v (
        template_id,
        organization_id,
        validation_status,
        validated_at,
        validated_by,
        validation_errors
    )
    VALUES (
        p_template_id,
        p_organization_id,
        CASE WHEN v_errors = '[]'::jsonb THEN 'passed' ELSE 'failed' END,
        now(),
        p_validated_by,
        v_errors
    )
    ON CONFLICT (template_id, organization_id) DO UPDATE
    SET validation_status = EXCLUDED.validation_status,
        validated_at = EXCLUDED.validated_at,
        validated_by = EXCLUDED.validated_by,
        validation_errors = EXCLUDED.validation_errors;
END;
$$;

COMMENT ON FUNCTION validate_label_template(UUID, UUID, UUID) IS
'Validates basic page/block geometry for a label template. Section-aware checks will be added when sectioned templates are present.';

-- Hook: run validation after inserting a template spec
CREATE OR REPLACE FUNCTION trg_label_template_specs_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM validate_label_template(NEW.id, NEW.organization_id, NULL);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_label_template_specs_validate ON label_template_specs;

CREATE TRIGGER trg_label_template_specs_validate
    AFTER INSERT ON label_template_specs
    FOR EACH ROW
    EXECUTE FUNCTION trg_label_template_specs_validate();

COMMIT;
