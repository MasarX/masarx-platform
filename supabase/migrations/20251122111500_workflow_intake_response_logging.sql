-- Migration: Align webhook intake configuration with dynamic workflow templates
-- Date: 2025-11-22 11:15 UTC

BEGIN;

DO $$
DECLARE
    v_intake_template_id UUID;
    v_followup_async UUID;
BEGIN
    SELECT id
    INTO v_intake_template_id
    FROM workflow_templates
    WHERE name = 'webhook_intake_v1'
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1;

    IF v_intake_template_id IS NULL THEN
        RAISE EXCEPTION 'webhook_intake_v1 workflow template not found. Configure template before running migration 20251122111500.';
    END IF;

    SELECT id
    INTO v_followup_async
    FROM workflow_templates
    WHERE name = 'async_provider_dispatch_v1'
    LIMIT 1;

    IF v_followup_async IS NULL THEN
        RAISE EXCEPTION 'async_provider_dispatch_v1 workflow template not found. Configure template before running migration 20251122111500.';
    END IF;

    UPDATE settings_versions
    SET value = jsonb_set(
            COALESCE(value, '{}'::jsonb),
            '{entry_template_id}',
            to_jsonb(v_intake_template_id::TEXT),
            true
        ),
        change_reason = 'Set default webhook intake entry template (20251122111500)',
        approved_at = workflow_now(),
        effective_from = workflow_now()
    WHERE category = 'webhook_intake'
      AND scope_type = 'global'
      AND (value->>'entry_template_id' IS NULL OR value->>'entry_template_id' = '');

    UPDATE settings
    SET cached_value = jsonb_set(
            COALESCE(cached_value, '{}'::jsonb),
            '{entry_template_id}',
            to_jsonb(v_intake_template_id::TEXT),
            true
        ),
        last_updated = workflow_now()
    WHERE category = 'webhook_intake'
      AND scope_type = 'global'
      AND (cached_value->>'entry_template_id' IS NULL OR cached_value->>'entry_template_id' = '');

    UPDATE settings_versions
    SET value = CASE
            WHEN COALESCE(value->'ack'->>'mode', value->'response'->>'mode', '') = 'accepted_async' THEN
                jsonb_set(
                    jsonb_set(
                        jsonb_set(
                            COALESCE(value, '{}'::jsonb),
                            '{workflow,template_id}',
                            to_jsonb(v_intake_template_id::TEXT),
                            TRUE
                        ),
                        '{workflow,launch_mode}',
                        to_jsonb('in_background'::TEXT),
                        TRUE
                    ),
                    '{workflow,context_patch}',
                    jsonb_strip_nulls(
                        COALESCE(value#>'{workflow,context_patch}', '{}'::jsonb)
                        || jsonb_build_object('followup_template_id', v_followup_async::TEXT)
                    ),
                    TRUE
                )
            ELSE
                jsonb_strip_nulls(
                    COALESCE(value, '{}'::jsonb) || jsonb_build_object('workflow', NULL)
                )
        END,
        change_reason = 'Normalize webhook ingest workflow template mapping (20251122111500)',
        approved_at = workflow_now(),
        effective_from = workflow_now()
    WHERE category = 'webhook_ingest_policy';

    UPDATE settings
    SET cached_value = CASE
            WHEN COALESCE(cached_value->'ack'->>'mode', cached_value->'response'->>'mode', '') = 'accepted_async' THEN
                jsonb_set(
                    jsonb_set(
                        jsonb_set(
                            COALESCE(cached_value, '{}'::jsonb),
                            '{workflow,template_id}',
                            to_jsonb(v_intake_template_id::TEXT),
                            TRUE
                        ),
                        '{workflow,launch_mode}',
                        to_jsonb('in_background'::TEXT),
                        TRUE
                    ),
                    '{workflow,context_patch}',
                    jsonb_strip_nulls(
                        COALESCE(cached_value#>'{workflow,context_patch}', '{}'::jsonb)
                        || jsonb_build_object('followup_template_id', v_followup_async::TEXT)
                    ),
                    TRUE
                )
            ELSE
                jsonb_strip_nulls(
                    COALESCE(cached_value, '{}'::jsonb) || jsonb_build_object('workflow', NULL)
                )
        END,
        last_updated = workflow_now()
    WHERE category = 'webhook_ingest_policy';
END;
$$;

COMMIT;
