-- pgTAP: Console V2 access capability request review lifecycle.
-- Proves approver approve/deny actions are backed by a typed RPC, registry
-- read surface, RBAC role/permission/assignment materialization, and audit
-- lineage.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(22);

DO $$
DECLARE
  v_org uuid := '00000000-0000-0000-0000-0000000ac001';
  v_other_org uuid := '00000000-0000-0000-0000-0000000ac002';
  v_ops uuid := '00000000-0000-0000-0000-0000000ac011';
  v_sender uuid := '00000000-0000-0000-0000-0000000ac012';
  v_target uuid := '00000000-0000-0000-0000-0000000ac013';
  v_other_target uuid := '00000000-0000-0000-0000-0000000ac014';
  v_approve_req uuid := '00000000-0000-0000-0000-0000000ac101';
  v_deny_req uuid := '00000000-0000-0000-0000-0000000ac102';
  v_terminal_req uuid := '00000000-0000-0000-0000-0000000ac103';
  v_cross_req uuid := '00000000-0000-0000-0000-0000000ac104';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Access Review Org', 'access-review-org-' || left(v_org::text, 8)),
    (v_other_org, 'Access Review Other Org', 'access-review-other-org-' || left(v_other_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'access-review-ops@example.test', 'Access Review Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'access-review-sender@example.test', 'Access Review Sender', 'sender_user', 'tenant', NULL),
    (v_target, v_org, 'access-review-target@example.test', 'Access Review Target', 'client_admin', 'tenant', NULL),
    (v_other_target, v_other_org, 'access-review-other-target@example.test', 'Access Review Other Target', 'client_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.capability_grant_requests (
    id, organization_id, requested_by, target_user_id,
    capability_key, scope_type, scope_id, reason, status, metadata
  )
  VALUES
    (
      v_approve_req, v_org, v_target, v_target,
      'shipments.write', 'tenant', v_org, 'pgtap approve access request', 'pending',
      jsonb_build_object('duration_hours', 8)
    ),
    (
      v_deny_req, v_org, v_target, v_target,
      'tasks.write', 'tenant', v_org, 'pgtap deny access request', 'pending',
      jsonb_build_object('duration_hours', 4)
    ),
    (
      v_terminal_req, v_org, v_target, v_target,
      'shipments.read', 'tenant', v_org, 'pgtap terminal access request', 'approved',
      jsonb_build_object('duration_hours', 1)
    ),
    (
      v_cross_req, v_org, v_target, v_other_target,
      'finance.read', 'tenant', v_org, 'pgtap cross tenant request', 'pending',
      jsonb_build_object('duration_hours', 1)
    )
  ON CONFLICT (id) DO UPDATE
    SET status = EXCLUDED.status,
        decision_notes = NULL,
        decided_by = NULL,
        decided_at = NULL,
        decision_log_id = NULL,
        settings_resolution_id = NULL,
        metadata = EXCLUDED.metadata;

  PERFORM set_config('test.access_review_org', v_org::text, true);
  PERFORM set_config('test.access_review_ops', v_ops::text, true);
  PERFORM set_config('test.access_review_sender', v_sender::text, true);
  PERFORM set_config('test.access_review_target', v_target::text, true);
  PERFORM set_config('test.access_review_approve_req', v_approve_req::text, true);
  PERFORM set_config('test.access_review_deny_req', v_deny_req::text, true);
  PERFORM set_config('test.access_review_terminal_req', v_terminal_req::text, true);
  PERFORM set_config('test.access_review_cross_req', v_cross_req::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT has_function(
  'public',
  'ui_review_capability_grant_request_v1',
  ARRAY['jsonb'],
  'public.ui_review_capability_grant_request_v1 exists'
);

SELECT has_function(
  'api',
  'ui_review_capability_grant_request_v1',
  ARRAY['jsonb'],
  'api.ui_review_capability_grant_request_v1 exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.ui_review_capability_grant_request_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute public access request review RPC'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.ui_review_capability_grant_request_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute api access request review RPC'
);

SELECT is(
  (
    SELECT resource->>'relation'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'capability_grant_requests'
  ),
  'public.v_capability_grant_request_directory',
  'capability_grant_requests registry reads review directory projection'
);

SELECT is(
  (
    SELECT resource->>'capability_read'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'capability_grant_requests'
  ),
  'access_policy.read',
  'capability_grant_requests registry read gate is access_policy.read'
);

SELECT is(
  (
    SELECT resource->>'capability_write'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'capability_grant_requests'
  ),
  'access_policy.approve',
  'capability_grant_requests registry write gate is access_policy.approve'
);

SELECT is(
  (SELECT reloptions::text FROM pg_class WHERE oid = 'public.v_capability_grant_request_directory'::regclass),
  '{security_invoker=true}',
  'v_capability_grant_request_directory is security_invoker'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.access_review_ops'), true);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1(
       'capability_grant_requests',
       jsonb_build_object('organization_id', current_setting('test.access_review_org')),
       10,
       0,
       NULL::jsonb
     ) $$,
  'capability_grant_requests lists through ui_list_resource_v1'
);

CREATE TEMP TABLE tmp_access_review_approve AS
SELECT public.ui_review_capability_grant_request_v1(jsonb_build_object(
  'request_id', current_setting('test.access_review_approve_req'),
  'decision', 'approved',
  'decision_notes', 'pgtap approved request review'
)) AS body;

SELECT ok(
  (SELECT (body->>'ok')::boolean FROM tmp_access_review_approve),
  'approve review RPC returns ok'
);

SELECT is(
  (SELECT body #>> '{request_readback,status}' FROM tmp_access_review_approve),
  'approved',
  'approve review RPC returns approved persisted readback'
);

RESET ROLE;

SELECT is(
  (SELECT decision_notes FROM public.capability_grant_requests WHERE id = current_setting('test.access_review_approve_req')::uuid),
  'pgtap approved request review',
  'approve review persists decision notes'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.rbac_role_permissions rp
      JOIN public.lookup_values lv ON lv.id = rp.permission_id
     WHERE rp.role_id = (SELECT (body->>'rbac_role_id')::uuid FROM tmp_access_review_approve)
       AND lv.value = 'shipments.write'
  ),
  'approve review materializes RBAC role permission'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.rbac_user_role_assignments a
     WHERE a.id = (SELECT (body->>'rbac_user_role_assignment_id')::uuid FROM tmp_access_review_approve)
       AND a.user_id = current_setting('test.access_review_target')::uuid
       AND a.revoked_at IS NULL
  ),
  'approve review materializes active RBAC user-role assignment'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.access_review_target'), true);
SET LOCAL ROLE authenticated;

SELECT ok(
  public.user_has_permission_v1('shipments.write', current_setting('test.access_review_org')::uuid),
  'approved request grants target user the requested RBAC permission'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', current_setting('test.access_review_ops'), true);
SET LOCAL ROLE authenticated;

CREATE TEMP TABLE tmp_access_review_deny AS
SELECT public.ui_review_capability_grant_request_v1(jsonb_build_object(
  'request_id', current_setting('test.access_review_deny_req'),
  'decision', 'denied',
  'decision_notes', 'pgtap denied request review'
)) AS body;

SELECT is(
  (SELECT body #>> '{request_readback,status}' FROM tmp_access_review_deny),
  'denied',
  'deny review RPC returns denied persisted readback'
);

RESET ROLE;

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.rbac_user_role_assignments a
      JOIN public.rbac_roles r ON r.id = a.role_id
     WHERE a.user_id = current_setting('test.access_review_target')::uuid
       AND r.key = 'access_request_tasks_write'
       AND a.revoked_at IS NULL
  ),
  'deny review does not create RBAC assignment'
);

RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.decision_log dl
     WHERE dl.resource_type = 'capability_grant_request'
       AND dl.resource_id = current_setting('test.access_review_approve_req')::uuid
       AND dl.decision_point = 'ui_review_capability_grant_request_v1'
       AND dl.decision_outcome = 'approved'
  ),
  'approve review writes decision_log lineage'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.domain_events de
     WHERE de.resource_type = 'capability_grant_request'
       AND de.resource_id = current_setting('test.access_review_approve_req')::uuid
       AND de.event_type = 'capability_grant_request.approved'
  ),
  'approve review writes domain event lineage'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.access_review_sender'), true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT public.ui_review_capability_grant_request_v1(jsonb_build_object(
       'request_id', current_setting('test.access_review_terminal_req'),
       'decision', 'denied',
       'decision_notes', 'sender denied'
     )) $$,
  '42501',
  NULL,
  'non-approver cannot review access requests'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', current_setting('test.access_review_ops'), true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT public.ui_review_capability_grant_request_v1(jsonb_build_object(
       'request_id', current_setting('test.access_review_terminal_req'),
       'decision', 'approved',
       'decision_notes', 'cannot re-review'
     )) $$,
  '22023',
  NULL,
  'review RPC fails closed when request is already terminal'
);

SELECT throws_ok(
  $$ SELECT public.ui_review_capability_grant_request_v1(jsonb_build_object(
       'request_id', current_setting('test.access_review_cross_req'),
       'decision', 'approved',
       'decision_notes', 'cross tenant target denied'
     )) $$,
  '42501',
  NULL,
  'review RPC fails closed when target user is outside request organization'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
