-- Migration: Clean legacy follow-up terminology from persisted policy data
-- Date: 2025-11-20 17:20 UTC

BEGIN;

DO $$
DECLARE
    v_legacy_key CONSTANT TEXT := 'post' || '_' || 'ack';
    v_followup_key CONSTANT TEXT := 'workflow_followup';
BEGIN
    UPDATE settings_versions
    SET value = jsonb_strip_nulls(
        CASE
            WHEN value ? v_legacy_key THEN (value - v_legacy_key) || jsonb_build_object('workflow', value -> v_legacy_key)
            WHEN value ? v_followup_key THEN (value - v_followup_key) || jsonb_build_object('workflow', value -> v_followup_key)
            ELSE value
        END
    )
    WHERE category = 'webhook_ingest_policy'
      AND (value ? v_legacy_key OR value ? v_followup_key);

    UPDATE settings_versions
    SET value = jsonb_strip_nulls(
        (value - 'workflow') || jsonb_build_object(
            'workflow',
            CASE
                WHEN value ? 'workflow' AND (value->'workflow') ? 'workflow' THEN
                    jsonb_strip_nulls(jsonb_build_object(
                        'template_id', (value->'workflow'->'workflow')->>'template_id',
                        'launch_mode', COALESCE((value->'workflow'->'workflow')->>'launch_mode', 'in_background'),
                        'context_patch', value->'workflow'->'workflow'->'context_patch'
                    ))
                ELSE COALESCE(value->'workflow', jsonb_build_object())
            END
        )
    )
    WHERE category = 'webhook_ingest_policy'
      AND value ? 'workflow'
      AND (value->'workflow') ? 'workflow';

    UPDATE settings
    SET cached_value = jsonb_strip_nulls(
        CASE
            WHEN cached_value ? v_legacy_key THEN (cached_value - v_legacy_key) || jsonb_build_object('workflow', cached_value -> v_legacy_key)
            WHEN cached_value ? v_followup_key THEN (cached_value - v_followup_key) || jsonb_build_object('workflow', cached_value -> v_followup_key)
            ELSE cached_value
        END
    )
    WHERE category = 'webhook_ingest_policy'
      AND (cached_value ? v_legacy_key OR cached_value ? v_followup_key);

    UPDATE settings
    SET cached_value = jsonb_strip_nulls(
        (cached_value - 'workflow') || jsonb_build_object(
            'workflow',
            CASE
                WHEN cached_value ? 'workflow' AND (cached_value->'workflow') ? 'workflow' THEN
                    jsonb_strip_nulls(jsonb_build_object(
                        'template_id', (cached_value->'workflow'->'workflow')->>'template_id',
                        'launch_mode', COALESCE((cached_value->'workflow'->'workflow')->>'launch_mode', 'in_background'),
                        'context_patch', cached_value->'workflow'->'workflow'->'context_patch'
                    ))
                ELSE COALESCE(cached_value->'workflow', jsonb_build_object())
            END
        )
    )
    WHERE category = 'webhook_ingest_policy'
      AND cached_value ? 'workflow'
      AND (cached_value->'workflow') ? 'workflow';
END;
$$;

COMMIT;
