-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: Warehouse transfer execute workflow v1 (task-driven parity)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(39);

CREATE OR REPLACE FUNCTION pg_temp.test_warehouse_transfer_execute_workflow_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_template_id UUID;
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_catalog JSONB := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'warehouse_transfer' AND is_active IS TRUE),
    'handler registered: warehouse_transfer'
  );

  RETURN NEXT has_function(
    'public',
    'transition_warehouse_transfer_v1',
    ARRAY['jsonb'],
    'service RPC exists: transition_warehouse_transfer_v1(jsonb)'
  );

  RETURN NEXT has_function(
    'public',
    'resolve_warehouse_transfer_policy',
    ARRAY['jsonb'],
    'policy resolver exists: resolve_warehouse_transfer_policy(jsonb)'
  );

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'warehouse_transfer_execute_v1'
   LIMIT 1;

  RETURN NEXT ok(v_template_id IS NOT NULL, 'workflow template exists: warehouse_transfer_execute_v1');
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id),
    16,
    'warehouse_transfer_execute_v1 has 16 steps'
  );

  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 1), 'task_enqueue', 'step 1 handler_key = task_enqueue');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 2), 'task_wait', 'step 2 handler_key = task_wait');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 3), 'task_enqueue', 'step 3 handler_key = task_enqueue');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 4), 'task_wait', 'step 4 handler_key = task_wait');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 5), 'warehouse_transfer', 'step 5 handler_key = warehouse_transfer');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 8), 'warehouse_transfer', 'step 8 handler_key = warehouse_transfer');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 9), 'task_enqueue', 'step 9 handler_key = task_enqueue');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 10), 'task_wait', 'step 10 handler_key = task_wait');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 11), 'task_enqueue', 'step 11 handler_key = task_enqueue');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 13), 'warehouse_transfer', 'step 13 handler_key = warehouse_transfer');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 14), 'task_enqueue', 'step 14 handler_key = task_enqueue');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 15), 'task_wait', 'step 15 handler_key = task_wait');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 16), 'warehouse_transfer', 'step 16 handler_key = warehouse_transfer');

  RETURN NEXT is((SELECT metadata->>'from_status' FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 8), 'in_transit', 'step 8 requires from_status = in_transit');
  RETURN NEXT is((SELECT metadata->>'capture_phase' FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 8), 'receive', 'step 8 captures receive summary');
  RETURN NEXT is((SELECT metadata->>'when_path' FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 9), '$.context.warehouse_transfer.receive.has_unmanifested_hold', 'step 9 conditionally enqueues hold task');
  RETURN NEXT is((SELECT metadata->>'allow_missing_task' FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 10), 'true', 'step 10 allows missing hold task when condition is false');
  RETURN NEXT is((SELECT metadata->>'from_status' FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 13), 'received', 'step 13 requires from_status = received');
  RETURN NEXT is((SELECT metadata->>'capture_phase' FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 13), 'reconcile', 'step 13 captures reconcile summary');
  RETURN NEXT is((SELECT metadata->>'when_path' FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 14), '$.context.warehouse_transfer.reconcile.requires_supervisor_approval', 'step 14 conditionally enqueues supervisor approval');
  RETURN NEXT is((SELECT metadata->>'allow_missing_task' FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 15), 'true', 'step 15 allows missing approval task when condition is false');
  RETURN NEXT is((SELECT metadata->>'from_status' FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 16), 'received', 'step 16 requires from_status = received');

  RETURN NEXT has_column('public', 'warehouse_transfers', 'received_shipment_count', 'warehouse_transfers.received_shipment_count exists');
  RETURN NEXT has_column('public', 'warehouse_transfers', 'damaged_shipment_count', 'warehouse_transfers.damaged_shipment_count exists');
  RETURN NEXT has_column('public', 'warehouse_transfers', 'missing_shipment_count', 'warehouse_transfers.missing_shipment_count exists');
  RETURN NEXT has_column('public', 'warehouse_transfers', 'unmanifested_shipment_count', 'warehouse_transfers.unmanifested_shipment_count exists');
  RETURN NEXT has_column('public', 'warehouse_transfers', 'reconciled_at', 'warehouse_transfers.reconciled_at exists');

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
      WHERE ld.category = 'warehouse_transfer_status'
        AND lv.value = 'reconciled'
    ),
    'warehouse_transfer_status includes reconciled'
  );

  SELECT cached_value
    INTO v_catalog
    FROM public.settings
   WHERE category = 'task_type_catalog'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
   LIMIT 1;

  RETURN NEXT ok(v_catalog IS NOT NULL, 'task_type_catalog global settings present');
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_catalog->'task_types', '[]'::jsonb)) AS t(value) WHERE t.value->>'key' = 'warehouse_transfer_pack'),
    'task_type_catalog includes warehouse_transfer_pack'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_catalog->'task_types', '[]'::jsonb)) AS t(value) WHERE t.value->>'key' = 'warehouse_transfer_dispatch'),
    'task_type_catalog includes warehouse_transfer_dispatch'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_catalog->'task_types', '[]'::jsonb)) AS t(value) WHERE t.value->>'key' = 'warehouse_transfer_receive'),
    'task_type_catalog includes warehouse_transfer_receive'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_catalog->'task_types', '[]'::jsonb)) AS t(value) WHERE t.value->>'key' = 'warehouse_transfer_reconcile'),
    'task_type_catalog includes warehouse_transfer_reconcile'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_catalog->'task_types', '[]'::jsonb)) AS t(value) WHERE t.value->>'key' = 'warehouse_supervisor_approval'),
    'task_type_catalog includes warehouse_supervisor_approval'
  );
END;
$function$;

SELECT * FROM pg_temp.test_warehouse_transfer_execute_workflow_v1();

SELECT * FROM finish();
ROLLBACK;
