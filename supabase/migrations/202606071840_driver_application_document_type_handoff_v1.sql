-- Driver application documents must materialize into canonical fleet documents.
--
-- Application document kinds are operator-facing intake values, while
-- driver_documents.doc_type is the fleet inventory taxonomy. Keep the bridge
-- row-driven through lookup metadata so approval does not depend on app-side
-- branches or hardcoded RPC conditionals.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606071840_driver_application_document_type_handoff_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable
)
VALUES (
  'driver_document_type',
  'Driver document types used by canonical fleet driver_documents inventory.',
  'ops',
  'tier_1',
  true
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  updated_at = now();

WITH driver_document_type_rows AS (
  SELECT *
  FROM (
    VALUES
      ('driver_license', 'Driver License', 'Driver license document.', 10, false, jsonb_build_object('source', 'fleet')),
      ('national_id', 'National ID', 'National ID/iqama document.', 20, false, jsonb_build_object('source', 'fleet')),
      ('medical', 'Medical certificate', 'Medical clearance document.', 30, false, jsonb_build_object('source', 'driver_application_doc_kind')),
      ('vehicle_inspection', 'Vehicle inspection', 'Vehicle inspection document.', 40, false, jsonb_build_object('source', 'driver_application_doc_kind')),
      ('insurance', 'Insurance', 'Insurance document.', 50, false, jsonb_build_object('source', 'driver_application_doc_kind')),
      ('hazmat_endorsement', 'Hazmat endorsement', 'Hazmat endorsement document.', 60, false, jsonb_build_object('source', 'driver_application_doc_kind'))
  ) AS v(value, label, description, sort_order, is_default, metadata)
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  ld.id,
  r.value,
  r.label,
  r.description,
  r.sort_order,
  r.is_default,
  'active',
  r.metadata
FROM public.lookup_definitions ld
JOIN driver_document_type_rows r ON ld.category = 'driver_document_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  status = 'active',
  effective_until = NULL,
  retired_at = NULL,
  metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
  updated_at = now();

WITH application_document_mappings AS (
  SELECT *
  FROM (
    VALUES
      ('license', 'driver_license'),
      ('national_id', 'national_id'),
      ('medical', 'medical'),
      ('vehicle_inspection', 'vehicle_inspection'),
      ('insurance', 'insurance'),
      ('hazmat_endorsement', 'hazmat_endorsement')
  ) AS v(application_doc_kind, fleet_document_type)
)
UPDATE public.lookup_values lv
SET
  metadata = COALESCE(lv.metadata, '{}'::jsonb)
    || jsonb_build_object(
         'fleet_document_type', m.fleet_document_type,
         'driver_document_type', m.fleet_document_type
       ),
  updated_at = now()
FROM public.lookup_definitions ld,
     application_document_mappings m
WHERE lv.lookup_definition_id = ld.id
  AND ld.category = 'driver_application_doc_kind'
  AND lv.value = m.application_doc_kind;

CREATE OR REPLACE FUNCTION public.marketplace_provision_freelancer_driver_fleet_profile_v1(
  p_request_id UUID,
  p_actor_user_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_req public.marketplace_participant_requests%ROWTYPE;
  v_status TEXT;
  v_driver_profile_id UUID;
  v_profile_created BOOLEAN := FALSE;
  v_doc RECORD;
  v_source_doc_type TEXT;
  v_doc_type TEXT;
  v_doc_status TEXT;
  v_docs_created INTEGER := 0;
  v_docs_existing INTEGER := 0;
  v_event_id UUID := gen_random_uuid();
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'marketplace_provision_freelancer_driver_fleet_profile_v1: request_id is required'
      USING ERRCODE = '22023';
  END IF;
  IF p_metadata IS NOT NULL AND jsonb_typeof(p_metadata) <> 'object' THEN
    RAISE EXCEPTION 'marketplace_provision_freelancer_driver_fleet_profile_v1: metadata must be an object'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_req
    FROM public.marketplace_participant_requests
   WHERE id = p_request_id
   FOR UPDATE;

  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'marketplace_provision_freelancer_driver_fleet_profile_v1: request % not found', p_request_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_req.requested_participant_type_key <> 'freelancer_driver' THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE, 'reason', 'not_freelancer_driver');
  END IF;

  IF v_req.status <> 'approved' THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE, 'reason', 'request_not_approved');
  END IF;

  IF v_req.approved_organization_id IS NULL OR v_req.approved_user_id IS NULL THEN
    RAISE EXCEPTION 'marketplace_provision_freelancer_driver_fleet_profile_v1: approved organization and user are required for request %', v_req.id
      USING ERRCODE = '23514';
  END IF;

  SELECT lv.value
    INTO v_status
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'driver_status'
     AND lv.is_default IS TRUE
   ORDER BY lv.sort_order, lv.value
   LIMIT 1;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'marketplace_provision_freelancer_driver_fleet_profile_v1: no default driver_status lookup row is configured'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.driver_profiles (
    organization_id,
    user_id,
    status,
    hired_at,
    metadata
  )
  VALUES (
    v_req.approved_organization_id,
    v_req.approved_user_id,
    v_status,
    now(),
    jsonb_strip_nulls(
      jsonb_build_object(
        'created_by', 'marketplace_provision_freelancer_driver_fleet_profile_v1',
        'created_correlation_id', v_correlation_id,
        'marketplace_request_id', v_req.id,
        'marketplace_participant_profile_id', v_req.approved_participant_profile_id,
        'application_status_token', v_req.public_status_token,
        'source', 'driver_application_approval',
        'phone', v_req.phone,
        'capabilities_requested', v_req.capabilities_requested
      )
    ) || COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (organization_id, user_id) DO UPDATE
  SET hired_at = COALESCE(public.driver_profiles.hired_at, EXCLUDED.hired_at),
      metadata = COALESCE(public.driver_profiles.metadata, '{}'::jsonb)
        || EXCLUDED.metadata
        || jsonb_build_object('fleet_handoff_refreshed_at', now()),
      updated_at = now()
  RETURNING id, (xmax = 0) INTO v_driver_profile_id, v_profile_created;

  FOR v_doc IN
    SELECT value, ordinality
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(v_req.verification_documents) = 'array' THEN v_req.verification_documents
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS doc(value, ordinality)
  LOOP
    v_source_doc_type := lower(NULLIF(btrim(COALESCE(v_doc.value->>'document_type_key', v_doc.value->>'type', '')), ''));
    IF v_source_doc_type IS NULL THEN
      CONTINUE;
    END IF;

    SELECT lower(NULLIF(btrim(COALESCE(
             lv.metadata->>'fleet_document_type',
             lv.metadata->>'driver_document_type'
           )), ''))
      INTO v_doc_type
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'driver_application_doc_kind'
       AND lv.value = v_source_doc_type
       AND COALESCE(lv.status, 'active') = 'active'
     ORDER BY lv.sort_order, lv.value
     LIMIT 1;

    v_doc_type := COALESCE(v_doc_type, v_source_doc_type);

    IF NOT EXISTS (
      SELECT 1
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'driver_document_type'
         AND lv.value = v_doc_type
         AND COALESCE(lv.status, 'active') = 'active'
    ) THEN
      CONTINUE;
    END IF;

    v_doc_status := CASE lower(NULLIF(btrim(COALESCE(v_doc.value->>'status', '')), ''))
      WHEN 'approved' THEN 'verified'
      WHEN 'verified' THEN 'verified'
      WHEN 'rejected' THEN 'rejected'
      WHEN 'expired' THEN 'expired'
      ELSE 'submitted'
    END;

    INSERT INTO public.driver_documents (
      organization_id,
      user_id,
      doc_type,
      status,
      document_ref_hash,
      issued_at,
      expires_at,
      verified_at,
      verified_by_user_id,
      metadata
    )
    SELECT
      v_req.approved_organization_id,
      v_req.approved_user_id,
      v_doc_type,
      v_doc_status,
      NULLIF(btrim(COALESCE(v_doc.value->>'document_ref_hash', v_doc.value->>'document_ref', v_doc.value->>'ref', '')), ''),
      NULLIF(btrim(COALESCE(v_doc.value->>'issued_at', '')), '')::DATE,
      NULLIF(btrim(COALESCE(v_doc.value->>'expires_at', '')), '')::DATE,
      CASE WHEN v_doc_status = 'verified' THEN now() ELSE NULL END,
      CASE
        WHEN v_doc_status = 'verified'
         AND EXISTS (
           SELECT 1
             FROM public.users verifier
            WHERE verifier.id = p_actor_user_id
              AND verifier.organization_id = v_req.approved_organization_id
         )
          THEN p_actor_user_id
        ELSE NULL
      END,
      jsonb_strip_nulls(
        jsonb_build_object(
          'source', 'driver_application_approval',
          'marketplace_request_id', v_req.id,
          'marketplace_document_index', v_doc.ordinality,
          'marketplace_document_status', v_doc.value->>'status',
          'source_document_type_key', v_source_doc_type,
          'resolved_driver_document_type', v_doc_type,
          'source_document_ref_present', (v_doc.value ? 'document_ref') OR (v_doc.value ? 'ref') OR (v_doc.value ? 'document_ref_hash')
        )
      ) || CASE
        WHEN jsonb_typeof(v_doc.value->'metadata') = 'object' THEN v_doc.value->'metadata'
        ELSE '{}'::jsonb
      END
    WHERE NOT EXISTS (
      SELECT 1
        FROM public.driver_documents dd
       WHERE dd.organization_id = v_req.approved_organization_id
         AND dd.user_id = v_req.approved_user_id
         AND dd.doc_type = v_doc_type
         AND dd.metadata->>'marketplace_request_id' = v_req.id::text
         AND dd.metadata->>'marketplace_document_index' = v_doc.ordinality::text
    );

    IF FOUND THEN
      v_docs_created := v_docs_created + 1;
    ELSE
      v_docs_existing := v_docs_existing + 1;
    END IF;
  END LOOP;

  INSERT INTO public.driver_compliance_events (
    id,
    organization_id,
    user_id,
    event_type,
    actor_user_id,
    actor_system,
    payload
  )
  SELECT
    v_event_id,
    v_req.approved_organization_id,
    v_req.approved_user_id,
    'marketplace_driver_approved',
    p_actor_user_id,
    'marketplace_provision_freelancer_driver_fleet_profile_v1',
    jsonb_build_object(
      'driver_profile_id', v_driver_profile_id,
      'marketplace_request_id', v_req.id,
      'marketplace_participant_profile_id', v_req.approved_participant_profile_id,
      'correlation_id', v_correlation_id,
      'documents_created', v_docs_created,
      'documents_existing', v_docs_existing
    )
  WHERE NOT EXISTS (
    SELECT 1
      FROM public.driver_compliance_events dce
     WHERE dce.organization_id = v_req.approved_organization_id
       AND dce.user_id = v_req.approved_user_id
       AND dce.event_type = 'marketplace_driver_approved'
       AND dce.payload->>'marketplace_request_id' = v_req.id::text
  );

  PERFORM public.enqueue_domain_event(
    v_req.approved_organization_id,
    'fleet.driver_onboarding_approved',
    'driver_profile',
    v_driver_profile_id,
    jsonb_build_object(
      'driver_user_id', v_req.approved_user_id,
      'marketplace_request_id', v_req.id,
      'documents_created', v_docs_created
    ),
    v_correlation_id
  );

  PERFORM public.log_decision(
    v_req.approved_organization_id,
    'fleet.driver_created',
    'driver_profile',
    v_driver_profile_id,
    'marketplace_participant_request.review',
    CASE WHEN v_profile_created THEN 'created' ELSE 'reconciled' END,
    'marketplace_provision_freelancer_driver_fleet_profile_v1',
    v_correlation_id,
    jsonb_build_object(
      'driver_user_id', v_req.approved_user_id,
      'marketplace_request_id', v_req.id,
      'driver_status_source', 'lookup_values.driver_status',
      'document_type_source', 'lookup_values.driver_application_doc_kind.metadata.fleet_document_type',
      'documents_created', v_docs_created,
      'documents_existing', v_docs_existing
    ),
    NULL
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'driver_profile_id', v_driver_profile_id,
    'driver_user_id', v_req.approved_user_id,
    'organization_id', v_req.approved_organization_id,
    'status', v_status,
    'created', v_profile_created,
    'documents_created', v_docs_created,
    'documents_existing', v_docs_existing,
    'correlation_id', v_correlation_id,
    'resolved_from', 'marketplace_participant_request/driver_status/driver_application_doc_kind'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.marketplace_provision_freelancer_driver_fleet_profile_v1(UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_provision_freelancer_driver_fleet_profile_v1(UUID, UUID, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.marketplace_provision_freelancer_driver_fleet_profile_v1(UUID, UUID, JSONB) TO service_role;

COMMENT ON FUNCTION public.marketplace_provision_freelancer_driver_fleet_profile_v1(UUID, UUID, JSONB)
  IS 'Materializes approved freelancer_driver marketplace applications into canonical fleet driver_profiles, driver_documents, and compliance ledger rows. Driver application document kinds resolve to driver_documents.doc_type through lookup_values.driver_application_doc_kind metadata and active driver_document_type rows.';

SELECT pg_advisory_unlock(hashtext('202606071840_driver_application_document_type_handoff_v1'));

COMMIT;
