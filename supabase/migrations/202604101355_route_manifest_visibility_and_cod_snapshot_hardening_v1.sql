-- Plan: B08 Delivery proof & closeout / Step: E08
-- Migration: Route manifest visibility + COD shipment snapshot hardening v1
-- Purpose:
--   - Resolve the effective JWT role from request.jwt.claims before the legacy
--     request.jwt.claim.role GUC so auth context switches do not inherit stale
--     service-role values.
--   - Keep tenant operators with routes.write on the full route inventory while
--     preserving assignment-scoped driver reads.
--   - Resolve route-stop COD shipment/payment fields through a browser-safe
--     security-definer helper so driver reads do not lose shipment-backed COD
--     data behind shipment RLS.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604101355_route_manifest_visibility_and_cod_snapshot_hardening_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.route_run_actor_can_read_v1(
  p_organization_id UUID,
  p_route_run_id UUID,
  p_driver_user_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_actor_user_id UUID := NULL;
  v_actor_user_type TEXT := NULL;
  v_scope_type TEXT := COALESCE(public.current_user_scope_type(), 'global');
  v_scope_id UUID := public.current_user_scope_id();
  v_actor_org_id UUID := public.current_user_org_id();
  v_claims JSONB := NULL;
  v_claim_role TEXT := NULL;
  v_is_service BOOLEAN := FALSE;
  v_effective_scope_id UUID := NULL;
BEGIN
  BEGIN
    v_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;

  v_claim_role := lower(COALESCE(
    NULLIF(btrim(COALESCE(v_claims->>'role', '')), ''),
    NULLIF(btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')), '')
  ));

  v_is_service := v_claim_role = 'service_role'
    OR (
      v_claim_role IS NULL
      AND session_user IN ('postgres', 'supabase_admin', 'service_role')
    );

  IF v_is_service THEN
    RETURN TRUE;
  END IF;

  IF public.is_platform_user() THEN
    RETURN TRUE;
  END IF;

  IF v_scope_type <> 'tenant' THEN
    RETURN FALSE;
  END IF;

  IF v_actor_org_id IS NULL OR v_actor_org_id IS DISTINCT FROM p_organization_id THEN
    RETURN FALSE;
  END IF;

  BEGIN
    v_actor_user_id := auth.uid();
  EXCEPTION
    WHEN others THEN
      v_actor_user_id := NULL;
  END;

  IF v_actor_user_id IS NOT NULL THEN
    SELECT NULLIF(btrim(COALESCE(u.user_type, '')), '')
      INTO v_actor_user_type
      FROM public.users u
     WHERE u.id = v_actor_user_id
       AND u.organization_id = p_organization_id
     LIMIT 1;
  END IF;

  v_effective_scope_id := COALESCE(v_scope_id, v_actor_org_id);

  IF public.user_has_resource_capability_v1('routes', 'write', v_scope_type, v_effective_scope_id)
     AND COALESCE(v_actor_user_type, '') <> 'driver' THEN
    RETURN TRUE;
  END IF;

  IF NOT public.user_has_resource_capability_v1('routes', 'read', v_scope_type, v_effective_scope_id) THEN
    RETURN FALSE;
  END IF;

  IF v_actor_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF p_driver_user_id IS NOT NULL AND p_driver_user_id = v_actor_user_id THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.route_run_assignments rra
     WHERE rra.organization_id = p_organization_id
       AND rra.route_run_id = p_route_run_id
       AND rra.driver_user_id = v_actor_user_id
       AND rra.assignment_status IN ('assigned', 'acknowledged', 'accepted')
  );
END;
$function$;

COMMENT ON FUNCTION public.route_run_actor_can_read_v1(UUID, UUID, UUID) IS
  'Executor-safe route visibility helper. Resolves role from request.jwt.claims first to avoid stale service-role claim GUCs, keeps tenant operators with routes.write on the full tenant inventory, and limits drivers to their assigned route inventory.';

CREATE OR REPLACE FUNCTION public.route_stop_shipment_payment_snapshot_v1(
  p_route_stop_id UUID
)
RETURNS TABLE (
  sender_id UUID,
  cod_amount NUMERIC,
  cod_currency TEXT,
  payment JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
/* objectives:allow RLS_OFF Justification: SECURITY DEFINER payment snapshot helper serves only route stops already gated by route_run_actor_can_read_v1. */
SET row_security = off
AS $function$
  SELECT
    s.sender_id,
    s.cod_amount,
    s.cod_currency,
    public.resolve_route_stop_payment_terms_v1(
      rs.organization_id,
      rs.client_id,
      s.sender_id,
      rr.branch_id,
      s.cod_amount,
      s.cod_currency
    ) AS payment
  FROM public.route_stops rs
  JOIN public.route_runs rr
    ON rr.id = rs.route_run_id
  LEFT JOIN public.shipments s
    ON s.id = rs.shipment_id
   AND s.organization_id = rs.organization_id
  WHERE rs.id = p_route_stop_id
    AND public.route_run_actor_can_read_v1(
      rs.organization_id,
      rs.route_run_id,
      rr.driver_user_id
    )
  LIMIT 1;
$function$;

COMMENT ON FUNCTION public.route_stop_shipment_payment_snapshot_v1(UUID) IS
  'Browser-safe security-definer helper that resolves shipment-backed COD/payment fields for a visible route stop without exposing raw shipment inventory.';

REVOKE ALL ON FUNCTION public.route_stop_shipment_payment_snapshot_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_stop_shipment_payment_snapshot_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.route_stop_shipment_payment_snapshot_v1(UUID) TO authenticated, service_role;

CREATE OR REPLACE VIEW public.route_stops_visible_v1
WITH (security_invoker = true) AS
SELECT
  rs.*,
  rr.status AS route_run_status,
  rr.driver_user_id,
  rr.vehicle_id,
  rr.branch_id,
  rr.route_plan_id,
  rr.planned_date,
  rr.planned_start_at AS route_planned_start_at,
  rr.planned_end_at AS route_planned_end_at,
  COALESCE(rr.metadata->'route_assignment', '{}'::jsonb) AS route_assignment,
  shipment_snapshot.cod_amount,
  shipment_snapshot.cod_currency,
  shipment_snapshot.payment AS payment,
  CASE
    WHEN COALESCE(shipment_snapshot.payment->>'expected_amount', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN (shipment_snapshot.payment->>'expected_amount')::numeric
    ELSE NULL
  END AS expected_amount,
  CASE lower(COALESCE(shipment_snapshot.payment->>'collection_required', ''))
    WHEN 'true' THEN TRUE
    WHEN 'false' THEN FALSE
    ELSE NULL
  END AS collection_required,
  COALESCE(shipment_snapshot.payment->'allowed_methods', '[]'::jsonb) AS allowed_methods,
  NULLIF(btrim(COALESCE(shipment_snapshot.payment->>'payment_mode_label', '')), '') AS payment_mode_label
FROM public.route_stops rs
JOIN public.route_runs rr
  ON rr.id = rs.route_run_id
LEFT JOIN LATERAL public.route_stop_shipment_payment_snapshot_v1(rs.id) AS shipment_snapshot
  ON TRUE
WHERE public.route_run_actor_can_read_v1(
  rs.organization_id,
  rs.route_run_id,
  rr.driver_user_id
);

COMMENT ON VIEW public.route_stops_visible_v1 IS
  'Executor-safe route_stop manifest projection scoped to the visible route inventory, including COD fields resolved through the canonical shipment payment snapshot helper.';

SELECT pg_advisory_unlock(hashtext('202604101355_route_manifest_visibility_and_cod_snapshot_hardening_v1'));

COMMIT;
