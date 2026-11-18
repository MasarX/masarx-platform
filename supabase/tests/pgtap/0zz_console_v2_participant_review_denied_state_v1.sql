-- pgTAP: Console V2 participant/driver application review actions deny
-- authenticated lower-permission callers before mutating review state or
-- writing review lineage.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

SET search_path TO public, pgtap, extensions, pg_temp;

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000e771';
  v_limited UUID := '00000000-0000-0000-0000-00000000e772';
  v_request UUID := '00000000-0000-0000-0000-00000000e773';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Participant Review Denied Org', 'console-v2-participant-review-denied')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_limited,
    v_org,
    'participant-review-denied-limited@example.com',
    'Participant Review Denied Limited',
    'driver',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

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
    v_request,
    'pending',
    'freelancer_driver',
    v_org,
    'participant-review-denied-applicant@example.com',
    'Participant Review Denied Applicant',
    'Console V2 Participant Review Denied Org',
    'console-v2-participant-review-denied',
    jsonb_build_array('local_delivery'),
    jsonb_build_array(
      jsonb_build_object('document_type_key', 'driver_license', 'status', 'approved', 'document_ref', 'denied-license')
    ),
    TRUE,
    '{}'::jsonb
  )
  ON CONFLICT (id) DO UPDATE
     SET status = 'pending',
         review_decision = NULL,
         reviewed_at = NULL,
         reviewed_by = NULL,
         review_reason = NULL,
         approved_organization_id = NULL,
         approved_user_id = NULL,
         approved_auth_user_id = NULL,
         approved_participant_profile_id = NULL,
         decision_metadata = '{}'::jsonb,
         last_error_code = NULL,
         last_error_message = NULL;

  DELETE FROM public.decision_log
   WHERE resource_type = 'marketplace_participant_request'
     AND resource_id = v_request;

  DELETE FROM public.domain_events
   WHERE resource_type = 'marketplace_participant_request'
     AND resource_id = v_request;

  PERFORM set_config('test.participant_review_denied_org', v_org::TEXT, TRUE);
  PERFORM set_config('test.participant_review_denied_limited', v_limited::TEXT, TRUE);
  PERFORM set_config('test.participant_review_denied_request', v_request::TEXT, TRUE);

  EXECUTE 'RESET ROLE';
END $$;

SELECT ok(
  to_regprocedure('public.marketplace_participant_request_review_apply_v1(uuid,text,uuid,uuid,boolean,text,uuid,uuid,jsonb)') IS NOT NULL,
  'public marketplace_participant_request_review_apply_v1 exists'
);

SELECT ok(
  to_regprocedure('api.marketplace_participant_request_review_apply_v1(uuid,text,uuid,uuid,boolean,text,uuid,uuid,jsonb)') IS NOT NULL,
  'api marketplace_participant_request_review_apply_v1 wrapper exists'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.marketplace_participant_request_review_apply_v1(uuid,text,uuid,uuid,boolean,text,uuid,uuid,jsonb)',
    'EXECUTE'
  ),
  'authenticated cannot execute public marketplace participant review RPC'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'api.marketplace_participant_request_review_apply_v1(uuid,text,uuid,uuid,boolean,text,uuid,uuid,jsonb)',
    'EXECUTE'
  ),
  'authenticated cannot execute api marketplace participant review wrapper'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.marketplace_participant_requests
     WHERE id = current_setting('test.participant_review_denied_request')::UUID
       AND status = 'pending'
       AND review_decision IS NULL
       AND reviewed_at IS NULL
       AND reviewed_by IS NULL
       AND approved_organization_id IS NULL
       AND approved_user_id IS NULL
       AND approved_auth_user_id IS NULL
       AND approved_participant_profile_id IS NULL
       AND COALESCE(decision_metadata, '{}'::jsonb) = '{}'::jsonb
  ),
  'denied participant review attempts leave request state unchanged'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.decision_log
     WHERE resource_type = 'marketplace_participant_request'
       AND resource_id = current_setting('test.participant_review_denied_request')::UUID
  ),
  'denied participant review attempts write no decision-log lineage'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.domain_events
     WHERE resource_type = 'marketplace_participant_request'
       AND resource_id = current_setting('test.participant_review_denied_request')::UUID
  ),
  'denied participant review attempts write no domain-event lineage'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'resources') AS resource
          WHERE resource->>'key' = 'marketplace_participant_requests'
            AND resource->>'capability_write' = 'marketplace_participant_requests.review'
       )
  ),
  'participant request registry keeps review capability as the write gate'
);

SELECT * FROM finish();

ROLLBACK;
