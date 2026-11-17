-- Migration: Label template asset cleanup (remove static storage keys)
-- Purpose: Replace seeded standard_4x6 templates with version 2 entries that
--          do not rely on hardcoded asset_refs. Runtime now expects org-level
--          configuration or payload-provided assets.
-- Alignment: ZERO HARD CODING (no static storage paths), DYNAMIC (templates
--             can bind assets per organization without code changes).

BEGIN;

WITH base_templates AS (
    SELECT
        organization_id,
        template_key,
        template_scope_type,
        template_scope_id,
        renderer_config,
        created_by
    FROM label_template_specs
    WHERE template_key = 'standard_4x6'
      AND version = 1
),
inserted AS (
    INSERT INTO label_template_specs (
        id,
        organization_id,
        template_key,
        version,
        template_scope_type,
        template_scope_id,
        renderer_config,
        asset_refs,
        created_by
    )
    SELECT
        gen_random_uuid(),
        b.organization_id,
        b.template_key,
        2,
        b.template_scope_type,
        b.template_scope_id,
        b.renderer_config,
        '[]'::jsonb,
        b.created_by
    FROM base_templates b
    WHERE NOT EXISTS (
        SELECT 1
        FROM label_template_specs existing
        WHERE existing.organization_id = b.organization_id
          AND existing.template_key = b.template_key
          AND existing.version = 2
    )
    RETURNING organization_id
)
SELECT COUNT(*) AS created_template_versions
FROM inserted;

COMMIT;
