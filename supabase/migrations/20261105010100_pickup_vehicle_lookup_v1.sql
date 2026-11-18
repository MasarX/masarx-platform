-- Forward port: active pickup assignment vehicle choices; retain current write-scope authority.
BEGIN;
CREATE OR REPLACE FUNCTION api.pickup_vehicle_lookup_v1(
  p_organization_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 100
)
RETURNS TABLE (
  vehicle_id UUID,
  organization_id UUID,
  branch_id UUID,
  branch_name TEXT,
  branch_code TEXT,
  plate_number TEXT,
  make TEXT,
  model TEXT,
  vin TEXT,
  label TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  WITH scope_context AS (
    SELECT * FROM api.pickup_read_scope_v1()
  ),
  effective_scope AS (
    SELECT
      CASE
        WHEN p_organization_id IS NOT NULL THEN p_organization_id
        ELSE scope_context.organization_id
      END AS organization_id,
      scope_context.is_service_request,
      scope_context.is_platform,
      scope_context.scope_type,
      scope_context.organization_id AS current_organization_id
    FROM scope_context
  ),
  authorized_scope AS (
    SELECT organization_id
    FROM effective_scope
    WHERE organization_id IS NOT NULL
      AND (
        is_service_request
        OR (
          (is_platform OR (scope_type = 'tenant' AND organization_id = current_organization_id))
          AND public.user_has_permission_v1('fleet.write', organization_id)
        )
      )
  )
  SELECT
    v.id AS vehicle_id,
    v.organization_id,
    v.branch_id,
    b.name AS branch_name,
    b.code AS branch_code,
    v.plate_number,
    v.make,
    v.model,
    v.vin,
    COALESCE(
      NULLIF(btrim(v.plate_number), ''),
      NULLIF(btrim(concat_ws(' ', v.make, v.model)), ''),
      NULLIF(btrim(v.vin), ''),
      'Vehicle ' || upper(left(v.id::text, 8))
    ) AS label
  FROM public.vehicles v
  JOIN authorized_scope scope
    ON scope.organization_id = v.organization_id
  LEFT JOIN public.branches b
    ON b.id = v.branch_id
   AND b.organization_id = v.organization_id
  WHERE lower(COALESCE(v.status, '')) = 'active'
    AND COALESCE(v.is_active, TRUE)
  ORDER BY COALESCE(v.updated_at, v.created_at) DESC, v.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 250);
$$;

REVOKE ALL ON FUNCTION api.pickup_vehicle_lookup_v1(UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION api.pickup_vehicle_lookup_v1(UUID, INT) TO authenticated, service_role;

COMMIT;
