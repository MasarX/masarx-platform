BEGIN;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.resolve_fieldops_supervisor_queue_v1(
  p_active_role TEXT DEFAULT 'supervisor',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_first_name TEXT;
  v_queue JSONB := '[]'::jsonb;
  v_active_id TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_supervisor_queue_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();

  IF v_org IS NULL THEN
    RETURN jsonb_build_object(
      'supervisor_name', NULL,
      'queue', '[]'::jsonb,
      'active_id', NULL
    );
  END IF;

  IF public.current_user_scope_type() IS DISTINCT FROM 'tenant'
     OR public.current_user_scope_id() IS DISTINCT FROM v_org
     OR NOT EXISTS (
       SELECT 1
       FROM public.rbac_user_role_assignments assignment
       JOIN public.rbac_roles role
         ON role.id = assignment.role_id
        AND role.organization_id = assignment.organization_id
        AND role.is_active
       WHERE assignment.user_id = v_user_id
         AND assignment.organization_id = v_org
         AND assignment.revoked_at IS NULL
         AND lower(COALESCE(NULLIF(role.metadata->>'mobile_v2_role', ''), role.key)) = 'supervisor'
     )
     OR NOT COALESCE(public.user_has_resource_capability_v1('routes', 'read', 'tenant', v_org), FALSE) THEN
    RAISE EXCEPTION 'FieldOps supervisor queue requires an authorized tenant supervisor'
      USING ERRCODE = '42501';
  END IF;

  v_first_name := public.fieldops_v2_user_first_name_v1(v_user_id);

  -- Union two real approval sources, newest first:
  --   route_runs awaiting review  -> kind = route_change
  --   fieldops_v2_incidents       -> kind = incident
  -- Each row maps to the MobileV2SupervisorItem envelope.
  WITH approvals AS (
    SELECT
      'run:' || rr.id::text                                        AS item_id,
      'route_change'                                               AS kind,
      COALESCE(u.full_name, '—')                                   AS driver,
      'RUN-' || substr(rr.id::text, 1, 8)                          AS ref,
      COALESCE(rr.updated_at, rr.created_at)                       AS at_ts,
      CONCAT_WS(' · ',
        'Route run awaiting review',
        NULLIF(rr.status, ''),
        rr.planned_date::text
      )                                                            AS detail
    FROM public.route_runs rr
    LEFT JOIN public.users u
      ON u.id = rr.driver_user_id
     AND u.organization_id = v_org
    WHERE rr.organization_id = v_org
      AND rr.status IN ('pending_review', 'requires_review', 'awaiting_approval')

    UNION ALL

    SELECT
      'incident:' || inc.id::text                                  AS item_id,
      'incident'                                                   AS kind,
      COALESCE(u.full_name, '—')                                   AS driver,
      'INC-' || substr(inc.id::text, 1, 8)                         AS ref,
      inc.created_at                                               AS at_ts,
      CONCAT_WS(' · ',
        NULLIF(inc.type_id, ''),
        'severity ' || COALESCE(inc.severity, 'low'),
        NULLIF(btrim(COALESCE(inc.statement, '')), '')
      )                                                            AS detail
    FROM public.fieldops_v2_incidents inc
    LEFT JOIN public.users u
      ON u.id = inc.reported_by_user_id
     AND u.organization_id = v_org
    WHERE inc.organization_id = v_org
  )
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id',     a.item_id,
          'kind',   a.kind,
          'driver', a.driver,
          'ref',    a.ref,
          'atMs',   (extract(epoch FROM a.at_ts) * 1000)::bigint,
          'detail', COALESCE(a.detail, '')
        )
        ORDER BY a.at_ts DESC
      ),
      '[]'::jsonb
    )
    INTO v_queue
    FROM approvals a;

  v_active_id := v_queue->0->>'id';

  RETURN jsonb_build_object(
    'supervisor_name', v_first_name,
    'queue', v_queue,
    'active_id', v_active_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_supervisor_queue_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_supervisor_queue_v1(TEXT, JSONB) TO authenticated, service_role;

COMMIT;
