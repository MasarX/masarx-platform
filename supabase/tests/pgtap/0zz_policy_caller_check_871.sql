BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;

SELECT plan(220);

CREATE FUNCTION pg_temp.check_policy_callers() RETURNS SETOF TEXT
LANGUAGE plpgsql AS $test$
DECLARE
  v_actor UUID := gen_random_uuid();
  v_org UUID := gen_random_uuid();
  v_other_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_provider UUID := gen_random_uuid();
  v_own JSONB := jsonb_build_object('organization_id', v_org);
  v_other JSONB := jsonb_build_object('organization_id', v_other_org);
  v_endpoint RECORD;
  v_scope RECORD;
  v_sql TEXT;
  v_denial CONSTANT TEXT := 'Policy context is outside the permitted organization scope';
  v_authenticated_claims TEXT := jsonb_build_object('sub', v_actor, 'role', 'authenticated')::text;
  v_service_claims TEXT := jsonb_build_object('sub', v_actor, 'role', 'service_role')::text;
BEGIN
  INSERT INTO public.organizations(id, name, slug, billing_status) VALUES
    (v_org, 'Policy fixture', 'policy-' || v_org, 'active'),
    (v_other_org, 'Policy fixture', 'policy-' || v_other_org, 'active');
  INSERT INTO public.clients(id, organization_id, name, slug, status)
    VALUES (v_client, v_other_org, 'Policy fixture', 'policy-' || v_client, 'active');
  INSERT INTO public.senders(id, client_id, name, status)
    VALUES (v_sender, v_client, 'Policy fixture', 'active');
  INSERT INTO public.branches(id, organization_id, code, name, is_active)
    VALUES (v_branch, v_other_org, 'policy-' || left(v_branch::text, 8), 'Policy fixture', TRUE);
  INSERT INTO public.providers(id, organization_id, name, provider_type, enabled)
    VALUES (v_provider, v_other_org, 'Policy fixture', 'delivery', TRUE);
  INSERT INTO public.users(id, organization_id, email, full_name, user_type, status, access_scope_type)
    VALUES (v_actor, v_org, 'policy-' || v_actor || '@example.test', 'Policy fixture', 'ops_admin', 'active', 'tenant');

  FOR v_endpoint IN
    SELECT name, format('SELECT * FROM api.%I(%%L::jsonb)', name) AS query, TRUE AS api_role
    FROM (VALUES
      ('resolve_address_policy'), ('resolve_communication_policy'), ('resolve_device_policy'),
      ('resolve_driver_safety_policy'), ('resolve_location_tracking_policy'), ('resolve_mobile_attestation_policy'),
      ('resolve_mobile_diagnostics_policy'), ('resolve_mobile_push_policy'), ('resolve_mobile_visibility_policy'),
      ('resolve_navigation_policy'), ('resolve_scan_policy'), ('resolve_ux_safety_policy'),
      ('resolve_mobile_sync_policy'), ('resolve_pod_policy'), ('resolve_mobile_shell_policy'), ('resolve_map_policy'),
      ('marketplace_policy_v1'), ('marketplace_request_policy_v1'), ('marketplace_visibility_policy_v1'),
      ('marketplace_execution_policy_v1'), ('marketplace_settlement_policy_v1'), ('marketplace_reputation_policy_v1'),
      ('marketplace_tracking_display_policy_v1'), ('marketplace_compliance_policy_v1'), ('resolve_tabular_import_policy_v1')
    ) AS wrappers(name)
    UNION ALL SELECT * FROM (VALUES
      ('resolve_mobile_shell_policy_row', 'SELECT * FROM public.resolve_mobile_shell_policy_row(%L::jsonb)', TRUE),
      ('marketplace_request_kind_catalog_v1', 'SELECT * FROM api.marketplace_request_kind_catalog_v1(%L::jsonb, TRUE)', TRUE),
      ('marketplace_policy_lookup_v1', 'SELECT * FROM public.marketplace_policy_lookup_v1(''marketplace_policy'', %L::jsonb)', TRUE),
      ('resolve_pricing_policy', 'SELECT * FROM public.resolve_pricing_policy(%L::jsonb)', FALSE),
      ('resolve_shipment_operation_policy_v1', 'SELECT public.resolve_shipment_operation_policy_v1(%L::jsonb)', FALSE),
      ('resolve_settings_row_from_context', 'SELECT * FROM public.resolve_settings_row_from_context(''tabular_import_policy'', %L::jsonb)', FALSE),
      ('resolve_settings_row_from_policy_context_v1', 'SELECT * FROM public.resolve_settings_row_from_policy_context_v1(''pricing_policy'', %L::jsonb)', FALSE)
    ) AS additional(name, query, api_role)
  LOOP
    PERFORM set_config('request.jwt.claim.sub', v_actor::text, TRUE);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
    PERFORM set_config('request.jwt.claims', v_authenticated_claims, TRUE);
    IF v_endpoint.api_role THEN
      EXECUTE 'SET LOCAL ROLE authenticated';
    END IF;

    FOR v_scope IN
      SELECT * FROM (VALUES
        ('organization', v_other),
        ('client', jsonb_build_object('client_id', v_client)),
        ('sender', jsonb_build_object('sender_id', v_sender)),
        ('resource', jsonb_build_object('resource_id', v_branch))
      ) AS inputs(label, context)
    LOOP
      RETURN NEXT throws_ok(format(v_endpoint.query, v_scope.context), '42501', v_denial,
        format('%s checks the %s scope', v_endpoint.name, v_scope.label));
    END LOOP;
    RETURN NEXT lives_ok(format(v_endpoint.query, v_own), format('%s accepts the caller scope', v_endpoint.name));

    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
    PERFORM set_config('request.jwt.claims', v_service_claims, TRUE);
    IF v_endpoint.api_role THEN
      EXECUTE 'SET LOCAL ROLE service_role';
    END IF;
    RETURN NEXT lives_ok(format(v_endpoint.query, v_other), format('%s accepts the service scope', v_endpoint.name));
    EXECUTE 'RESET ROLE';
  END LOOP;

  FOR v_endpoint IN
    SELECT * FROM (VALUES ('api'), ('public')) AS schemas(schema_name)
    CROSS JOIN (VALUES ('v1'), ('v2')) AS versions(version_name)
  LOOP
    PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
    PERFORM set_config('request.jwt.claims', v_authenticated_claims, TRUE);
    EXECUTE 'SET LOCAL ROLE authenticated';
    FOR v_scope IN
      SELECT * FROM (VALUES
        ('organization', v_other_org, NULL::uuid, NULL::uuid),
        ('client', v_org, v_client, NULL::uuid),
        ('sender', v_org, NULL::uuid, v_sender),
        ('caller', v_org, NULL::uuid, NULL::uuid),
        ('service', v_other_org, v_client, v_sender)
      ) AS inputs(label, org_id, client_id, sender_id)
    LOOP
      IF v_endpoint.version_name = 'v1' THEN
        v_sql := format('SELECT %I.resolve_ndr_branch_next_action_v1(%L::uuid, %L::uuid, %L::uuid)',
          v_endpoint.schema_name, v_scope.org_id, v_scope.client_id, v_scope.sender_id);
      ELSE
        v_sql := format('SELECT %I.resolve_ndr_branch_next_action_v2(%L::jsonb)', v_endpoint.schema_name,
          jsonb_strip_nulls(jsonb_build_object('organization_id', v_scope.org_id,
            'client_id', v_scope.client_id, 'sender_id', v_scope.sender_id)));
      END IF;

      IF v_scope.label = 'service' THEN
        EXECUTE 'RESET ROLE';
        PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
        PERFORM set_config('request.jwt.claims', v_service_claims, TRUE);
        EXECUTE 'SET LOCAL ROLE service_role';
      END IF;
      IF v_scope.label IN ('caller', 'service') THEN
        RETURN NEXT lives_ok(v_sql, format('%s next action %s accepts the %s scope',
          v_endpoint.schema_name, v_endpoint.version_name, v_scope.label));
      ELSE
        RETURN NEXT throws_ok(v_sql, '42501', v_denial, format('%s next action %s checks the %s scope',
          v_endpoint.schema_name, v_endpoint.version_name, v_scope.label));
      END IF;
    END LOOP;
    EXECUTE 'RESET ROLE';
  END LOOP;

  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config('request.jwt.claims', v_authenticated_claims, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  FOR v_scope IN
    SELECT * FROM (VALUES ('client_id', v_client), ('sender_id', v_sender), ('resource_id', v_branch)) AS inputs(key, id)
  LOOP
    RETURN NEXT throws_ok(format('SELECT api.resolve_mobile_shell_policy(''driver'', %L::jsonb)',
      jsonb_build_object(v_scope.key, v_scope.id)), '42501', v_denial, 'Shell checks the ' || v_scope.key || ' scope');
  END LOOP;
  RETURN NEXT lives_ok(format('SELECT api.resolve_mobile_shell_policy(''driver'', %L::jsonb)', v_own),
    'Shell accepts the caller scope');
  RETURN NEXT ok(
    (api.resolve_mobile_shell_policy('driver', v_other) -> 'scope_path') @>
      jsonb_build_array(jsonb_build_object('scope_type', 'tenant', 'scope_id', v_org)),
    'Shell applies the active organization');
  RETURN NEXT throws_ok(format('SELECT * FROM api.resolve_tabular_import_policy_v1(%L::jsonb)',
    jsonb_build_object('organizationId', v_other_org)), '42501', v_denial, 'Tabular policy checks registry context keys');
  RETURN NEXT throws_ok(format('SELECT * FROM api.resolve_tabular_import_policy_v1(%L::jsonb)',
    jsonb_build_object('providerId', v_provider)), '42501', v_denial, 'Tabular policy checks the registered resource scope');

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
  PERFORM set_config('request.jwt.claims', v_service_claims, TRUE);
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT lives_ok(format('SELECT api.resolve_mobile_shell_policy(''driver'', %L::jsonb)', v_own),
    'Shell accepts the service scope');
  EXECUTE 'RESET ROLE';
END;
$test$;

SELECT * FROM pg_temp.check_policy_callers();
SELECT * FROM finish();
ROLLBACK;
