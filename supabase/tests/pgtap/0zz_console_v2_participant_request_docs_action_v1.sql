-- pgTAP: Console V2 Network participant applications request-docs action.
-- Proves the row-driven lookup contract and backend pending-state review
-- lineage used by /network/participant-applications.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-000087300001';
  v_reviewer UUID := '00000000-0000-0000-0000-000087300002';
  v_request UUID := '00000000-0000-0000-0000-000087300003';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Network Request Docs Org', 'console-v2-network-request-docs')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES (
    v_reviewer,
    v_org,
    'console-v2-network-request-docs-reviewer@example.com',
    'Console V2 Network Request Docs Reviewer',
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
    'partner_carrier',
    v_org,
    'console-v2-network-request-docs-applicant@example.com',
    'Console V2 Network Request Docs Applicant',
    'Console V2 Network Request Docs Org',
    'console-v2-network-request-docs',
    jsonb_build_array('carrier_network'),
    jsonb_build_array(),
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

  DELETE FROM public.marketplace_events
   WHERE resource_type = 'marketplace_participant_request'
     AND resource_id = v_request;

  PERFORM set_config('test.participant_request_docs_org', v_org::TEXT, TRUE);
  PERFORM set_config('test.participant_request_docs_reviewer', v_reviewer::TEXT, TRUE);
  PERFORM set_config('test.participant_request_docs_request', v_request::TEXT, TRUE);

  EXECUTE 'RESET ROLE';
END $$;

CREATE TEMP TABLE participant_request_docs_result(payload jsonb) ON COMMIT DROP;

SET LOCAL ROLE postgres;

INSERT INTO participant_request_docs_result(payload)
SELECT public.marketplace_participant_request_review_apply_v1(
  current_setting('test.participant_request_docs_request')::UUID,
  'request_additional_docs',
  current_setting('test.participant_request_docs_reviewer')::UUID,
  NULL,
  FALSE,
  NULL,
  NULL,
  NULL,
  jsonb_build_object(
    'request_additional_docs', TRUE,
    'requested_documents', jsonb_build_array('commercial_registration'),
    'reason', 'PgTapNetworkDocsReadback',
    'note', 'PgTapNetworkDocsReadback'
  )
);

RESET ROLE;

SELECT ok(
  to_regprocedure('public.marketplace_participant_request_review_apply_v1(uuid,text,uuid,uuid,boolean,text,uuid,uuid,jsonb)') IS NOT NULL,
  'public marketplace participant review RPC exists'
);

SELECT ok(
  to_regprocedure('api.marketplace_participant_request_review_apply_v1(uuid,text,uuid,uuid,boolean,text,uuid,uuid,jsonb)') IS NOT NULL,
  'api marketplace participant review wrapper exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions
     WHERE category = 'marketplace_participant_application_doc_kind'
       AND scope_type = 'global'
  ),
  'non-driver participant application doc-kind lookup definition exists globally'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions d
      JOIN public.lookup_values v ON v.lookup_definition_id = d.id
     WHERE d.category = 'marketplace_participant_application_doc_kind'
       AND v.value = 'commercial_registration'
       AND v.is_default IS TRUE
       AND v.status = 'active'
       AND v.metadata->>'tone' = 'info'
  ),
  'commercial registration doc-kind row is active and default'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions d
      JOIN public.lookup_values v ON v.lookup_definition_id = d.id
     WHERE d.category = 'marketplace_participant_request_status'
       AND v.value = 'pending'
       AND (v.metadata->'allowed_actions') ? 'approve'
       AND (v.metadata->'allowed_actions') ? 'reject'
       AND (v.metadata->'allowed_actions') ? 'request_additional_docs'
       AND v.status = 'active'
  ),
  'pending participant status exposes row-driven request-docs action'
);

SELECT is(
  (SELECT payload->>'decision' FROM participant_request_docs_result LIMIT 1),
  'request_additional_docs',
  'request-docs RPC result returns the pending-state decision'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.marketplace_participant_requests
     WHERE id = current_setting('test.participant_request_docs_request')::UUID
       AND status = 'pending'
       AND review_decision IS NULL
       AND reviewed_at IS NOT NULL
       AND reviewed_by = current_setting('test.participant_request_docs_reviewer')::UUID
       AND review_reason = 'PgTapNetworkDocsReadback'
       AND approved_participant_profile_id IS NULL
  ),
  'request-docs review keeps the application pending without materializing a profile'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.marketplace_participant_requests
     WHERE id = current_setting('test.participant_request_docs_request')::UUID
       AND decision_metadata->>'decision' = 'request_additional_docs'
       AND (decision_metadata->>'request_additional_docs')::boolean IS TRUE
       AND (decision_metadata->'requested_documents') ? 'commercial_registration'
       AND decision_metadata->>'note' = 'PgTapNetworkDocsReadback'
  ),
  'request-docs readback carries requested document metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.decision_log
     WHERE resource_type = 'marketplace_participant_request'
       AND resource_id = current_setting('test.participant_request_docs_request')::UUID
       AND decision_point = 'participant_request.review'
       AND decision_outcome = 'request_additional_docs'
       AND decision_reason = 'PgTapNetworkDocsReadback'
  ),
  'request-docs review writes decision-log lineage'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.marketplace_events
     WHERE resource_type = 'marketplace_participant_request'
       AND resource_id = current_setting('test.participant_request_docs_request')::UUID
       AND event_type = 'participant_request.additional_docs_requested'
       AND (payload->'requested_documents') ? 'commercial_registration'
  ),
  'request-docs review writes marketplace event lineage'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.lookup_definitions d
      JOIN public.lookup_values v ON v.lookup_definition_id = d.id
     WHERE d.category = 'marketplace_participant_request_status'
       AND v.value IN ('approved', 'rejected', 'withdrawn')
       AND COALESCE(v.metadata->'allowed_actions', '[]'::jsonb) ? 'request_additional_docs'
  ),
  'terminal participant statuses do not expose request-docs action'
);

SELECT ok(
  (SELECT COUNT(*)
     FROM public.lookup_definitions d
     JOIN public.lookup_values v ON v.lookup_definition_id = d.id
    WHERE d.category = 'marketplace_participant_application_doc_kind'
      AND v.status = 'active') >= 5,
  'non-driver participant application has a complete requestable doc-kind set'
);

SELECT * FROM finish();
ROLLBACK;
