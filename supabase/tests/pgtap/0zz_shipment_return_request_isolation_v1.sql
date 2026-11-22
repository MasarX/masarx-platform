BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

CREATE FUNCTION pg_temp.check_shipment_return_request_isolation()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $fixture$
DECLARE
  v_orgs UUID[] := ARRAY[gen_random_uuid(), gen_random_uuid()];
  v_actors UUID[] := ARRAY[gen_random_uuid(), gen_random_uuid()];
  v_shipments UUID[] := ARRAY[gen_random_uuid(), gen_random_uuid()];
  v_runs UUID[] := ARRAY[NULL::UUID, NULL::UUID];
  v_template UUID;
  v_key TEXT := gen_random_uuid()::text;
  v_client UUID;
  v_sender UUID;
  v_other_client UUID := gen_random_uuid();
  v_client_actor UUID := gen_random_uuid();
  v_actor RECORD;
  v_input JSONB;
  v_result JSONB;
  v_first_status TEXT;
  v_replay JSONB;
  v_refused JSONB;
BEGIN
  -- Use the seeded, uniquely named template, with its steps disabled until rollback.
  SELECT id INTO STRICT v_template FROM public.workflow_templates
   WHERE name = 'shipment_return_v1' AND status = 'active' AND scope_type = 'global';
  UPDATE public.workflow_template_steps SET enabled = FALSE
   WHERE workflow_template_id = v_template AND enabled;

  FOR i IN 1..2 LOOP
    v_client := gen_random_uuid();
    v_sender := gen_random_uuid();
    INSERT INTO public.organizations (id, name, slug)
    VALUES (v_orgs[i], 'Return test organization', 'return-test-' || v_orgs[i]);
    INSERT INTO public.clients (id, organization_id, name, slug, status)
    VALUES (v_client, v_orgs[i], 'Return test client', 'return-test-' || v_client, 'active');
    INSERT INTO public.senders (id, client_id, name, brand_name, status)
    VALUES (v_sender, v_client, 'Return test sender', 'Return test sender', 'active');
    INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
    VALUES (v_actors[i], v_orgs[i], v_actors[i] || '@example.test', 'Return test operator', 'ops_admin', 'active', 'tenant');
    INSERT INTO public.shipments (id, organization_id, client_id, sender_id, tracking_number, service_type, status)
    VALUES (v_shipments[i], v_orgs[i], v_client, v_sender, 'RETURN-TEST-' || v_shipments[i], 'delivery', 'delivered');
  END LOOP;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_other_client, v_orgs[1], 'Return test client', 'return-test-' || v_other_client, 'active');
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES (v_client_actor, v_orgs[1], v_client_actor || '@example.test', 'Return test operator', 'ops_admin', 'active', 'client', v_other_client);

  FOR v_actor IN
    SELECT * FROM (VALUES
      (v_actors[2], v_orgs[2], 'tenant', 'cross-tenant'),
      (v_client_actor, v_orgs[1], 'client', 'cross-client')
    ) AS callers(user_id, organization_id, scope_type, boundary)
  LOOP
    PERFORM set_config('request.jwt.claim.sub', v_actor.user_id::text, TRUE);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
    PERFORM set_config('request.jwt.claims', jsonb_build_object(
      'role', 'authenticated', 'sub', v_actor.user_id, 'organization_id', v_actor.organization_id,
      'access_scope_type', v_actor.scope_type
    )::text, TRUE);
    EXECUTE 'SET LOCAL ROLE authenticated';
    RETURN NEXT throws_ok(
      format('SELECT public.shipment_return_request_v1(%L::jsonb)',
        jsonb_build_object('shipment_id', v_shipments[1], 'operation', 'return')),
      '42501',
      format('shipment amend/cancel forbidden or shipment not found: %s', v_shipments[1]),
      v_actor.boundary || ' caller is denied by shipment scope'
    );
    EXECUTE 'RESET ROLE';
    RETURN NEXT is((SELECT COUNT(*) FROM public.workflow_runs
                     WHERE context->>'original_shipment_id' = v_shipments[1]::text),
                   0::bigint, v_actor.boundary || ' refusal creates no workflow run for the target shipment');
  END LOOP;

  FOR i IN 1..2 LOOP
    PERFORM set_config('request.jwt.claim.sub', v_actors[i]::text, TRUE);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
    PERFORM set_config('request.jwt.claims', jsonb_build_object(
      'role', 'authenticated', 'sub', v_actors[i], 'organization_id', v_orgs[i], 'access_scope_type', 'tenant'
    )::text, TRUE);
    v_input := jsonb_build_object('shipment_id', v_shipments[i], 'operation', 'return', 'idempotency_key', v_key);
    EXECUTE 'SET LOCAL ROLE authenticated';
    v_result := api.shipment_return_request_v1(v_input);
    EXECUTE 'RESET ROLE';
    v_runs[i] := (v_result->>'workflow_run_id')::UUID;

    IF i = 1 THEN
      UPDATE public.workflow_runs SET workflow_status = 'failed'
       WHERE id = v_runs[i] AND workflow_template_id = v_template
       RETURNING workflow_status INTO v_first_status;
    END IF;
  END LOOP;

  RETURN NEXT is(v_first_status, 'failed', 'the first tenant has a persisted run with a distinct status');
  RETURN NEXT ok(
    v_runs[1] IS NOT NULL AND v_runs[2] IS NOT NULL AND v_first_status IS NOT NULL
    AND position(v_runs[1]::text IN v_result::text) = 0
    AND position(to_jsonb(v_first_status)::text IN v_result::text) = 0,
    'the second response reveals neither the first tenant run ID nor its status'
  );
  RETURN NEXT ok(
    v_result->>'ok' = 'true' AND NOT (v_result ? 'already_processed')
    AND EXISTS (
      SELECT 1 FROM public.workflow_runs
       WHERE id = v_runs[2] AND workflow_template_id = v_template
         AND context->>'original_shipment_id' = v_shipments[2]::text
         AND context->>'organization_id' = v_orgs[2]::text
         AND workflow_status = v_result->>'workflow_status'
    ),
    'the second tenant creates and reads its own run when both use the same key'
  );

  UPDATE public.workflow_runs SET workflow_status = 'in_progress', completed_at = NULL
   WHERE id = v_runs[2];
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_replay := api.shipment_return_request_v1(v_input);
  v_refused := api.shipment_return_request_v1(v_input || jsonb_build_object('idempotency_key', gen_random_uuid()));
  EXECUTE 'RESET ROLE';

  RETURN NEXT ok(
    v_replay->>'ok' = 'true' AND v_replay->>'already_processed' = 'true'
    AND (v_replay->>'workflow_run_id')::UUID = v_runs[2] AND v_replay->>'workflow_status' = 'in_progress',
    'the same shipment and key replay the open run'
  );
  RETURN NEXT ok(
    v_refused->>'ok' = 'false' AND v_refused#>>'{error,code}' = 'shipment_return_already_open'
    AND NOT (v_refused ? 'workflow_run_id'),
    'a new key is refused while a return for the same shipment is open'
  );
  RETURN NEXT is((SELECT COUNT(*) FROM public.workflow_runs
                   WHERE workflow_template_id = v_template
                     AND context->>'original_shipment_id' = v_shipments[2]::text
                     AND context->>'organization_id' = v_orgs[2]::text),
                 1::bigint, 'replay and rejection create no additional workflow run');
END;
$fixture$;

SELECT * FROM pg_temp.check_shipment_return_request_isolation();
SELECT * FROM finish();
ROLLBACK;
