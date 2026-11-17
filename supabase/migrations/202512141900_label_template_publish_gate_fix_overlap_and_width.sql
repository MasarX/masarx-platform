-- Migration: Fix validate_label_renderer_config overlap logic (mutual exclusivity + barcode reserve_bottom) and relax width requirements for text blocks.

BEGIN;

SET search_path TO public, pg_temp;

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
  v_reserve_bottom NUMERIC := 0;
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

    -- Width is optional for text in the legacy inline schema (still renderable); skip overlap validation when unknown.
    IF bw IS NULL OR bw <= 0 THEN
      IF v_type IN ('barcode','image') THEN
        v_errors := v_errors || jsonb_build_object('code','block_width_missing','message','block width/max_width must be > 0','block_index',v_idx,'block',blk);
      END IF;
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

    -- Barcodes reserve a bottom band for human-readable text; validate overlap against the bars region only.
    IF v_type = 'barcode' THEN
      v_reserve_bottom := COALESCE(public.__label_try_numeric(blk->>'reserve_bottom'), 0);
      IF v_reserve_bottom > 0 AND bh - v_reserve_bottom > 0 THEN
        draw_y := draw_y + v_reserve_bottom;
        bh := bh - v_reserve_bottom;
      END IF;
    END IF;

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
        IF NOT public.__label_render_if_mutually_exclusive(blk, existing->'block') THEN
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

-- Revalidate existing templates after overlap logic changes.
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

