-- pgTAP: tpl_create_shipment workflow template registration + structural invariants.
--
-- Verifies the canonical migration 202604281300_tpl_create_shipment_v1.sql
-- correctly seeds:
--   1) the workflow_templates row with name=tpl_create_shipment, status=active.
--   2) all 7 canonical handler steps in the expected sequence_order.
--   3) the 4 logical pipeline phases referenced by the FE composer
--      (validate → create → first-mile → notify_client per Phase 0
--      INGRESS-COMPLETE notes in apps/console-v2/__audit__/CROSSWALK/SUMMARY.md).
--   4) handler_keys are all backed by entries in public.operation_handlers
--      (capability gating: workflow engine only resolves active handlers).
--   5) RLS posture is preserved (workflow_templates rows read by service_role,
--      writes governed by 202601191940_workflow_templates_write_rls.sql).

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(15);

-- 1) Template row exists and is active.
SELECT ok(
  EXISTS(
    SELECT 1 FROM public.workflow_templates
    WHERE name = 'tpl_create_shipment'
      AND status = 'active'
      AND scope_type = 'global'
  ),
  'tpl_create_shipment template exists, status=active, scope=global'
);

-- 2) Steps_checksum is populated (template was published with computed digest).
SELECT ok(
  (
    SELECT steps_checksum IS NOT NULL AND length(steps_checksum) > 0
    FROM public.workflow_templates
    WHERE name = 'tpl_create_shipment'
  ),
  'tpl_create_shipment steps_checksum is populated'
);

-- 3) Step count is exactly 7 (matches the canonical pipeline).
SELECT is(
  (
    SELECT COUNT(*)::int
    FROM public.workflow_template_steps wts
    JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
    WHERE wt.name = 'tpl_create_shipment'
  ),
  7,
  'tpl_create_shipment has exactly 7 canonical steps'
);

-- 4) Step 0 is context_extract_from_mapping (intake hand-off).
SELECT is(
  (
    SELECT handler_key
    FROM public.workflow_template_steps wts
    JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
    WHERE wt.name = 'tpl_create_shipment'
      AND sequence_order = 0
  ),
  'context_extract_from_mapping',
  'step 0 is context_extract_from_mapping (payload → workflow context)'
);

-- 5) Step 1 is context_set_defaults (apply service_type/initial_status).
SELECT is(
  (
    SELECT handler_key
    FROM public.workflow_template_steps wts
    JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
    WHERE wt.name = 'tpl_create_shipment'
      AND sequence_order = 1
  ),
  'context_set_defaults',
  'step 1 is context_set_defaults'
);

-- 6) Step 2 is context_require — validate-phase guard for client_id +
--    client_reference_number (matches FE composer pre-submit check at
--    apps/console-v2/src/modules/operate/shipments.tsx:203-206).
SELECT is(
  (
    SELECT handler_key
    FROM public.workflow_template_steps wts
    JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
    WHERE wt.name = 'tpl_create_shipment'
      AND sequence_order = 2
  ),
  'context_require',
  'step 2 is context_require (validate phase)'
);

-- 7) Step 2 metadata enforces the canonical required fields.
SELECT ok(
  (
    SELECT (wts.metadata->'required') @> '["client_id"]'::jsonb
       AND (wts.metadata->'required') @> '["client_reference_number"]'::jsonb
       AND wts.metadata->>'on_missing' = 'fail_workflow'
    FROM public.workflow_template_steps wts
    JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
    WHERE wt.name = 'tpl_create_shipment'
      AND sequence_order = 2
  ),
  'step 2 (validate) requires client_id + client_reference_number, fails workflow when missing'
);

-- 8) Step 3 is reserve_shipment_identifiers (planned id + tracking).
SELECT is(
  (
    SELECT handler_key
    FROM public.workflow_template_steps wts
    JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
    WHERE wt.name = 'tpl_create_shipment'
      AND sequence_order = 3
  ),
  'reserve_shipment_identifiers',
  'step 3 is reserve_shipment_identifiers'
);

-- 9) Step 4 is shipment_create — the create phase.
SELECT is(
  (
    SELECT handler_key
    FROM public.workflow_template_steps wts
    JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
    WHERE wt.name = 'tpl_create_shipment'
      AND sequence_order = 4
  ),
  'shipment_create',
  'step 4 is shipment_create (create phase)'
);

-- 10) Step 5 is task_enqueue with task_type_key=dispatch_first_mile —
--     the first-mile assignment phase.
SELECT ok(
  (
    SELECT handler_key = 'task_enqueue'
       AND wts.metadata->>'task_type_key' = 'dispatch_first_mile'
       AND wts.metadata->>'queue_key' = 'dispatch'
    FROM public.workflow_template_steps wts
    JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
    WHERE wt.name = 'tpl_create_shipment'
      AND sequence_order = 5
  ),
  'step 5 is task_enqueue with dispatch_first_mile (first-mile phase)'
);

-- 11) Step 6 is shipment_created_notification — the notify_client phase.
SELECT ok(
  (
    SELECT handler_key = 'shipment_created_notification'
       AND wts.metadata->>'context_key' = 'shipment_created_notification'
    FROM public.workflow_template_steps wts
    JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
    WHERE wt.name = 'tpl_create_shipment'
      AND sequence_order = 6
  ),
  'step 6 is shipment_created_notification (notify_client phase)'
);

-- 12) Capability gating: every handler_key referenced is registered + active
--     in public.operation_handlers (so the workflow engine can dispatch each
--     step at runtime; missing/inactive handlers would cause runtime failure).
--     Distinct handler_keys: context_extract_from_mapping, context_set_defaults,
--     context_require, reserve_shipment_identifiers, shipment_create,
--     task_enqueue, enqueue_notification = 7.
SELECT is(
  (
    SELECT COUNT(DISTINCT wts.handler_key)::int
    FROM public.workflow_template_steps wts
    JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
    JOIN public.operation_handlers oh
      ON oh.handler_key = wts.handler_key AND oh.is_active = TRUE
    WHERE wt.name = 'tpl_create_shipment'
  ),
  7,
  'all 7 distinct handler_keys in tpl_create_shipment steps are registered + active in operation_handlers'
);

-- 13) All steps are enabled (engine consults `enabled=TRUE` to dispatch).
SELECT is(
  (
    SELECT COUNT(*)::int
    FROM public.workflow_template_steps wts
    JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
    WHERE wt.name = 'tpl_create_shipment'
      AND wts.enabled = TRUE
  ),
  7,
  'all 7 steps are enabled'
);

-- 14) Sequence order is contiguous 0..6 (engine relies on monotonic
--     sequence_order to advance through steps).
SELECT is(
  (
    SELECT array_agg(sequence_order ORDER BY sequence_order)
    FROM public.workflow_template_steps wts
    JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
    WHERE wt.name = 'tpl_create_shipment'
  ),
  ARRAY[0,1,2,3,4,5,6]::INTEGER[],
  'sequence_order is contiguous 0..6'
);

-- 15) RLS guard: workflow_templates table has RLS enabled (sanity check on
--     the canonical lockdown invariant; SSOT migration is
--     202601191940_workflow_templates_write_rls.sql).
SELECT ok(
  (
    SELECT relrowsecurity
    FROM pg_class
    WHERE relname = 'workflow_templates'
      AND relnamespace = 'public'::regnamespace
  ),
  'public.workflow_templates has RLS enabled (canonical posture preserved)'
);

SELECT * FROM finish();

ROLLBACK;
