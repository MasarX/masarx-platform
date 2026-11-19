-- Migration 202610160835 records a successful workflow reuse as a succeeded row.
-- pgTAP: Console V2 shipment import duplicate-row contract.
--
-- A successful import row can reuse a shipment. Both rows must reference
-- the same shipment and the reuse must preserve the original shipment data.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(13);

CREATE OR REPLACE FUNCTION pg_temp.exercise_console_v2_import_duplicate_reuse_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-000092110001';
  v_user UUID := '00000000-0000-0000-0000-000092110002';
  v_client UUID := '00000000-0000-0000-0000-000092110003';
  v_sender UUID := '00000000-0000-0000-0000-000092110004';
  v_tracking TEXT := 'PGTAP-IMPORT-DUP-9211-001';
  v_first_ref TEXT := 'PGTAP-IMPORT-DUP-REF-9211-001';
  v_second_ref TEXT := 'PGTAP-IMPORT-DUP-REF-9211-002';
  v_prepare_payload JSONB := '{}'::jsonb;
  v_prepare JSONB := '{}'::jsonb;
  v_start JSONB := '{}'::jsonb;
  v_process JSONB := '{}'::jsonb;
  v_reuse_prepare JSONB := '{}'::jsonb;
  v_reuse_start JSONB := '{}'::jsonb;
  v_reuse_process JSONB := '{}'::jsonb;
  v_run_id UUID;
  v_reuse_run_id UUID;
  v_shipment_count INT := 0;
  v_target_count INT := 0;
  v_target_record_id TEXT;
  v_first_workflow_run_id UUID;
  v_reuse_workflow_run_id UUID;
  v_shipment_metadata JSONB := '{}'::jsonb;
  v_shipment_special_instructions TEXT;
