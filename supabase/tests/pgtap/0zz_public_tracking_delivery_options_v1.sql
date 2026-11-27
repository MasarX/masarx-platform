BEGIN;
SET LOCAL search_path TO public, extensions, pgtap, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(39);

SELECT ok(NOT has_function_privilege(role_name, signature, 'EXECUTE'),
  format('%s cannot execute %s', role_name, signature))
FROM (VALUES ('anon'::name), ('authenticated'::name)) AS roles(role_name)
CROSS JOIN (VALUES
  ('api.public_tracking_delivery_options_v1(jsonb)'),
  ('public.public_tracking_delivery_option_choices_v1(public.shipments, jsonb)'),
  ('public.public_tracking_validate_delivery_option_v1(uuid, uuid, uuid, jsonb, jsonb)'),
  ('public.public_tracking_apply_delivery_option_v1(uuid, uuid, uuid, jsonb, jsonb)'),
  ('public.route_stop_inherit_recipient_delivery_option_v1()')
) AS functions(signature);

CREATE FUNCTION pg_temp.check_tracking_options()
RETURNS SETOF text
LANGUAGE plpgsql
AS $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_other_org uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_shipment uuid := gen_random_uuid();
  v_cod uuid := gen_random_uuid();
  v_branch uuid := gen_random_uuid();
  v_other_branch uuid := gen_random_uuid();
  v_run uuid := gen_random_uuid();
  v_stop uuid := gen_random_uuid();
  v_cod_stop uuid := gen_random_uuid();
  v_token text := gen_random_uuid()::text;
  v_cod_token text := gen_random_uuid()::text;
  v_expired_token text := gen_random_uuid()::text;
  v_input jsonb := jsonb_build_object('session_token', v_token, 'ip_hash', gen_random_uuid());
  v_cod_input jsonb := v_input || jsonb_build_object('session_token', v_cod_token, 'shipment_id', v_shipment);
  v_request jsonb := v_input || '{"request_type":"delivery_option"}'::jsonb;
  v_cod_request jsonb := v_cod_input || jsonb_build_object('request_type', 'delivery_option',
    'payload', jsonb_build_object('option', 'branch_pickup', 'branch_id', v_branch));
  v_result jsonb;
  v_case_id uuid;
  v_policy jsonb;
  v_sample public.shipments%ROWTYPE;
  v_now timestamptz := workflow_now();
