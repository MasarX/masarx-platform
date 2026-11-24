BEGIN;
SET LOCAL search_path TO public, extensions, pgtap, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

SELECT ok(NOT has_function_privilege('anon', 'api.public_tracking_proof_v1(jsonb)', 'EXECUTE'),
  'anon cannot access storage references through the service RPC');
SELECT ok(NOT has_function_privilege('authenticated', 'api.public_tracking_proof_v1(jsonb)', 'EXECUTE'),
  'authenticated cannot access storage references through the service RPC');

CREATE FUNCTION pg_temp.check_tracking_proof()
RETURNS SETOF text
LANGUAGE plpgsql
AS $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_shipment uuid := gen_random_uuid();
  v_other_shipment uuid := gen_random_uuid();
  v_action uuid := gen_random_uuid();
  v_photo uuid := gen_random_uuid();
  v_signature uuid := gen_random_uuid();
  v_token text := gen_random_uuid()::text;
  v_other_token text := gen_random_uuid()::text;
  v_expired_token text := gen_random_uuid()::text;
  v_input jsonb := jsonb_build_object('session_token', v_token, 'ip_hash', gen_random_uuid());
  v_proof jsonb;
  v_policy jsonb;
  v_now timestamptz := workflow_now();
BEGIN
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Proof test', 'tracking-proof-' || left(v_org::text, 8));
  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Proof test client', 'tracking-proof-' || left(v_client::text, 8), 'active');
  PERFORM set_config('app.organization_onboarding_source', '', true);
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'pgtap:tracking-proof');

  INSERT INTO public.shipments (id, organization_id, client_id, tracking_number, service_type, status)
  VALUES
    (v_shipment, v_org, v_client, 'PROOF-' || left(v_shipment::text, 8), 'delivery', 'delivered'),
    (v_other_shipment, v_org, v_client, 'OTHER-' || left(v_other_shipment::text, 8), 'delivery', 'pending');

  INSERT INTO public.shipment_actions
    (id, organization_id, client_id, shipment_id, action_type, action_category, canonical_status, timestamp, action_data)
  VALUES (v_action, v_org, v_client, v_shipment, 'status_change', 'operational', 'delivered',
    v_now, jsonb_build_object('pod', jsonb_build_object('recipient_name', 'Fixture Name', 'signature_artifact_id', v_signature)));

  INSERT INTO public.artifacts (id, organization_id, storage_bucket, storage_key, mime_type, metadata)
  VALUES
    (v_photo, v_org, 'fieldops-evidence', v_org::text || '/test-photo.png', 'image/png', '{"artifact_kind":"photo"}'),
    (v_signature, v_org, 'fieldops-evidence', v_org::text || '/test-signature.png', 'image/png', '{"artifact_kind":"signature"}');

  INSERT INTO public.artifact_links (organization_id, artifact_id, resource_type, resource_id, relation_type)
  VALUES (v_org, v_photo, 'shipment_action', v_action, 'pod'),
    (v_org, v_signature, 'shipment_action', v_action, 'pod');

  INSERT INTO public.tracking_sessions (organization_id, client_id, shipment_id, token, expires_at)
  VALUES (v_org, v_client, v_shipment, v_token, v_now + interval '2 days'),
    (v_org, v_client, v_other_shipment, v_other_token, v_now + interval '2 days'),
    (v_org, v_client, v_shipment, v_expired_token, v_now - interval '1 minute');

  SET LOCAL ROLE service_role;
  v_proof := api.public_tracking_proof_v1(v_input)->'proof';
  RETURN NEXT is(v_proof->>'state', 'available', 'verified delivered shipment has proof');
  RETURN NEXT is(jsonb_array_length(v_proof->'artifacts'), 2, 'one artifact per enabled kind');
  RETURN NEXT is(v_proof->>'recipient_name', 'F' || repeat('*', length('Fixture Name') - 1), 'typed recipient name is masked');
  RETURN NEXT is(api.public_tracking_proof_v1(v_input || jsonb_build_object('session_token', gen_random_uuid()))
    #>> '{error,code}', 'invalid_session', 'wrong token cannot list proof');
  RETURN NEXT is(api.public_tracking_proof_v1(v_input || jsonb_build_object('session_token', v_expired_token))
    #>> '{error,code}', 'invalid_session', 'expired token cannot list proof');
  RETURN NEXT is(api.public_tracking_proof_v1(v_input || jsonb_build_object(
    'session_token', v_other_token, 'shipment_id', v_shipment, 'artifact_id', v_photo))
    #>> '{proof,state}', 'unavailable', 'another shipment token cannot select a shipment or artifact');
  RESET ROLE;

  UPDATE public.artifacts SET metadata = metadata || '{"hide_from_public_tracking":true}'
  WHERE id = v_photo;
  v_proof := api.public_tracking_proof_v1(v_input)->'proof';
  RETURN NEXT is(jsonb_array_length(v_proof->'artifacts'), 1, 'a hidden photo is excluded');
  RETURN NEXT is(v_proof #>> '{artifacts,0,kind}', 'signature', 'the other enabled artifact remains visible');

  v_policy := public.public_tracking_policy_v1(jsonb_build_object('organization_id', v_org, 'client_id', v_client));
  PERFORM public.upsert_settings_value_v1('public_tracking_policy', 'client', v_client,
    v_policy || '{"proof":{"signature_enabled":false}}'::jsonb, 1, 'pgtap disable signature');
  RETURN NEXT is(api.public_tracking_proof_v1(v_input) #>> '{proof,state}', 'unavailable',
    'tenant policy can disable a proof kind');

  PERFORM set_config('platform.now_override', (v_now + interval '24 hours')::text, true);
  RETURN NEXT is(api.public_tracking_proof_v1(v_input) #>> '{proof,state}', 'expired',
    'proof expires at the default 24 hour boundary');
END;
$$;

SELECT * FROM pg_temp.check_tracking_proof();
SELECT * FROM finish();
ROLLBACK;
