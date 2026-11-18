-- Plan: Console V2 operations lifecycle closure
-- Step: fleet driver create, driver document upload, and live HOS projection.
--
-- Scope:
--   - Create a driver profile for an existing tenant user.
--   - Attach an already-registered artifact as a submitted driver document.
--   - Replace the placeholder HOS resolver with a live aggregate projection.
--   - Expose matching api-schema wrappers for Console V2 browser clients.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605041130_console_v2_fleet_lifecycle_closure_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_driver_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();

  v_user_id UUID;
  v_driver_code TEXT;
  v_status TEXT;
  v_hired_at TIMESTAMPTZ;
  v_metadata JSONB;

  v_user public.users%ROWTYPE;
  v_driver_profile_id UUID;
  v_created BOOLEAN := FALSE;
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'create_driver_v1: p_args must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'create_driver_v1: authenticated tenant user required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('fleet.write', v_scope_type, v_scope_id);

  v_user_id := NULLIF(btrim(COALESCE(p_args->>'user_id', p_args->>'driver_user_id', '')), '')::UUID;
  v_driver_code := NULLIF(btrim(COALESCE(p_args->>'driver_code', '')), '');
  v_status := lower(NULLIF(btrim(COALESCE(p_args->>'status', '')), ''));
  v_hired_at := NULLIF(btrim(COALESCE(p_args->>'hired_at', '')), '')::TIMESTAMPTZ;
  v_metadata := COALESCE(p_args->'metadata', '{}'::jsonb);

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'create_driver_v1: user_id or driver_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_metadata) <> 'object' THEN
    RAISE EXCEPTION 'create_driver_v1: metadata must be a JSON object' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_user
    FROM public.users
   WHERE id = v_user_id;
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'create_driver_v1: user % not found', v_user_id USING ERRCODE = 'P0002';
  END IF;
  IF v_user.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'create_driver_v1: user % belongs to another organization', v_user_id USING ERRCODE = '42501';
  END IF;

  IF v_status IS NULL THEN
    SELECT lv.value
      INTO v_status
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'driver_status'
       AND lv.is_default IS TRUE
     ORDER BY lv.sort_order, lv.value
     LIMIT 1;
  END IF;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'create_driver_v1: no default driver_status lookup row is configured' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'driver_status'
       AND lv.value = v_status
  ) THEN
    RAISE EXCEPTION 'create_driver_v1: status % not in lookup driver_status', v_status USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.driver_profiles (
    organization_id,
    user_id,
    driver_code,
    status,
    hired_at,
    metadata
  )
  VALUES (
    v_org_id,
    v_user_id,
    v_driver_code,
    v_status,
    v_hired_at,
    v_metadata || jsonb_build_object(
      'created_by', 'create_driver_v1',
      'created_correlation_id', v_correlation_id
    )
  )
  ON CONFLICT (organization_id, user_id) DO NOTHING
  RETURNING id INTO v_driver_profile_id;

  IF v_driver_profile_id IS NOT NULL THEN
    v_created := TRUE;

    PERFORM public.enqueue_domain_event(
      v_org_id,
      'fleet.driver_created',
      'driver_profile',
      v_driver_profile_id,
      jsonb_build_object(
        'driver_user_id', v_user_id,
        'driver_code', v_driver_code,
        'status', v_status,
        'requested_by', auth.uid()
      ),
      v_correlation_id
    );

    PERFORM public.log_decision(
      v_org_id,
      'fleet.driver_created',
      'driver_profile',
      v_driver_profile_id,
      'rpc_dispatch',
      'created',
      'create_driver_v1',
      v_correlation_id,
      jsonb_build_object(
        'driver_user_id', v_user_id,
        'driver_code', v_driver_code,
        'status', v_status,
        'driver_status_source', 'lookup_values.driver_status'
      ),
      NULL
    );
  ELSE
    SELECT dp.id, dp.status
      INTO v_driver_profile_id, v_status
      FROM public.driver_profiles dp
     WHERE dp.organization_id = v_org_id
       AND dp.user_id = v_user_id
     LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'created', v_created,
    'driver_profile_id', v_driver_profile_id,
    'driver_user_id', v_user_id,
    'organization_id', v_org_id,
    'status', v_status,
    'correlation_id', v_correlation_id,
    'resolved_from', 'driver_status/lookup'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.upload_driver_document_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();

  v_driver_profile_id UUID;
  v_driver_user_id UUID;
  v_doc_type TEXT;
  v_status TEXT;
  v_issuer TEXT;
  v_document_ref_hash TEXT;
  v_issued_at DATE;
  v_expires_at DATE;
  v_artifact_id UUID;
  v_storage_bucket TEXT;
  v_storage_key TEXT;
  v_mime_type TEXT;
  v_size_bytes BIGINT;
  v_metadata JSONB;

  v_dp public.driver_profiles%ROWTYPE;
  v_artifact public.artifacts%ROWTYPE;
  v_driver_document_id UUID := gen_random_uuid();
  v_compliance_event_id UUID := gen_random_uuid();
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'upload_driver_document_v1: p_args must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'upload_driver_document_v1: authenticated tenant user required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('fleet.write', v_scope_type, v_scope_id);

  v_driver_profile_id := NULLIF(btrim(COALESCE(p_args->>'driver_profile_id', p_args->>'driver_id', '')), '')::UUID;
  v_driver_user_id := NULLIF(btrim(COALESCE(p_args->>'driver_user_id', p_args->>'user_id', '')), '')::UUID;
  v_doc_type := lower(NULLIF(btrim(COALESCE(p_args->>'doc_type', p_args->>'document_type', p_args->>'kind', '')), ''));
  v_issuer := NULLIF(btrim(COALESCE(p_args->>'issuer', '')), '');
  v_document_ref_hash := NULLIF(btrim(COALESCE(p_args->>'document_ref_hash', p_args->>'sha256', '')), '');
  v_issued_at := NULLIF(btrim(COALESCE(p_args->>'issued_at', '')), '')::DATE;
  v_expires_at := NULLIF(btrim(COALESCE(p_args->>'expires_at', '')), '')::DATE;
  v_artifact_id := NULLIF(btrim(COALESCE(p_args->>'artifact_id', '')), '')::UUID;
  v_storage_bucket := NULLIF(btrim(COALESCE(p_args->>'storage_bucket', '')), '');
  v_storage_key := NULLIF(btrim(COALESCE(p_args->>'storage_key', '')), '');
  v_mime_type := NULLIF(btrim(COALESCE(p_args->>'mime_type', '')), '');
  BEGIN
    v_size_bytes := NULLIF(btrim(COALESCE(p_args->>'size_bytes', '')), '')::BIGINT;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'upload_driver_document_v1: size_bytes must be a positive integer when provided'
      USING ERRCODE = '22023';
  END;
  v_metadata := COALESCE(p_args->'metadata', '{}'::jsonb);

  IF v_driver_profile_id IS NULL AND v_driver_user_id IS NULL THEN
    RAISE EXCEPTION 'upload_driver_document_v1: driver_profile_id or driver_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF v_doc_type IS NULL THEN
    RAISE EXCEPTION 'upload_driver_document_v1: doc_type is required' USING ERRCODE = '22023';
  END IF;
  IF v_artifact_id IS NULL AND (v_storage_bucket IS NULL OR v_storage_key IS NULL) THEN
    RAISE EXCEPTION 'upload_driver_document_v1: artifact_id or storage_bucket + storage_key is required'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_metadata) <> 'object' THEN
    RAISE EXCEPTION 'upload_driver_document_v1: metadata must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF v_size_bytes IS NOT NULL AND v_size_bytes < 0 THEN
    RAISE EXCEPTION 'upload_driver_document_v1: size_bytes must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF v_issued_at IS NOT NULL AND v_expires_at IS NOT NULL AND v_expires_at < v_issued_at THEN
    RAISE EXCEPTION 'upload_driver_document_v1: expires_at must be >= issued_at' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'driver_document_kind'
       AND lv.value = v_doc_type
  ) THEN
    RAISE EXCEPTION 'upload_driver_document_v1: doc_type % not in lookup driver_document_kind', v_doc_type
      USING ERRCODE = '22023';
  END IF;

  SELECT lv.value
    INTO v_status
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'driver_document_status'
     AND lv.is_default IS TRUE
   ORDER BY lv.sort_order, lv.value
   LIMIT 1;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'upload_driver_document_v1: no default driver_document_status lookup row is configured' USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_dp
    FROM public.driver_profiles
   WHERE (
       v_driver_profile_id IS NOT NULL
       AND id = v_driver_profile_id
     )
      OR (
       v_driver_profile_id IS NULL
       AND user_id = v_driver_user_id
       AND organization_id = v_org_id
     )
   LIMIT 1;
  IF v_dp.id IS NULL THEN
    RAISE EXCEPTION 'upload_driver_document_v1: driver_profile not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_dp.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'upload_driver_document_v1: driver_profile % belongs to another organization', v_dp.id USING ERRCODE = '42501';
  END IF;

  IF v_artifact_id IS NULL THEN
    SELECT ra.artifact_id
      INTO v_artifact_id
      FROM public.register_artifact_v1(jsonb_build_object(
        'organization_id', v_org_id,
        'storage_bucket', v_storage_bucket,
        'storage_key', v_storage_key,
        'mime_type', v_mime_type,
        'size_bytes', v_size_bytes,
        'sha256', v_document_ref_hash,
        'created_by_user_id', auth.uid(),
        'source_system', 'console_v2_driver_documents',
        'metadata', jsonb_build_object(
          'driver_profile_id', v_dp.id,
          'driver_user_id', v_dp.user_id,
          'doc_type', v_doc_type,
          'correlation_id', v_correlation_id
        )
      )) AS ra;
    IF v_artifact_id IS NULL THEN
      RAISE EXCEPTION 'upload_driver_document_v1: artifact registration did not return artifact_id'
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  SELECT *
    INTO v_artifact
    FROM public.artifacts
   WHERE id = v_artifact_id;
  IF v_artifact.id IS NULL THEN
    RAISE EXCEPTION 'upload_driver_document_v1: artifact % not found', v_artifact_id USING ERRCODE = 'P0002';
  END IF;
  IF v_artifact.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'upload_driver_document_v1: artifact % belongs to another organization', v_artifact_id USING ERRCODE = '42501';
  END IF;

  v_document_ref_hash := COALESCE(v_document_ref_hash, NULLIF(btrim(COALESCE(v_artifact.sha256, '')), ''));

  INSERT INTO public.driver_documents (
    id,
    organization_id,
    user_id,
    doc_type,
    status,
    issuer,
    document_ref_hash,
    issued_at,
    expires_at,
    artifact_id,
    metadata
  )
  VALUES (
    v_driver_document_id,
    v_org_id,
    v_dp.user_id,
    v_doc_type,
    v_status,
    v_issuer,
    v_document_ref_hash,
    v_issued_at,
    v_expires_at,
    v_artifact_id,
    v_metadata || jsonb_build_object(
      'uploaded_by', 'upload_driver_document_v1',
      'uploaded_correlation_id', v_correlation_id
    )
  );

  INSERT INTO public.artifact_links (
    organization_id,
    artifact_id,
    resource_type,
    resource_id,
    relation_type,
    metadata
  )
  VALUES (
    v_org_id,
    v_artifact_id,
    'driver_document',
    v_driver_document_id,
    'source_document',
    jsonb_build_object(
      'driver_profile_id', v_dp.id,
      'driver_user_id', v_dp.user_id,
      'doc_type', v_doc_type,
      'correlation_id', v_correlation_id
    )
  )
  ON CONFLICT (organization_id, artifact_id, resource_type, resource_id, relation_type) DO NOTHING;

  INSERT INTO public.driver_compliance_events (
    id,
    organization_id,
    user_id,
    event_type,
    actor_user_id,
    actor_system,
    payload,
    settings_resolution_id
  )
  VALUES (
    v_compliance_event_id,
    v_org_id,
    v_dp.user_id,
    'document_uploaded',
    auth.uid(),
    'upload_driver_document_v1',
    jsonb_build_object(
      'driver_document_id', v_driver_document_id,
      'artifact_id', v_artifact_id,
      'doc_type', v_doc_type,
      'status', v_status,
      'severity', 'info',
      'correlation_id', v_correlation_id
    ),
    NULL
  );

  PERFORM public.enqueue_domain_event(
    v_org_id,
    'compliance.driver_document_uploaded',
    'driver_document',
    v_driver_document_id,
    jsonb_build_object(
      'driver_profile_id', v_dp.id,
      'driver_user_id', v_dp.user_id,
      'artifact_id', v_artifact_id,
      'doc_type', v_doc_type,
      'requested_by', auth.uid()
    ),
    v_correlation_id
  );

  PERFORM public.log_decision(
    v_org_id,
    'compliance.driver_document_uploaded',
    'driver_document',
    v_driver_document_id,
    'rpc_dispatch',
    'submitted',
    'upload_driver_document_v1',
    v_correlation_id,
    jsonb_build_object(
      'driver_profile_id', v_dp.id,
      'driver_user_id', v_dp.user_id,
      'artifact_id', v_artifact_id,
      'doc_type', v_doc_type,
      'driver_document_status_source', 'lookup_values.driver_document_status'
    ),
    NULL
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'driver_document_id', v_driver_document_id,
    'driver_profile_id', v_dp.id,
    'driver_user_id', v_dp.user_id,
    'artifact_id', v_artifact_id,
    'doc_type', v_doc_type,
    'status', v_status,
    'driver_compliance_event_id', v_compliance_event_id,
    'correlation_id', v_correlation_id,
    'resolved_from', 'driver_document_kind/lookup'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_driver_hours_of_service_v1(p_driver_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  WITH visible_driver AS (
    SELECT dp.id
      FROM public.driver_profiles dp
     WHERE dp.id = p_driver_id
     LIMIT 1
  ),
  bounded AS (
    SELECT
      dhos.duty_status,
      dhos.segment_start,
      GREATEST(dhos.segment_start, date_trunc('day', now())) AS today_start,
      LEAST(COALESCE(dhos.segment_end, now()), now()) AS today_end,
      GREATEST(dhos.segment_start, now() - INTERVAL '7 days') AS week_start,
      LEAST(COALESCE(dhos.segment_end, now()), now()) AS week_end
    FROM public.driver_hours_of_service dhos
    JOIN visible_driver vd ON vd.id = dhos.driver_id
    WHERE dhos.segment_start < now()
      AND COALESCE(dhos.segment_end, now()) > now() - INTERVAL '7 days'
  ),
  today_segments AS (
    SELECT
      segment_start,
      duty_status,
      FLOOR(EXTRACT(EPOCH FROM (today_end - today_start)) / 60)::INT AS duration_minutes
    FROM bounded
    WHERE today_end > today_start
  ),
  week_segments AS (
    SELECT
      duty_status,
      FLOOR(EXTRACT(EPOCH FROM (week_end - week_start)) / 60)::INT AS duration_minutes
    FROM bounded
    WHERE week_end > week_start
  ),
  week_totals AS (
    SELECT
      COALESCE(SUM(duration_minutes) FILTER (WHERE duty_status = 'driving'), 0)::INT AS driving,
      COALESCE(SUM(duration_minutes) FILTER (WHERE duty_status IN ('driving', 'on_duty')), 0)::INT AS on_duty,
      COALESCE(SUM(duration_minutes) FILTER (WHERE duty_status = 'off_duty'), 0)::INT AS off_duty,
      COALESCE(SUM(duration_minutes) FILTER (WHERE duty_status = 'sleeper'), 0)::INT AS sleeper
    FROM week_segments
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM visible_driver) THEN NULL::jsonb
    ELSE jsonb_build_object(
      'today',
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'type', duty_status,
              'durationMinutes', duration_minutes
            )
            ORDER BY segment_start
          )
          FROM today_segments
          WHERE duration_minutes > 0
        ),
        '[]'::jsonb
      ),
      'week_total',
      jsonb_build_object(
        'driving', COALESCE((SELECT driving FROM week_totals), 0),
        'on_duty', COALESCE((SELECT on_duty FROM week_totals), 0),
        'off_duty', COALESCE((SELECT off_duty FROM week_totals), 0),
        'sleeper', COALESCE((SELECT sleeper FROM week_totals), 0)
      )
    )
  END;
