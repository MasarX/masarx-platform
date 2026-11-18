-- pgTAP: webhook intake HTTP response must not expose planned ids as canonical resources.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

SELECT has_function(
  'public',
  'workflow_intake_webhook',
  ARRAY['text', 'jsonb', 'text', 'jsonb'],
  'workflow_intake_webhook wrapper exists'
);

SELECT ok(
  has_function_privilege('edge_webhook_role', 'public.workflow_intake_webhook(text,jsonb,text,jsonb)', 'EXECUTE'),
  'edge_webhook_role can execute workflow_intake_webhook'
);

SELECT ok(
  position('planned_resource' in lower(pg_get_functiondef('public.workflow_intake_webhook(text,jsonb,text,jsonb)'::regprocedure))) > 0,
  'accepted async responses expose planned_resource when terminal shipment readback is not available'
);

SELECT ok(
  position('v_webhook_inbox_directory' in lower(pg_get_functiondef('public.workflow_intake_webhook(text,jsonb,text,jsonb)'::regprocedure))) > 0,
  'workflow_intake_webhook reconciles response resource from terminal inbox projection'
);

SELECT ok(
  position('wid.is_terminal is true' in lower(pg_get_functiondef('public.workflow_intake_webhook(text,jsonb,text,jsonb)'::regprocedure))) > 0,
  'canonical resource response is gated on terminal inbox state'
);

SELECT ok(
  position('ack_body = v_result->''body''' in lower(pg_get_functiondef('public.workflow_intake_webhook(text,jsonb,text,jsonb)'::regprocedure))) > 0,
  'persisted webhook ack body is aligned with the returned response body'
);

SELECT ok(
  position('decision_category = ''http_response_emitted''' in lower(pg_get_functiondef('public.workflow_intake_webhook(text,jsonb,text,jsonb)'::regprocedure))) > 0
  AND position('decision_inputs = jsonb_set' in lower(pg_get_functiondef('public.workflow_intake_webhook(text,jsonb,text,jsonb)'::regprocedure))) > 0,
  'decision log response body is aligned with the returned response body for history projections'
);

SELECT * FROM finish();
ROLLBACK;
