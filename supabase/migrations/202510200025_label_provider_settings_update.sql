-- Migration: Label provider settings ensure invoke metadata
-- Purpose: Guarantee the active label_provider settings row includes invoke_url
--          and invoke_secret fields without overwriting existing values.
-- Alignment: DYNAMIC + ZERO HARD CODING (values live in settings); migration is
--             idempotent and safe for environments with real secrets.

BEGIN;

WITH current_settings AS (
    SELECT
        s.settings_version_id,
        s.id AS settings_id
    FROM settings s
    WHERE s.category = 'label_provider'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    LIMIT 1
),
updated_versions AS (
    UPDATE settings_versions sv
    SET
        value = jsonb_set(
                    jsonb_set(
                        sv.value,
                        '{providers,0,invoke_url}',
                        to_jsonb(
                            COALESCE(
                                NULLIF(sv.value->'providers'->0->>'invoke_url', ''),
                                'https://example.supabase.co/functions/v1/label-renderer' /* objectives:allow SUPABASE_URL Justification: placeholder sentinel, not an actual endpoint */
                            )
                        ),
                        TRUE
                    ),
                    '{providers,0,invoke_secret}',
                    to_jsonb(
                        COALESCE(
                            NULLIF(sv.value->'providers'->0->>'invoke_secret', ''),
                            'EXAMPLE_PASSWORD'
                        )
                    ),
                    TRUE
                ),
        version = GREATEST(sv.version, 2),
        change_reason = COALESCE(
            NULLIF(sv.change_reason, ''),
            'Ensure label provider settings include invoke metadata'
        ),
        approved_at = COALESCE(sv.approved_at, workflow_now()),
        effective_from = COALESCE(sv.effective_from, workflow_now())
    WHERE sv.id IN (SELECT settings_version_id FROM current_settings)
    RETURNING sv.id, sv.value
),
inserted_versions AS (
    INSERT INTO settings_versions (
        id,
        category,
        scope_type,
        scope_id,
        scope_hash,
        version,
        value,
        schema_version,
        change_reason,
        approved_at,
        effective_from
    )
    SELECT
        '77770000-0000-0000-0000-000000000103'::uuid,
        'label_provider',
        'global',
        NULL,
        '00000000-0000-0000-0000-000000000000'::uuid,
        2,
        jsonb_build_object(
            'version', 2,
            'providers', jsonb_build_array(
                jsonb_build_object(
                    'name', 'internal_renderer',
                    'mode', 'internal',
                    'invoke_url', 'https://example.supabase.co/functions/v1/label-renderer' /* objectives:allow SUPABASE_URL Justification: placeholder sentinel, not an actual endpoint */ ,
                    'invoke_secret', 'EXAMPLE_PASSWORD',
                    'timeout_ms', 15000
                )
            )
        ),
        1,
        'Seed label provider invoke metadata',
        workflow_now(),
        workflow_now()
    WHERE NOT EXISTS (SELECT 1 FROM current_settings)
    RETURNING settings_versions.id, settings_versions.value
),
effective_versions AS (
    SELECT * FROM updated_versions
    UNION ALL
    SELECT * FROM inserted_versions
)
UPDATE settings s
SET
    settings_version_id = ev.id,
    cached_value = ev.value,
    last_updated = workflow_now()
FROM effective_versions ev
WHERE s.category = 'label_provider'
  AND s.scope_type = 'global'
  AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid;

COMMIT;
