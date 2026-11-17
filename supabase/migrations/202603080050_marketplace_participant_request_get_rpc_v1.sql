BEGIN;

SELECT pg_advisory_lock(hashtext('202603080050_marketplace_participant_request_get_rpc_v1'));

CREATE OR REPLACE FUNCTION public.marketplace_participant_request_get_v1(
  p_request_id UUID
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT jsonb_strip_nulls(
    jsonb_build_object(
      'id', r.id,
      'status', r.status,
      'requested_participant_type_key', r.requested_participant_type_key,
      'email', r.email,
      'full_name', r.full_name,
      'organization_name', r.organization_name,
      'organization_slug', r.organization_slug,
      'requested_organization_id', r.requested_organization_id,
      'requested_by_user_id', r.requested_by_user_id
    )
  )
    FROM public.marketplace_participant_requests r
   WHERE r.id = p_request_id;
$function$;

REVOKE ALL ON FUNCTION public.marketplace_participant_request_get_v1(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.marketplace_participant_request_get_v1(UUID) TO service_role;

CREATE OR REPLACE FUNCTION api.marketplace_participant_request_get_v1(
  p_request_id UUID
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.marketplace_participant_request_get_v1($1);
$function$;

REVOKE ALL ON FUNCTION api.marketplace_participant_request_get_v1(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.marketplace_participant_request_get_v1(UUID) TO service_role;

SELECT pg_advisory_unlock(hashtext('202603080050_marketplace_participant_request_get_rpc_v1'));

COMMIT;
