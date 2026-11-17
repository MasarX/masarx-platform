-- Migration: Update label_design (settings & cached_value) to use barcode image blocks (global + tenant latest)

BEGIN;

CREATE OR REPLACE FUNCTION public.replace_barcode_blocks_with_images(p_value jsonb)
RETURNS jsonb
LANGUAGE sql
AS $$
    SELECT COALESCE(jsonb_set(
        p_value,
        '{templates,shipping,blocks}',
        (
            SELECT jsonb_agg(
                CASE
                    WHEN elem->>'type' = 'barcode' THEN
                        jsonb_build_object(
                            'type', 'image',
                            'asset_ref', 'barcode_asset_path',
                            'x', COALESCE((elem->>'x')::numeric, 0),
                            'y', COALESCE((elem->>'y')::numeric, 0),
                            'width', COALESCE((elem->>'width')::numeric, 120),
                            'height', COALESCE((elem->>'height')::numeric, 30),
                            'align', elem->>'align'
                        )
                    ELSE elem
                END
            )
            FROM jsonb_array_elements(COALESCE(p_value#>'{templates,shipping,blocks}', '[]'::jsonb)) AS elem
        )
    ), p_value);
$$;

-- Update settings_versions (global)
WITH lg AS (
    SELECT id, value, version FROM settings_versions
    WHERE category='label_design' AND scope_type='global' AND scope_id IS NULL
    ORDER BY approved_at DESC NULLS LAST, created_at DESC
    LIMIT 1
)
UPDATE settings_versions sv
SET value = replace_barcode_blocks_with_images(lg.value),
    version = lg.version + 1,
    change_reason = 'barcode blocks -> image assets',
    approved_at = now()
FROM lg WHERE sv.id = lg.id;

-- Update settings (cached_value) (global)
WITH ls AS (
    SELECT id, cached_value FROM settings
    WHERE category='label_design' AND scope_type='global' AND scope_id IS NULL
    ORDER BY last_updated DESC
    LIMIT 1
)
UPDATE settings s
SET cached_value = replace_barcode_blocks_with_images(ls.cached_value),
    last_updated = now()
FROM ls WHERE s.id = ls.id;

-- Update settings_versions (tenant latest)
WITH tenants AS (
    SELECT DISTINCT scope_id FROM settings_versions WHERE category='label_design' AND scope_type='tenant'
), lt AS (
    SELECT t.scope_id, sv.id, sv.value, sv.version
    FROM tenants t
    CROSS JOIN LATERAL (
        SELECT id, value, version
        FROM settings_versions
        WHERE category='label_design' AND scope_type='tenant' AND scope_id = t.scope_id
        ORDER BY approved_at DESC NULLS LAST, created_at DESC
        LIMIT 1
    ) sv
)
UPDATE settings_versions sv
SET value = replace_barcode_blocks_with_images(lt.value),
    version = lt.version + 1,
    change_reason = 'barcode blocks -> image assets',
    approved_at = now()
FROM lt WHERE sv.id = lt.id;

-- Update settings (cached_value) for tenants
WITH tenants AS (
    SELECT DISTINCT scope_id FROM settings WHERE category='label_design' AND scope_type='tenant'
), lt AS (
    SELECT t.scope_id, s.id, s.cached_value
    FROM tenants t
    CROSS JOIN LATERAL (
        SELECT id, cached_value
        FROM settings
        WHERE category='label_design' AND scope_type='tenant' AND scope_id = t.scope_id
        ORDER BY last_updated DESC
        LIMIT 1
    ) s
)
UPDATE settings s
SET cached_value = replace_barcode_blocks_with_images(lt.cached_value),
    last_updated = now()
FROM lt WHERE s.id = lt.id;

DROP FUNCTION public.replace_barcode_blocks_with_images(jsonb);

COMMIT;
