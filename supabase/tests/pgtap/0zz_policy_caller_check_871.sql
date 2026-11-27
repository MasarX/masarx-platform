BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;

SELECT plan(243);

CREATE FUNCTION pg_temp.policy_scope_id(p_category TEXT, p_context JSONB) RETURNS UUID
LANGUAGE sql SECURITY DEFINER SET search_path TO public, pg_temp AS $test$
  SELECT scope_id FROM public.resolve_settings_row_from_context(p_category, p_context);
$test$;

CREATE FUNCTION pg_temp.policy_query_error(p_sql_role TEXT, p_sql TEXT) RETURNS TEXT
LANGUAGE plpgsql AS $test$
DECLARE
  v_error TEXT;
BEGIN
  IF p_sql_role IS NOT NULL THEN
    EXECUTE format('SET LOCAL ROLE %I', p_sql_role);
  END IF;
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLSTATE || ': ' || SQLERRM;
  END;
  IF p_sql_role IS NOT NULL THEN
    EXECUTE 'RESET ROLE';
  END IF;
  RETURN v_error;
END;
$test$;

CREATE FUNCTION pg_temp.policy_claim_one_job() RETURNS UUID
LANGUAGE sql SECURITY DEFINER SET search_path TO public, pg_temp AS $test$
  SELECT job_id FROM public.claim_pending_jobs(1);
$test$;