$function$;

CREATE OR REPLACE FUNCTION api.create_driver_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.create_driver_v1(COALESCE($1, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.upload_driver_document_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.upload_driver_document_v1(COALESCE($1, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.resolve_driver_hours_of_service_v1(p_driver_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.resolve_driver_hours_of_service_v1($1);
$function$;

REVOKE ALL ON FUNCTION public.create_driver_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_driver_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_driver_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.upload_driver_document_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upload_driver_document_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.upload_driver_document_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.resolve_driver_hours_of_service_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_driver_hours_of_service_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_driver_hours_of_service_v1(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.create_driver_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.create_driver_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.create_driver_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.upload_driver_document_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.upload_driver_document_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.upload_driver_document_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.resolve_driver_hours_of_service_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_driver_hours_of_service_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION api.resolve_driver_hours_of_service_v1(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.create_driver_v1(JSONB)
  IS 'Canonical fleet RPC: create a driver_profiles row for an existing tenant user. Capability: fleet.write. Does not create auth users or invitations.';
COMMENT ON FUNCTION public.upload_driver_document_v1(JSONB)
  IS 'Canonical fleet RPC: attach a registered artifact, or register a storage object then attach it, as a submitted driver_documents row and link it through artifact_links. Capability: fleet.write.';
COMMENT ON FUNCTION public.resolve_driver_hours_of_service_v1(UUID)
  IS 'Canonical fleet resolver for per-driver HOS. Returns {today:[{type,durationMinutes}], week_total:{driving,on_duty,off_duty,sleeper}} from public.driver_hours_of_service.';
COMMENT ON FUNCTION api.create_driver_v1(JSONB)
  IS 'Console V2 api-schema wrapper delegating to canonical public.create_driver_v1(jsonb).';
COMMENT ON FUNCTION api.upload_driver_document_v1(JSONB)
  IS 'Console V2 api-schema wrapper delegating to canonical public.upload_driver_document_v1(jsonb).';
COMMENT ON FUNCTION api.resolve_driver_hours_of_service_v1(UUID)
  IS 'Console V2 api-schema wrapper delegating to canonical public.resolve_driver_hours_of_service_v1(uuid).';

SELECT pg_advisory_unlock(hashtext('202605041130_console_v2_fleet_lifecycle_closure_v1'));

COMMIT;
