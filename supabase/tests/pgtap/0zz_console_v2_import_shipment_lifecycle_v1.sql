-- pgTAP: Console V2 CSV/XLS/XLSX shipment import lifecycle.
--
-- This proves the backend contract behind the file-upload path can map a
-- prepared shipment import into real shipment, recipient, and address rows.
-- Browser clicked proof is still required before production-readiness closure.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(29);

SELECT ok(
  jsonb_array_length(COALESCE(public.tabular_import_resolve_resource_v1('shipments')->'columns', '[]'::jsonb)) >= 10,
  'shipments import resource exposes importable columns'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.tabular_import_resolve_resource_v1('shipments')->'columns') AS c(value)
     WHERE c.value->>'key' = 'tracking_number'
       AND COALESCE((c.value#>>'{import,enabled}')::boolean, FALSE)
       AND COALESCE((c.value#>>'{import,required}')::boolean, FALSE)
       AND COALESCE((c.value#>>'{import,identity}')::boolean, FALSE)
  ),
  'shipments tracking_number is enabled, required, and identity-marked for imports'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.tabular_import_resolve_resource_v1('shipments')->'columns') AS c(value)
     WHERE c.value->>'key' = 'recipient_id'
       AND COALESCE(c.value#>>'{import,reference,resource}', '') = 'recipients'
       AND COALESCE((c.value#>>'{import,reference,allow_inline_node}')::boolean, FALSE)
  ),
  'shipments recipient_id supports inline recipient creation during imports'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.tabular_import_resolve_resource_v1('shipments')->'columns') AS c(value)
     WHERE c.value->>'key' = 'destination_address_id'
       AND COALESCE(c.value#>>'{import,reference,resource}', '') = 'addresses'
       AND COALESCE((c.value#>>'{import,reference,allow_inline_node}')::boolean, FALSE)
  ),
  'shipments destination_address_id supports inline address creation during imports'
);

SELECT ok(
  public.tabular_import_resolve_resource_v1('shipments')#>'{import,accepted_formats}' @> '["csv","xls","xlsx"]'::jsonb,
  'shipments import accepts CSV/XLS/XLSX formats'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'request_entry_point'
       AND lv.value = 'import'
       AND COALESCE(lv.status, 'active') = 'active'
  ),
  'request_entry_point lookup accepts import workflow runs'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.tabular_import_resolve_resource_v1('shipments')->'columns') AS c(value)
     WHERE c.value->>'key' = 'box_count'
       AND c.value->>'edit_type' = 'integer'
       AND COALESCE(c.value#>'{import,coercions}', '[]'::jsonb) @> '["integer"]'::jsonb
  ),
  'shipments box_count import contract is integer typed before execution'
);

CREATE OR REPLACE FUNCTION pg_temp.exercise_console_v2_import_shipment_lifecycle_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-000091900001';
  v_user UUID := '00000000-0000-0000-0000-000091900002';
  v_client UUID := '00000000-0000-0000-0000-000091900003';
  v_sender UUID := '00000000-0000-0000-0000-000091900004';
  v_tracking TEXT := 'PGTAP-IMPORT-9190-001';
  v_recipient_external TEXT := 'REC-PGTAP-IMPORT-9190-001';
  v_prepare JSONB := '{}'::jsonb;
  v_start JSONB := '{}'::jsonb;
  v_process JSONB := '{}'::jsonb;
  v_readback JSONB := '{}'::jsonb;
  v_import_readback JSONB := '{}'::jsonb;
  v_invalid_prepare JSONB := '{}'::jsonb;
  v_related_block_prepare JSONB := '{}'::jsonb;
  v_related_block_readback JSONB := '{}'::jsonb;
  v_run_id UUID;
  v_invalid_run_id UUID;
  v_related_block_run_id UUID;
  v_shipment_id UUID;
  v_workflow_run_id UUID;
  v_workflow_status TEXT;
  v_recipient_id UUID;
  v_address_id UUID;
  v_invalid_start_blocked BOOLEAN := FALSE;
  v_related_block_start_blocked BOOLEAN := FALSE;
BEGIN
  EXECUTE 'RESET ROLE';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Import Shipment Org', 'console-v2-import-shipment-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES (
    v_user,
    v_org,
    'console-v2-import-shipment@example.test',
    'Console V2 Import Shipment',
    'ops_admin',
    'active',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         user_type = EXCLUDED.user_type,
         status = EXCLUDED.status,
         access_scope_type = EXCLUDED.access_scope_type,
         access_scope_id = EXCLUDED.access_scope_id;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Console V2 Import Shipment Client', 'console-v2-import-shipment-client', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, brand_name, status)
  VALUES (v_sender, v_client, 'Console V2 Import Shipment Sender', 'Console V2 Import Shipment Sender', 'active')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_user::text,
      'role', 'authenticated',
      'organization_id', v_org::text,
      'access_scope_type', 'tenant'
    )::text,
    true
  );
  PERFORM set_config(
    'request.jwt.claim',
    json_build_object(
      'sub', v_user::text,
      'role', 'authenticated',
      'organization_id', v_org::text,
      'access_scope_type', 'tenant'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_prepare := public.tabular_import_prepare_v1(
    jsonb_build_object(
      'resource_key', 'shipments',
      'write_mode', 'create',
      'rule_source', 'manual',
      'source_format', 'csv',
      'source_file_name', 'console-v2-import-shipment.csv',
      'headers', jsonb_build_array(
        'tracking_number',
        'client_reference_number',
        'service_type',
        'status',
        'box_count',
        'cod_amount',
        'cod_currency',
        'promised_delivery_date',
        'special_instructions',
        'recipient_name',
        'recipient_phone',
        'recipient_external_id',
        'address_line_1',
        'city',
        'province',
        'country',
        'validation_status'
      ),
      'rules', jsonb_build_array(
        jsonb_build_object('source_column', 'tracking_number', 'target_field', 'tracking_number', 'enabled', TRUE),
        jsonb_build_object('source_column', 'client_reference_number', 'target_field', 'client_reference_number', 'enabled', TRUE),
        jsonb_build_object('source_column', 'service_type', 'target_field', 'service_type', 'enabled', TRUE),
        jsonb_build_object('source_column', 'status', 'target_field', 'status', 'enabled', TRUE),
        jsonb_build_object('source_column', 'box_count', 'target_field', 'box_count', 'enabled', TRUE),
        jsonb_build_object('source_column', 'cod_amount', 'target_field', 'cod_amount', 'enabled', TRUE),
        jsonb_build_object('source_column', 'cod_currency', 'target_field', 'cod_currency', 'enabled', TRUE),
        jsonb_build_object('source_column', 'promised_delivery_date', 'target_field', 'promised_delivery_date', 'enabled', TRUE),
        jsonb_build_object('source_column', 'special_instructions', 'target_field', 'special_instructions', 'enabled', TRUE),
        jsonb_build_object('source_column', 'recipient_name', 'target_field', 'recipient.name', 'enabled', TRUE),
        jsonb_build_object('source_column', 'recipient_phone', 'target_field', 'recipient.phone_number', 'enabled', TRUE),
        jsonb_build_object('source_column', 'recipient_external_id', 'target_field', 'recipient.external_id', 'enabled', TRUE),
        jsonb_build_object('source_column', 'address_line_1', 'target_field', 'destination_address.raw_input', 'enabled', TRUE),
        jsonb_build_object('source_column', 'address_line_1', 'target_field', 'destination_address.normalized_line1', 'enabled', TRUE),
        jsonb_build_object('source_column', 'city', 'target_field', 'destination_address.city', 'enabled', TRUE),
        jsonb_build_object('source_column', 'province', 'target_field', 'destination_address.province', 'enabled', TRUE),
        jsonb_build_object('source_column', 'country', 'target_field', 'destination_address.country', 'enabled', TRUE),
        jsonb_build_object('source_column', 'validation_status', 'target_field', 'destination_address.validation_status', 'enabled', TRUE)
      ),
      'rows', jsonb_build_array(
        jsonb_build_object(
          'tracking_number', v_tracking,
          'client_reference_number', 'PGTAP-IMPORT-REF-9190-001',
          'service_type', 'delivery',
          'status', 'pending',
          'box_count', '2',
          'cod_amount', '118.50',
          'cod_currency', 'SAR',
          'promised_delivery_date', '2026-05-20',
          'special_instructions', 'Call before delivery',
          'recipient_name', 'Import Lifecycle Recipient',
          'recipient_phone', '+12025550193',
          'recipient_external_id', v_recipient_external,
          'address_line_1', 'King Fahd Road',
          'city', 'Riyadh',
          'province', 'Riyadh',
          'country', 'SA',
          'validation_status', 'pending'
        )
      ),
      'scope_context', jsonb_build_object(
        'tenant', v_org,
        'client', v_client,
        'sender', v_sender
      )
    )
  );

  v_run_id := NULLIF(v_prepare->>'run_id', '')::uuid;
  RETURN NEXT ok(
    v_run_id IS NOT NULL
    AND COALESCE((v_prepare->>'total_rows')::int, 0) = 1
    AND COALESCE((v_prepare->>'blocked_count')::int, 1) = 0
    AND COALESCE((v_prepare->>'will_create')::int, 0) = 1,
    'tabular import prepare stages one createable shipment row'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.tabular_import_run_rows rr
       WHERE rr.run_id = v_run_id
         AND rr.metadata->'related_nodes' @> '[{"node_key":"recipient","action":"create"},{"node_key":"destination_address","action":"create"}]'::jsonb
    ),
    'prepare stages inline recipient and destination address related nodes'
  );

  v_invalid_prepare := public.tabular_import_prepare_v1(
    jsonb_build_object(
      'resource_key', 'shipments',
      'write_mode', 'create',
      'rule_source', 'manual',
      'source_format', 'csv',
      'source_file_name', 'console-v2-import-shipment-invalid.csv',
      'headers', jsonb_build_array(
        'tracking_number',
        'client_reference_number',
        'service_type',
        'status',
        'box_count',
        'cod_amount',
        'cod_currency',
        'promised_delivery_date',
        'recipient_name',
        'recipient_phone',
        'recipient_external_id',
        'address_line_1',
        'city',
        'province',
        'country',
        'validation_status'
      ),
      'rules', jsonb_build_array(
        jsonb_build_object('source_column', 'tracking_number', 'target_field', 'tracking_number', 'enabled', TRUE),
        jsonb_build_object('source_column', 'client_reference_number', 'target_field', 'client_reference_number', 'enabled', TRUE),
        jsonb_build_object('source_column', 'service_type', 'target_field', 'service_type', 'enabled', TRUE),
        jsonb_build_object('source_column', 'status', 'target_field', 'status', 'enabled', TRUE),
        jsonb_build_object('source_column', 'box_count', 'target_field', 'box_count', 'enabled', TRUE),
        jsonb_build_object('source_column', 'cod_amount', 'target_field', 'cod_amount', 'enabled', TRUE),
        jsonb_build_object('source_column', 'cod_currency', 'target_field', 'cod_currency', 'enabled', TRUE),
        jsonb_build_object('source_column', 'promised_delivery_date', 'target_field', 'promised_delivery_date', 'enabled', TRUE),
        jsonb_build_object('source_column', 'recipient_name', 'target_field', 'recipient.name', 'enabled', TRUE),
        jsonb_build_object('source_column', 'recipient_phone', 'target_field', 'recipient.phone_number', 'enabled', TRUE),
        jsonb_build_object('source_column', 'recipient_external_id', 'target_field', 'recipient.external_id', 'enabled', TRUE),
        jsonb_build_object('source_column', 'address_line_1', 'target_field', 'destination_address.raw_input', 'enabled', TRUE),
        jsonb_build_object('source_column', 'address_line_1', 'target_field', 'destination_address.normalized_line1', 'enabled', TRUE),
        jsonb_build_object('source_column', 'city', 'target_field', 'destination_address.city', 'enabled', TRUE),
        jsonb_build_object('source_column', 'province', 'target_field', 'destination_address.province', 'enabled', TRUE),
        jsonb_build_object('source_column', 'country', 'target_field', 'destination_address.country', 'enabled', TRUE),
        jsonb_build_object('source_column', 'validation_status', 'target_field', 'destination_address.validation_status', 'enabled', TRUE)
      ),
      'rows', jsonb_build_array(
        jsonb_build_object(
          'tracking_number', 'PGTAP-IMPORT-9190-BLOCKED',
          'client_reference_number', 'PGTAP-IMPORT-REF-9190-BLOCKED',
          'service_type', 'delivery',
          'status', 'pending',
          'box_count', '2.5',
          'cod_amount', 'not-money',
          'cod_currency', 'SAR',
          'promised_delivery_date', 'not-a-date',
          'recipient_name', 'Import Invalid Recipient',
          'recipient_phone', '+12025550194',
          'recipient_external_id', 'REC-PGTAP-IMPORT-9190-BLOCKED',
          'address_line_1', 'King Fahd Road',
          'city', 'Riyadh',
          'province', 'Riyadh',
          'country', 'SA',
          'validation_status', 'pending'
        )
      ),
      'scope_context', jsonb_build_object(
        'tenant', v_org,
        'client', v_client,
        'sender', v_sender
      )
    )
  );

  v_invalid_run_id := NULLIF(v_invalid_prepare->>'run_id', '')::uuid;
  RETURN NEXT ok(
    v_invalid_run_id IS NOT NULL
    AND COALESCE((v_invalid_prepare->>'blocked_count')::int, 0) = 1,
    'invalid typed shipment import values block the prepared row before start'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.tabular_import_run_rows rr
       WHERE rr.run_id = v_invalid_run_id
         AND rr.diagnostics @> '[{"code":"integer_parse_failed","blocking":true}]'::jsonb
         AND rr.diagnostics @> '[{"code":"number_parse_failed","blocking":true}]'::jsonb
         AND rr.diagnostics @> '[{"code":"date_parse_failed","blocking":true}]'::jsonb
    ),
    'invalid typed shipment import values are exposed as blocking row diagnostics'
  );

  BEGIN
    PERFORM public.ui_start_tabular_import_run_v1(v_invalid_run_id, NULL);
    v_invalid_start_blocked := FALSE;
  EXCEPTION
    WHEN OTHERS THEN
      v_invalid_start_blocked := SQLERRM LIKE '%still has blocked rows%';
  END;

  RETURN NEXT ok(
    v_invalid_start_blocked,
    'ui_start_tabular_import_run_v1 rejects prepared runs with invalid typed row diagnostics'
  );

  v_related_block_prepare := public.tabular_import_prepare_v1(
    jsonb_build_object(
      'resource_key', 'shipments',
      'write_mode', 'create',
      'rule_source', 'manual',
      'source_format', 'csv',
      'source_file_name', 'console-v2-import-shipment-related-blocked.csv',
      'headers', jsonb_build_array(
        'tracking_number',
        'client_reference_number',
        'service_type',
        'status',
        'box_count',
        'cod_amount',
        'cod_currency',
        'promised_delivery_date',
        'recipient_name',
        'recipient_phone',
        'recipient_external_id',
        'address_line_1',
        'city',
        'country'
      ),
      'rules', jsonb_build_array(
        jsonb_build_object('source_column', 'tracking_number', 'target_field', 'tracking_number', 'enabled', TRUE),
        jsonb_build_object('source_column', 'client_reference_number', 'target_field', 'client_reference_number', 'enabled', TRUE),
        jsonb_build_object('source_column', 'service_type', 'target_field', 'service_type', 'enabled', TRUE),
        jsonb_build_object('source_column', 'status', 'target_field', 'status', 'enabled', TRUE),
        jsonb_build_object('source_column', 'box_count', 'target_field', 'box_count', 'enabled', TRUE),
        jsonb_build_object('source_column', 'cod_amount', 'target_field', 'cod_amount', 'enabled', TRUE),
        jsonb_build_object('source_column', 'cod_currency', 'target_field', 'cod_currency', 'enabled', TRUE),
        jsonb_build_object('source_column', 'promised_delivery_date', 'target_field', 'promised_delivery_date', 'enabled', TRUE),
        jsonb_build_object('source_column', 'recipient_name', 'target_field', 'recipient.name', 'enabled', TRUE),
        jsonb_build_object('source_column', 'recipient_phone', 'target_field', 'recipient.phone_number', 'enabled', TRUE),
        jsonb_build_object('source_column', 'recipient_external_id', 'target_field', 'recipient.external_id', 'enabled', TRUE),
        jsonb_build_object('source_column', 'address_line_1', 'target_field', 'destination_address.raw_input', 'enabled', TRUE),
        jsonb_build_object('source_column', 'address_line_1', 'target_field', 'destination_address.normalized_line1', 'enabled', TRUE),
        jsonb_build_object('source_column', 'city', 'target_field', 'destination_address.city', 'enabled', TRUE),
        jsonb_build_object('source_column', 'country', 'target_field', 'destination_address.country', 'enabled', TRUE)
      ),
      'rows', jsonb_build_array(
        jsonb_build_object(
          'tracking_number', 'PGTAP-IMPORT-9190-RELATED-BLOCKED',
          'client_reference_number', 'PGTAP-IMPORT-REF-9190-RELATED-BLOCKED',
          'service_type', 'delivery',
          'status', 'pending',
          'box_count', '1',
          'cod_amount', '42.50',
          'cod_currency', 'SAR',
          'promised_delivery_date', '2026-05-15',
          'recipient_name', 'Import Related Blocked Recipient',
          'recipient_phone', '+12025550195',
          'recipient_external_id', 'REC-PGTAP-IMPORT-9190-RELATED-BLOCKED',
          'address_line_1', 'King Fahd Road',
          'city', 'Riyadh',
          'country', 'SA'
        )
      ),
      'scope_context', jsonb_build_object(
        'tenant', v_org,
        'client', v_client,
        'sender', v_sender
      )
    )
  );

  v_related_block_run_id := NULLIF(v_related_block_prepare->>'run_id', '')::uuid;
  SELECT public.ui_get_tabular_import_run_v1(v_related_block_run_id)
    INTO v_related_block_readback;

  RETURN NEXT ok(
    v_related_block_run_id IS NOT NULL
    AND COALESCE((v_related_block_prepare->>'blocked_count')::int, 0) = 1
    AND COALESCE((v_related_block_readback->>'blocked_count')::int, 0) = 1,
    'related-node-only shipment import blockers are returned in prepare response and canonical readback'
  );

  RETURN NEXT ok(
    COALESCE(v_related_block_prepare->'blocking_diagnostics', '[]'::jsonb)
      @> '[{"code":"related_required_field_missing","fieldPath":"destination_address.province","blocking":true}]'::jsonb
    AND COALESCE(v_related_block_prepare->'blocking_diagnostics', '[]'::jsonb)
      @> '[{"code":"related_required_field_missing","fieldPath":"destination_address.validation_status","blocking":true}]'::jsonb
    AND COALESCE(v_related_block_readback#>'{summary,blocking_diagnostics}', '[]'::jsonb)
      @> '[{"code":"related_required_field_missing","fieldPath":"destination_address.province","blocking":true}]'::jsonb
    AND COALESCE(v_related_block_readback#>'{summary,blocking_diagnostics}', '[]'::jsonb)
      @> '[{"code":"related_required_field_missing","fieldPath":"destination_address.validation_status","blocking":true}]'::jsonb,
    'missing related address province and validation status diagnostics are visible before start'
  );

  BEGIN
    PERFORM public.ui_start_tabular_import_run_v1(v_related_block_run_id, NULL);
    v_related_block_start_blocked := FALSE;
  EXCEPTION
    WHEN OTHERS THEN
      v_related_block_start_blocked := SQLERRM LIKE '%still has blocked rows%';
  END;

  RETURN NEXT ok(
    v_related_block_start_blocked,
    'ui_start_tabular_import_run_v1 rejects related-node-only blocked prepared runs'
  );

  v_start := public.ui_start_tabular_import_run_v1(v_run_id, NULL);
  RETURN NEXT ok(
    v_start->>'status' = 'queued'
    AND NULLIF(v_start->>'task_id', '') IS NOT NULL,
    'tabular import start queues the prepared run through the UI start RPC'
  );

  EXECUTE 'RESET ROLE';
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'service_role')::text,
    true
  );

  v_process := public.process_tabular_import_run_v1(v_run_id, 10);
  RETURN NEXT ok(
    v_process->>'status' = 'completed',
    'tabular import worker completes the shipment import run'
  );

  SELECT s.id, s.recipient_id, s.destination_address_id
    INTO v_shipment_id, v_recipient_id, v_address_id
    FROM public.shipments s
   WHERE s.tracking_number = v_tracking
     AND s.client_id = v_client
   LIMIT 1;

  RETURN NEXT ok(
    v_shipment_id IS NOT NULL,
    'tabular import worker creates a real shipment row'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.shipments s
       WHERE s.id = v_shipment_id
         AND s.organization_id = v_org
         AND s.client_id = v_client
         AND s.sender_id = v_sender
         AND s.service_type = 'delivery'
         AND s.status = 'pending'
         AND s.cod_amount = 118.50
         AND s.cod_currency = 'SAR'
         AND s.box_count = 2
         AND s.promised_delivery_date = DATE '2026-05-20'
         AND s.special_instructions = 'Call before delivery'
    ),
    'created shipment preserves client/sender/service/status/boxes/COD/promised date/instructions data'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.recipients r
       WHERE r.id = v_recipient_id
         AND r.external_id = v_recipient_external
         AND r.name = 'Import Lifecycle Recipient'
         AND r.client_id = v_client
    ),
    'import-created shipment links to an inline-created recipient'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.addresses a
       WHERE a.id = v_address_id
         AND a.raw_input = 'King Fahd Road'
         AND a.city = 'Riyadh'
         AND a.province = 'Riyadh'
         AND a.validation_status = 'pending'
         AND a.client_id = v_client
    ),
    'import-created shipment links to an inline-created destination address'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.tabular_import_run_rows rr
       WHERE rr.run_id = v_run_id
         AND rr.target_record_id = v_shipment_id::text
         AND rr.execution_status = 'succeeded'
    ),
    'import run row stores the created shipment id for readback'
  );

  v_import_readback := public.ui_get_tabular_import_run_v1(v_run_id);
  RETURN NEXT ok(
    v_import_readback->>'id' = v_run_id::text
    AND COALESCE(jsonb_array_length(v_import_readback->'rows'), 0) > 0
    AND (v_import_readback->'rows' @> jsonb_build_array(jsonb_build_object('target_record_id', v_shipment_id::text)))
    AND COALESCE(jsonb_array_length(v_import_readback#>'{rows,0,related_nodes}'), 0) >= 2,
    'dedicated import-run detail RPC exposes created shipment and related-node handoff rows'
  );

  v_workflow_run_id := NULLIF(v_import_readback#>>'{rows,0,workflow_run_id}', '')::uuid;
  v_workflow_status := NULLIF(v_import_readback#>>'{rows,0,workflow_status}', '');

  RETURN NEXT ok(
    v_workflow_run_id IS NOT NULL
    AND v_workflow_status = 'completed'
    AND v_import_readback#>>'{rows,0,primary_result,workflow_run_id}' = v_workflow_run_id::text,
    'import-run detail row exposes workflow_run_id, workflow_status, and primary workflow result'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.workflow_runs wr
        JOIN public.workflow_templates wt ON wt.id = wr.workflow_template_id
       WHERE wr.id = v_workflow_run_id
         AND wr.entry_point = 'import'
         AND wr.context->>'trigger_source' = 'import'
         AND wt.name = 'shipment_manual_create_v1'
    ),
    'import-created shipment workflow run is canonical and entry_point import'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.workflow_run_steps step
       WHERE step.workflow_run_id = v_workflow_run_id
         AND step.handler_key = 'shipment_create'
         AND step.step_status = 'completed'
         AND step.operation_result->>'shipment_id' = v_shipment_id::text
    ),
    'import workflow run completed the canonical shipment_create step for the created shipment'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.shipments s
       WHERE s.id = v_shipment_id
         AND s.metadata->>'workflow_run_id' = v_workflow_run_id::text
         AND COALESCE(s.metadata->'import_workflow_runs', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('workflow_run_id', v_workflow_run_id::text))
    ),
    'created shipment metadata stores top-level and import-history workflow lineage'
  );

  v_import_readback := api.ui_get_tabular_import_run_v1(v_run_id);
  RETURN NEXT ok(
    v_import_readback->>'id' = v_run_id::text
    AND COALESCE(jsonb_array_length(v_import_readback->'rows'), 0) > 0
    AND v_import_readback#>>'{rows,0,workflow_run_id}' = v_workflow_run_id::text
    AND v_import_readback#>>'{rows,0,workflow_status}' = 'completed',
    'api.ui_get_tabular_import_run_v1 exposes the same browser-safe import-run detail readback'
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_user::text,
      'role', 'authenticated',
      'organization_id', v_org::text,
      'access_scope_type', 'tenant'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_readback := public.ui_get_resource_v1('shipments', v_shipment_id);
  RETURN NEXT ok(
    v_readback->>'id' = v_shipment_id::text
    AND v_readback->>'tracking_number' = v_tracking,
    'created shipment is readable through the Console V2 ui_get_resource_v1 shipment readback path'
  );
EXCEPTION WHEN OTHERS THEN
  RETURN NEXT fail('import shipment lifecycle raised ' || SQLSTATE || ': ' || SQLERRM);
END;
$function$;

SELECT * FROM pg_temp.exercise_console_v2_import_shipment_lifecycle_v1();

SELECT * FROM finish();

ROLLBACK;
