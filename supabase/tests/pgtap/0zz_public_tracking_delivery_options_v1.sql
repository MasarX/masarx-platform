BEGIN;
SET LOCAL search_path TO public, extensions, pgtap, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(21);

SELECT ok(NOT has_function_privilege('anon', 'api.public_tracking_delivery_options_v1(jsonb)', 'EXECUTE'),
  'anonymous cannot call the options RPC directly');
SELECT ok(NOT has_function_privilege('authenticated', 'api.public_tracking_delivery_options_v1(jsonb)', 'EXECUTE'),
  'authenticated cannot call the options RPC directly');

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
  v_token text := gen_random_uuid()::text;
  v_cod_token text := gen_random_uuid()::text;
  v_expired_token text := gen_random_uuid()::text;
  v_input jsonb := jsonb_build_object('session_token', v_token, 'ip_hash', gen_random_uuid());
  v_cod_input jsonb := v_input || jsonb_build_object('session_token', v_cod_token, 'shipment_id', v_shipment);
  v_request jsonb := v_input || '{"request_type":"delivery_option"}'::jsonb;
  v_result jsonb;
  v_case_id uuid;
  v_policy jsonb;
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
  VALUES (v_shipment, v_org, v_client, 'OPTION-' || left(v_shipment::text, 8), 'delivery', 'pending', 0),
    (v_cod, v_org, v_client, 'COD-' || left(v_cod::text, 8), 'delivery', 'pending', 10);
  INSERT INTO public.route_runs (id, organization_id, status) VALUES (v_run, v_org, 'planned');
  INSERT INTO public.route_stops (id, organization_id, route_run_id, client_id, shipment_id, sequence_order)
  VALUES (v_stop, v_org, v_run, v_client, v_shipment, 1);

  INSERT INTO public.tracking_sessions (organization_id, client_id, shipment_id, token, expires_at)
  VALUES (v_org, v_client, v_shipment, v_token, v_now + interval '1 hour'),
    (v_org, v_client, v_cod, v_cod_token, v_now + interval '1 hour'),
    (v_org, v_client, v_shipment, v_expired_token, v_now - interval '1 minute');

  RETURN NEXT is(api.public_tracking_delivery_options_v1(v_input) #>> '{delivery_options,changes_open}', 'false',
    'alternatives are disabled until the tenant offers them');
  v_policy := public.public_tracking_policy_v1(jsonb_build_object('organization_id', v_org, 'client_id', v_client));
  PERFORM public.upsert_settings_value_v1('public_tracking_policy', 'client', v_client,
    public.deep_merge_jsonb(v_policy, '{"actions":{"delivery_option":{"branch_pickup_enabled":true,"safe_place_enabled":true}}}'),
    1, 'pgtap enable delivery options');

  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  SET LOCAL ROLE service_role;
  v_result := api.public_tracking_delivery_options_v1(v_input)->'delivery_options';
  RETURN NEXT ok(v_result->'choices' ?& ARRAY['home_delivery', 'branch_pickup', 'safe_place'],
    'the verified shipment receives enabled alternatives');
  RETURN NEXT is(jsonb_array_length(v_result->'branches'), 1, 'branch list includes only enabled branches for the tenant');
  RETURN NEXT is(v_result #>> '{branches,0,id}', v_branch::text, 'list returns the approved branch');
  RETURN NEXT ok(NOT ((api.public_tracking_delivery_options_v1(v_cod_input) #> '{delivery_options,choices}') ? 'safe_place'),
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
  UPDATE public.route_runs SET status = 'in_progress', started_at = v_now WHERE id = v_run;
  INSERT INTO public.route_stops (organization_id, route_run_id, client_id, shipment_id, sequence_order)
  VALUES (v_org, v_run, v_client, v_cod, 2);
  RETURN NEXT is(api.public_tracking_delivery_options_v1(v_cod_input) #>> '{delivery_options,changes_open}',
    'false', 'route start closes choices with the same public state');
END;
$$;

SELECT * FROM pg_temp.check_tracking_options();
SELECT * FROM finish();
ROLLBACK;
