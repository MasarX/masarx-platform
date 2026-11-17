-- Plan: PLAN-202603-b01-first-batch-execution / Step: S14
-- pgTAP: recurring shipment schedules reuse workflow_templates + workflow_schedule_triggers.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.workflow_templates
     WHERE name = 'recurring_shipment_create_v1'
  ),
  'recurring_shipment_create_v1 template exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.workflow_template_steps wts
      JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
     WHERE wt.name = 'recurring_shipment_create_v1'
       AND wts.sequence_order = 0
       AND wts.handler_key = 'reserve_shipment_identifiers'
  ),
  'recurring shipment template includes reserve_shipment_identifiers'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.workflow_template_steps wts
      JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
     WHERE wt.name = 'recurring_shipment_create_v1'
       AND wts.sequence_order = 1
       AND wts.handler_key = 'shipment_create'
  ),
  'recurring shipment template includes shipment_create'
);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_client_admin UUID := gen_random_uuid();
  v_sender_user UUID := gen_random_uuid();
  v_template UUID;
  v_client_trigger UUID;
  v_sender_trigger UUID := gen_random_uuid();
  v_client_context JSONB;
  v_sender_context JSONB;
  v_manual_context JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT id
    INTO v_template
    FROM public.workflow_templates
   WHERE name = 'recurring_shipment_create_v1'
   LIMIT 1;

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Recurring Shipment Org', 'recurring-shipment-org-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (
    v_client,
    v_org,
    'Recurring Shipment Client',
    'recurring-shipment-client-' || left(v_client::text, 8),
    'active'
  );

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'Recurring Shipment Sender', 'active');

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    access_scope_type,
    access_scope_id
  )
  VALUES
    (
      v_client_admin,
      v_org,
      'recurring-shipment-client-admin-' || left(v_client_admin::text, 8) || '@example.com',
      'Recurring Shipment Client Admin',
      'client_admin',
      'client',
      v_client
    ),
    (
      v_sender_user,
      v_org,
      'recurring-shipment-sender-user-' || left(v_sender_user::text, 8) || '@example.com',
      'Recurring Shipment Sender User',
      'sender_user',
      'sender',
      v_sender
    );

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_client_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT (
    public.ui_create_workflow_schedule_trigger_v1(
      v_template,
      jsonb_build_object('type', 'interval', 'interval_seconds', 3600, 'timezone', 'UTC'),
      '{}'::jsonb,
      TRUE,
      'Recurring shipment pgTAP'::text
    )->>'workflow_schedule_trigger_id'
  )::uuid INTO v_client_trigger;

  PERFORM ok(v_client_trigger IS NOT NULL, 'client_admin can create recurring shipment schedule');

  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT public.build_workflow_schedule_trigger_context_v1(
           wst,
           'worker',
           NULL::uuid,
           wst.next_run_at,
           NULL::uuid
         )
    INTO v_client_context
    FROM public.workflow_schedule_triggers wst
   WHERE wst.id = v_client_trigger;

  PERFORM is(v_client_context->>'client_id', v_client::text, 'client scope auto-fills client_id');
  PERFORM ok(
    v_client_context->>'idempotency_key' = public.workflow_schedule_trigger_run_key_v1(v_client_trigger, (SELECT next_run_at FROM public.workflow_schedule_triggers WHERE id = v_client_trigger)),
    'automatic schedule context includes deterministic idempotency key'
  );

  INSERT INTO public.workflow_schedule_triggers (
    id,
    organization_id,
    scope_type,
    scope_id,
    workflow_template_id,
    schedule,
    context_patch,
    enabled,
    next_run_at,
    created_at,
    updated_at
  )
  VALUES (
    v_sender_trigger,
    v_org,
    'sender',
    v_sender,
    v_template,
    jsonb_build_object('type', 'interval', 'interval_seconds', 3600, 'timezone', 'UTC'),
    '{}'::jsonb,
    TRUE,
    public.workflow_now(),
    now(),
    now()
  );

  SELECT public.build_workflow_schedule_trigger_context_v1(
           wst,
           'manual',
           NULL::uuid,
           NULL::timestamptz,
           v_client_admin
         )
    INTO v_manual_context
    FROM public.workflow_schedule_triggers wst
   WHERE wst.id = v_client_trigger;

  SELECT public.build_workflow_schedule_trigger_context_v1(
           wst,
           'worker',
           NULL::uuid,
           wst.next_run_at,
           NULL::uuid
         )
    INTO v_sender_context
    FROM public.workflow_schedule_triggers wst
   WHERE wst.id = v_sender_trigger;

  PERFORM ok(
    v_manual_context->>'idempotency_key' IS NULL,
    'manual schedule runs do not pin automatic idempotency keys'
  );

  PERFORM ok(
    v_sender_context->>'sender_id' = v_sender::text
    AND v_sender_context->>'client_id' = v_client::text
    AND v_sender_context->>'tracking_scope_type' = 'sender',
    'sender scope auto-fills sender_id, client_id, and tracking scope'
  );

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_sender_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM throws_ok(
    format(
      $sql$ SELECT public.ui_run_workflow_schedule_trigger_v1('%s'::uuid); $sql$,
      v_client_trigger
    ),
    '42501',
    'Capability denied: workflow_runs.write'
  );

  EXECUTE 'RESET ROLE';
END $$;

SELECT * FROM finish();
ROLLBACK;
