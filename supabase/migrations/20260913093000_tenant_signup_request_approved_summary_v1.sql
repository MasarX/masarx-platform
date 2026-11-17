-- Approved tenant-signup self-service summary.
BEGIN;

SELECT pg_advisory_lock(hashtext('20260913093000_tenant_signup_request_approved_summary_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.tenant_signup_request_approved_summary_v1(p_request_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_actor_id UUID := auth.uid();
  v_summary JSONB;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'tenant_signup_request_approved_summary_forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
           'id', r.id,
           'status', r.status,
           'reviewed_at', r.reviewed_at,
           'approved_organization_id', r.approved_organization_id,
           'approved_user_id', r.approved_user_id,
           'invite_email_sent_at', r.invite_email_sent_at,
           'invite_redirect_to', r.invite_redirect_to
         )
    INTO v_summary
    FROM public.tenant_signup_requests r
   WHERE r.id = p_request_id
     AND r.status = 'approved'
     AND r.review_decision = 'approved'
     AND r.approved_auth_user_id = v_actor_id
     AND (r.approved_user_id IS NULL OR r.approved_user_id = v_actor_id);

  IF v_summary IS NULL THEN
    RAISE EXCEPTION 'tenant_signup_request_approved_summary_forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN v_summary;
END;
$function$;

CREATE OR REPLACE FUNCTION api.tenant_signup_request_approved_summary_v1(p_request_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO public, api, pg_temp
AS $function$
  SELECT public.tenant_signup_request_approved_summary_v1(p_request_id)
$function$;

COMMENT ON FUNCTION public.tenant_signup_request_approved_summary_v1(UUID)
  IS 'Return the seven-key approval summary only to the authenticated user bound to the approved signup request.';
COMMENT ON FUNCTION api.tenant_signup_request_approved_summary_v1(UUID)
  IS 'Browser-safe wrapper for the caller-bound approved tenant signup summary.';

REVOKE ALL ON FUNCTION public.tenant_signup_request_approved_summary_v1(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION api.tenant_signup_request_approved_summary_v1(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tenant_signup_request_approved_summary_v1(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION api.tenant_signup_request_approved_summary_v1(UUID) TO authenticated;

SELECT pg_advisory_unlock(hashtext('20260913093000_tenant_signup_request_approved_summary_v1'));
COMMIT;