CREATE FUNCTION pg_temp.check_edge_policy_callers(
  p_org UUID, p_client UUID, p_other_client UUID, p_actor UUID
) RETURNS SETOF TEXT
LANGUAGE plpgsql AS $test$
DECLARE
  v_source UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_mapping UUID := gen_random_uuid();
  v_provider UUID := gen_random_uuid();
  v_pack UUID := gen_random_uuid();
  v_version UUID := gen_random_uuid();
  v_template UUID := gen_random_uuid();
  v_template_step UUID := gen_random_uuid();
  v_run UUID := gen_random_uuid();
  v_step UUID := gen_random_uuid();
  v_own_job UUID := gen_random_uuid();
  v_other_job UUID := gen_random_uuid();
  v_token TEXT := gen_random_uuid()::text;
  v_category TEXT := 'fixture_account_' || replace(v_source::text, '-', '');
  v_path TEXT := '/pgtap/policy-account/' || v_source;
  v_value JSONB := '{"company_id":"999999","enabled":true}';
  v_context JSONB := jsonb_build_object('organization_id', p_org, 'client_id', p_client,
    'sender_id', v_sender, 'webhook_source_id', v_source);
  v_claims JSONB := jsonb_build_object('sub', 'edge-function', 'role', 'edge_api_gateway_role', 'aud', 'authenticated');
  v_denial CONSTANT TEXT := '42501: Policy context is outside the permitted organization scope';
  v_result JSONB;
  v_scope_id UUID;
  v_scope_denial TEXT;
  v_job UUID;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', TRUE);
  PERFORM set_config('request.jwt.claim.role', '', TRUE);
  PERFORM set_config('request.jwt.claims', '', TRUE);
  PERFORM public.create_next_partitions();

  INSERT INTO public.senders(id, client_id, name, status)
    VALUES (v_sender, p_client, 'Policy fixture', 'active');
  INSERT INTO public.mapping_configs(id, mapping_type, mapping_key, mapping_config, mapping_version)
    VALUES (v_mapping, 'webhook_inbound', 'policy-' || v_mapping, '{}', 1);
  INSERT INTO public.webhook_sources(id, organization_id, source_identifier, name, provider_type,
    auth_token, mapping_config_id, rate_limit_per_hour, enabled, sender_id)
    VALUES (v_source, p_org, 'policy-' || v_source, 'Policy fixture', 'api_gateway',
      v_token, v_mapping, 1000, TRUE, v_sender);
  INSERT INTO public.providers(id, organization_id, name, provider_type, enabled, metadata)
    VALUES (v_provider, p_org, 'policy-' || v_provider, '3pl', TRUE, '{"base_url":"https://example.test"}');
  INSERT INTO public.api_route_packs(id, name) VALUES (v_pack, 'policy-' || v_pack);
  INSERT INTO public.api_routes(pack_id, route_name, method, path_template, scope_type, scope_id, provider_id, policy)
    VALUES (v_pack, 'policy-fixture', 'POST', v_path, 'source', v_source, v_provider,
      jsonb_build_object('provider_account', jsonb_build_object('category', v_category)));
  INSERT INTO public.settings_versions_p0(id, category, scope_type, scope_id, scope_hash, version, value,
    schema_version, change_reason, approved_at, effective_from)
    VALUES (v_version, v_category, 'tenant', p_org, p_org, 1, v_value, 1, 'Policy fixture', now(), now());
  INSERT INTO public.settings(category, scope_type, scope_id, scope_hash, settings_version_id, cached_value)
    VALUES (v_category, 'tenant', p_org, p_org, v_version, v_value);

  INSERT INTO public.workflow_templates(id, name, version, status, scope_type)
    VALUES (v_template, 'policy-' || v_template, 1, 'active', 'global');
  INSERT INTO public.workflow_template_steps(id, workflow_template_id, sequence_order, operation_name,
    transition_condition, handler_key, handler_version, enabled)
    VALUES (v_template_step, v_template, 1, 'workflow_control', 'always', 'workflow_control', 'v1', TRUE);
  PERFORM set_config('app.workflow_run_id', v_run::text, TRUE);
  INSERT INTO public.workflow_runs(id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context)
    VALUES (v_run, v_template, 1, 'test', 'pending', jsonb_build_object('organization_id', p_org));
  INSERT INTO public.workflow_run_steps(id, workflow_run_id, workflow_template_step_id, sequence_order,
    step_status, operation_name, handler_key, handler_version, max_retries, enqueued_at)
    VALUES (v_step, v_run, v_template_step, 1, 'pending', 'workflow_control', 'workflow_control', 'v1', 1, now());
  PERFORM set_config('app.workflow_run_step_id', v_step::text, TRUE);
  PERFORM set_config('platform.workflow_engine', '1', TRUE);
  PERFORM set_config('platform.workflow_run_step_id', v_step::text, TRUE);

  PERFORM set_config('request.jwt.claim.role', 'edge_api_gateway_role', TRUE);
  PERFORM set_config('request.jwt.claims', v_claims::text, TRUE);
  EXECUTE 'SET LOCAL ROLE edge_api_gateway_role';
  v_scope_id := pg_temp.policy_scope_id(v_category, v_context);
  v_scope_denial := pg_temp.policy_query_error(NULL,
    format('SELECT pg_temp.policy_scope_id(%L, %L::jsonb)', 'tabular_import_policy', v_context));
  v_result := public.workflow_intake_api_gateway_v1(v_token, 'POST', v_path, '', '{}', '{}');
  EXECUTE 'RESET ROLE';
  RETURN NEXT is(v_scope_id::text, p_org::text, 'Gateway resolves the configured account for its source organization');
  RETURN NEXT is(v_scope_denial, v_denial, 'Gateway scope is limited to configured lookups');
  RETURN NEXT is(v_result->>'action', 'proxy', 'Intake accepts the configured account');

  RETURN NEXT is(pg_temp.policy_query_error('authenticated',
    format('SELECT pg_temp.policy_scope_id(%L, %L::jsonb)', v_category, v_context)),
    v_denial, 'Gateway lookup requires the database role');

  PERFORM set_config('request.jwt.claim.role', 'edge_webhook_role', TRUE);
  PERFORM set_config('request.jwt.claims', (v_claims || '{"role":"edge_webhook_role"}')::text, TRUE);
  RETURN NEXT is(pg_temp.policy_query_error('edge_webhook_role',
    format('SELECT pg_temp.policy_scope_id(%L, %L::jsonb)', 'workflow_defaults', v_context)),
    NULL::text, 'Webhook resolves workflow defaults for its source');

  PERFORM set_config('request.jwt.claim.role', 'edge_api_caller_role', TRUE);
  PERFORM set_config('request.jwt.claims', (v_claims || '{"role":"edge_api_caller_role"}')::text, TRUE);
  RETURN NEXT is(pg_temp.policy_query_error('edge_api_caller_role',
    format('SELECT pg_temp.policy_scope_id(%L, %L::jsonb)', 'outbound_retry_policy', v_context)),
    NULL::text, 'API caller resolves retry policy for its work');

  PERFORM set_config('request.jwt.claim.role', '', TRUE);
  PERFORM set_config('request.jwt.claims', '', TRUE);
  INSERT INTO public.outbound_calls(id, call_type, target_type, target_id, method, url, status, priority, scheduled_at)
    VALUES (v_own_job, 'provider_api', 'client', p_client, 'POST', 'https://example.test/own', 'pending', 10000, now()),
           (v_other_job, 'provider_api', 'client', p_other_client, 'POST', 'https://example.test/other', 'pending', 10001, now());
  PERFORM set_config('request.jwt.claim.sub', p_actor::text, TRUE);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', p_actor, 'role', 'authenticated')::text, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_job := pg_temp.policy_claim_one_job();
  EXECUTE 'RESET ROLE';
  RETURN NEXT is(v_job::text, v_own_job::text, 'Inline worker claims a job for the active organization');
  RETURN NEXT ok((SELECT lease_expires_at IS NULL FROM public.outbound_calls WHERE id = v_other_job),
    'Inline worker leaves other organizations available for background work');
