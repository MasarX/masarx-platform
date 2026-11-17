-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S04
-- Migration: Marketplace network request controls and participant availability

BEGIN;
SELECT pg_advisory_lock(hashtext('202603081220_marketplace_network_request_ops_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.marketplace_request_release_v1(
  p_request_id UUID,
  p_release_state TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_req public.marketplace_requests%ROWTYPE;
  v_release_state TEXT := lower(NULLIF(btrim(COALESCE(p_release_state, '')), ''));
  v_visibility RECORD;
BEGIN
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_tenant_user_required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('marketplace_requests.write', 'tenant', v_org_id);

  IF v_release_state NOT IN ('private_pool', 'curated_network', 'public') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_release_state'));
  END IF;

  SELECT *
    INTO v_req
    FROM public.marketplace_requests r
   WHERE r.id = p_request_id
     AND r.requester_organization_id = v_org_id
   FOR UPDATE;

  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  IF v_req.status NOT IN ('published', 'negotiation') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_open'));
  END IF;

  SELECT *
    INTO v_visibility
    FROM public.marketplace_resolve_policy_row_v1(
      'marketplace_visibility_policy',
      jsonb_build_object(
        'organization_id', v_req.requester_organization_id,
        'request_kind_key', v_req.request_kind_key
      )
    )
   LIMIT 1;

  IF v_release_state = 'curated_network'
     AND NOT public.tenant_signup_policy_bool_v1(v_visibility.value, ARRAY['allow_curated_network_release'], TRUE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'curated_network_release_disabled'));
  END IF;

  IF v_release_state = 'public'
     AND NOT public.tenant_signup_policy_bool_v1(v_visibility.value, ARRAY['allow_public_release'], FALSE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'public_release_disabled'));
  END IF;

  UPDATE public.marketplace_requests
     SET release_state = v_release_state,
         metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = now()
   WHERE id = v_req.id;

  PERFORM public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'marketplace_visibility_policy',
    p_resource_type := 'marketplace_request',
    p_resource_id := v_req.id,
    p_decision_point := 'request.release_state',
    p_decision_outcome := v_release_state,
    p_performed_by_system := 'marketplace_request_release_v1',
    p_decision_inputs := jsonb_build_object('release_state', v_release_state),
    p_decision_reason := 'request_release_updated',
    p_settings_resolution_id := v_visibility.settings_resolution_id
  );

  PERFORM public.marketplace_append_event_v1(
    v_org_id,
    'marketplace_request',
    v_req.id,
    'request.release_state_changed',
    jsonb_build_object('release_state', v_release_state)
  );

  RETURN jsonb_build_object('ok', TRUE, 'id', v_req.id, 'release_state', v_release_state);
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_private_pool_upsert_v1(
  p_request_id UUID,
  p_private_pool JSONB,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_req public.marketplace_requests%ROWTYPE;
  v_pool JSONB := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_tenant_user_required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('marketplace_requests.write', 'tenant', v_org_id);

  IF jsonb_typeof(COALESCE(p_private_pool, '[]'::jsonb)) <> 'array' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_private_pool'));
  END IF;

  BEGIN
    SELECT COALESCE(
             jsonb_agg(to_jsonb(pool_org_id::text) ORDER BY pool_org_id::text),
             '[]'::jsonb
           )
      INTO v_pool
      FROM (
        SELECT DISTINCT NULLIF(btrim(value), '')::uuid AS pool_org_id
          FROM jsonb_array_elements_text(COALESCE(p_private_pool, '[]'::jsonb)) AS pool(value)
         WHERE NULLIF(btrim(value), '') IS NOT NULL
      ) normalized;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_private_pool'));
  END;

  SELECT *
    INTO v_req
    FROM public.marketplace_requests r
   WHERE r.id = p_request_id
     AND r.requester_organization_id = v_org_id
   FOR UPDATE;

  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  IF v_req.status NOT IN ('draft', 'published', 'negotiation') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_mutable'));
  END IF;

  UPDATE public.marketplace_requests
     SET private_pool = v_pool,
         metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = now()
   WHERE id = v_req.id;

  PERFORM public.marketplace_append_event_v1(
    v_org_id,
    'marketplace_request',
    v_req.id,
    'request.private_pool_updated',
    jsonb_build_object('private_pool_count', jsonb_array_length(v_pool))
  );

  RETURN jsonb_build_object('ok', TRUE, 'id', v_req.id, 'private_pool', v_pool);
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_request_reopen_v1(
  p_request_id UUID,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_req public.marketplace_requests%ROWTYPE;
  v_request_policy RECORD;
  v_expire_hours INTEGER := 24;
BEGIN
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_tenant_user_required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('marketplace_requests.write', 'tenant', v_org_id);

  SELECT *
    INTO v_req
    FROM public.marketplace_requests r
   WHERE r.id = p_request_id
     AND r.requester_organization_id = v_org_id
   FOR UPDATE;

  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  IF v_req.status = 'published' THEN
    RETURN jsonb_build_object('ok', TRUE, 'id', v_req.id, 'status', 'published', 'already_processed', TRUE);
  END IF;

  IF v_req.status NOT IN ('cancelled', 'expired') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_reopenable'));
  END IF;

  SELECT *
    INTO v_request_policy
    FROM public.marketplace_resolve_policy_row_v1(
      'marketplace_request_policy',
      jsonb_build_object(
        'organization_id', v_req.requester_organization_id,
        'request_kind_key', v_req.request_kind_key
      )
    )
   LIMIT 1;

  v_expire_hours := COALESCE((v_request_policy.value->'request_defaults'->>'expire_hours')::integer, 24);

  UPDATE public.marketplace_requests
     SET status = 'published',
         published_at = now(),
         closed_at = NULL,
         awarded_offer_id = NULL,
         expires_at = now() + make_interval(hours => GREATEST(v_expire_hours, 1)),
         metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = now()
   WHERE id = v_req.id;

  PERFORM public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'marketplace_request_policy',
    p_resource_type := 'marketplace_request',
    p_resource_id := v_req.id,
    p_decision_point := 'request.reopen',
    p_decision_outcome := 'published',
    p_performed_by_system := 'marketplace_request_reopen_v1',
    p_decision_inputs := jsonb_build_object('expire_hours', v_expire_hours),
    p_decision_reason := 'request_reopened',
    p_settings_resolution_id := v_request_policy.settings_resolution_id
  );

  PERFORM public.marketplace_append_event_v1(
    v_org_id,
    'marketplace_request',
    v_req.id,
    'request.reopened',
    jsonb_build_object('expires_at', now() + make_interval(hours => GREATEST(v_expire_hours, 1)))
  );

  RETURN jsonb_build_object('ok', TRUE, 'id', v_req.id, 'status', 'published');
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_request_expire_v1(
  p_request_id UUID,
  p_reason TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_is_platform BOOLEAN := public.is_platform_user();
  v_req public.marketplace_requests%ROWTYPE;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_reason, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authenticated_user_required' USING ERRCODE = '42501';
  END IF;

  IF v_org_id IS NULL AND NOT v_is_platform THEN
    RAISE EXCEPTION 'authenticated_tenant_user_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_resource_capability_v1('marketplace_requests', 'write') THEN
    RAISE EXCEPTION 'marketplace_requests.write capability required' USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_req
    FROM public.marketplace_requests r
   WHERE r.id = p_request_id
     AND (v_is_platform OR r.requester_organization_id = v_org_id)
   FOR UPDATE;

  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  IF v_req.status = 'expired' THEN
    RETURN jsonb_build_object('ok', TRUE, 'id', v_req.id, 'status', 'expired', 'already_processed', TRUE);
  END IF;

  IF v_req.status NOT IN ('published', 'negotiation', 'award_pending_acceptance') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_expirable'));
  END IF;

  UPDATE public.marketplace_offers
     SET status = 'expired',
         responded_at = COALESCE(responded_at, now()),
         metadata = COALESCE(metadata, '{}'::jsonb)
           || jsonb_build_object('expire_reason', v_reason)
           || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = now()
   WHERE request_id = v_req.id
     AND status IN ('submitted', 'countered');

  UPDATE public.marketplace_awards
     SET status = 'expired',
         metadata = COALESCE(metadata, '{}'::jsonb)
           || jsonb_build_object('expire_reason', v_reason)
           || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = now()
   WHERE request_id = v_req.id
     AND status = 'pending_acceptance';

  UPDATE public.marketplace_contracts
     SET status = 'cancelled',
         cancelled_at = COALESCE(cancelled_at, now()),
         metadata = COALESCE(metadata, '{}'::jsonb)
           || jsonb_build_object('expire_reason', v_reason)
           || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = now()
   WHERE request_id = v_req.id
     AND status = 'pending_acceptance';

  UPDATE public.marketplace_requests
     SET status = 'expired',
         closed_at = now(),
         awarded_offer_id = NULL,
         metadata = COALESCE(metadata, '{}'::jsonb)
           || jsonb_build_object('expire_reason', v_reason)
           || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = now()
   WHERE id = v_req.id;

  PERFORM public.marketplace_append_event_v1(
    COALESCE(v_org_id, v_req.requester_organization_id),
    'marketplace_request',
    v_req.id,
    'request.expired',
    jsonb_build_object('reason', v_reason)
  );

  RETURN jsonb_build_object('ok', TRUE, 'id', v_req.id, 'status', 'expired');
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_availability_upsert_v1(
  p_availability_id UUID DEFAULT NULL,
  p_starts_at TIMESTAMPTZ DEFAULT NULL,
  p_ends_at TIMESTAMPTZ DEFAULT NULL,
  p_availability_status TEXT DEFAULT 'available',
  p_capacity JSONB DEFAULT '{}'::jsonb,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_profile public.marketplace_participant_profiles%ROWTYPE;
  v_status TEXT := lower(NULLIF(btrim(COALESCE(p_availability_status, '')), ''));
  v_row public.marketplace_availability_windows%ROWTYPE;
  v_id UUID := COALESCE(p_availability_id, gen_random_uuid());
BEGIN
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_participant_required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('marketplace_participants.write', 'tenant', v_org_id);

  IF v_status NOT IN ('available', 'unavailable', 'reserved') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_availability_status'));
  END IF;

  SELECT *
    INTO v_profile
    FROM public.marketplace_participant_profiles p
   WHERE p.organization_id = v_org_id
     AND p.status = 'approved'
   LIMIT 1;

  IF v_profile.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'participant_not_found'));
  END IF;

  IF p_starts_at IS NULL OR p_ends_at IS NULL OR p_ends_at <= p_starts_at THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_time_window'));
  END IF;

  IF p_availability_id IS NOT NULL THEN
    SELECT *
      INTO v_row
      FROM public.marketplace_availability_windows aw
     WHERE aw.id = p_availability_id
     FOR UPDATE;

    IF v_row.id IS NOT NULL AND v_row.participant_profile_id <> v_profile.id THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'availability_not_found'));
    END IF;
  END IF;

  IF v_row.id IS NULL THEN
    INSERT INTO public.marketplace_availability_windows (
      id,
      participant_profile_id,
      availability_status,
      starts_at,
      ends_at,
      capacity,
      metadata
    )
    VALUES (
      v_id,
      v_profile.id,
      v_status,
      p_starts_at,
      p_ends_at,
      COALESCE(p_capacity, '{}'::jsonb),
      COALESCE(p_metadata, '{}'::jsonb)
    )
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.marketplace_availability_windows
       SET availability_status = v_status,
           starts_at = p_starts_at,
           ends_at = p_ends_at,
           capacity = COALESCE(p_capacity, '{}'::jsonb),
           metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
           updated_at = now()
     WHERE id = v_row.id
     RETURNING * INTO v_row;
  END IF;

  PERFORM public.marketplace_append_event_v1(
    v_org_id,
    'marketplace_availability',
    v_row.id,
    'availability.upserted',
    jsonb_build_object('availability_status', v_row.availability_status)
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'id', v_row.id,
    'availability_status', v_row.availability_status,
    'starts_at', v_row.starts_at,
    'ends_at', v_row.ends_at
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.marketplace_private_pool_upsert_v1(UUID, JSONB, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_request_release_v1(UUID, TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_request_reopen_v1(UUID, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_request_expire_v1(UUID, TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_availability_upsert_v1(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, JSONB, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603081220_marketplace_network_request_ops_v1'));
COMMIT;
