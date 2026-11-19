-- Migration: Lock down direct basket item DML from browser API schema
-- Purpose:
--   Basket membership must be changed by workflow-engine basket policy
--   and shipment resort flows, not by Console/Portal clients mutating
--   basket_items directly through PostgREST views.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605041710_basket_items_api_dml_lockdown_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

REVOKE INSERT, UPDATE, DELETE ON api.basket_items FROM authenticated;

COMMENT ON VIEW api.basket_items IS
  'Browser-safe read projection for basket memberships. Direct DML is intentionally revoked for authenticated clients; membership changes flow through canonical basket policy/resort workflows.';

SELECT pg_advisory_unlock(hashtext('202605041710_basket_items_api_dml_lockdown_v1'));

COMMIT;