END;
$test$;

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
  v_own_client UUID := gen_random_uuid();
  v_own_branch UUID := gen_random_uuid();
  v_run UUID := gen_random_uuid();
  v_stop UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_session TEXT := gen_random_uuid()::text;
  v_result_id UUID;
  v_result JSONB;
  v_profile UUID;
  v_request UUID;
  v_offer UUID;
  v_award UUID;
  v_contract UUID;
  v_package UUID;
  v_own JSONB := jsonb_build_object('organization_id', v_org);
  v_other JSONB := jsonb_build_object('organization_id', v_other_org);
  v_endpoint RECORD;
  v_scope RECORD;
  v_sql TEXT;
  v_sql_role TEXT;
  v_scope_type TEXT;
  v_denial CONSTANT TEXT := '42501: Policy context is outside the permitted organization scope';
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
    v_sql_role := CASE WHEN v_endpoint.api_role THEN 'authenticated' END;

    FOR v_scope IN
      SELECT * FROM (VALUES
        ('organization', v_other),
        ('client', jsonb_build_object('client_id', v_client)),
        ('sender', jsonb_build_object('sender_id', v_sender)),
        ('resource', jsonb_build_object('resource_id', v_branch))
      ) AS inputs(label, context)
    LOOP
      RETURN NEXT is(pg_temp.policy_query_error(v_sql_role, format(v_endpoint.query, v_scope.context)), v_denial,
        format('%s checks the %s scope', v_endpoint.name, v_scope.label));
    END LOOP;
    RETURN NEXT is(pg_temp.policy_query_error(v_sql_role, format(v_endpoint.query, v_own)),
      NULL::text, format('%s accepts the caller scope', v_endpoint.name));

    PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
    PERFORM set_config('request.jwt.claims', v_service_claims, TRUE);
    v_sql_role := CASE WHEN v_endpoint.api_role THEN 'service_role' END;
    RETURN NEXT is(pg_temp.policy_query_error(v_sql_role, format(v_endpoint.query, v_other)),
      NULL::text, format('%s accepts the service scope', v_endpoint.name));
  END LOOP;

  FOR v_endpoint IN
    SELECT * FROM (VALUES ('api'), ('public')) AS schemas(schema_name)
    CROSS JOIN (VALUES ('v1'), ('v2')) AS versions(version_name)
  LOOP
    PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
    PERFORM set_config('request.jwt.claims', v_authenticated_claims, TRUE);
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
        PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
        PERFORM set_config('request.jwt.claims', v_service_claims, TRUE);
      END IF;
      v_sql_role := CASE WHEN v_scope.label = 'service' THEN 'service_role' ELSE 'authenticated' END;
      IF v_scope.label IN ('caller', 'service') THEN
        RETURN NEXT is(pg_temp.policy_query_error(v_sql_role, v_sql), NULL::text, format('%s next action %s accepts the %s scope',
          v_endpoint.schema_name, v_endpoint.version_name, v_scope.label));
      ELSE
        RETURN NEXT is(pg_temp.policy_query_error(v_sql_role, v_sql), v_denial, format('%s next action %s checks the %s scope',
          v_endpoint.schema_name, v_endpoint.version_name, v_scope.label));
      END IF;
    END LOOP;
  END LOOP;

  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config('request.jwt.claims', v_authenticated_claims, TRUE);
  FOR v_scope IN
    SELECT * FROM (VALUES ('client_id', v_client), ('sender_id', v_sender), ('resource_id', v_branch)) AS inputs(key, id)
  LOOP
    RETURN NEXT is(pg_temp.policy_query_error('authenticated', format('SELECT api.resolve_mobile_shell_policy(''driver'', %L::jsonb)',
      jsonb_build_object(v_scope.key, v_scope.id))), v_denial, 'Shell checks the ' || v_scope.key || ' scope');
  END LOOP;
  RETURN NEXT is(pg_temp.policy_query_error('authenticated', format('SELECT api.resolve_mobile_shell_policy(''driver'', %L::jsonb)', v_own)),
    NULL::text, 'Shell accepts the caller scope');
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result := api.resolve_mobile_shell_policy('driver', v_other);
  EXECUTE 'RESET ROLE';
  RETURN NEXT ok(
    (v_result -> 'scope_path') @>
      jsonb_build_array(jsonb_build_object('scope_type', 'tenant', 'scope_id', v_org)),
    'Shell applies the active organization');
  RETURN NEXT is(pg_temp.policy_query_error('authenticated', format('SELECT * FROM api.resolve_tabular_import_policy_v1(%L::jsonb)',
    jsonb_build_object('organizationId', v_other_org))), v_denial, 'Tabular policy checks registry context keys');
  RETURN NEXT is(pg_temp.policy_query_error('authenticated', format('SELECT * FROM api.resolve_tabular_import_policy_v1(%L::jsonb)',
    jsonb_build_object('providerId', v_provider))), v_denial, 'Tabular policy checks the registered resource scope');

  PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
  PERFORM set_config('request.jwt.claims', v_service_claims, TRUE);
  RETURN NEXT is(pg_temp.policy_query_error('service_role', format('SELECT api.resolve_mobile_shell_policy(''driver'', %L::jsonb)', v_own)),
    NULL::text, 'Shell accepts the service scope');

  PERFORM set_config('request.jwt.claims', '', TRUE);
  PERFORM set_config('request.jwt.claim.role', '', TRUE);
  PERFORM set_config('request.jwt.claim.sub', '', TRUE);
  INSERT INTO public.clients(id, organization_id, name, slug, status)
    VALUES (v_own_client, v_org, 'Policy fixture', 'policy-' || v_own_client, 'active');
  INSERT INTO public.branches(id, organization_id, code, name, is_active)
    VALUES (v_own_branch, v_org, 'policy-' || left(v_own_branch::text, 8), 'Policy fixture', TRUE);
  INSERT INTO public.shipments(id, organization_id, client_id, tracking_number, service_type, status)
    VALUES (v_shipment, v_org, v_own_client, 'P-' || left(v_shipment::text, 12), 'delivery', 'out_for_delivery');
  INSERT INTO public.route_runs(id, organization_id, branch_id, status, planned_date)
    VALUES (v_run, v_org, v_own_branch, 'in_progress', CURRENT_DATE);
  INSERT INTO public.route_stops(id, organization_id, route_run_id, client_id, shipment_id, stop_kind, sequence_order)
    VALUES (v_stop, v_org, v_run, v_own_client, v_shipment, 'delivery', 1);
  INSERT INTO public.tracking_sessions(organization_id, client_id, shipment_id, token, expires_at)
    VALUES (v_org, v_own_client, v_shipment, v_session, '2099-01-01T00:00:00Z');

  RETURN NEXT is(pg_temp.policy_query_error('service_role', format('SELECT * FROM api.resolve_device_policy(%L::jsonb)', v_other)),
    NULL::text, 'SQL service session resolves a supplied organization');
  EXECUTE 'SET LOCAL ROLE service_role';
  v_result := api.public_tracking_live_session_v1(jsonb_build_object('session_token', v_session, 'ip_hash', gen_random_uuid()));
  EXECUTE 'RESET ROLE';
  RETURN NEXT is(v_result->>'ok', 'true', 'Tracking resolves the organization of a valid session');

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', 'edge-function', 'role', 'edge_label_renderer_role')::text, TRUE);
  EXECUTE 'SET LOCAL ROLE edge_label_renderer_role';
  v_result_id := public.request_label_generation_target_v1('route', v_run, 'shipping');
  EXECUTE 'RESET ROLE';
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.label_jobs WHERE id = v_result_id AND organization_id = v_org),
    'Renderer resolves a route template with its service subject');

  PERFORM set_config('request.jwt.claims', v_authenticated_claims, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT r.scope_path INTO v_result FROM api.resolve_pod_policy(v_own || jsonb_build_object(
    'resource_type', 'route_stop', 'resource_id', v_stop)) AS r;
  EXECUTE 'RESET ROLE';
  RETURN NEXT ok(v_result @>
    jsonb_build_array(jsonb_build_object('scope_type', 'resource', 'scope_id', v_own_branch)),
    'POD resolves a route stop through its branch');
  RETURN NEXT is(pg_temp.policy_query_error('authenticated', format('SELECT * FROM api.resolve_pod_policy(%L::jsonb)',
    v_other || jsonb_build_object('resource_type', 'route_stop', 'resource_id', v_stop))),
    v_denial, 'POD checks explicit organization with a resolved stop branch');
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT scope_type INTO v_scope_type FROM api.resolve_device_policy(jsonb_build_object('resource_id', 'invalid'));
  EXECUTE 'RESET ROLE';
  RETURN NEXT is(v_scope_type, 'global', 'Device policy uses global scope for a malformed resource');
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT scope_type INTO v_scope_type FROM api.resolve_mobile_shell_policy('[]'::jsonb);
  EXECUTE 'RESET ROLE';
  RETURN NEXT is(v_scope_type, 'global', 'Mobile shell uses global scope for non-object context');
  RETURN NEXT is(pg_temp.policy_query_error('authenticated', format('SELECT * FROM api.resolve_device_policy(%L::jsonb)',
    v_own || jsonb_build_object('actor_id', 'fixture'))), NULL::text, 'Device policy accepts a non-scope actor label');
  RETURN NEXT is(pg_temp.policy_query_error('authenticated', format('SELECT * FROM api.resolve_device_policy(%L::jsonb)',
    jsonb_build_object('organization_id', NULL, 'client_id', v_client))), v_denial,
    'Device policy still checks the client with a null organization');
  RETURN NEXT is(pg_temp.policy_query_error('authenticated', format('SELECT * FROM api.resolve_device_policy(%L::jsonb)',
    jsonb_build_object('organization_id', 'invalid', 'client_id', v_client))), v_denial,
    'Device policy still checks the client with a malformed organization');

  RETURN NEXT ok(public.ensure_task_type_from_catalog_v1(v_other_org, 'route_stop_execute', '{}') IS NOT NULL,
    'System provisioning resolves the bound task organization');
  RETURN NEXT is(public.compute_delivery_attempt_projection_v1(v_org, v_own_client, v_shipment, v_stop,
    'delivered', 'status_update', '{}')->>'outcome', 'delivered', 'Delivery projection resolves the policy for its route record');

  UPDATE public.route_runs SET branch_id = NULL WHERE id = v_run;
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT r.scope_path INTO v_result FROM api.resolve_pod_policy(jsonb_build_object(
    'resource_type', 'route_stop', 'resource_id', v_stop)) AS r;
  EXECUTE 'RESET ROLE';
  RETURN NEXT ok(v_result @>
    jsonb_build_array(jsonb_build_object('scope_type', 'tenant', 'scope_id', v_org)),
    'POD binds a stop without a branch to its route organization');

  INSERT INTO public.marketplace_participant_profiles(organization_id, participant_type_key, display_name)
    VALUES (v_other_org, 'provider_tenant', 'Policy fixture') RETURNING id INTO v_profile;
  INSERT INTO public.marketplace_requests(requester_organization_id, request_kind_key, status, title)
    VALUES (v_org, 'capacity_block', 'completed', 'Policy fixture') RETURNING id INTO v_request;
  INSERT INTO public.marketplace_offers(request_id, supplier_participant_profile_id, supplier_organization_id, status, pricing)
    VALUES (v_request, v_profile, v_other_org, 'accepted', '{"amount":100,"currency":"SAR"}') RETURNING id INTO v_offer;
  INSERT INTO public.marketplace_awards(request_id, offer_id, requester_organization_id, supplier_organization_id,
    supplier_participant_profile_id, status)
    VALUES (v_request, v_offer, v_org, v_other_org, v_profile, 'materialized') RETURNING id INTO v_award;
  INSERT INTO public.marketplace_contracts(award_id, request_id, requester_organization_id, supplier_organization_id,
    supplier_participant_profile_id, status, settlement_mode_key)
    VALUES (v_award, v_request, v_org, v_other_org, v_profile, 'completed', 'auto_recorded_internal') RETURNING id INTO v_contract;
  INSERT INTO public.marketplace_work_packages(contract_id, award_id, request_id, requester_organization_id,
    supplier_organization_id, supplier_participant_profile_id, status)
    VALUES (v_contract, v_award, v_request, v_org, v_other_org, v_profile, 'completed') RETURNING id INTO v_package;

  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result := api.marketplace_settlement_finalize_v1(v_package, v_contract);
  EXECUTE 'RESET ROLE';
  RETURN NEXT ok(v_result->>'status' = 'settled' AND v_result->>'supplier_settlement_batch_id' IS NOT NULL,
    'Marketplace posts the supplier batch from the bound contract');
  RETURN NEXT ok(NOT EXISTS (
    SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role', 'ui_rpc_executor']) AS roles(role_name)
    WHERE has_function_privilege(role_name, 'public.resolve_settings_row_from_bound_policy_context_v1(text,jsonb)', 'EXECUTE')
       OR has_function_privilege(role_name, 'public.marketplace_policy_lookup_bound_v1(text,jsonb)', 'EXECUTE')
  ), 'Record-bound lookup implementations are owner-only');
  RETURN QUERY SELECT * FROM pg_temp.check_edge_policy_callers(v_org, v_own_client, v_client, v_actor);
END;
$test$;

SELECT * FROM pg_temp.check_policy_callers();
SELECT * FROM finish();
ROLLBACK;
