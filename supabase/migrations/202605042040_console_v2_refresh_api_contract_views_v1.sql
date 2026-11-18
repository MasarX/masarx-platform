-- Late Console V2 tables are registered as user-facing RLS tables after the
-- broad api-contract generator has already run. Add only the missing views so
-- specialized API projections such as api.route_stops are not overwritten by a
-- generic SELECT * view.

BEGIN;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE VIEW api.ops_alerts
WITH (security_invoker = true) AS
SELECT *
FROM public.ops_alerts;

CREATE OR REPLACE VIEW api.planning_os_execution_cards
WITH (security_invoker = true) AS
SELECT *
FROM public.planning_os_execution_cards;

CREATE OR REPLACE VIEW api.planning_os_project_items
WITH (security_invoker = true) AS
SELECT *
FROM public.planning_os_project_items;

CREATE OR REPLACE VIEW api.support_user_roster_policy
WITH (security_invoker = true) AS
SELECT *
FROM public.support_user_roster_policy;

CREATE OR REPLACE VIEW api.vehicle_documents
WITH (security_invoker = true) AS
SELECT *
FROM public.vehicle_documents;

CREATE OR REPLACE VIEW api.wave_catalog
WITH (security_invoker = true) AS
SELECT *
FROM public.wave_catalog;

REVOKE ALL ON api.ops_alerts FROM PUBLIC, anon;
REVOKE ALL ON api.planning_os_execution_cards FROM PUBLIC, anon;
REVOKE ALL ON api.planning_os_project_items FROM PUBLIC, anon;
REVOKE ALL ON api.support_user_roster_policy FROM PUBLIC, anon;
REVOKE ALL ON api.vehicle_documents FROM PUBLIC, anon;
REVOKE ALL ON api.wave_catalog FROM PUBLIC, anon;

GRANT SELECT ON api.ops_alerts TO authenticated, service_role;
GRANT SELECT ON api.planning_os_execution_cards TO authenticated, service_role;
GRANT SELECT ON api.planning_os_project_items TO authenticated, service_role;
GRANT SELECT ON api.support_user_roster_policy TO authenticated, service_role;
GRANT SELECT ON api.vehicle_documents TO authenticated, service_role;
GRANT SELECT ON api.wave_catalog TO authenticated, service_role;

COMMIT;
