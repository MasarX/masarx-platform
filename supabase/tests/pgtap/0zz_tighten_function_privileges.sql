BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(52);

SELECT ok(NOT EXISTS (
  SELECT 1
  FROM aclexplode(COALESCE(proc.proacl, acldefault('f', proc.proowner))) AS acl
  WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
), 'tighten function privileges')
FROM pg_proc AS proc
WHERE proc.oid IN (
  'public.worker_action_call_supplier_api(uuid,jsonb,jsonb)'::regprocedure,
  'public.enqueue_outbound_call_from_operation_template_v1(uuid,jsonb,jsonb,uuid,integer,integer,text)'::regprocedure,
  'public.build_outbound_call_dispatch_from_operation_template_v1(uuid,jsonb,jsonb,jsonb,text)'::regprocedure,
  'public.worker_action_geocode_enrich(uuid,jsonb,jsonb)'::regprocedure,
  'public.get_recent_outbound_calls(integer)'::regprocedure,
  'public.public_tracking_enqueue_recipient_notification_v1(uuid,uuid,uuid,text,text,jsonb)'::regprocedure,
  'public.public_tracking_queue_provider_update_v1(jsonb)'::regprocedure,
  'public.claim_pending_jobs(integer)'::regprocedure,
  'public.requeue_expired_edge_jobs(integer)'::regprocedure,
  'public.ops_maintenance_quarantine_outbound_calls(jsonb)'::regprocedure,
  'public.apply_outbound_call_failover_v1(uuid,jsonb,text,uuid)'::regprocedure,
  'public.record_outbound_call_provider_failure_v1(uuid,integer,text,text,uuid)'::regprocedure,
  'public.finalize_outbound_workflow_step_v1(uuid,text)'::regprocedure
);

SELECT is(has_function_privilege(role_name, signature, 'EXECUTE'),
          role_name = 'service_role',
          'tighten function privileges')
FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS roles(role_name)
CROSS JOIN (VALUES
  ('public.worker_action_call_supplier_api(uuid,jsonb,jsonb)'),
  ('public.enqueue_outbound_call_from_operation_template_v1(uuid,jsonb,jsonb,uuid,integer,integer,text)'),
  ('public.build_outbound_call_dispatch_from_operation_template_v1(uuid,jsonb,jsonb,jsonb,text)'),
  ('public.worker_action_geocode_enrich(uuid,jsonb,jsonb)'),
  ('public.get_recent_outbound_calls(integer)'),
  ('public.public_tracking_enqueue_recipient_notification_v1(uuid,uuid,uuid,text,text,jsonb)'),
  ('public.public_tracking_queue_provider_update_v1(jsonb)'),
  ('public.claim_pending_jobs(integer)'),
  ('public.requeue_expired_edge_jobs(integer)'),
  ('public.ops_maintenance_quarantine_outbound_calls(jsonb)'),
  ('public.apply_outbound_call_failover_v1(uuid,jsonb,text,uuid)'),
  ('public.record_outbound_call_provider_failure_v1(uuid,integer,text,text,uuid)'),
  ('public.finalize_outbound_workflow_step_v1(uuid,text)')
) AS functions(signature);

SELECT * FROM finish();
ROLLBACK;
