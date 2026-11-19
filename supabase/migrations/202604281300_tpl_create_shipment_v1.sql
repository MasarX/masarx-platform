-- Migration: Register canonical workflow template `tpl_create_shipment`
-- Purpose: Back the operator-initiated Create-shipment composer in console-v2
--          (apps/console-v2/src/modules/operate/shipments.tsx:213) so its
--          `start_workflow_run({ template_id: 'tpl_create_shipment' })` call
--          resolves to a real workflow_template + steps lineage in production.
--
-- Why row-driven (objectives compliance):
--   - Zero hardcoding: all behavior is row-driven via existing canonical
--     handlers (`context_extract_from_mapping`, `context_set_defaults`,
--     `context_require`, `reserve_shipment_identifiers`, `shipment_create`,
--     `task_enqueue`, `enqueue_notification`). No new handler logic added.
--   - Zero redundancy: reuses the existing handler library (registered in
--     supabase/migrations/202510200007_workflow_handler_columns.sql +
--     202511231615_shipment_create_handler.sql +
--     202511231735_reserve_identifiers_handler.sql +
--     202511231740_context_extract_from_mapping_handler.sql +
--     202601242450_workflow_context_guards_return_swap_v1.sql +
--     202601212891_workflow_task_handlers.sql +
--     202510150223_seed_workflow_templates.sql `enqueue_notification`).
--   - Single source of truth: the workflow template + steps live in
--     public.workflow_templates / public.workflow_template_steps. The FE
--     composer kicks off via `start_workflow_run` which resolves the template
--     by name -> id, then progresses each step via the canonical engine.
--   - Override ladder: notification + first-mile assignment behavior remains
--     row-driven via comms_scheduling / route_assignment_policy (resolved
--     downstream by handlers, not hardcoded here).
--
-- Cross-walk: closes Phase 0 INGRESS-COMPLETE / Wave 5 / Wave 6 follow-up
-- "OPERATIONS — tpl_create_shipment workflow template not registered" gap
-- documented in apps/console-v2/__audit__/CROSSWALK/OPERATIONS.md.
--
-- Backwards compatibility: append-only migration; no historical migration is
-- altered. RLS on workflow_templates / workflow_template_steps is already
-- governed by the canonical write-path RLS migration
-- (202601191940_workflow_templates_write_rls.sql) — no policy change here.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604281300_tpl_create_shipment_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- 1) Upsert the canonical workflow_template row.
--    Trigger label `shipments.create` mirrors the operator surface in
--    apps/console-v2/src/modules/operate/shipments.tsx:209-213 and
--    apps/console-v2/src/lib/seed-raw/workflows.js:60.
--    Status `active` so the FE composer cannot 404 in production.
INSERT INTO public.workflow_templates AS wt (
    id,
    name,
    description,
    version,
    status,
    scope_type,
    scope_id,
    notes
)
VALUES (
    '99990000-0000-0000-0000-000000570008'::uuid,
    'tpl_create_shipment',
    'Operator-initiated shipment creation: validate -> create -> first-mile assign -> notify client.',
    1,
    'active',
    'global',
    NULL,
    'Backs console-v2 Create-shipment composer (shipments.tsx:213). Row-driven kickoff via start_workflow_run.'
)
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description,
    status = EXCLUDED.status,
    scope_type = EXCLUDED.scope_type,
    scope_id = EXCLUDED.scope_id,
    notes = EXCLUDED.notes,
    updated_at = now();

-- 2) Upsert the 6 canonical steps (idempotent via deterministic UUIDs).
--    Sequence:
--      0. context_extract_from_mapping  — pull payload into workflow context
--      1. context_set_defaults          — apply default service_type/status
--      2. context_require               — guard required fields (client_id, client_reference_number)
--      3. reserve_shipment_identifiers  — reserve planned id + tracking number
--      4. shipment_create               — INSERT public.shipments row
--      5. task_enqueue                  — first-mile dispatch task (route assignment)
--      6. enqueue_notification          — comms_scheduling notify the client
--
--    All handlers are pre-registered; we only attach data rows. Behavior
--    remains row-driven via metadata (no app-side branching).

