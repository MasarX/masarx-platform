BEGIN;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'mid_route_injection_policy', 'Tenant opt-in for driver-visible offers on an active route.',
  TRUE, FALSE, TRUE, 'return_null', '["tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'mid_route_injection_policy', 1,
  '{"type":"object","properties":{"enabled":{"type":"boolean"}},"required":["enabled"],"additionalProperties":false}'::jsonb,
  'Enable scoped stop offers without modifying the active route.', '[{"enabled":false}]'::jsonb, TRUE
);

CREATE TABLE public.mid_route_stop_injections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES public.route_runs(id) ON DELETE CASCADE,
  stop_id uuid NOT NULL REFERENCES public.route_stops(id) ON DELETE CASCADE,
  injected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  position jsonb CHECK (jsonb_typeof(position) = 'object'),
  reason text CHECK (length(reason) <= 1000),
  acknowledged_at timestamptz
);
CREATE INDEX mid_route_stop_injections_pending_idx
  ON public.mid_route_stop_injections (route_id, injected_at DESC) WHERE acknowledged_at IS NULL;
ALTER TABLE public.mid_route_stop_injections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mid_route_stop_injections FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.mid_route_stop_injections TO service_role;
CREATE POLICY mid_route_stop_injections_service ON public.mid_route_stop_injections
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE FUNCTION api.pending_mid_route_stops_v1(p_route_id uuid)
RETURNS TABLE (stop_id uuid, injected_at timestamptz, "position" jsonb, reason text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT e.stop_id, e.injected_at, e."position", e.reason
    FROM public.mid_route_stop_injections e
    JOIN public.route_runs r ON r.id = e.route_id
    JOIN public.route_stops s ON s.id = e.stop_id AND s.organization_id = r.organization_id
   WHERE r.id = p_route_id AND r.organization_id = public.current_user_org_id()
     AND public.current_user_scope_type() = 'tenant' AND r.driver_user_id = auth.uid()
     AND public.route_run_actor_can_read_v1(r.organization_id, r.id, r.driver_user_id)
     AND lower(r.status) NOT IN ('completed', 'canceled') AND e.acknowledged_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.settings p
        WHERE p.scope_type = 'tenant' AND p.scope_id = r.organization_id
          AND p.category = 'mid_route_injection_policy' AND p.cached_value->'enabled' = 'true'::jsonb
     )
   ORDER BY e.injected_at DESC, e.id
   LIMIT 50;
$function$;
REVOKE ALL ON FUNCTION api.pending_mid_route_stops_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.pending_mid_route_stops_v1(uuid) TO authenticated;

COMMIT;
