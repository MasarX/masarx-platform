BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(38);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.operation_handlers
    WHERE handler_key = 'shipment_reschedule'
      AND handler_schema = 'workflow_handlers'
      AND handler_name = 'execute_shipment_reschedule_v1'
      AND is_active = TRUE
  ),
  'shipment_reschedule handler is registered and active'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.workflow_templates
    WHERE name = 'shipment_reschedule_v1'
      AND status = 'active'
  ),
  'shipment_reschedule_v1 template exists and is active'
);

SELECT is(
  (
    SELECT COUNT(*)
    FROM public.workflow_template_steps wts
    JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
    WHERE wt.name = 'shipment_reschedule_v1'
      AND wts.enabled = TRUE
  )::INT,
  2,
  'shipment_reschedule_v1 has the expected two enabled steps'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.workflow_template_steps wts
    JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
    WHERE wt.name = 'shipment_reschedule_v1'
      AND wts.sequence_order = 10
      AND wts.handler_key = 'shipment_reschedule'
  ),
  'shipment_reschedule_v1 routes its execute step through shipment_reschedule'
);

SELECT matches(
  pg_get_functiondef('public.shipment_amend_cancel_execute_v1(jsonb)'::regprocedure),
  'shipment_amend_cancel_execute_base_v1',
  'shipment_amend_cancel_execute_v1 delegates to the canonical workflow executor base'
);

SELECT ok(
  strpos(
    lower(pg_get_functiondef('public.shipment_amend_cancel_execute_base_v1(jsonb)'::regprocedure)),
    'start_workflow_run'
  ) > 0
  AND strpos(
    lower(pg_get_functiondef('public.shipment_amend_cancel_execute_base_v1(jsonb)'::regprocedure)),
    'progress_workflow_run'
  ) > 0,
  'shipment_amend_cancel_execute_base_v1 starts and progresses the canonical workflow run entrypoint'
);

SELECT matches(
  pg_get_functiondef('public.shipment_amend_cancel_v1(jsonb)'::regprocedure),
  'resolve_shipment_operation_template_name_v1',
  'shipment_amend_cancel_v1 resolves workflow templates through shipment_operation_policy'
);

SELECT ok(
  strpos(
    lower(pg_get_functiondef('public.shipment_amend_cancel_v1(jsonb)'::regprocedure)),
    'dry_run'
  ) > 0
  AND strpos(
    lower(pg_get_functiondef('public.shipment_amend_cancel_v1(jsonb)'::regprocedure)),
    'shipment_amend_cancel_execute_v1'
  ) > 0,
  'shipment_amend_cancel_v1 keeps dry-run previews outside the canonical executor'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = 'shipment_amend_cancel_execute_v1'
      AND p.oid::regprocedure::text = 'shipment_amend_cancel_execute_v1(jsonb)'
  ),
  'shipment_amend_cancel_execute_v1 internal executor exists'
);

SELECT ok(
  NOT (
    strpos(
      lower(pg_get_functiondef('public.shipment_amend_cancel_execute_v1(jsonb)'::regprocedure)),
      'jsonb_populate_record'
    ) > 0
  ),
  'shipment_amend_cancel_execute_v1 does not fabricate workflow_runs in memory'
);

SELECT ok(
  NOT (
    strpos(
      replace(
        replace(
          replace(
            lower(pg_get_functiondef('public.shipment_amend_cancel_execute_v1(jsonb)'::regprocedure)),
            E'\n',
            ''
          ),
          E'\r',
          ''
        ),
        ' ',
        ''
      ),
      'jsonb_populate_record(null::public.workflow_run_steps'
    ) > 0
  ),
  'shipment_amend_cancel_execute_v1 does not fabricate workflow_run_steps in memory'
);

SELECT ok(
  NOT (
    strpos(
      lower(pg_get_functiondef('public.shipment_amend_cancel_execute_v1(jsonb)'::regprocedure)),
      'execute_shipment_modify_v1'
    ) > 0
    OR strpos(
      lower(pg_get_functiondef('public.shipment_amend_cancel_execute_v1(jsonb)'::regprocedure)),
      'execute_shipment_update_address_v1'
    ) > 0
    OR strpos(
      lower(pg_get_functiondef('public.shipment_amend_cancel_execute_v1(jsonb)'::regprocedure)),
      'execute_shipment_delete_v1'
    ) > 0
  ),
  'shipment_amend_cancel_execute_v1 does not invoke shipment handlers directly'
);

