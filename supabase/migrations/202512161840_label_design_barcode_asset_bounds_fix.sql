-- Migration: Clamp barcode_asset_path image blocks within page bounds
-- Purpose:
--   - Some seeded label_design templates include an image block (asset_ref=barcode_asset_path)
--     whose width exceeds the page's right margin when measured in points (width_inch*72).
--   - resolve_label_template validates inline renderer_config via validate_label_renderer_config()
--     and raises when blocks exceed bounds, breaking label rendering and pgTAP.
--   - Fix is dynamic: clamp offending image widths based on page size + margin across all
--     current label_design settings rows (any scope).
-- Date: 2025-12-16

BEGIN;

CREATE OR REPLACE FUNCTION public.__clamp_label_design_template_blocks(p_template JSONB)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_page JSONB;
  v_blocks JSONB;
  v_page_w_pts NUMERIC;
  v_page_h_pts NUMERIC;
  v_margin_pts NUMERIC := 0;
  v_new_blocks JSONB := '[]'::jsonb;
  blk JSONB;
  v_type TEXT;
  v_asset_ref TEXT;
  bx NUMERIC;
  bw NUMERIC;
  v_align TEXT;
  draw_x NUMERIC;
  max_w NUMERIC;
BEGIN
  IF p_template IS NULL OR jsonb_typeof(p_template) <> 'object' THEN
    RETURN p_template;
  END IF;

  v_page := p_template->'page';
  v_blocks := p_template->'blocks';
  IF v_page IS NULL OR jsonb_typeof(v_page) <> 'object' THEN
    RETURN p_template;
  END IF;
  IF v_blocks IS NULL OR jsonb_typeof(v_blocks) <> 'array' THEN
    RETURN p_template;
  END IF;

  v_page_w_pts := public.__label_try_numeric(v_page->>'width_pt');
  v_page_h_pts := public.__label_try_numeric(v_page->>'height_pt');
  IF v_page_w_pts IS NULL OR v_page_h_pts IS NULL THEN
    IF public.__label_try_numeric(v_page->>'width_inch') IS NOT NULL
       AND public.__label_try_numeric(v_page->>'height_inch') IS NOT NULL THEN
      v_page_w_pts := public.__label_try_numeric(v_page->>'width_inch') * 72;
      v_page_h_pts := public.__label_try_numeric(v_page->>'height_inch') * 72;
    ELSIF public.__label_try_numeric(v_page->>'width_mm') IS NOT NULL
       AND public.__label_try_numeric(v_page->>'height_mm') IS NOT NULL THEN
      v_page_w_pts := (public.__label_try_numeric(v_page->>'width_mm') / 25.4) * 72;
      v_page_h_pts := (public.__label_try_numeric(v_page->>'height_mm') / 25.4) * 72;
    END IF;
  END IF;

  IF public.__label_try_numeric(v_page->>'margin_inch') IS NOT NULL THEN
    v_margin_pts := public.__label_try_numeric(v_page->>'margin_inch') * 72;
  ELSIF public.__label_try_numeric(v_page->>'margin_mm') IS NOT NULL THEN
    v_margin_pts := (public.__label_try_numeric(v_page->>'margin_mm') / 25.4) * 72;
  ELSE
    v_margin_pts := 0;
  END IF;

  IF v_page_w_pts IS NULL OR v_page_w_pts <= 0 THEN
    RETURN p_template;
  END IF;

  FOR blk IN SELECT * FROM jsonb_array_elements(v_blocks)
  LOOP
    v_type := lower(COALESCE(NULLIF(btrim(blk->>'type'), ''), ''));
    v_asset_ref := COALESCE(NULLIF(btrim(blk->>'asset_ref'), ''), '');

    IF v_type = 'image' AND v_asset_ref = 'barcode_asset_path' THEN
      bx := COALESCE(public.__label_try_numeric(blk->>'x'), 0);
      bw := COALESCE(public.__label_try_numeric(blk->>'width'), 0);
      v_align := lower(COALESCE(NULLIF(btrim(blk->>'align'), ''), 'left'));

      draw_x := bx;
      IF v_align = 'center' THEN
        draw_x := bx - (bw / 2);
        max_w := 2 * LEAST((bx - v_margin_pts), ((v_page_w_pts - v_margin_pts) - bx));
      ELSIF v_align = 'right' THEN
        draw_x := bx - bw;
        max_w := bx - v_margin_pts;
      ELSE
        max_w := (v_page_w_pts - v_margin_pts) - draw_x;
      END IF;

      IF max_w IS NOT NULL AND max_w > 0 AND bw > 0 AND (draw_x + bw) > (v_page_w_pts - v_margin_pts) THEN
        blk := jsonb_set(blk, '{width}', to_jsonb(max_w), FALSE);
      END IF;
    END IF;

    v_new_blocks := v_new_blocks || jsonb_build_array(blk);
  END LOOP;

  RETURN jsonb_set(p_template, '{blocks}', v_new_blocks, FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION public.__clamp_label_design_config(p_config JSONB)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_templates JSONB;
  v_key TEXT;
  v_template JSONB;
  v_new_templates JSONB := '{}'::jsonb;
BEGIN
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    RETURN p_config;
  END IF;

  v_templates := p_config->'templates';
  IF v_templates IS NULL OR jsonb_typeof(v_templates) <> 'object' THEN
    RETURN p_config;
  END IF;

  FOR v_key, v_template IN SELECT key, value FROM jsonb_each(v_templates)
  LOOP
    v_new_templates := v_new_templates || jsonb_build_object(v_key, public.__clamp_label_design_template_blocks(v_template));
  END LOOP;

  RETURN jsonb_set(p_config, '{templates}', v_new_templates, FALSE);
END;
$$;

WITH patched AS (
  SELECT
    s.id,
    s.settings_version_id,
    public.__clamp_label_design_config(s.cached_value) AS new_value
  FROM settings s
  WHERE s.category = 'label_design'
)
UPDATE settings s
SET cached_value = p.new_value,
    last_updated = now()
FROM patched p
WHERE s.id = p.id
  AND s.cached_value IS DISTINCT FROM p.new_value;

WITH patched AS (
  SELECT
    s.settings_version_id AS id,
    public.__clamp_label_design_config(s.cached_value) AS new_value
  FROM settings s
  WHERE s.category = 'label_design'
    AND s.settings_version_id IS NOT NULL
)
UPDATE settings_versions sv
SET value = p.new_value,
    version = sv.version + 1,
    change_reason = 'Clamp barcode_asset_path image bounds to page width/margin',
    approved_at = now()
FROM patched p
WHERE sv.id = p.id
  AND sv.value IS DISTINCT FROM p.new_value;

DROP FUNCTION public.__clamp_label_design_config(JSONB);
DROP FUNCTION public.__clamp_label_design_template_blocks(JSONB);

COMMIT;

