-- Migration: Label template publish gate (validation-aware resolution + overlap checks)
-- Purpose:
--  - Make validate_label_template section/token-aware without false failures during seed order.
--  - Add overlap detection for collidable blocks (text/barcode/image), honoring simple render_if mutual exclusivity.
--  - Enforce "publish gate" by requiring validation_status='passed' before resolve_label_template can return a catalog template.

BEGIN;

SET search_path TO public, pg_temp;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.__label_try_numeric(p_text TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_text IS NULL OR btrim(p_text) = '' THEN
    RETURN NULL;
  END IF;
  IF p_text ~ '^-?\\d+(\\.\\d+)?$' THEN
    RETURN p_text::numeric;
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.__label_try_numeric(TEXT) IS
'Internal helper: best-effort numeric parse used by label template validation (returns NULL when not numeric).';

CREATE OR REPLACE FUNCTION public.__label_render_if_mutually_exclusive(p_a JSONB, p_b JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  a_if JSONB := p_a->'render_if';
  b_if JSONB := p_b->'render_if';
  a_path TEXT;
  b_path TEXT;
  a_eq TEXT;
  b_eq TEXT;
  a_neq TEXT;
  b_neq TEXT;
BEGIN
  IF a_if IS NULL OR b_if IS NULL THEN
    RETURN FALSE;
  END IF;
  a_path := NULLIF(btrim(a_if->>'path'), '');
  b_path := NULLIF(btrim(b_if->>'path'), '');
  IF a_path IS NULL OR b_path IS NULL OR a_path <> b_path THEN
    RETURN FALSE;
  END IF;

  a_eq := NULLIF(btrim(a_if->>'equals'), '');
  b_eq := NULLIF(btrim(b_if->>'equals'), '');
  a_neq := NULLIF(btrim(a_if->>'not_equals'), '');
  b_neq := NULLIF(btrim(b_if->>'not_equals'), '');

  -- equals vs equals: different required values => cannot both be true.
  IF a_eq IS NOT NULL AND b_eq IS NOT NULL AND a_eq <> b_eq THEN
    RETURN TRUE;
  END IF;

  -- equals vs not_equals: only mutually exclusive when the values match.
  IF a_eq IS NOT NULL AND b_neq IS NOT NULL AND a_eq = b_neq THEN
    RETURN TRUE;
  END IF;
  IF b_eq IS NOT NULL AND a_neq IS NOT NULL AND b_eq = a_neq THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$;

COMMENT ON FUNCTION public.__label_render_if_mutually_exclusive(JSONB, JSONB) IS
'Returns true when two blocks have render_if conditions that are trivially mutually exclusive (same path; equals vs equals with different values; equals vs not_equals with same value).';

CREATE OR REPLACE FUNCTION public.validate_label_renderer_config(p_renderer_config JSONB)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_errors JSONB := '[]'::jsonb;
  v_page JSONB;
  v_blocks JSONB;
  v_page_w_pts NUMERIC;
  v_page_h_pts NUMERIC;
  v_margin_pts NUMERIC := 0;
  v_has_page BOOLEAN := FALSE;
  blk JSONB;
  v_idx INT := 0;
  v_boxes JSONB := '[]'::jsonb;
  existing JSONB;
  bx NUMERIC;
  b_y NUMERIC;
  bw NUMERIC;
  bh NUMERIC;
  draw_x NUMERIC;
  draw_y NUMERIC;
  v_align TEXT;
  v_type TEXT;
  ex NUMERIC;
  ey NUMERIC;
  ew NUMERIC;
  eh NUMERIC;
BEGIN
  IF p_renderer_config IS NULL OR jsonb_typeof(p_renderer_config) <> 'object' THEN
    RETURN jsonb_build_array(jsonb_build_object('code','renderer_config_invalid','message','renderer_config must be an object'));
  END IF;

  v_page := p_renderer_config->'page';
  IF v_page IS NULL OR jsonb_typeof(v_page) <> 'object' THEN
    v_errors := v_errors || jsonb_build_object('code','page_missing','message','renderer_config.page missing');
  ELSE
    v_has_page := TRUE;
    -- Prefer explicit point dims; fallback to inches/mm.
    v_page_w_pts := public.__label_try_numeric(v_page->>'width_pt');
    v_page_h_pts := public.__label_try_numeric(v_page->>'height_pt');

    IF v_page_w_pts IS NULL OR v_page_h_pts IS NULL THEN
      IF public.__label_try_numeric(v_page->>'width_inch') IS NOT NULL AND public.__label_try_numeric(v_page->>'height_inch') IS NOT NULL THEN
        v_page_w_pts := public.__label_try_numeric(v_page->>'width_inch') * 72;
        v_page_h_pts := public.__label_try_numeric(v_page->>'height_inch') * 72;
      ELSIF public.__label_try_numeric(v_page->>'width_mm') IS NOT NULL AND public.__label_try_numeric(v_page->>'height_mm') IS NOT NULL THEN
        v_page_w_pts := (public.__label_try_numeric(v_page->>'width_mm') / 25.4) * 72;
        v_page_h_pts := (public.__label_try_numeric(v_page->>'height_mm') / 25.4) * 72;
      END IF;
    END IF;

    IF v_page_w_pts IS NULL OR v_page_w_pts <= 0 THEN
      v_errors := v_errors || jsonb_build_object('code','page_width_invalid','message','page width invalid or missing');
    END IF;
    IF v_page_h_pts IS NULL OR v_page_h_pts <= 0 THEN
      v_errors := v_errors || jsonb_build_object('code','page_height_invalid','message','page height invalid or missing');
    END IF;

    -- Margin (optional)
    IF public.__label_try_numeric(v_page->>'margin_inch') IS NOT NULL THEN
      v_margin_pts := public.__label_try_numeric(v_page->>'margin_inch') * 72;
    ELSIF public.__label_try_numeric(v_page->>'margin_mm') IS NOT NULL THEN
      v_margin_pts := (public.__label_try_numeric(v_page->>'margin_mm') / 25.4) * 72;
    ELSE
      v_margin_pts := 0;
    END IF;
  END IF;

  v_blocks := p_renderer_config->'blocks';
  IF v_blocks IS NULL OR jsonb_typeof(v_blocks) <> 'array' THEN
    v_errors := v_errors || jsonb_build_object('code','blocks_missing','message','renderer_config.blocks missing');
    RETURN v_errors;
  END IF;

  FOR blk IN SELECT * FROM jsonb_array_elements(v_blocks)
  LOOP
    v_idx := v_idx + 1;
    v_type := lower(COALESCE(NULLIF(btrim(blk->>'type'), ''), ''));

    -- Only validate overlap for collidable blocks (lines/rects are borders).
    IF v_type NOT IN ('text','barcode','image') THEN
      CONTINUE;
    END IF;

    bx := COALESCE(public.__label_try_numeric(blk->>'x'), 0);
    b_y := COALESCE(public.__label_try_numeric(blk->>'y'), 0);
    bw := COALESCE(public.__label_try_numeric(blk->>'width'), public.__label_try_numeric(blk->>'max_width'), 0);
    bh := COALESCE(public.__label_try_numeric(blk->>'height'), public.__label_try_numeric(blk->>'max_height'), 0);

    IF bw IS NULL OR bw <= 0 THEN
      v_errors := v_errors || jsonb_build_object('code','block_width_missing','message','block width/max_width must be > 0','block_index',v_idx,'block',blk);
      CONTINUE;
    END IF;

    IF (bh IS NULL OR bh <= 0) AND v_type = 'text' THEN
      bh := COALESCE(public.__label_try_numeric(blk->>'font_size'), 12) + 4;
    END IF;
    IF bh IS NULL OR bh <= 0 THEN
      v_errors := v_errors || jsonb_build_object('code','block_height_missing','message','block height/max_height must be > 0','block_index',v_idx,'block',blk);
      CONTINUE;
    END IF;

    v_align := lower(COALESCE(NULLIF(btrim(blk->>'align'), ''), 'left'));
    draw_x := bx;
    IF v_align = 'center' THEN
      draw_x := bx - (bw / 2);
    ELSIF v_align = 'right' THEN
      draw_x := bx - bw;
    END IF;
    draw_y := b_y;

    IF v_has_page AND v_page_w_pts IS NOT NULL AND v_page_h_pts IS NOT NULL THEN
      IF draw_x < v_margin_pts OR draw_y < v_margin_pts THEN
        v_errors := v_errors || jsonb_build_object('code','block_out_of_bounds_top_left','message','block starts before margin','block_index',v_idx,'block',blk);
      END IF;
      IF (draw_x + bw) > (v_page_w_pts - v_margin_pts) OR (draw_y + bh) > (v_page_h_pts - v_margin_pts) THEN
        v_errors := v_errors || jsonb_build_object('code','block_out_of_bounds_bottom_right','message','block exceeds page bounds','block_index',v_idx,'block',blk);
      END IF;
    END IF;

    -- Overlap check: compare against prior collidable blocks.
    FOR existing IN SELECT * FROM jsonb_array_elements(v_boxes)
    LOOP
      ex := (existing->>'x')::numeric;
      ey := (existing->>'y')::numeric;
      ew := (existing->>'width')::numeric;
      eh := (existing->>'height')::numeric;

      IF NOT (
        (draw_x + bw) <= ex OR (ex + ew) <= draw_x OR (draw_y + bh) <= ey OR (ey + eh) <= draw_y
      ) THEN
        IF NOT public.__label_render_if_mutually_exclusive(blk, existing) THEN
          v_errors := v_errors || jsonb_build_object(
            'code','blocks_overlap',
            'message','collidable blocks overlap',
            'block_index',v_idx,
            'other_block_index',(existing->>'block_index')::int,
            'block',blk,
            'other_block',existing->'block'
          );
        END IF;
      END IF;
    END LOOP;

    v_boxes := v_boxes || jsonb_build_array(jsonb_build_object(
      'block_index', v_idx,
      'type', v_type,
      'x', draw_x,
      'y', draw_y,
      'width', bw,
      'height', bh,
      'block', blk
    ));
  END LOOP;

  RETURN v_errors;
END;
$$;

COMMENT ON FUNCTION public.validate_label_renderer_config(JSONB) IS
'Validates renderer_config.page/blocks (bounds + overlap for collidable blocks), without relying on section/token tables.';

-- -----------------------------------------------------------------------------
-- validate_label_template: uses renderer_config validation + optional sections/tokens
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_label_template(
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
    v_has_sections BOOLEAN := FALSE;
    v_has_sectioned_blocks BOOLEAN := FALSE;
    v_validation_status TEXT := 'passed';
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

    v_errors := COALESCE(public.validate_label_renderer_config(v_tpl.renderer_config), '[]'::jsonb);

    -- Detect presence of sectioned blocks.
    IF v_tpl.renderer_config ? 'blocks' THEN
      FOR blk IN SELECT * FROM jsonb_array_elements(v_tpl.renderer_config -> 'blocks')
      LOOP
        IF blk ? 'section_key' THEN
          v_has_sectioned_blocks := TRUE;
          EXIT;
        END IF;
      END LOOP;
    END IF;

    -- Load tokens (optional)
    SELECT COALESCE(jsonb_object_agg(token_key, value), '{}'::jsonb)
    INTO v_tokens
    FROM label_design_tokens
    WHERE template_id = p_template_id
      AND organization_id = p_organization_id;

    -- Detect presence of sections.
    SELECT EXISTS(
      SELECT 1
      FROM label_sections
      WHERE template_id = p_template_id
        AND organization_id = p_organization_id
      LIMIT 1
    )
    INTO v_has_sections;

    IF v_tpl.renderer_config -> 'blocks' IS NOT NULL THEN
        FOR blk IN SELECT * FROM jsonb_array_elements(v_tpl.renderer_config -> 'blocks')
        LOOP
            bx := public.__label_try_numeric(blk ->> 'x');
            b_y := public.__label_try_numeric(blk ->> 'y');
            bw := public.__label_try_numeric(blk ->> 'width');
            bh := public.__label_try_numeric(blk ->> 'height');

            -- Token-aware font size floor (design-time minimums)
            IF blk ? 'font_size' AND v_tokens ? 'min_font_size' THEN
                IF (blk ->> 'font_size')::NUMERIC < (v_tokens ->> 'min_font_size')::NUMERIC THEN
                    v_errors := v_errors || jsonb_build_object(
                        'code', 'font_size_below_min',
                        'message', 'font size below min_font_size token',
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

            -- Optional section containment: only enforce when sections exist for this template.
            IF v_has_sections AND blk ? 'section_key' THEN
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
                    IF bx IS NULL OR b_y IS NULL OR bw IS NULL OR bh IS NULL THEN
                      v_errors := v_errors || jsonb_build_object(
                        'code', 'block_dim_missing_for_section',
                        'message', 'block requires x/y/width/height for section containment',
                        'block', blk,
                        'section_key', s.section_key
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
            END IF;
        END LOOP;
    END IF;

    -- If template is sectioned but sections haven't been inserted yet, mark pending rather than failed.
    IF v_errors = '[]'::jsonb THEN
      IF v_has_sectioned_blocks AND NOT v_has_sections THEN
        v_validation_status := 'pending';
        v_errors := v_errors || jsonb_build_object(
          'code','sections_pending',
          'message','Template has section_key blocks but no label_sections rows yet; insert sections then revalidate.'
        );
      ELSE
        v_validation_status := 'passed';
      END IF;
    ELSE
      v_validation_status := 'failed';
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
        v_validation_status,
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

COMMENT ON FUNCTION public.validate_label_template(UUID, UUID, UUID) IS
'Validates renderer_config plus (when present) section containment and token minimums; sets validation_status pending/passed/failed.';

-- -----------------------------------------------------------------------------
-- Revalidation hooks: section/token inserts should refresh template validation
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trg_label_sections_revalidate_template()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.validate_label_template(NEW.template_id, NEW.organization_id, NULL);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_label_sections_revalidate_template ON public.label_sections;
CREATE TRIGGER trg_label_sections_revalidate_template
  AFTER INSERT ON public.label_sections
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_label_sections_revalidate_template();

CREATE OR REPLACE FUNCTION public.trg_label_design_tokens_revalidate_template()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.validate_label_template(NEW.template_id, NEW.organization_id, NULL);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_label_design_tokens_revalidate_template ON public.label_design_tokens;
CREATE TRIGGER trg_label_design_tokens_revalidate_template
  AFTER INSERT ON public.label_design_tokens
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_label_design_tokens_revalidate_template();

-- -----------------------------------------------------------------------------
-- Publish gate helpers + resolve_label_template enforcement
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_label_template_published(
  p_template_id UUID,
  p_organization_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_status TEXT;
  v_errors JSONB;
BEGIN
  SELECT validation_status, validation_errors
  INTO v_status, v_errors
  FROM label_template_validation
  WHERE template_id = p_template_id
    AND organization_id = p_organization_id;

  IF NOT FOUND THEN
    PERFORM public.validate_label_template(p_template_id, p_organization_id, NULL);
    SELECT validation_status, validation_errors
    INTO v_status, v_errors
    FROM label_template_validation
    WHERE template_id = p_template_id
      AND organization_id = p_organization_id;
  END IF;

  IF v_status IS DISTINCT FROM 'passed' THEN
    RAISE EXCEPTION 'Template % (org %) is not publishable: status=% errors=%', p_template_id, p_organization_id, COALESCE(v_status,'(missing)'), COALESCE(v_errors,'[]'::jsonb)
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.assert_label_template_published(UUID, UUID) IS
'Raises when label_template_validation is not passed for the given template/org (publish gate for label rendering).';

CREATE OR REPLACE FUNCTION public.resolve_label_template(
    p_organization_id UUID,
    p_client_id UUID,
    p_sender_id UUID,
    p_label_type TEXT
)
RETURNS TABLE (
    template_id UUID,
    template_version INTEGER,
    template_snapshot JSONB,
    resolved_scope TEXT,
    max_attempts INTEGER,
    retry_backoff JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
    v_config JSONB;
    v_template JSONB;
    v_scope TEXT;
    v_template_key TEXT;
    v_template_version INTEGER;
    v_template_id UUID;
    v_renderer_config JSONB;
    v_max_attempts INTEGER;
    v_retry_backoff JSONB;
    v_assets JSONB;
    v_label_type TEXT := lower(p_label_type);
    v_page JSONB;
    v_barcode JSONB;
    v_blocks JSONB;
    v_template_record label_template_specs%ROWTYPE;
    v_candidate_config JSONB;
    v_inline_errors JSONB;
BEGIN
    IF p_label_type IS NULL OR trim(p_label_type) = '' THEN
        RAISE EXCEPTION 'label_type must be provided.';
    END IF;

    v_candidate_config := NULL;
    IF p_sender_id IS NOT NULL THEN
        SELECT cached_value
        INTO v_candidate_config
        FROM settings
        WHERE category = 'label_design'
          AND scope_type = 'sender'
          AND scope_id = p_sender_id
        ORDER BY last_updated DESC
        LIMIT 1;
        IF FOUND THEN
            v_config := v_candidate_config;
            v_scope := 'sender';
        END IF;
    END IF;

    IF v_config IS NULL AND p_client_id IS NOT NULL THEN
        SELECT cached_value
        INTO v_candidate_config
        FROM settings
        WHERE category = 'label_design'
          AND scope_type = 'client'
          AND scope_id = p_client_id
        ORDER BY last_updated DESC
        LIMIT 1;
        IF FOUND THEN
            v_config := v_candidate_config;
            v_scope := 'client';
        END IF;
    END IF;

    IF v_config IS NULL AND p_organization_id IS NOT NULL THEN
        SELECT cached_value
        INTO v_candidate_config
        FROM settings
        WHERE category = 'label_design'
          AND scope_type = 'tenant'
          AND scope_id = p_organization_id
        ORDER BY last_updated DESC
        LIMIT 1;
        IF FOUND THEN
            v_config := v_candidate_config;
            v_scope := 'tenant';
        END IF;
    END IF;

    IF v_config IS NULL THEN
        SELECT cached_value
        INTO v_candidate_config
        FROM settings
        WHERE category = 'label_design'
          AND scope_type = 'global'
          AND scope_id IS NULL
        ORDER BY last_updated DESC
        LIMIT 1;
        IF FOUND THEN
            v_config := v_candidate_config;
            v_scope := 'global';
        END IF;
    END IF;

    IF v_config IS NULL THEN
        RAISE EXCEPTION 'Label design configuration missing for organization %', p_organization_id;
    END IF;

    -- v2 schema prefers templates.<label_type>
    IF (v_config ? 'templates') THEN
        v_template := v_config -> 'templates' -> v_label_type;
        IF v_template IS NULL THEN
            v_template := v_config -> 'templates' -> 'default';
        END IF;
    END IF;

    -- Legacy fallback (v1 schema)
    IF v_template IS NULL THEN
        IF v_config ? 'templates' THEN
            v_template := v_config -> 'templates' -> p_label_type;
            IF v_template IS NULL THEN
                v_template := v_config -> 'templates' -> 'default';
            END IF;
        END IF;
    END IF;

    IF v_template IS NULL THEN
        RAISE EXCEPTION 'Template configuration missing for label_type=% within scope=%', p_label_type, v_scope;
    END IF;

    -- Detect inline renderer configuration (schema v2)
    IF (v_template ? 'page') AND (v_template ? 'blocks') THEN
        v_template_key := COALESCE(NULLIF(v_template ->> 'template_key', ''), v_label_type);
        v_page := COALESCE(v_template -> 'page', '{}'::jsonb);
        v_blocks := COALESCE(v_template -> 'blocks', '[]'::jsonb);
        v_assets := COALESCE(v_template -> 'assets', '[]'::jsonb);
        v_barcode := COALESCE(v_template -> 'barcode', '{}'::jsonb);

        IF (v_barcode = '{}'::jsonb) THEN
            SELECT jsonb_build_object(
                'type', COALESCE(block ->> 'barcode_type', 'CODE128'),
                'value_path', COALESCE(block ->> 'value_path', 'shipment.tracking_number')
            )
            INTO v_barcode
            FROM jsonb_array_elements(v_blocks) AS block
            WHERE block ->> 'type' = 'barcode'
            LIMIT 1;

            IF v_barcode IS NULL THEN
                v_barcode := jsonb_build_object(
                    'type', 'CODE128',
                    'value_path', 'shipment.tracking_number'
                );
            END IF;
        END IF;

        v_renderer_config := jsonb_strip_nulls(
            jsonb_build_object(
                'page', v_page,
                'blocks', v_blocks,
                'assets', v_assets,
                'barcode', v_barcode
            )
        );

        v_inline_errors := public.validate_label_renderer_config(v_renderer_config);
        IF v_inline_errors IS NOT NULL AND v_inline_errors <> '[]'::jsonb THEN
          RAISE EXCEPTION 'Inline renderer_config invalid: %', v_inline_errors
            USING ERRCODE = 'P0001';
        END IF;

        v_template_version := 1;
        IF (v_template ->> 'version') IS NOT NULL THEN
            BEGIN
                v_template_version := NULLIF(regexp_replace(v_template ->> 'version', '[^0-9]', '', 'g'), '')::INTEGER;
            EXCEPTION WHEN OTHERS THEN
                v_template_version := 1;
            END;
        END IF;

        v_template_id := uuid_from_hash(format(
            '%s:%s:%s:%s',
            COALESCE(p_organization_id::text, 'global'),
            v_scope,
            v_template_key,
            COALESCE(v_template ->> 'version', '1')
        ));

        v_max_attempts := COALESCE(NULLIF(v_template ->> 'max_attempts', '')::INTEGER, 5);
        v_retry_backoff := COALESCE(v_template -> 'retry_backoff_seconds', '[]'::jsonb);

        RETURN QUERY
        SELECT
            v_template_id,
            v_template_version,
            jsonb_build_object(
                'template_id', v_template_id,
                'template_key', v_template_key,
                'template_version', v_template_version,
                'renderer_config', v_renderer_config,
                'asset_refs', v_assets,
                'resolved_scope', v_scope,
                'label_config', jsonb_strip_nulls(
                    jsonb_build_object(
                        'version', v_template ->> 'version',
                        'provider_hint', v_template ->> 'provider_hint',
                        'max_attempts', v_max_attempts,
                        'retry_backoff_seconds', v_retry_backoff,
                        'barcode_format', v_barcode ->> 'type'
                    )
                ),
                'schema_version', 2,
                'label_type', v_label_type
            ),
            v_scope,
            v_max_attempts,
            v_retry_backoff;

        RETURN;
    END IF;

    -- Legacy template resolution (schema v1) using label_template_specs
    v_template_key := v_template ->> 'template_key';
    IF v_template_key IS NULL OR trim(v_template_key) = '' THEN
        RAISE EXCEPTION 'Template configuration for label_type=% is missing template_key', p_label_type;
    END IF;

    v_template_version := NULLIF(v_template ->> 'template_version', '')::INTEGER;

    IF v_template_version IS NOT NULL THEN
        SELECT *
        INTO v_template_record
        FROM label_template_specs
        WHERE organization_id = p_organization_id
          AND template_key = v_template_key
          AND version = v_template_version
        ORDER BY version DESC
        LIMIT 1;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Template % (version %s) not found for organization %',
              v_template_key,
              COALESCE(v_template_version::TEXT, 'latest'),
              p_organization_id;
        END IF;

        PERFORM public.assert_label_template_published(v_template_record.id, v_template_record.organization_id);
    ELSE
        -- Prefer latest passed version; fallback to latest version with a publish gate error.
        SELECT t.*
        INTO v_template_record
        FROM label_template_specs t
        JOIN label_template_validation v
          ON v.template_id = t.id
         AND v.organization_id = t.organization_id
         AND v.validation_status = 'passed'
        WHERE t.organization_id = p_organization_id
          AND t.template_key = v_template_key
        ORDER BY t.version DESC
        LIMIT 1;

        IF NOT FOUND THEN
          SELECT *
          INTO v_template_record
          FROM label_template_specs
          WHERE organization_id = p_organization_id
            AND template_key = v_template_key
          ORDER BY version DESC
          LIMIT 1;

          IF NOT FOUND THEN
            RAISE EXCEPTION 'Template % (version %s) not found for organization %',
              v_template_key,
              'latest',
              p_organization_id;
          END IF;

          PERFORM public.assert_label_template_published(v_template_record.id, v_template_record.organization_id);
        END IF;
    END IF;

    RETURN QUERY
    SELECT
        v_template_record.id,
        v_template_record.version,
        jsonb_build_object(
            'template_key', v_template_key,
            'template_version', v_template_record.version,
            'renderer_config', v_template_record.renderer_config,
            'asset_refs', v_template_record.asset_refs,
            'resolved_scope', v_scope,
            'label_config', v_template
        ),
        v_scope,
        COALESCE(NULLIF(v_template ->> 'max_attempts', '')::INTEGER, 5),
        COALESCE(v_template -> 'retry_backoff_seconds', '[]'::jsonb);
END;
$function$;

COMMENT ON FUNCTION public.resolve_label_template(UUID, UUID, UUID, TEXT)
    IS 'Resolve template metadata for a label request, enforcing publish gate for catalog templates (validation_status=passed).';

-- -----------------------------------------------------------------------------
-- Backfill: validate existing templates so publish gate is deterministic.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT id, organization_id
    FROM label_template_specs
  LOOP
    PERFORM public.validate_label_template(r.id, r.organization_id, NULL);
  END LOOP;
END;
$$;

COMMIT;
