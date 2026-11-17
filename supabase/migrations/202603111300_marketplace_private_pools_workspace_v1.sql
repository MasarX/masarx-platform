-- Plan: PLAN-202603-marketplace-network-local-signoff-hardening / Step: S03
-- Migration: Marketplace private pools workspace/read-model RPC

BEGIN;
SELECT pg_advisory_lock(hashtext('202603111300_marketplace_private_pools_workspace_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.marketplace_private_pools_workspace_v1(
  p_requester_organization_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_is_platform BOOLEAN := public.is_platform_user();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authenticated_user_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_resource_capability_v1('marketplace_requests', 'read') THEN
    RAISE EXCEPTION 'marketplace_requests.read capability required' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'summary', jsonb_build_object(
      'request_count',
      COALESCE((
        SELECT count(DISTINCT r.id)
          FROM public.marketplace_requests r
         WHERE jsonb_array_length(COALESCE(r.private_pool, '[]'::jsonb)) > 0
           AND (
             p_requester_organization_id IS NULL
             OR r.requester_organization_id = p_requester_organization_id
           )
           AND (
             v_is_platform
             OR r.requester_organization_id = v_org_id
             OR public.marketplace_can_read_request_v1(r.id)
           )
      ), 0),
      'membership_count',
      COALESCE((
        SELECT count(*)
          FROM public.marketplace_requests r
          JOIN LATERAL jsonb_array_elements_text(COALESCE(r.private_pool, '[]'::jsonb)) AS pool(value)
            ON TRUE
         WHERE jsonb_array_length(COALESCE(r.private_pool, '[]'::jsonb)) > 0
           AND (
             p_requester_organization_id IS NULL
             OR r.requester_organization_id = p_requester_organization_id
           )
           AND (
             v_is_platform
             OR r.requester_organization_id = v_org_id
             OR public.marketplace_can_read_request_v1(r.id)
           )
      ), 0)
    ),
    'private_pools', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'request_id', r.id,
                 'request_title', r.title,
                 'request_kind_key', r.request_kind_key,
                 'status', r.status,
                 'release_state', r.release_state,
                 'requester_organization_id', r.requester_organization_id,
                 'requester_organization_name', requester.name,
                 'supplier_organization_id', supplier.id,
                 'supplier_organization_name', supplier.name,
                 'created_at', r.created_at,
                 'updated_at', r.updated_at
               )
               ORDER BY r.updated_at DESC, r.created_at DESC, supplier.name NULLS LAST, supplier.id
             )
        FROM public.marketplace_requests r
        LEFT JOIN public.organizations requester
          ON requester.id = r.requester_organization_id
        JOIN LATERAL (
          SELECT value::uuid AS supplier_organization_id
            FROM jsonb_array_elements_text(COALESCE(r.private_pool, '[]'::jsonb))
        ) AS pool
          ON TRUE
        LEFT JOIN public.organizations supplier
          ON supplier.id = pool.supplier_organization_id
       WHERE jsonb_array_length(COALESCE(r.private_pool, '[]'::jsonb)) > 0
         AND (
           p_requester_organization_id IS NULL
           OR r.requester_organization_id = p_requester_organization_id
         )
         AND (
           v_is_platform
           OR r.requester_organization_id = v_org_id
           OR public.marketplace_can_read_request_v1(r.id)
         )
    ), '[]'::jsonb)
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.marketplace_private_pools_workspace_v1(UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603111300_marketplace_private_pools_workspace_v1'));
COMMIT;