WITH tpl AS (
    SELECT id FROM public.workflow_templates WHERE name = 'tpl_create_shipment'
)
INSERT INTO public.workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    handler_key,
    handler_version,
    metadata,
    manual_action_required,
    enabled,
    created_at,
    updated_at
)
SELECT
    step_id::uuid,
    (SELECT id FROM tpl),
    seq,
    op_name,
    op_cat,
    'always',
    handler_key,
    'v1',
    meta,
    FALSE,
    TRUE,
    now(),
    now()
FROM (VALUES
    (
        '99990000-0000-0000-0000-000000580000',
        0,
        'context_extract',
        'workflow',
        'context_extract_from_mapping',
        '{}'::jsonb
    ),
    (
        '99990000-0000-0000-0000-000000580001',
        1,
        'context_set_defaults',
        'workflow',
        'context_set_defaults',
        jsonb_build_object(
            'mode', 'set_if_missing',
            'defaults', jsonb_build_object(
                'service_type', 'delivery',
                'initial_status', 'pending'
            )
        )
    ),
    (
        '99990000-0000-0000-0000-000000580002',
        2,
        'context_require_validate',
        'workflow',
        'context_require',
        jsonb_build_object(
            'required', jsonb_build_array('client_id', 'client_reference_number'),
            'on_missing', 'fail_workflow'
        )
    ),
    (
        '99990000-0000-0000-0000-000000580003',
        3,
        'reserve_identifiers',
        'workflow',
        'reserve_shipment_identifiers',
        jsonb_build_object('resource_type', 'shipment')
    ),
    (
        '99990000-0000-0000-0000-000000580004',
        4,
        'create_shipment',
        'workflow',
        'shipment_create',
        '{}'::jsonb
    ),
    (
        '99990000-0000-0000-0000-000000580005',
        5,
        'first_mile_dispatch',
        'workflow',
        'task_enqueue',
        jsonb_strip_nulls(jsonb_build_object(
            'task_type_key', 'dispatch_first_mile',
            'queue_key', 'dispatch',
            'context_key', 'first_mile_task',
            'resource_type', 'shipment',
            'resource_id_path', '$.context.shipment.id',
            'task_metadata', jsonb_build_object('source_template', 'tpl_create_shipment')
        ))
    ),
    (
        '99990000-0000-0000-0000-000000580006',
        6,
        'send_shipment_created_notification',
        'shipment_created_notification_policy',
        'shipment_created_notification',
        jsonb_build_object(
            'context_key', 'shipment_created_notification',
            'notification_path', '$.context.workflow.context_patch.shipment_created_notification'
        )
    )
) AS s(step_id, seq, op_name, op_cat, handler_key, meta)
ON CONFLICT (id) DO UPDATE
SET sequence_order = EXCLUDED.sequence_order,
    operation_name = EXCLUDED.operation_name,
    operation_settings_category = EXCLUDED.operation_settings_category,
    transition_condition = EXCLUDED.transition_condition,
    handler_key = EXCLUDED.handler_key,
    handler_version = EXCLUDED.handler_version,
    metadata = EXCLUDED.metadata,
    manual_action_required = EXCLUDED.manual_action_required,
    enabled = EXCLUDED.enabled,
    updated_at = now();

-- 3) Recalculate steps_checksum + published_at for the template (mirrors the
--    existing seed pattern in 202510150223_seed_workflow_templates.sql:464+).
WITH checksum AS (
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
        ) AS digest
    FROM public.workflow_template_steps wts
    WHERE wts.workflow_template_id = (
        SELECT id FROM public.workflow_templates WHERE name = 'tpl_create_shipment'
    )
    GROUP BY wts.workflow_template_id
)
UPDATE public.workflow_templates wt
SET steps_checksum = checksum.digest,
    published_at = COALESCE(wt.published_at, now()),
    updated_at = now()
FROM checksum
WHERE wt.id = checksum.workflow_template_id;

SELECT pg_advisory_unlock(hashtext('202604281300_tpl_create_shipment_v1'));
COMMIT;
