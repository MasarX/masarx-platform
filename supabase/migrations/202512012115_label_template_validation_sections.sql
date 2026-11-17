-- Migration: Enhance label template validation with section checks
-- Purpose: Extend validate_label_template to enforce section containment when sections are present.
-- Notes: Blocks can optionally carry section_key; when provided and matching a label_sections row,
--        the block must fit within the section minus padding. Page/block checks remain intact.

BEGIN;

SET search_path TO public, pg_temp;

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
    v_tokens JSONB := '{}'::jsonb;
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
    s RECORD;
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

    -- Load tokens (optional)
    SELECT COALESCE(jsonb_object_agg(token_key, value), '{}'::jsonb)
    INTO v_tokens
    FROM label_design_tokens
    WHERE template_id = p_template_id
      AND organization_id = p_organization_id;

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
            -- Token-aware font size floor (auto-scale floor)
            IF blk ? 'font_size' AND v_tokens ? 'min_font_size' THEN
                IF (blk ->> 'font_size')::NUMERIC < (v_tokens ->> 'min_font_size')::NUMERIC THEN
                    v_errors := v_errors || jsonb_build_object(
                        'code', 'font_size_below_min',
                        'message', 'font size below min_font_size token',
                        'block', blk
                    );
                END IF;
            END IF;

            IF bw IS NULL OR bw <= 0 OR bh IS NULL OR bh <= 0 THEN
                v_errors := v_errors || jsonb_build_object(
                    'code', 'block_dim_invalid',
                    'message', 'block width/height invalid',
                    'block', blk
                );
            END IF;

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

            -- Barcode minimums via tokens
            IF blk ->> 'type' = 'barcode' THEN
                IF v_tokens ? 'barcode_min_module_width' AND blk ? 'module_width' THEN
                    IF (blk ->> 'module_width')::NUMERIC < (v_tokens ->> 'barcode_min_module_width')::NUMERIC THEN
                        v_errors := v_errors || jsonb_build_object(
                            'code', 'barcode_module_width_below_min',
                            'message', 'barcode module_width below minimum token',
                            'block', blk
                        );
                    END IF;
                END IF;
                IF v_tokens ? 'barcode_min_height' AND blk ? 'height' THEN
                    IF (blk ->> 'height')::NUMERIC < (v_tokens ->> 'barcode_min_height')::NUMERIC THEN
                        v_errors := v_errors || jsonb_build_object(
                            'code', 'barcode_height_below_min',
                            'message', 'barcode height below minimum token',
                            'block', blk
                        );
                    END IF;
                END IF;
            END IF;

            -- Optional section containment: if block.section_key exists and section present, enforce fit.
            IF blk ? 'section_key' THEN
                SELECT *
                INTO s
                FROM label_sections
                WHERE template_id = p_template_id
                  AND organization_id = p_organization_id
                  AND section_key = blk ->> 'section_key'
                LIMIT 1;

                IF NOT FOUND THEN
                    v_errors := v_errors || jsonb_build_object(
                        'code', 'section_missing',
                        'message', 'block references missing section',
                        'block', blk
                    );
                ELSE
                    IF bx < s.x + s.padding_left
                       OR b_y < s.y + s.padding_top
                       OR (bx + bw) > (s.x + s.width - s.padding_right)
                       OR (b_y + bh) > (s.y + s.height - s.padding_bottom) THEN
                        v_errors := v_errors || jsonb_build_object(
                            'code', 'block_outside_section',
                            'message', 'block exceeds section bounds',
                            'block', blk,
                            'section_key', s.section_key
                        );
                    END IF;
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
'Validates page/block geometry and section containment (when block.section_key present).';

-- Hook: run validation after inserting a template spec.
-- Keep this definition here so the migration is safe to apply even when
-- earlier hook migrations were skipped or applied out of order.
CREATE OR REPLACE FUNCTION trg_label_template_specs_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM validate_label_template(NEW.id, NEW.organization_id, NULL);
    RETURN NEW;
END;
$$;

-- Recreate trigger to ensure it points to the updated function
DROP TRIGGER IF EXISTS trg_label_template_specs_validate ON label_template_specs;

CREATE TRIGGER trg_label_template_specs_validate
    AFTER INSERT ON label_template_specs
    FOR EACH ROW
    EXECUTE FUNCTION trg_label_template_specs_validate();

COMMIT;
