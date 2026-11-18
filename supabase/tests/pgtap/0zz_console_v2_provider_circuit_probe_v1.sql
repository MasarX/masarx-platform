-- pgTAP: Console V2 Provider Health selected recovery probe action.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

CREATE OR REPLACE FUNCTION pg_temp.test_provider_circuit_probe_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org uuid := '00000000-0000-0000-0000-000096241001';
  v_other_org uuid := '00000000-0000-0000-0000-000096241002';
  v_ops uuid := '00000000-0000-0000-0000-000096241011';
  v_denied uuid := '00000000-0000-0000-0000-000096241012';
  v_cross_tenant_ops uuid := '00000000-0000-0000-0000-000096241013';
  v_provider uuid := '00000000-0000-0000-0000-000096241021';
  v_circuit uuid := '00000000-0000-0000-0000-000096241031';
  v_result jsonb;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Console V2 Provider Circuit Probe Org', 'console-v2-provider-circuit-probe'),
    (v_other_org, 'Console V2 Provider Circuit Probe Other Org', 'console-v2-provider-circuit-probe-other')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES
    (
      v_ops,
      v_org,
      'console-provider-circuit-probe-ops@example.com',
      'Provider Circuit Probe Ops',
      'ops_admin',
      'active',
      'tenant',
      NULL
    ),
    (
      v_denied,
      v_org,
      'console-provider-circuit-probe-driver@example.com',
      'Provider Circuit Probe Driver',
      'driver',
      'active',
      'tenant',
      NULL
    ),
    (
      v_cross_tenant_ops,
      v_other_org,
      'console-provider-circuit-probe-cross-tenant@example.com',
      'Provider Circuit Probe Cross Tenant Ops',
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

  INSERT INTO public.providers (id, organization_id, name, provider_type, enabled, health_status)
  VALUES (
    v_provider,
    v_org,
    'Console V2 Provider Circuit Probe Provider',
    'webhook',
    TRUE,
    'degraded'
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         health_status = EXCLUDED.health_status,
         updated_at = now();

  INSERT INTO public.circuit_breaker_state (
    id,
    provider_id,
    operation_name,
    state,
    failure_count,
    success_count,
    opened_at,
    half_open_test_at,
    manual_intervention_required,
    updated_at
  ) VALUES (
    v_circuit,
    v_provider,
    'forward_event',
    'half_open',
    3,
    0,
    now() - interval '5 minutes',
    now() - interval '1 minute',
    TRUE,
    now() - interval '5 minutes'
  )
  ON CONFLICT (id) DO UPDATE
     SET state = EXCLUDED.state,
         failure_count = EXCLUDED.failure_count,
         success_count = EXCLUDED.success_count,
         opened_at = EXCLUDED.opened_at,
         half_open_test_at = EXCLUDED.half_open_test_at,
         manual_intervention_required = EXCLUDED.manual_intervention_required,
         updated_at = EXCLUDED.updated_at;

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', v_ops::text,
      'organization_id', v_org::text,
      'access_scope_type', 'tenant'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_result := api.ui_execute_provider_circuit_probe_v1(jsonb_build_object(
    'provider_id', v_provider,
    'operation_name', 'forward_event',
    'reason', 'pgtap provider circuit probe'
  ));

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    COALESCE((v_result->>'ok')::boolean, FALSE)
    AND v_result->>'state' = 'closed'
    AND v_result->>'health_status' = 'healthy'
    AND NULLIF(v_result->>'decision_log_id', '') IS NOT NULL
    AND NULLIF(v_result->>'correlation_id', '') IS NOT NULL,
    'api.ui_execute_provider_circuit_probe_v1 returns backend probe evidence'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.circuit_breaker_state cbs
       WHERE cbs.id = v_circuit
         AND cbs.state = 'closed'
         AND cbs.failure_count = 0
         AND cbs.success_count = 1
         AND cbs.opened_at IS NULL
         AND cbs.half_open_test_at IS NULL
         AND cbs.manual_intervention_required = FALSE
    ),
    'provider circuit probe closes half-open breaker and clears probe state'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.providers p
       WHERE p.id = v_provider
         AND p.health_status = 'healthy'
    ),
    'provider circuit probe marks provider healthy for readback'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.provider_health_logs phl
       WHERE phl.provider_id = v_provider
         AND phl.organization_id = v_org
         AND phl.status = 'healthy'
         AND phl.metadata->>'new_state' = 'closed'
    ),
    'provider circuit probe emits healthy provider health log through trigger'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.decision_log dl
       WHERE dl.id = (v_result->>'decision_log_id')::uuid
         AND dl.organization_id = v_org
         AND dl.decision_category = 'circuit_breaker'
         AND dl.resource_type = 'circuit_breaker_state'
         AND dl.resource_id = v_circuit
         AND dl.decision_point = 'recovery_probe'
         AND dl.decision_outcome = 'recovered'
         AND dl.decision_reason = 'pgtap provider circuit probe'
    ),
    'provider circuit probe writes operator decision log'
  );

  UPDATE public.providers
     SET health_status = 'degraded'
   WHERE id = v_provider;
  UPDATE public.circuit_breaker_state
     SET state = 'open',
         failure_count = 4,
         success_count = 0,
         opened_at = now(),
         half_open_test_at = now() + interval '10 minutes',
         manual_intervention_required = TRUE,
         updated_at = now()
   WHERE id = v_circuit;

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', v_ops::text,
      'organization_id', v_org::text,
      'access_scope_type', 'tenant'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format(
      $$ SELECT api.ui_execute_provider_circuit_probe_v1(jsonb_build_object(
           'provider_id', %L,
           'operation_name', 'forward_event',
           'reason', 'open circuit probe'
         )) $$,
      v_provider::text
    ),
    '22023',
    NULL,
    'provider circuit probe fails closed unless the selected circuit is half-open'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  UPDATE public.circuit_breaker_state
     SET state = 'half_open',
         failure_count = 3,
         success_count = 0,
         opened_at = now(),
         half_open_test_at = now() - interval '1 minute',
         manual_intervention_required = TRUE,
         updated_at = now()
   WHERE id = v_circuit;

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', v_denied::text,
      'organization_id', v_org::text,
      'access_scope_type', 'tenant'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format(
      $$ SELECT api.ui_execute_provider_circuit_probe_v1(jsonb_build_object(
           'provider_id', %L,
           'operation_name', 'forward_event',
           'reason', 'denied probe'
         )) $$,
      v_provider::text
    ),
    '42501',
    NULL,
    'user without integration write permission cannot probe provider circuit'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', v_cross_tenant_ops::text,
      'organization_id', v_other_org::text,
      'access_scope_type', 'tenant'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format(
      $$ SELECT api.ui_execute_provider_circuit_probe_v1(jsonb_build_object(
           'provider_id', %L,
           'operation_name', 'forward_event',
           'reason', 'cross tenant probe'
         )) $$,
      v_provider::text
    ),
    '42501',
    NULL,
    'tenant operator cannot probe another tenant provider circuit'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.circuit_breaker_state cbs
       WHERE cbs.id = v_circuit
         AND cbs.state = 'half_open'
         AND cbs.failure_count = 3
         AND cbs.manual_intervention_required = TRUE
    ),
    'denied provider circuit probe leaves breaker unchanged'
  );
END;
$function$;

SELECT * FROM pg_temp.test_provider_circuit_probe_v1();

SELECT * FROM finish();
ROLLBACK;
