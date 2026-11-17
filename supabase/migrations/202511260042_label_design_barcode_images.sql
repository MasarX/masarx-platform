-- Migration: Update label_design to use barcode image blocks in place (global + tenant latest rows)

BEGIN;

CREATE OR REPLACE FUNCTION public.replace_barcode_blocks_with_images(p_value jsonb)
RETURNS jsonb
LANGUAGE sql
AS $$
    SELECT COALESCE(jsonb_set(
        p_value,
        '{renderer_config,blocks}',
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
            FROM jsonb_array_elements(COALESCE(p_value->'renderer_config'->'blocks', '[]'::jsonb)) AS elem
        )
    ), '{}'::jsonb);
$$;

-- Update latest global label_design in place
WITH latest_global AS (
    SELECT id, value, version FROM settings_versions
    WHERE category = 'label_design' AND scope_type = 'global' AND scope_id IS NULL
    ORDER BY approved_at DESC NULLS LAST, created_at DESC
    LIMIT 1
)
UPDATE settings_versions sv
SET value = replace_barcode_blocks_with_images(COALESCE(lg.value, '{}'::jsonb)),
    version = lg.version + 1,
    change_reason = 'barcode blocks -> image assets',
    approved_at = now()
FROM latest_global lg
WHERE sv.id = lg.id;

-- Update latest tenant label_design in place
WITH tenants AS (
    SELECT DISTINCT scope_id FROM settings_versions WHERE category = 'label_design' AND scope_type = 'tenant'
), latest_tenant AS (
    SELECT t.scope_id, sv.id, sv.value, sv.version
    FROM tenants t
    CROSS JOIN LATERAL (
        SELECT id, value, version
        FROM settings_versions
        WHERE category = 'label_design' AND scope_type = 'tenant' AND scope_id = t.scope_id
        ORDER BY approved_at DESC NULLS LAST, created_at DESC
        LIMIT 1
    ) sv
)
UPDATE settings_versions sv
SET value = replace_barcode_blocks_with_images(COALESCE(lt.value, '{}'::jsonb)),
    version = lt.version + 1,
    change_reason = 'barcode blocks -> image assets',
    approved_at = now()
FROM latest_tenant lt
WHERE sv.id = lt.id;

DROP FUNCTION public.replace_barcode_blocks_with_images(jsonb);

COMMIT;
