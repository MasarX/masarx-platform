-- pgTAP: Decision log contract + observability view coverage
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

SELECT plan(6);

DO $$
DECLARE
  v_org UUID;
  v_context UUID;
  v_webhook_decision UUID;
  v_webhook_resource UUID;
  v_handler_decision UUID;
  v_handler_resource UUID;
  v_outbound_decision UUID;
  v_outbound_resource UUID;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT id
  INTO v_org
  FROM organizations
  ORDER BY created_at
  LIMIT 1;

  IF v_org IS NULL THEN
    INSERT INTO organizations (id, name, slug)
    VALUES (
      gen_random_uuid(),
      'Observability Test Org',
      'observability-' || left(gen_random_uuid()::text, 8)
    )
    RETURNING id INTO v_org;
  END IF;

  INSERT INTO request_contexts (id, entry_point)
  VALUES (gen_random_uuid(), 'webhook')
  RETURNING id INTO v_context;

  v_webhook_resource := gen_random_uuid();
  SELECT log_decision(
      v_org,
      'http_response_emitted',
      'webhook_inbox',
      v_webhook_resource,
      'observability-webhook',
      'response_sent',
      'webhook_orchestrator',
      v_context,
      jsonb_build_object(
        'status', 202,
        'mode', 'accepted_async',
        'validation_results', jsonb_build_object('hmac', jsonb_build_object('status', 'passed'))
      ),
      'Webhook response emitted'
    )
    INTO v_webhook_decision;

  v_handler_resource := gen_random_uuid();
  SELECT log_decision(
      v_org,
      'workflow_handler',
      'workflow_run',
      v_handler_resource,
      'observability-handler',
      'handler_completed',
      'workflow_engine',
      NULL,
      jsonb_build_object(
        'handler_key', 'workflow_control',
        'step_id', gen_random_uuid()
      ),
      'Handler finished without errors'
    )
    INTO v_handler_decision;

  v_outbound_resource := gen_random_uuid();
  SELECT log_decision(
      v_org,
      'outbound_dispatch',
      'outbound_call',
      v_outbound_resource,
      'observability-outbound',
      'queued',
      'outbound_worker',
      NULL,
      jsonb_build_object(
        'request', jsonb_build_object('method', 'POST', 'url', 'https://api.example.com/dispatch'),
        'priority', 'high'
      ),
      'Enqueued outbound HTTP call'
    )
    INTO v_outbound_decision;

  PERFORM ok(
    (SELECT decision_inputs ? 'status'
     FROM decision_log
     WHERE id = v_webhook_decision),
    'Webhook decision captures HTTP response metadata'
  );

  PERFORM ok(
    (SELECT decision_inputs ? 'handler_key'
     FROM decision_log
     WHERE id = v_handler_decision),
    'Handler decision stores handler metadata in decision_inputs'
  );

  PERFORM ok(
    (SELECT decision_inputs ? 'request'
     FROM decision_log
     WHERE id = v_outbound_decision),
    'Outbound decision stores HTTP request context'
  );

  PERFORM is(
    (SELECT status
     FROM observability_events_v
     WHERE event_source = 'webhook_http_response'
       AND resource_id = v_webhook_resource
     ORDER BY event_time DESC
     LIMIT 1),
    'response_sent',
    'Observability view surfaces webhook ACK decisions'
  );

  PERFORM is(
    (SELECT status
     FROM observability_events_v
     WHERE event_type = 'workflow_handler'
       AND resource_id = v_handler_resource
       AND metadata->>'decision_point' = 'observability-handler'
     ORDER BY event_time DESC
     LIMIT 1),
    'handler_completed',
    'Observability view surfaces workflow handler decisions'
  );

  PERFORM is(
    (SELECT status
     FROM observability_events_v
     WHERE event_type = 'outbound_dispatch'
       AND resource_id = v_outbound_resource
       AND metadata->>'decision_point' = 'observability-outbound'
     ORDER BY event_time DESC
     LIMIT 1),
    'queued',
    'Observability view surfaces outbound dispatch decisions'
  );
END;
$$;

SELECT finish();

ROLLBACK;