BEGIN
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Options test', 'options-' || left(v_org::text, 8)),
    (v_other_org, 'Other test tenant', 'options-' || left(v_other_org::text, 8));
  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Options test client', 'options-' || left(v_client::text, 8), 'active');
  PERFORM set_config('app.organization_onboarding_source', '', true);
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'pgtap:tracking-options');
  PERFORM public.bootstrap_tenant_onboarding_v1(v_other_org, 'pgtap:tracking-options');

  INSERT INTO public.branches (id, organization_id, code, name, is_active, metadata)
  VALUES (v_branch, v_org, 'fixture-pickup', 'Pickup available', true, '{"pickup_enabled":true}'),
    (gen_random_uuid(), v_org, 'fixture-disabled', 'Pickup not offered', true, '{"pickup_enabled":false}'),
    (v_other_branch, v_other_org, 'other-pickup', 'Other tenant pickup', true, '{"pickup_enabled":true}');

  INSERT INTO public.shipments (id, organization_id, client_id, tracking_number, service_type, status, cod_amount)
  VALUES (v_shipment, v_org, v_client, 'OPTION-' || left(v_shipment::text, 8), 'delivery', 'created', 0),
    (v_cod, v_org, v_client, 'COD-' || left(v_cod::text, 8), 'delivery', 'pending_dispatch', 10);
  INSERT INTO public.route_runs (id, organization_id, status) VALUES (v_run, v_org, 'planned');
  INSERT INTO public.route_stops (id, organization_id, route_run_id, client_id, shipment_id, sequence_order)
  VALUES (v_stop, v_org, v_run, v_client, v_shipment, 1),
    (v_cod_stop, v_org, v_run, v_client, v_cod, 2);

  INSERT INTO public.tracking_sessions (organization_id, client_id, shipment_id, token, expires_at)
  VALUES (v_org, v_client, v_shipment, v_token, v_now + interval '1 hour'),
    (v_org, v_client, v_cod, v_cod_token, v_now + interval '1 hour'),
    (v_org, v_client, v_shipment, v_expired_token, v_now - interval '1 minute');

  RETURN NEXT is(api.public_tracking_delivery_options_v1(v_input) #>> '{delivery_options,changes_open}', 'false',
    'alternatives are disabled until the tenant offers them');
  v_policy := public.public_tracking_policy_v1(jsonb_build_object('organization_id', v_org, 'client_id', v_client));
  v_policy := public.deep_merge_jsonb(v_policy,
    '{"actions":{"delivery_option":{"branch_pickup_enabled":true,"safe_place_enabled":true}}}');
  PERFORM public.upsert_settings_value_v1('public_tracking_policy', 'client', v_client,
    v_policy, 1, 'pgtap enable delivery options');

  SELECT * INTO v_sample FROM public.shipments WHERE id = v_shipment;
  RETURN NEXT is(public.public_tracking_delivery_option_choices_v1(v_sample,
    jsonb_set(v_policy, '{actions,delivery_option,allowed_statuses}', '["pending_dispatch"]'))->>'changes_open',
    'false', 'a tenant policy can exclude a default eligible status');
  v_sample.status := 'delivered';
  RETURN NEXT is(public.public_tracking_delivery_option_choices_v1(v_sample, v_policy)->>'changes_open',
    'false', 'a delivered shipment is outside the default change window');
  v_sample.status := 'unknown_status';
  RETURN NEXT is(public.public_tracking_delivery_option_choices_v1(v_sample,
    jsonb_set(v_policy, '{actions,delivery_option,allowed_statuses}', '["unknown_status"]'))->>'changes_open',
    'false', 'a policy entry outside the shipment status lookup cannot open the window');

  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  SET LOCAL ROLE service_role;
  v_result := api.public_tracking_delivery_options_v1(v_input)->'delivery_options';
  RETURN NEXT ok(v_result->'choices' ?& ARRAY['home_delivery', 'branch_pickup', 'safe_place'],
    'the verified shipment in created status receives enabled alternatives');
  RETURN NEXT is(jsonb_array_length(v_result->'branches'), 1, 'branch list includes only enabled branches for the tenant');
  RETURN NEXT is(v_result #>> '{branches,0,id}', v_branch::text, 'list returns the approved branch');
  v_result := api.public_tracking_delivery_options_v1(v_cod_input)->'delivery_options';
  RETURN NEXT ok(v_result->'choices' ? 'branch_pickup', 'pending dispatch is eligible by default');
  RETURN NEXT ok(NOT (v_result->'choices' ? 'safe_place'),
    'COD token cannot override its shipment and get safe place');
  RETURN NEXT is(api.public_tracking_delivery_options_v1(v_input || jsonb_build_object('session_token', gen_random_uuid()))
    #>> '{error,code}', 'invalid_session', 'wrong token cannot read choices');
  RETURN NEXT is(api.public_tracking_delivery_options_v1(v_input || jsonb_build_object('session_token', v_expired_token))
    #>> '{error,code}', 'invalid_session', 'expired token cannot read choices');
  RETURN NEXT is(api.public_tracking_submit_request_v2(v_request || jsonb_build_object('payload',
    jsonb_build_object('option', 'branch_pickup', 'branch_id', v_other_branch)))
    #>> '{error,code}', 'invalid_request', 'a branch from another tenant cannot be selected');
  RETURN NEXT is(api.public_tracking_submit_request_v2(v_cod_input || '{"request_type":"delivery_option","payload":{"option":"safe_place","place":"reception","consent":true}}')
    #>> '{error,code}', 'invalid_request', 'COD cannot submit safe place');
  RETURN NEXT is(api.public_tracking_submit_request_v2(v_request || '{"payload":{"option":"safe_place","place":"reception"}}')
    #>> '{error,code}', 'invalid_request', 'safe place requires consent');
  RETURN NEXT is(api.public_tracking_submit_request_v2(v_request || jsonb_build_object('payload',
    jsonb_build_object('option', 'safe_place', 'place', 'other', 'consent', true, 'instruction', repeat('x',121))))
    #>> '{error,code}', 'invalid_request', 'safe place limits free text to 120 characters');

  v_request := v_request || '{"payload":{"option":"safe_place","place":"reception","consent":true}}';
  v_result := api.public_tracking_submit_request_v2(v_request);
  v_case_id := (v_result->>'support_case_id')::uuid;
  RETURN NEXT is(v_result->>'outcome', 'pending_review', 'safe place enters the existing review queue');
  RETURN NEXT is(api.public_tracking_submit_request_v2(v_request)->>'support_case_id', v_case_id::text,
    'resubmitting the same request reuses the case');
  RETURN NEXT is(api.public_tracking_submit_request_v2(v_request || jsonb_build_object('payload',
    jsonb_build_object('option', 'branch_pickup', 'branch_id', v_branch))) #>> '{error,code}',
    'changes_closed', 'a different choice cannot be submitted while a request is open');
  RETURN NEXT is(api.public_tracking_review_request_v1(jsonb_build_object('support_case_id', v_case_id, 'decision', 'approve'))->>'outcome',
    'applied', 'operations approval applies safe place');
  RESET ROLE;
  RETURN NEXT is((SELECT metadata #>> '{recipient_delivery_option,place}' FROM public.route_stops WHERE id = v_stop),
    'reception', 'approval reaches the active route stop without carrying consent');
  RETURN NEXT ok((SELECT metadata #> '{recipient_delivery_option,consent}' IS NULL FROM public.route_stops WHERE id = v_stop),
    'the stop does not store customer consent data');

  v_result := api.public_tracking_submit_request_v2(v_input ||
    '{"request_type":"delivery_option","payload":{"option":"home_delivery"}}');
  RETURN NEXT is(v_result->>'outcome', 'pending_review', 'one switch back needs review');
  PERFORM api.public_tracking_review_request_v1(jsonb_build_object(
    'support_case_id', v_result->>'support_case_id', 'decision', 'approve'));
  RETURN NEXT is(api.public_tracking_delivery_options_v1(v_input) #>> '{delivery_options,changes_open}',
    'false', 'approved switch back closes further changes');

  v_result := api.public_tracking_submit_request_v2(v_cod_request);
  v_case_id := (v_result->>'support_case_id')::uuid;
  RETURN NEXT is(v_result->>'outcome', 'pending_review', 'branch pickup enters review before the route starts');
  UPDATE public.route_runs SET status = 'in_progress', started_at = v_now WHERE id = v_run;
  RETURN NEXT is(api.public_tracking_delivery_options_v1(v_cod_input) #>> '{delivery_options,changes_open}',
    'false', 'route start closes choices with the same public state');
  RETURN NEXT is(api.public_tracking_submit_request_v2(v_cod_request) #>> '{error,code}',
    'changes_closed', 'submission is refused after the route starts');
  RETURN NEXT is(api.public_tracking_review_request_v1(jsonb_build_object(
    'support_case_id', v_case_id, 'decision', 'approve')) #>> '{error,code}',
    'changes_closed', 'approval is refused after the route starts during review');
  RETURN NEXT ok((SELECT metadata->'recipient_delivery_option' IS NULL FROM public.shipments WHERE id = v_cod),
    'refused approval leaves the shipment option unchanged');
  RETURN NEXT ok((SELECT metadata->'recipient_delivery_option' IS NULL FROM public.route_stops WHERE id = v_cod_stop),
    'refused approval leaves the route stop option unchanged');
END;
$$;

SELECT * FROM pg_temp.check_tracking_options();
SELECT * FROM finish();
ROLLBACK;