BEGIN
  EXECUTE 'RESET ROLE';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Import Duplicate Org', 'console-v2-import-duplicate-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES (
    v_user,
    v_org,
    'console-v2-import-duplicate@example.test',
    'Console V2 Import Duplicate',
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
  VALUES (v_client, v_org, 'Console V2 Import Duplicate Client', 'console-v2-import-duplicate-client', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, brand_name, status)
  VALUES (v_sender, v_client, 'Console V2 Import Duplicate Sender', 'Console V2 Import Duplicate Sender', 'active')
  ON CONFLICT (id) DO NOTHING;

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
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_prepare_payload := jsonb_build_object(
      'resource_key', 'shipments',
      'write_mode', 'create',
      'rule_source', 'manual',
      'source_format', 'csv',
      'source_file_name', 'console-v2-import-duplicate.csv',
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
          'client_reference_number', v_first_ref,
          'service_type', 'delivery',
          'status', 'pending',
          'box_count', '1',
          'cod_amount', '42.50',
          'cod_currency', 'SAR',
          'promised_delivery_date', '2026-05-20',
          'special_instructions', 'Duplicate reuse contract row original',
          'recipient_name', 'Import Duplicate Recipient A',
          'recipient_phone', '+12025550190',
          'recipient_external_id', 'REC-PGTAP-IMPORT-DUP-9211-001',
          'address_line_1', 'King Fahd Road',
          'city', 'Riyadh',
          'province', 'Riyadh',
          'country', 'SA',
          'validation_status', 'pending'
        ),
        jsonb_build_object(
          'tracking_number', v_tracking,
          'client_reference_number', v_second_ref,
          'service_type', 'delivery',
          'status', 'pending',
          'box_count', '1',
          'cod_amount', '42.50',
          'cod_currency', 'SAR',
          'promised_delivery_date', '2026-05-20',
          'special_instructions', 'Duplicate reuse contract row should not overwrite',
          'recipient_name', 'Import Duplicate Recipient B',
          'recipient_phone', '+12025550191',
          'recipient_external_id', 'REC-PGTAP-IMPORT-DUP-9211-002',
          'address_line_1', 'King Fahd Branch Road',
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
  );
  v_prepare := public.tabular_import_prepare_v1(v_prepare_payload);

  v_run_id := NULLIF(v_prepare->>'run_id', '')::uuid;

  RETURN NEXT ok(
    v_run_id IS NOT NULL
    AND COALESCE((v_prepare->>'total_rows')::int, 0) = 2
    AND COALESCE((v_prepare->>'blocked_count')::int, 1) = 0
    AND COALESCE((v_prepare->>'will_create')::int, 0) = 2,
    'same-tracking import with distinct row identities stages two create rows before backend execution'
  );

  v_start := public.ui_start_tabular_import_run_v1(v_run_id, NULL);
  RETURN NEXT is(v_start->>'status', 'queued', 'duplicate import run can start');

  EXECUTE 'RESET ROLE';
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'service_role')::text,
    true
  );

  v_process := public.process_tabular_import_run_v1(v_run_id, 10);
  RETURN NEXT is(v_process->>'status', 'completed', 'duplicate import run completes with reuse reported by the workflow');

  SELECT count(*)::int
    INTO v_shipment_count
    FROM public.shipments
   WHERE client_id = v_client
     AND tracking_number = v_tracking;

  RETURN NEXT is(v_shipment_count::text, '1', 'duplicate import creates exactly one shipment');

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.tabular_import_runs r
       WHERE r.id = v_run_id
         AND r.created_count = 2
         AND r.skipped_count = 0
         AND r.failed_count = 0
         AND r.blocked_count = 0
    ),
    'run rollups count both successful import rows'
  );

  SELECT count(DISTINCT rr.target_record_id), min(rr.target_record_id)
    INTO v_target_count, v_target_record_id
    FROM public.tabular_import_run_rows rr
   WHERE rr.run_id = v_run_id;

  RETURN NEXT ok(
    v_target_count = 1
    AND v_target_record_id IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM public.tabular_import_run_rows rr
       WHERE rr.run_id = v_run_id
         AND rr.row_number = 1
         AND rr.action = 'create'
         AND rr.execution_status = 'succeeded'
         AND rr.target_record_id = v_target_record_id
    )
    AND EXISTS (
      SELECT 1
        FROM public.tabular_import_run_rows rr
       WHERE rr.run_id = v_run_id
         AND rr.row_number = 2
         AND rr.action = 'create'
         AND rr.execution_status = 'succeeded'
         AND rr.target_record_id = v_target_record_id
    ),
    'duplicate row succeeds and points at the existing shipment'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.tabular_import_run_rows rr
       WHERE rr.run_id = v_run_id
         AND rr.row_number = 2
         AND rr.metadata#>>'{primary_result,operation}' IN ('reused', 'reused_client_reference')
    ),
    'succeeded duplicate row carries explicit workflow reuse readback'
  );

  SELECT NULLIF(rr.metadata#>>'{primary_result,workflow_run_id}', '')::uuid
    INTO v_first_workflow_run_id
    FROM public.tabular_import_run_rows rr
   WHERE rr.run_id = v_run_id
     AND rr.row_number = 1;

  SELECT s.metadata, s.special_instructions
    INTO v_shipment_metadata, v_shipment_special_instructions
    FROM public.shipments s
   WHERE s.id = v_target_record_id::uuid;

  RETURN NEXT ok(
    v_first_workflow_run_id IS NOT NULL
    AND v_shipment_metadata->>'source' = 'tabular_import'
    AND v_shipment_metadata->>'workflow_run_id' = v_first_workflow_run_id::text
    AND COALESCE(v_shipment_metadata->'import_workflow_runs', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('workflow_run_id', v_first_workflow_run_id::text)),
    'first same-run duplicate import preserves created-row workflow lineage on the shipment'
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

  v_reuse_prepare := public.tabular_import_prepare_v1(
    v_prepare_payload || jsonb_build_object(
      'source_file_name', 'console-v2-import-duplicate-reuse-existing.csv',
      'rows', jsonb_build_array(
        jsonb_build_object(
          'tracking_number', v_tracking,
          'client_reference_number', 'PGTAP-IMPORT-DUP-REF-9211-003',
          'service_type', 'delivery',
          'status', 'pending',
          'box_count', '1',
          'cod_amount', '42.50',
          'cod_currency', 'SAR',
          'promised_delivery_date', '2026-05-20',
          'special_instructions', 'Existing duplicate reuse should not overwrite',
          'recipient_name', 'Import Duplicate Recipient C',
          'recipient_phone', '+12025550192',
          'recipient_external_id', 'REC-PGTAP-IMPORT-DUP-9211-003',
          'address_line_1', 'King Fahd Duplicate Road',
          'city', 'Riyadh',
          'province', 'Riyadh',
          'country', 'SA',
          'validation_status', 'pending'
        )
      )
    )
  );
  v_reuse_run_id := NULLIF(v_reuse_prepare->>'run_id', '')::uuid;

  RETURN NEXT ok(
    v_reuse_run_id IS NOT NULL
    AND COALESCE((v_reuse_prepare->>'total_rows')::int, 0) = 1
    AND COALESCE((v_reuse_prepare->>'blocked_count')::int, 1) = 0,
    'existing-shipment duplicate reuse stages a separate backend-backed import run'
  );

  v_reuse_start := public.ui_start_tabular_import_run_v1(v_reuse_run_id, NULL);
  RETURN NEXT is(v_reuse_start->>'status', 'queued', 'existing-shipment duplicate reuse import can start');

  EXECUTE 'RESET ROLE';
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'service_role')::text,
    true
  );

  v_reuse_process := public.process_tabular_import_run_v1(v_reuse_run_id, 10);
  RETURN NEXT is(v_reuse_process->>'status', 'completed', 'existing-shipment duplicate reuse completes successfully');

  SELECT NULLIF(rr.metadata#>>'{primary_result,workflow_run_id}', '')::uuid
    INTO v_reuse_workflow_run_id
    FROM public.tabular_import_run_rows rr
   WHERE rr.run_id = v_reuse_run_id
     AND rr.row_number = 1;

  SELECT s.metadata, s.special_instructions
    INTO v_shipment_metadata, v_shipment_special_instructions
    FROM public.shipments s
   WHERE s.id = v_target_record_id::uuid;

  RETURN NEXT ok(
    v_reuse_workflow_run_id IS NOT NULL
    AND v_reuse_workflow_run_id <> v_first_workflow_run_id
    AND EXISTS (
      SELECT 1
        FROM public.tabular_import_run_rows rr
       WHERE rr.run_id = v_reuse_run_id
         AND rr.row_number = 1
         AND rr.action = 'create'
         AND rr.execution_status = 'succeeded'
         AND rr.target_record_id = v_target_record_id
         AND rr.metadata#>>'{primary_result,operation}' = 'reused'
    ),
    'existing-shipment duplicate row exposes its own successful reuse workflow'
  );

  RETURN NEXT ok(
    COALESCE(v_shipment_metadata->'import_workflow_runs', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('workflow_run_id', v_first_workflow_run_id::text))
    AND COALESCE(v_shipment_metadata->'import_workflow_runs', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('workflow_run_id', v_reuse_workflow_run_id::text, 'operation', 'reused'))
    AND v_shipment_metadata->>'workflow_run_id' = v_first_workflow_run_id::text
    AND v_shipment_special_instructions = 'Duplicate reuse contract row original',
    'existing-shipment duplicate import preserves original shipment truth and stores reuse workflow separately'
  );
END;
$function$;

SELECT * FROM pg_temp.exercise_console_v2_import_duplicate_reuse_v1();

SELECT * FROM finish();
ROLLBACK;
