-- Plan: B08 Delivery proof & closeout / Step: E04
-- Migration: Route stop view rebuild compatibility v1
-- Purpose:
--   - Keep fresh bootstrap compatible when the Batch 7 delivery-attempt
--     projection adds columns before the Batch 8 COD view rewrite.
--   - Rebuild the route-stop read views so later CREATE OR REPLACE VIEW steps
--     can safely materialize the COD-aware contract without column-drop errors.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604101125_b08_route_stop_view_rebuild_compat_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS api.route_stops;
DROP VIEW IF EXISTS public.route_stops_visible_v1;

SELECT pg_advisory_unlock(hashtext('202604101125_b08_route_stop_view_rebuild_compat_v1'));

COMMIT;
