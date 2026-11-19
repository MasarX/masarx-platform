BEGIN;

-- Repair api.route_stops after older compatibility rebuilds left the API view
-- on the base route_stops shape. Browser route-manifest reads must expose the
-- executor-scoped projection, including latest shipment action and delivery
-- attempt metadata from public.route_stops_visible_v1.
DROP VIEW IF EXISTS api.route_stops;

CREATE VIEW api.route_stops
WITH (security_invoker = true) AS
SELECT *
FROM public.route_stops_visible_v1;

COMMENT ON VIEW api.route_stops IS
  'Browser-safe executor-scoped route_stop manifest projection built through public.route_stops_visible_v1, including shipment-action and delivery-attempt metadata.';

REVOKE ALL ON api.route_stops FROM PUBLIC;
REVOKE ALL ON api.route_stops FROM anon;
GRANT SELECT ON api.route_stops TO authenticated, service_role;

COMMIT;
