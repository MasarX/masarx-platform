BEGIN;
SET LOCAL lock_timeout = '30s';

CREATE FUNCTION api.pending_customer_sign_events_v1(p_driver_id uuid)
RETURNS TABLE (task_id uuid, signed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT s.task_id, max(s.submitted_at)
    FROM public.contactless_pod_submissions s
    JOIN public.tasks t ON t.id = s.task_id AND t.organization_id = s.organization_id
   WHERE p_driver_id = auth.uid() AND s.issued_by = p_driver_id AND t.assigned_to = p_driver_id
     AND s.organization_id = public.current_user_org_id() AND public.current_user_scope_type() = 'tenant'
     AND t.status IN ('assigned', 'in_progress') AND s.submitted_at IS NOT NULL
     AND public.contactless_pod_origin_for_tenant_v1(s.organization_id) IS NOT NULL
   GROUP BY s.task_id
   ORDER BY max(s.submitted_at) DESC, s.task_id
   LIMIT 100;
$function$;
REVOKE ALL ON FUNCTION api.pending_customer_sign_events_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.pending_customer_sign_events_v1(uuid) TO authenticated;

COMMIT;
