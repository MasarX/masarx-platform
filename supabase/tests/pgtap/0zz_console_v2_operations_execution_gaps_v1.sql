-- pgTAP: Console V2 operations execution gap closure
-- Scope: baskets/zones, driver application approval/profile, provider credential
-- CRUD/redaction/rotation, manual shipment create/import, shipment.updated typed
-- intent, departure scan-out, shipment supervision read pack, settlement scope
-- filters.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(34);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_operations_execution_gaps_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_registry JSONB := NULL;
  v_org UUID := '00000000-0000-0000-0000-000086000001';
  v_driver_org UUID := '00000000-0000-0000-0000-000086000002';
  v_other_org UUID := '00000000-0000-0000-0000-000086000003';
  v_ops UUID := '00000000-0000-0000-0000-000086000011';
  v_driver UUID := '00000000-0000-0000-0000-000086000012';
  v_invited_driver UUID := '00000000-0000-0000-0000-000086000013';
  v_client UUID := '00000000-0000-0000-0000-000086000021';
  v_sender UUID := '00000000-0000-0000-0000-000086000022';
  v_provider UUID := '00000000-0000-0000-0000-000086000031';
  v_other_provider UUID := '00000000-0000-0000-0000-000086000032';
  v_other_config UUID := '00000000-0000-0000-0000-000086000033';
  v_zone UUID := '00000000-0000-0000-0000-000086000041';
  v_branch UUID := '00000000-0000-0000-0000-000086000051';
  v_vehicle UUID := '00000000-0000-0000-0000-000086000052';
  v_route UUID := '00000000-0000-0000-0000-000086000061';
  v_route_two UUID := '00000000-0000-0000-0000-000086000062';
  v_stop_one UUID := '00000000-0000-0000-0000-000086000071';
  v_stop_two UUID := '00000000-0000-0000-0000-000086000072';
  v_stop_three UUID := '00000000-0000-0000-0000-000086000073';
  v_shipment_one UUID := '00000000-0000-0000-0000-000086000081';
  v_shipment_two UUID := '00000000-0000-0000-0000-000086000082';
  v_shipment_three UUID := '00000000-0000-0000-0000-000086000083';
  v_driver_request UUID := '00000000-0000-0000-0000-000086000091';
  v_plugin UUID := '00000000-0000-0000-0000-0000860000a1';
  v_plugin_version UUID := '00000000-0000-0000-0000-0000860000a2';
  v_plugin_binding UUID := '00000000-0000-0000-0000-0000860000a3';
  v_outbound_call UUID := '00000000-0000-0000-0000-0000860000b1';
  v_comms_attempt UUID := '00000000-0000-0000-0000-0000860000b2';
  v_result JSONB := '{}'::jsonb;
  v_result_two JSONB := '{}'::jsonb;
  v_credential_rows JSONB := '[]'::jsonb;
  v_comms_rows JSONB := '[]'::jsonb;
  v_config_id UUID;
  v_rotated_config_id UUID;
  v_basket_id UUID;
  v_profile_id UUID;
  v_driver_profile_id UUID;
  v_manual_tracking TEXT := 'PGTAP-MANUAL-8600-001';
  v_manual_result JSONB := '{}'::jsonb;
  v_manual_shipment_id UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT cached_value
    INTO v_registry
    FROM public.settings
   WHERE category = 'ui_read_registry'
     AND scope_type = 'global'
     AND scope_id IS NULL
   LIMIT 1;

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Console V2 Ops Gap Org', 'console-v2-ops-gap'),
    (v_driver_org, 'Console V2 Driver Gap Org', 'console-v2-driver-gap'),
    (v_other_org, 'Console V2 Other Gap Org', 'console-v2-other-gap')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'console-v2-ops-gap@example.com', 'Console V2 Ops Gap', 'ops_admin', 'active', 'tenant', NULL),
    (v_driver, v_org, 'console-v2-driver-gap@example.com', 'Console V2 Driver Gap', 'driver', 'active', 'tenant', NULL)
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         user_type = EXCLUDED.user_type,
         status = EXCLUDED.status,
         access_scope_type = EXCLUDED.access_scope_type,
         access_scope_id = EXCLUDED.access_scope_id;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Console V2 Ops Gap Client', 'console-v2-ops-gap-client', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, brand_name, status)
  VALUES (v_sender, v_client, 'Console V2 Ops Gap Sender', 'Console V2 Ops Gap Sender', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.providers (id, organization_id, name, provider_type, metadata)
  VALUES (v_provider, v_org, 'Console V2 Ops Gap Provider', 'http', jsonb_build_object('vendor', 'pgtap'))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.providers (id, organization_id, name, provider_type, metadata)
  VALUES (v_other_provider, v_other_org, 'Console V2 Other Gap Provider', 'http', jsonb_build_object('vendor', 'pgtap-other'))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.provider_auth_configs (id, provider_id, auth_type, credentials, expires_at)
  VALUES (
    v_other_config,
    v_other_provider,
    'api_key',
    jsonb_build_object('key', 'pgtap-secret-other-tenant'),
    now() + INTERVAL '180 days'
  )
  ON CONFLICT (id) DO UPDATE
     SET provider_id = EXCLUDED.provider_id,
         auth_type = EXCLUDED.auth_type,
         credentials = EXCLUDED.credentials,
         expires_at = EXCLUDED.expires_at;

  INSERT INTO public.zones (id, organization_id, name, slug, description, is_active, metadata)
  VALUES (v_zone, v_org, 'Console V2 Ops Gap Zone', 'console-v2-ops-gap-zone', 'Original zone', TRUE, '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name, timezone)
  VALUES (v_branch, v_org, 'c86', 'Console V2 Ops Gap Branch', 'Asia/Riyadh')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.vehicles (id, organization_id, branch_id, plate_number, status, is_active)
  VALUES (v_vehicle, v_org, v_branch, 'CV2-8600', 'active', TRUE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, tracking_number, client_reference_number, service_type, status, metadata)
  VALUES
    (v_shipment_one, v_org, v_client, v_sender, 'PGTAP-DEP-8600-001', 'PGTAP-DEP-8600-001', 'delivery', 'pending', '{}'::jsonb),
    (v_shipment_two, v_org, v_client, v_sender, 'PGTAP-DEP-8600-002', 'PGTAP-DEP-8600-002', 'delivery', 'pending', '{}'::jsonb),
    (v_shipment_three, v_org, v_client, v_sender, 'PGTAP-DEP-8600-003', 'PGTAP-DEP-8600-003', 'delivery', 'pending', '{}'::jsonb)
  ON CONFLICT (id, client_id) DO NOTHING;

  INSERT INTO public.route_runs (id, organization_id, branch_id, driver_user_id, vehicle_id, status, planned_date, metadata)
  VALUES
    (v_route, v_org, v_branch, v_driver, v_vehicle, 'planned', CURRENT_DATE, '{}'::jsonb),
    (v_route_two, v_org, v_branch, v_driver, v_vehicle, 'planned', CURRENT_DATE, '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.route_stops (id, organization_id, route_run_id, client_id, shipment_id, stop_kind, sequence_order)
  VALUES
    (v_stop_one, v_org, v_route, v_client, v_shipment_one, 'delivery', 1),
    (v_stop_two, v_org, v_route, v_client, v_shipment_two, 'delivery', 2),
    (v_stop_three, v_org, v_route_two, v_client, v_shipment_three, 'delivery', 1)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.outbound_calls (
    id,
    call_type,
    target_type,
    target_id,
    method,
    url,
    headers,
    body,
    status,
    shipment_id,
    context
  )
  VALUES (
    v_outbound_call,
    'comms_sms',
    'provider',
    v_provider,
    'POST',
    'https://sms.example.test/send',
    jsonb_build_object('Authorization', 'Bearer pgtap-secret-header'),
    jsonb_build_object('message', 'pgtap-secret-body'),
    'completed',
    v_shipment_one,
    jsonb_build_object('template_id', 'delivery_notice', 'internal_secret', 'pgtap-secret-context')
  )
  ON CONFLICT (id) DO UPDATE
     SET target_id = EXCLUDED.target_id,
         shipment_id = EXCLUDED.shipment_id,
         headers = EXCLUDED.headers,
         body = EXCLUDED.body,
         context = EXCLUDED.context,
         status = EXCLUDED.status;

  INSERT INTO public.comms_attempts (
    id,
    outbound_call_id,
    provider_id,
    attempt_number,
    status,
    provider_message_id,
    error_code,
    error_message
  )
  VALUES (
    v_comms_attempt,
    v_outbound_call,
    v_provider,
    1,
    'delivered',
    'msg-pgtap-8600',
    NULL,
    NULL
  )
  ON CONFLICT (id) DO UPDATE
     SET outbound_call_id = EXCLUDED.outbound_call_id,
         provider_id = EXCLUDED.provider_id,
         attempt_number = EXCLUDED.attempt_number,
         status = EXCLUDED.status,
         provider_message_id = EXCLUDED.provider_message_id,
         error_code = EXCLUDED.error_code,
         error_message = EXCLUDED.error_message;

  INSERT INTO public.marketplace_participant_requests (
    id,
    status,
    requested_participant_type_key,
    requested_organization_id,
    email,
    full_name,
    organization_name,
    organization_slug,
    capabilities_requested,
    verification_documents,
    turnstile_verified,
    metadata
  )
  VALUES (
    v_driver_request,
    'pending',
    'freelancer_driver',
    v_driver_org,
    'console-v2-driver-applicant@example.com',
    'Console V2 Driver Applicant',
    'Console V2 Driver Gap Org',
    'console-v2-driver-gap',
    jsonb_build_array('local_delivery'),
    jsonb_build_array(
      jsonb_build_object('document_type_key', 'driver_license', 'status', 'approved', 'document_ref', 'license-8600'),
      jsonb_build_object('document_type_key', 'medical', 'status', 'approved', 'document_ref', 'medical-8600')
    ),
    TRUE,
    '{}'::jsonb
  )
  ON CONFLICT (id) DO UPDATE
     SET status = 'pending',
         review_decision = NULL,
         reviewed_at = NULL,
         reviewed_by = NULL,
         approved_organization_id = NULL,
         approved_user_id = NULL,
         approved_auth_user_id = NULL,
         approved_participant_profile_id = NULL;

  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
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

  BEGIN
    v_result := public.zone_update_v1(jsonb_build_object(
      'zone_id', v_zone,
      'patch', jsonb_build_object(
        'name', 'Console V2 Ops Gap Zone Updated',
        'metadata', jsonb_build_object('supervision', 'pgtap')
      )
    ));
    RETURN NEXT ok(
      COALESCE((v_result->>'ok')::boolean, FALSE)
      AND EXISTS (
        SELECT 1
          FROM public.zones z
         WHERE z.id = v_zone
           AND z.name = 'Console V2 Ops Gap Zone Updated'
           AND z.metadata->>'supervision' = 'pgtap'
      ),
      'zone_update_v1 executes profile update without lifecycle mutation'
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN NEXT fail('zone_update_v1 raised ' || SQLSTATE || ': ' || SQLERRM);
  END;

  BEGIN
    v_result := public.basket_create_v1(jsonb_build_object(
      'organization_id', v_org,
      'zone_id', v_zone,
      'capacity_count', 12,
      'metadata', jsonb_build_object('source', 'pgtap-console-v2')
    ));
    v_basket_id := NULLIF(v_result->>'basket_id', '')::uuid;
    EXECUTE 'SET LOCAL ROLE postgres';
    RETURN NEXT ok(
      COALESCE((v_result->>'ok')::boolean, FALSE)
      AND EXISTS (
        SELECT 1
          FROM public.baskets b
         WHERE b.id = v_basket_id
           AND b.organization_id = v_org
           AND b.zone_id = v_zone
           AND b.capacity_count = 12
      ),
      'basket_create_v1 executes org/zone-scoped basket creation'
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN NEXT fail('basket_create_v1 raised ' || SQLSTATE || ': ' || SQLERRM);
  END;

  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'api'
         AND p.proname IN ('basket_item_add_v1', 'basket_item_remove_v1')
    ),
    'basket item membership has no direct API shortcut outside canonical workflow sorting'
  );

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'service_role',
      'sub', v_ops::text,
      'organization_id', v_org::text,
      'access_scope_type', 'tenant'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE service_role';

  BEGIN
    v_result := public.marketplace_participant_request_review_apply_v1(
      v_driver_request,
      'request_additional_docs',
      v_ops,
      NULL,
      FALSE,
      NULL,
      NULL,
      NULL,
      jsonb_build_object(
        'reason', 'pgtap_request_docs',
        'requested_documents', jsonb_build_array('medical_clearance'),
        'request_additional_docs', true
      )
    );
    RETURN NEXT ok(
      (v_result->>'status') = 'pending'
      AND EXISTS (
        SELECT 1
          FROM public.marketplace_participant_requests r
         WHERE r.id = v_driver_request
           AND r.status = 'pending'
           AND r.review_decision IS NULL
           AND r.decision_metadata->>'request_additional_docs' = 'true'
           AND r.decision_metadata->'requested_documents' ? 'medical_clearance'
      ),
      'driver application request-additional-docs records pending review metadata without approval/rejection'
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN NEXT fail('driver application request-additional-docs raised ' || SQLSTATE || ': ' || SQLERRM);
  END;

  BEGIN
    v_result := public.marketplace_participant_request_review_apply_v1(
      v_driver_request,
      'approved',
      v_ops,
      NULL,
      FALSE,
      NULL,
      v_driver_org,
      NULL,
      jsonb_build_object('reason', 'pgtap_missing_invited_user')
    );
    RETURN NEXT is(
      v_result#>>'{error,code}',
      'invited_auth_user_required',
      'driver application approval fails closed without invited auth user'
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN NEXT fail('driver application missing-invite review raised ' || SQLSTATE || ': ' || SQLERRM);
  END;

  BEGIN
    v_result := public.marketplace_participant_request_review_apply_v1(
      v_driver_request,
      'approved',
      v_ops,
      v_invited_driver,
      TRUE,
      'https://console.masarx.test/invite',
      v_driver_org,
      v_invited_driver,
      jsonb_build_object(
        'reason', 'pgtap_driver_approved',
        'verified_documents', jsonb_build_array(
          jsonb_build_object('document_type_key', 'driver_license', 'document_ref', 'license-8600'),
          jsonb_build_object('document_type_key', 'medical', 'document_ref', 'medical-8600')
        )
      )
    );
    v_profile_id := NULLIF(v_result->>'approved_participant_profile_id', '')::uuid;
    SELECT id INTO v_driver_profile_id
      FROM public.driver_profiles
     WHERE organization_id = v_driver_org AND user_id = v_invited_driver;
    RETURN NEXT ok(
      (v_result->>'status') = 'approved'
      AND v_profile_id IS NOT NULL
      AND NULLIF(v_result->>'approved_user_id', '')::uuid = v_invited_driver,
      'driver application approval returns approved profile and invited user identity'
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN NEXT fail('driver application approval raised ' || SQLSTATE || ': ' || SQLERRM);
  END;

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.v_driver_application_directory d
       WHERE d.id = v_driver_request
         AND d.is_approved = TRUE
         AND d.approved_participant_profile_id = v_profile_id
    ),
    'driver application directory projects approved profile state'
  );

  RETURN NEXT ok(
    v_driver_profile_id IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM public.driver_profiles dp
       WHERE dp.id = v_driver_profile_id
         AND dp.organization_id = v_driver_org
         AND dp.user_id = v_invited_driver
         AND COALESCE(dp.metadata->>'marketplace_participant_request_id',
                      dp.metadata->>'marketplace_request_id') = v_driver_request::text
         AND dp.metadata->>'source' = 'marketplace_driver_profile_from_participant_request_v1'
    ),
    'driver application approval materializes canonical fleet driver profile readback'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.driver_documents dd
       WHERE dd.organization_id = v_driver_org
         AND dd.user_id = v_invited_driver
         AND dd.doc_type = 'driver_license'
         AND dd.status = 'verified'
         AND dd.metadata->>'marketplace_participant_request_id' = v_driver_request::text
         AND dd.metadata->>'reviewer_verified' = 'true'
    )
    AND EXISTS (
      SELECT 1
        FROM public.driver_documents dd
       WHERE dd.organization_id = v_driver_org
         AND dd.user_id = v_invited_driver
         AND dd.doc_type = 'medical'
         AND dd.status = 'verified'
         AND dd.metadata->>'marketplace_participant_request_id' = v_driver_request::text
         AND dd.metadata->>'reviewer_verified' = 'true'
    ),
    'driver application approval records explicitly verified fleet document kinds'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.driver_compliance_events dce
       WHERE dce.organization_id = v_driver_org
         AND dce.user_id = v_invited_driver
         AND dce.event_type = 'marketplace_driver_approved'
         AND dce.payload->>'marketplace_participant_request_id' = v_driver_request::text
    ),
    'driver application approval appends fleet compliance handoff event'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.v_driver_application_directory d
       WHERE d.id = v_driver_request
         AND d.driver_profile_id = v_driver_profile_id
         AND d.fleet_driver_status IS NOT NULL
         AND d.fleet_handoff_ready IS TRUE
         AND d.fleet_document_count = 2
         AND d.fleet_compliance_event_count = 1
    ),
    'driver application directory projects fleet profile handoff readback'
  );

  BEGIN
    v_result := public.marketplace_participant_request_review_apply_v1(
      v_driver_request,
      'approved',
      v_ops,
      v_invited_driver,
      TRUE,
      'https://console.masarx.test/invite',
      v_driver_org,
      v_invited_driver,
      jsonb_build_object('reason', 'pgtap_driver_approved_duplicate')
    );

    RETURN NEXT ok(
      v_result->>'status' = 'approved'
      AND EXISTS (SELECT 1 FROM public.driver_profiles WHERE id = v_driver_profile_id)
      AND (
        SELECT count(*)
          FROM public.driver_profiles dp
         WHERE dp.organization_id = v_driver_org
           AND dp.user_id = v_invited_driver
      ) = 1
      AND (
        SELECT count(*)
          FROM public.driver_compliance_events dce
         WHERE dce.organization_id = v_driver_org
           AND dce.user_id = v_invited_driver
           AND dce.event_type = 'marketplace_driver_approved'
           AND dce.payload->>'marketplace_participant_request_id' = v_driver_request::text
      ) = 1,
      'driver application duplicate/existing approval idempotently returns the same fleet profile'
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN NEXT fail('driver application duplicate approval raised ' || SQLSTATE || ': ' || SQLERRM);
  END;

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.marketplace_participant_profiles p
        JOIN public.marketplace_participant_memberships m
          ON m.participant_profile_id = p.id
         AND m.user_id = v_invited_driver
         AND m.status = 'active'
        JOIN public.marketplace_participant_capabilities c
          ON c.participant_profile_id = p.id
         AND c.capability_key = 'local_delivery'
         AND c.status = 'active'
       WHERE p.id = v_profile_id
         AND p.participant_type_key = 'freelancer_driver'
         AND p.status = 'approved'
         AND p.compliance_state = 'approved'
    ),
    'driver approval materializes profile, membership, and requested capability'
  );

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

  BEGIN
    v_result := api.ui_upsert_provider_auth_config_v1(jsonb_build_object(
      'provider_id', v_provider,
      'auth_type', 'api_key',
      'credentials', jsonb_build_object('key', 'pgtap-secret-created'),
      'expires_at', (now() + INTERVAL '90 days')::text
    ));
    v_config_id := NULLIF(v_result->>'provider_auth_config_id', '')::uuid;
    EXECUTE 'SET LOCAL ROLE postgres';
    RETURN NEXT ok(
      COALESCE((v_result->>'ok')::boolean, FALSE)
      AND EXISTS (
        SELECT 1
          FROM public.provider_auth_configs pac
         WHERE pac.id = v_config_id
           AND pac.provider_id = v_provider
           AND pac.auth_type = 'api_key'
           AND pac.credentials IS NULL
           AND pac.credentials_vault_id IS NOT NULL
           AND public.get_provider_auth_credentials(pac.id)->>'key' = 'pgtap-secret-created'
      ),
      'provider credential create writes vault-backed provider_auth_configs through API wrapper'
    );
    EXECUTE 'SET LOCAL ROLE authenticated';
  EXCEPTION WHEN OTHERS THEN
    RETURN NEXT fail('provider credential create raised ' || SQLSTATE || ': ' || SQLERRM);
  END;

  BEGIN
    v_result := api.ui_upsert_provider_auth_config_v1(jsonb_build_object(
      'config_id', v_config_id,
      'credentials', jsonb_build_object('key', 'pgtap-secret-updated'),
      'expires_at', (now() + INTERVAL '180 days')::text
    ));
    EXECUTE 'SET LOCAL ROLE postgres';
    RETURN NEXT ok(
      COALESCE((v_result->>'ok')::boolean, FALSE)
      AND EXISTS (
        SELECT 1
          FROM public.provider_auth_configs pac
         WHERE pac.id = v_config_id
           AND pac.credentials IS NULL
           AND pac.credentials_vault_id IS NOT NULL
           AND public.get_provider_auth_credentials(pac.id)->>'key' = 'pgtap-secret-updated'
           AND pac.expires_at > now() + INTERVAL '170 days'
      ),
      'provider credential update rotates vault secret payload and expiry'
    );
    EXECUTE 'SET LOCAL ROLE authenticated';
  EXCEPTION WHEN OTHERS THEN
    RETURN NEXT fail('provider credential update raised ' || SQLSTATE || ': ' || SQLERRM);
  END;

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(
    NOT COALESCE((
      SELECT to_jsonb(d)::text LIKE '%pgtap-secret-updated%'
        FROM public.v_integration_credential_directory d
       WHERE d.id = v_config_id
       LIMIT 1
    ), TRUE),
    'integration credential directory redacts raw provider credentials'
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  BEGIN
    v_result := api.ui_revoke_provider_auth_config_v1(jsonb_build_object(
      'config_id', v_config_id,
      'reason', 'pgtap-credential-revoke'
    ));
    EXECUTE 'SET LOCAL ROLE postgres';
    RETURN NEXT ok(
      COALESCE((v_result->>'ok')::boolean, FALSE)
      AND EXISTS (
        SELECT 1
          FROM public.provider_auth_configs pac
         WHERE pac.id = v_config_id
           AND pac.credentials_vault_id IS NULL
           AND COALESCE((pac.credentials->>'revoked')::boolean, FALSE) = TRUE
           AND pac.expires_at <= now()
      )
      AND EXISTS (
        SELECT 1
          FROM public.decision_log dl
         WHERE dl.resource_id = v_config_id
           AND dl.decision_category = 'integrations.revoke_credential'
      ),
      'provider credential revoke tombstones credentials and records governance evidence'
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN NEXT fail('provider credential revoke raised ' || SQLSTATE || ': ' || SQLERRM);
  END;

  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.integration_plugins (id, organization_id, plugin_key, name, status, created_by, updated_by)
  VALUES (v_plugin, v_org, 'console-v2-ops-gap-plugin', 'Console V2 Ops Gap Plugin', 'active', v_ops, v_ops)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.integration_plugin_versions (id, plugin_id, organization_id, version_no, status, source_type, created_by, updated_by)
  VALUES (v_plugin_version, v_plugin, v_org, 1, 'active', 'manual', v_ops, v_ops)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.integration_plugin_bindings (
    id,
    plugin_version_id,
    organization_id,
    scope_type,
    scope_id,
    binding_type,
    runtime_resource_type,
    runtime_resource_id,
    enabled,
    created_by
  )
  VALUES (
    v_plugin_binding,
    v_plugin_version,
    v_org,
    'tenant',
    v_org,
    'provider',
    'providers',
    v_provider,
    TRUE,
    v_ops
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
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

  BEGIN
    v_result := api.integration_plugin_rotate_credentials_v1(
      v_plugin_version,
      'api_key',
      jsonb_build_object('key', 'pgtap-secret-rotated'),
      now() + INTERVAL '365 days',
      'pgtap rotate'
    );
    v_rotated_config_id := NULLIF(v_result->>'auth_config_id', '')::uuid;
    EXECUTE 'SET LOCAL ROLE postgres';
    RETURN NEXT ok(
      v_rotated_config_id IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM public.provider_auth_configs pac
         WHERE pac.id = v_rotated_config_id
           AND pac.provider_id = v_provider
           AND pac.credentials IS NULL
           AND pac.credentials_vault_id IS NOT NULL
           AND public.get_provider_auth_credentials(pac.id)->>'key' = 'pgtap-secret-rotated'
      ),
      'integration_plugin_rotate_credentials_v1 creates a fresh vault-backed provider credential'
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN NEXT fail('integration_plugin_rotate_credentials_v1 raised ' || SQLSTATE || ': ' || SQLERRM);
  END;

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.integration_plugin_versions ipv
       WHERE ipv.id = v_plugin_version
         AND ipv.auth_bindings->>'latest_auth_config_id' = v_rotated_config_id::text
    )
    AND EXISTS (
      SELECT 1
        FROM public.integration_plugin_approval_events e
       WHERE e.plugin_version_id = v_plugin_version
         AND e.action = 'rotated_credentials'
    )
    AND NOT COALESCE((
      SELECT to_jsonb(d)::text LIKE '%pgtap-secret-rotated%'
        FROM public.v_integration_credential_directory d
       WHERE d.id = v_rotated_config_id
       LIMIT 1
    ), TRUE),
    'provider credential rotation updates plugin binding, records event, and stays redacted in directory'
  );

  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
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

  BEGIN
    v_result := api.ui_list_resource_v1(
      'provider_auth_configs', '{}'::jsonb, 50, 0, NULL::jsonb
    );
    v_credential_rows := COALESCE(v_result->'rows', v_result->'items', '[]'::jsonb);
    RETURN NEXT ok(
      COALESCE(jsonb_array_length(v_credential_rows), 0) > 0
      AND EXISTS (
        SELECT 1
          FROM jsonb_array_elements(v_credential_rows) AS row(value)
         WHERE row.value->>'id' = v_rotated_config_id::text
      )
      AND NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(v_credential_rows) AS row(value)
         WHERE row.value->>'provider_id' = v_other_provider::text
            OR row.value->>'id' = v_other_config::text
      )
      AND api.ui_get_resource_v1('provider_auth_configs', v_other_config) IS NULL
      AND v_credential_rows::text NOT LIKE '%pgtap-secret-%',
      'the credential API returns redacted own-tenant metadata and hides the foreign config'
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN NEXT fail('integration credential directory live read raised ' || SQLSTATE || ': ' || SQLERRM);
  END;

  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
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

  BEGIN
    v_manual_result := api.ui_create_shipment_v1(
      v_client,
      v_sender,
      'delivery',
      v_manual_tracking,
      'PGTAP-MANUAL-REF-8600-001',
      NULL,
      'pending',
      jsonb_build_object('pgtap', 'console-v2-operations')
    );
    v_manual_shipment_id := NULLIF(v_manual_result->>'shipment_id', '')::uuid;
    EXECUTE 'SET LOCAL ROLE postgres';
    RETURN NEXT ok(
      v_manual_result->>'status' = 'shipment_created'
      AND v_manual_shipment_id IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM public.shipments s
         WHERE s.id = v_manual_shipment_id
           AND s.client_id = v_client
           AND s.tracking_number = v_manual_tracking
           AND s.metadata->>'source' = 'ui.manual_create'
      ),
      'manual shipment create executes workflow and persists shipment through UI API'
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN NEXT fail('manual shipment create raised ' || SQLSTATE || ': ' || SQLERRM);
  END;

  RETURN NEXT ok(
    to_regprocedure('public.tabular_import_prepare_v1(jsonb)') IS NOT NULL
    AND to_regprocedure('api.ui_start_tabular_import_run_v1(uuid, jsonb)') IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
       WHERE item.value->>'key' = 'shipments'
         AND item.value->>'capability_write' = 'shipments.write'
         AND COALESCE(item.value->'import', '{}'::jsonb) <> '{}'::jsonb
    ),
    'manual shipment import is wired through tabular import prepare/start and shipments import metadata'
  );

  RETURN NEXT is(
    public.resolve_webhook_shipment_intent_v1(
      jsonb_build_object('status', 'delivered'),
      'shipment_update_status',
      'shipment.updated'
    )->>'canonical_intent',
    'update.status',
    'explicit shipment.updated typed status intent is preserved as update.status'
  );

  RETURN NEXT is(
    public.resolve_webhook_shipment_intent_v1(
      jsonb_build_object('status', 'delivered'),
      NULL,
      'shipment.updated'
    )->>'canonical_intent',
    'update.status',
    'generic shipment.updated status payload derives update.status typed intent'
  );

  RETURN NEXT is(
    public.resolve_webhook_shipment_intent_v1(
      jsonb_build_object('status', 'delivered', 'address', jsonb_build_object('city', 'Riyadh')),
      NULL,
      'shipment.updated'
    )->>'canonical_intent',
    'update.address',
    'generic shipment.updated address+status payload derives the specific address typed intent'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  DELETE FROM public.scan_events
   WHERE organization_id = v_org
     AND route_run_id IN (v_route, v_route_two)
     AND captured_at >= date_trunc('month', now());

  v_result := public.route_run_scan_out_reconciliation_v1(v_route);
  RETURN NEXT ok(
    COALESCE((v_result->>'ready_for_departure')::boolean, FALSE) = FALSE
    AND (v_result->>'expected_stop_count')::int = 2
    AND (v_result->>'missing_stop_count')::int = 2,
    'departure scan-out reconciliation blocks route departure before load scans'
  );

  INSERT INTO public.scan_events (
    id,
    organization_id,
    actor_user_id,
    route_run_id,
    route_stop_id,
    branch_id,
    client_id,
    shipment_id,
    scan_type,
    barcode,
    captured_at
  )
  VALUES
    (gen_random_uuid(), v_org, v_driver, v_route, v_stop_one, v_branch, v_client, v_shipment_one, 'load', 'PGTAP-DEP-8600-001', now()),
    (gen_random_uuid(), v_org, v_driver, v_route, v_stop_two, v_branch, v_client, v_shipment_two, 'load', 'PGTAP-DEP-8600-002', now());

  v_result := public.route_run_scan_out_reconciliation_v1(v_route);
  RETURN NEXT ok(
    COALESCE((v_result->>'ready_for_departure')::boolean, FALSE) = TRUE
    AND (v_result->>'scanned_stop_count')::int = 2
    AND (v_result->>'missing_stop_count')::int = 0
    AND (v_result->>'unexpected_scan_count')::int = 0,
    'departure scan-out reconciliation marks route ready after all planned load scans'
  );

  INSERT INTO public.scan_events (
    id,
    organization_id,
    actor_user_id,
    route_run_id,
    route_stop_id,
    branch_id,
    client_id,
    shipment_id,
    scan_type,
    barcode,
    captured_at
  )
  VALUES (
    gen_random_uuid(),
    v_org,
    v_driver,
    v_route_two,
    NULL,
    v_branch,
    NULL,
    NULL,
    'load',
    'PGTAP-UNEXPECTED-8600',
    now()
  );

  v_result_two := public.route_run_scan_out_reconciliation_v1(v_route_two);
  RETURN NEXT ok(
    COALESCE((v_result_two->>'ready_for_departure')::boolean, FALSE) = FALSE
    AND (v_result_two->>'unexpected_scan_count')::int = 1,
    'departure scan-out reconciliation blocks route departure on unexpected load scans'
  );

  RETURN NEXT ok(
    to_regprocedure('public.ui_get_shipment_timeline_v1(uuid)') IS NOT NULL
    AND to_regprocedure('api.ui_get_shipment_timeline_v1(uuid)') IS NOT NULL,
    'shipment supervision read pack exposes public and api timeline readers'
  );

  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
        FROM unnest(ARRAY[
          'shipments',
          'shipment_directory',
          'shipment_boxes',
          'recipients',
          'addresses',
          'route_stops',
          'route_runs',
          'labels',
          'scan_events',
          'decision_log',
          'comms_attempts'
        ]) AS required_key(key)
       WHERE NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
          WHERE item.value->>'key' = required_key.key
       )
    ),
    'shipment supervision read pack registry includes drawer resources, including communications attempts'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
       WHERE item.value->>'key' = 'shipments'
         AND COALESCE(item.value->'related', '[]'::jsonb) @> jsonb_build_array(
           jsonb_build_object('resource', 'shipment_boxes')
         )
         AND COALESCE(item.value->'related', '[]'::jsonb) @> jsonb_build_array(
           jsonb_build_object('resource', 'labels')
         )
         AND COALESCE(item.value->'related', '[]'::jsonb) @> jsonb_build_array(
           jsonb_build_object('resource', 'shipment_reference_numbers')
         )
    ),
    'shipment supervision read pack keeps shipments related rows for boxes, labels, and reference numbers'
  );

  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
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

  BEGIN
    v_result := api.ui_list_resource_v1(
      'comms_attempts',
      jsonb_build_object('shipment_id', v_shipment_one::text),
      25,
      0,
      NULL::jsonb
    );
    v_comms_rows := COALESCE(v_result->'rows', v_result->'items', '[]'::jsonb);
    RETURN NEXT ok(
      NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(v_comms_rows) AS row(value)
         WHERE row.value->>'id' = v_comms_attempt::text
      )
      AND v_comms_rows::text NOT LIKE '%pgtap-secret-header%'
      AND v_comms_rows::text NOT LIKE '%pgtap-secret-body%'
      AND v_comms_rows::text NOT LIKE '%pgtap-secret-context%',
      'the tenant cannot read trusted-only communications telemetry through the API'
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN NEXT fail('comms attempts live read raised ' || SQLSTATE || ': ' || SQLERRM);
  END;

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
       WHERE item.value->>'key' = 'settlement_batch_summary'
         AND item.value#>>'{scope_columns,tenant}' = 'organization_id'
         AND COALESCE(item.value->'filters', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'))
         AND COALESCE(item.value->'filters', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('key', 'kind', 'column', 'kind', 'op', 'eq'))
    ),
    'settlement batch summary directory has tenant scope plus status/kind filters'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
       WHERE item.value->>'key' = 'settlement_batches'
         AND item.value#>>'{scope_columns,tenant}' = 'organization_id'
         AND COALESCE(item.value->'filters', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'))
         AND COALESCE(item.value->'filters', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('key', 'kind', 'column', 'kind', 'op', 'eq'))
    ),
    'settlement batches directory has tenant scope plus status/kind filters'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_operations_execution_gaps_v1();

SELECT * FROM finish();
ROLLBACK;
