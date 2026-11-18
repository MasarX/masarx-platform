-- Migration: fieldops_mobile_v2_route_load_scan_policy_v1
-- Date: 2026-06-09
-- Scope: Mobile V2 route scan-out prerequisite for COD delivery collection.
--
-- The Mobile V2 scanner already renders the row-defined `load` action and
-- the backend already exposes canonical scan intake through
-- api.record_scan_event_v1. This migration wires that action through policy
-- so the native scanner can submit route load scans without app-side DB
-- fallback or backend-only proof.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606091015_fieldops_mobile_v2_route_load_scan_policy_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

UPDATE public.schema_registry
   SET schema = jsonb_set(
                schema,
                '{properties,actions,items,properties,submit_rpc}',
                jsonb_build_object(
                  'type', 'string',
                  'description', 'Backend RPC executor for production-wired loader/route scanner actions.'
                ),
                TRUE
              )
 WHERE category = 'mobile_loader_policy'
   AND version = 1;

WITH updated_versions AS (
  UPDATE public.settings_versions sv
     SET value = jsonb_set(
                   sv.value,
                   '{actions}',
                   (
                     SELECT COALESCE(
                       jsonb_agg(
                         CASE
                           WHEN action->>'key' = 'load'
                             THEN action || jsonb_build_object('submit_rpc', 'record_scan_event_v1')
                           ELSE action
                         END
                         ORDER BY ord
                       ),
                       sv.value->'actions'
                     )
                       FROM jsonb_array_elements(sv.value->'actions') WITH ORDINALITY AS t(action, ord)
                   ),
                   TRUE
                 ),
         change_reason = COALESCE(sv.change_reason, 'Mobile V2 loader policy update')
           || '; route load scan submits through api.record_scan_event_v1'
   WHERE sv.category = 'mobile_loader_policy'
     AND sv.effective_until IS NULL
     AND sv.approved_at IS NOT NULL
     AND jsonb_typeof(sv.value->'actions') = 'array'
   RETURNING sv.id, sv.value
)
UPDATE public.settings s
   SET cached_value = uv.value,
       last_updated = now()
  FROM updated_versions uv
 WHERE s.settings_version_id = uv.id
   AND s.category = 'mobile_loader_policy';

SELECT pg_advisory_unlock(hashtext('202606091015_fieldops_mobile_v2_route_load_scan_policy_v1'));
COMMIT;
