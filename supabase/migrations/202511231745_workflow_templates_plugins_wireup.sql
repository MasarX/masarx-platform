-- Migration: wire workflow templates to context/reserve plugins

BEGIN;

SET search_path TO public, pg_temp;

DO $$
DECLARE
    tpl RECORD;
BEGIN
    FOR tpl IN
        SELECT id, name
        FROM workflow_templates
        WHERE name IN ('async_provider_dispatch_v1', 'shipment_swap_v1', 'shipment_return_v1')
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM workflow_template_steps
            WHERE workflow_template_id = tpl.id
              AND handler_key = 'reserve_shipment_identifiers'
        ) THEN
            UPDATE workflow_template_steps
               SET sequence_order = sequence_order + 2,
                   updated_at = now()
             WHERE workflow_template_id = tpl.id;

            INSERT INTO workflow_template_steps (
                id,
                workflow_template_id,
                sequence_order,
                operation_name,
                operation_settings_category,
                transition_condition,
                condition_jsonlogic,
                next_operation_name,
                next_operation_priority,
                next_operation_delay_seconds,
                manual_action_required,
                metadata,
                enabled,
                created_at,
                updated_at,
                handler_key,
                handler_version
            )
            VALUES (
                gen_random_uuid(),
                tpl.id,
                0,
                'context_extract_from_mapping',
                'workflow',
                'always',
                NULL,
                NULL,
                NULL,
                NULL,
                FALSE,
                '{}'::jsonb,
                TRUE,
                now(),
                now(),
                'context_extract_from_mapping',
                'v1'
            ),
            (
                gen_random_uuid(),
                tpl.id,
                1,
                'reserve_identifiers',
                'workflow',
                'always',
                NULL,
                NULL,
                NULL,
                NULL,
                FALSE,
                jsonb_build_object('resource_type', 'shipment'),
                TRUE,
                now(),
                now(),
                'reserve_shipment_identifiers',
                'v1'
            );
        END IF;
    END LOOP;
END;
$$;

DO $$
DECLARE
    tpl RECORD;
BEGIN
    FOR tpl IN
        SELECT id, name
        FROM workflow_templates
        WHERE name IN ('shipment_delete_v1', 'shipment_modify_v1')
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM workflow_template_steps
            WHERE workflow_template_id = tpl.id
              AND handler_key = 'context_extract_from_mapping'
        ) THEN
            UPDATE workflow_template_steps
               SET sequence_order = sequence_order + 1,
                   updated_at = now()
             WHERE workflow_template_id = tpl.id;

            INSERT INTO workflow_template_steps (
                id,
                workflow_template_id,
                sequence_order,
                operation_name,
                operation_settings_category,
                transition_condition,
                condition_jsonlogic,
                next_operation_name,
                next_operation_priority,
                next_operation_delay_seconds,
                manual_action_required,
                metadata,
                enabled,
                created_at,
                updated_at,
                handler_key,
                handler_version
            )
            VALUES (
                gen_random_uuid(),
                tpl.id,
                0,
                'context_extract_from_mapping',
                'workflow',
                'always',
                NULL,
                NULL,
                NULL,
                NULL,
                FALSE,
                '{}'::jsonb,
                TRUE,
                now(),
                now(),
                'context_extract_from_mapping',
                'v1'
            );
        END IF;
    END LOOP;
END;
$$;

-- Recalculate steps checksums for affected templates.
WITH recalculated AS (
    SELECT
        wts.workflow_template_id,
        md5(
            string_agg(
                concat_ws(
                    '|',
                    wts.sequence_order,
                    COALESCE(wts.operation_name, ''),
                    COALESCE(wts.operation_settings_category, ''),
                    COALESCE(wts.transition_condition, ''),
                    COALESCE(wts.handler_key, ''),
                    COALESCE(wts.handler_version, ''),
                    COALESCE(wts.metadata::TEXT, '')
                ),
                '||' ORDER BY wts.sequence_order
            )
        ) AS checksum
    FROM workflow_template_steps wts
    WHERE wts.workflow_template_id IN (
        SELECT id FROM workflow_templates WHERE name IN (
            'async_provider_dispatch_v1',
            'shipment_swap_v1',
            'shipment_return_v1',
            'shipment_delete_v1',
            'shipment_modify_v1'
        )
    )
    GROUP BY wts.workflow_template_id
)
UPDATE workflow_templates wt
SET steps_checksum = recalculated.checksum,
    updated_at = now()
FROM recalculated
WHERE wt.id = recalculated.workflow_template_id;

COMMIT;