SELECT ok(
  NOT (
    strpos(
      lower(pg_get_functiondef('workflow_handlers.execute_shipment_update_address_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)),
      lower(quote_literal('SA'))
    ) > 0
  ),
  'shipment_update_address_v1 does not hardcode a country default'
);

SELECT is(
  public.shipment_operation_guard_state_v1(
    jsonb_build_object(
      'delete',
      jsonb_build_object(
        'allowed_statuses',
        jsonb_build_array('pending'),
        'window_hours',
        24
      )
    ),
    'cancel',
    'pending',
    now() - interval '48 hours'
  )->>'reason',
  'shipment_delete_window_expired',
  'cancel guard reports expired delete window'
);

SELECT is(
  public.shipment_operation_guard_state_v1(
    jsonb_build_object(
      'delete',
      jsonb_build_object(
        'allowed_statuses',
        jsonb_build_array('pending'),
        'window_hours',
        24
      )
    ),
    'cancel',
    'pending',
    now() - interval '48 hours'
  )->>'allowed',
  'false',
  'cancel guard blocks when delete window has expired'
);

SELECT is(
  public.shipment_operation_guard_state_v1(
    jsonb_build_object(
      'reschedule',
      jsonb_build_object(
        'allowed_statuses',
        jsonb_build_array('pending', 'created')
      )
    ),
    'reschedule',
    'dispatched',
    now()
  )->>'reason',
  'shipment_status_not_allowed',
  'reschedule guard blocks when shipment status is outside policy'
);

SELECT function_privs_are(
  'public',
  'shipment_amend_cancel_v1',
  ARRAY['jsonb'],
  'anon',
  ARRAY[]::text[],
  'shipment_amend_cancel_v1 is not executable by anon'
);

SELECT function_privs_are(
  'public',
  'shipment_amend_cancel_v1',
  ARRAY['jsonb'],
  'authenticated',
  ARRAY['EXECUTE'],
  'shipment_amend_cancel_v1 is executable by authenticated'
);

SELECT has_function(
  'api',
  'shipment_amend_cancel_options_v1',
  ARRAY['uuid'],
  'api.shipment_amend_cancel_options_v1(uuid) exists'
);

SELECT function_privs_are(
  'api',
  'shipment_amend_cancel_options_v1',
  ARRAY['uuid'],
  'authenticated',
  ARRAY['EXECUTE'],
  'api.shipment_amend_cancel_options_v1 is executable by authenticated'
);

SELECT has_function(
  'api',
  'shipment_amend_cancel_v1',
  ARRAY['jsonb'],
  'api.shipment_amend_cancel_v1(jsonb) exists'
);

SELECT function_privs_are(
  'api',
  'shipment_amend_cancel_v1',
  ARRAY['jsonb'],
  'authenticated',
  ARRAY['EXECUTE'],
  'api.shipment_amend_cancel_v1 is executable by authenticated'
);


SELECT matches(
  pg_get_functiondef('public.shipment_amend_cancel_v1(jsonb)'::regprocedure),
  'progress_workflow_run_until_wait_v1',
  'shipment_amend_cancel_v1 reuses the shared inline workflow progress helper'
);

SELECT ok(
  NOT (
    strpos(
      lower(pg_get_functiondef('public.shipment_amend_cancel_v1(jsonb)'::regprocedure)),
      'pg_sleep('
    ) > 0
  ),
  'shipment_amend_cancel_v1 does not maintain a bespoke inline sleep loop'
);

SELECT matches(
  pg_get_functiondef('public.shipment_amend_cancel_v1(jsonb)'::regprocedure),
  'WHEN SQLSTATE ''42501'' THEN[[:space:]]+RAISE;[[:space:]]+WHEN others THEN[[:space:]]+v_inline_error := SQLERRM;',
  'shipment_amend_cancel_v1 propagates authorization denial while retaining nonsecurity inline diagnostics'
);


SELECT matches(
  pg_get_functiondef('public.shipment_amend_cancel_v1(jsonb)'::regprocedure),
  'v_inline_error := NULLIF[(]v_progress->>''error'', ''''[)];',
  'shipment_amend_cancel_v1 retains returned shared-helper error diagnostics'
);

SELECT function_privs_are(
  'public', 'shipment_amend_cancel_options_v1', ARRAY['uuid'], 'anon',
  ARRAY[]::text[],
  'public.shipment_amend_cancel_options_v1 denies anon'
);

SELECT function_privs_are(
  'api', 'shipment_amend_cancel_options_v1', ARRAY['uuid'], 'anon',
  ARRAY[]::text[],
  'api.shipment_amend_cancel_options_v1 denies anon'
);

SELECT function_privs_are(
  'api', 'shipment_amend_cancel_v1', ARRAY['jsonb'], 'anon',
  ARRAY[]::text[],
  'api.shipment_amend_cancel_v1 denies anon'
);

SELECT function_privs_are(
  'public', 'shipment_amend_cancel_options_v1', ARRAY['uuid'], 'service_role',
  ARRAY['EXECUTE'],
  'public.shipment_amend_cancel_options_v1 allows service_role'
);

SELECT function_privs_are(
  'public', 'shipment_amend_cancel_v1', ARRAY['jsonb'], 'service_role',
  ARRAY['EXECUTE'],
  'public.shipment_amend_cancel_v1 allows service_role'
);

SELECT function_privs_are(
  'api', 'shipment_amend_cancel_options_v1', ARRAY['uuid'], 'service_role',
  ARRAY['EXECUTE'],
  'api.shipment_amend_cancel_options_v1 allows service_role'
);

SELECT function_privs_are(
  'api', 'shipment_amend_cancel_v1', ARRAY['jsonb'], 'service_role',
  ARRAY['EXECUTE'],
  'api.shipment_amend_cancel_v1 allows service_role'
);

SELECT function_privs_are(
  'public', 'shipment_amend_cancel_options_v1', ARRAY['uuid'], 'authenticated',
  ARRAY['EXECUTE'],
  'public.shipment_amend_cancel_options_v1 allows authenticated'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    WHERE p.oid = 'public.shipment_amend_cancel_options_v1(uuid)'::regprocedure
      AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  ),
  'public.shipment_amend_cancel_options_v1 denies PUBLIC execute'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    WHERE p.oid = 'public.shipment_amend_cancel_v1(jsonb)'::regprocedure
      AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  ),
  'public.shipment_amend_cancel_v1 denies PUBLIC execute'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    WHERE p.oid = 'api.shipment_amend_cancel_options_v1(uuid)'::regprocedure
      AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  ),
  'api.shipment_amend_cancel_options_v1 denies PUBLIC execute'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    WHERE p.oid = 'api.shipment_amend_cancel_v1(jsonb)'::regprocedure
      AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  ),
  'api.shipment_amend_cancel_v1 denies PUBLIC execute'
);


SELECT * FROM finish();

ROLLBACK;
