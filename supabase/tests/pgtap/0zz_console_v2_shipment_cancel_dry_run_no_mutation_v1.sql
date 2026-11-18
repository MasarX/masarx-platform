-- pgTAP: Console V2 shipment cancel preview must not mutate shipment state.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_shipment_cancel_dry_run_no_mutation_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_ops UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_before_runs INT := 0;
  v_after_runs INT := 0;
  v_result JSONB := '{}'::jsonb;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Cancel Dry Run Org', 'console-v2-cancel-dry-run-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Console V2 Cancel Dry Run Client', 'console-v2-cancel-dry-run-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, status)
  VALUES (v_sender, v_client, 'Console V2 Cancel Dry Run Sender', 'Console V2 Cancel Dry Run Sender', 'active');

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    status,
    access_scope_type,
    access_scope_id
  )
  VALUES (
    v_ops,
    v_org,
    'console-v2-cancel-dry-run-' || left(v_ops::text, 8) || '@example.test',
    'Console V2 Cancel Dry Run',
    'ops_admin',
    'active',
    'tenant',
    NULL
  );

  PERFORM public.upsert_settings_value_v1(
    'shipment_operation_policy',
    'tenant',
    v_org,
    jsonb_build_object(
      'version', 1,
      'delete', jsonb_build_object(
        'allowed_statuses', jsonb_build_array('pending'),
        'mode', 'soft_cancel',
        'window_hours', 24,
        'workflow_template_name', 'shipment_delete_v1'
      )
    ),
    1,
    'console v2 cancel dry-run no-mutation contract'
  );

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    tracking_number,
    client_reference_number,
    service_type,
    status,
    created_at,
    updated_at
  )
  VALUES (
    v_shipment,
    v_org,
    v_client,
    v_sender,
    'PGTAP-CANCEL-DRY-RUN-' || left(v_shipment::text, 8),
    'PGTAP-CANCEL-DRY-RUN-' || left(v_shipment::text, 8),
    'delivery',
    'pending',
    now(),
    now()
  );

  SELECT COUNT(*)::INT
    INTO v_before_runs
    FROM public.workflow_runs
   WHERE context->>'shipment_id' = v_shipment::text;

  PERFORM set_config('request.jwt.claim.sub', v_ops::text, TRUE);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', v_ops::text,
      'organization_id', v_org::text,
      'access_scope_type', 'tenant'
    )::text,
    TRUE
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_result := api.shipment_amend_cancel_v1(
    jsonb_build_object(
      'shipment_id', v_shipment::text,
      'operation', 'cancel',
      'surface', 'console',
      'dry_run', TRUE,
      'reason', 'pgtap preview only',
      'idempotency_key', 'pgtap-cancel-dry-run-' || left(v_shipment::text, 8)
    )
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT COUNT(*)::INT
    INTO v_after_runs
    FROM public.workflow_runs
   WHERE context->>'shipment_id' = v_shipment::text;

  RETURN NEXT ok(
    v_result->>'ok' = 'true'
    AND v_result->>'dry_run' = 'true'
    AND v_result->>'operation' = 'cancel',
    'cancel dry-run returns a backend-backed preview result'
  );

  RETURN NEXT ok(
    NOT (v_result ? 'workflow_run_id')
    AND v_result#>>'{operation_result,mutation_suppressed}' = 'true',
    'cancel dry-run suppresses workflow start in its returned contract'
  );

  RETURN NEXT is(
    (SELECT status FROM public.shipments WHERE id = v_shipment AND client_id = v_client),
    'pending',
    'cancel dry-run leaves shipment status unchanged'
  );

  RETURN NEXT is(
    v_after_runs::TEXT,
    v_before_runs::TEXT,
    'cancel dry-run does not create workflow runs for the shipment'
  );

  RETURN NEXT is(
    (
      SELECT COUNT(*)::TEXT
      FROM public.shipment_actions
      WHERE shipment_id = v_shipment
        AND action_type = 'delete'
        AND action_data->>'idempotency_key' = 'pgtap-cancel-dry-run-' || left(v_shipment::text, 8)
    ),
    '0',
    'cancel dry-run does not write shipment delete actions'
  );
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_shipment_cancel_dry_run_no_mutation_v1();

SELECT * FROM finish();

ROLLBACK;
