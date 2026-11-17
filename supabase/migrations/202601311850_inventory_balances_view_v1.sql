-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: Inventory balances view v1 (derived from inventory_movements SSOT)
-- Date: 2026-01-31
--
-- Goals:
--   - Provide a query-optimized "stock-on-hand" surface without introducing a redundant SSOT table.
--   - Keep SSOT: inventory_movements. This view is a deterministic projection.
--   - Expose via `api.inventory_balances_v1` (security_invoker=true) for driver/warehouse/ops apps.
BEGIN;
SELECT pg_advisory_lock(hashtext('202601311850_inventory_balances_view_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Inventory balances projection (view)
-------------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.inventory_balances_v1 AS
WITH movement_deltas AS (
  SELECT
    m.organization_id,
    m.item_id,
    m.from_location_id AS location_id,
    -m.quantity AS delta_quantity,
    m.occurred_at
  FROM public.inventory_movements m
  WHERE m.from_location_id IS NOT NULL

  UNION ALL

  SELECT
    m.organization_id,
    m.item_id,
    m.to_location_id AS location_id,
    m.quantity AS delta_quantity,
    m.occurred_at
  FROM public.inventory_movements m
  WHERE m.to_location_id IS NOT NULL
),
balances AS (
  SELECT
    d.organization_id,
    d.item_id,
    d.location_id,
    SUM(d.delta_quantity) AS quantity,
    MAX(d.occurred_at) AS last_movement_at
  FROM movement_deltas d
  GROUP BY d.organization_id, d.item_id, d.location_id
)
SELECT
  b.organization_id,
  b.item_id,
  i.key AS item_key,
  i.name AS item_name,
  i.unit AS item_unit,
  b.location_id,
  wl.branch_id,
  wl.code AS location_code,
  wl.name AS location_name,
  b.quantity,
  b.last_movement_at
FROM balances b
JOIN public.inventory_items i
  ON i.id = b.item_id
JOIN public.warehouse_locations wl
  ON wl.id = b.location_id;

COMMENT ON VIEW public.inventory_balances_v1 IS
  'Inventory balances projection derived from inventory_movements (SSOT). Not a source of truth. Use api.inventory_balances_v1 for contract access.';

-- Defense-in-depth: ensure view runs with invoker privileges when supported (Postgres 15+).
DO $$
BEGIN
  IF current_setting('server_version_num')::INT >= 150000 THEN
    EXECUTE 'ALTER VIEW public.inventory_balances_v1 SET (security_invoker = true)';
  END IF;
END $$;

REVOKE ALL ON public.inventory_balances_v1 FROM PUBLIC;
REVOKE ALL ON public.inventory_balances_v1 FROM anon;
REVOKE ALL ON public.inventory_balances_v1 FROM authenticated;
GRANT SELECT ON public.inventory_balances_v1 TO service_role;

-------------------------------------------------------------------------------
-- 2) API contract view (PostgREST surface)
-------------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS api;

CREATE OR REPLACE VIEW api.inventory_balances_v1
WITH (security_invoker = true)
AS
SELECT * FROM public.inventory_balances_v1;

REVOKE ALL ON api.inventory_balances_v1 FROM PUBLIC;
REVOKE ALL ON api.inventory_balances_v1 FROM anon;
REVOKE ALL ON api.inventory_balances_v1 FROM authenticated;

GRANT SELECT ON api.inventory_balances_v1 TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON api.inventory_balances_v1 TO service_role;

SELECT pg_advisory_unlock(hashtext('202601311850_inventory_balances_view_v1'));
COMMIT;
