-- Spec-Issue: W11-3 PLATFORM paired projection (warehouse-transfers)
-- Step: W11-3-VIEW-1
-- Migration: Canonical projection view public.v_warehouse_transfer_summary.
-- Capability: warehouse.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-transfer manifest aggregates (item_count, received_count,
--   variance_count, posted_at, variance_flag) for the FE warehouse module
--   from canonical tables only:
--     - public.warehouse_transfers       (projection)
--     - public.warehouse_transfer_items  (membership; expected items count)
--     - public.scan_events               (destination receipt scans)
--
--   The FE `TransferRow` (apps/console-v2/src/modules/platform/warehouse.tsx)
--   previously declared aggregate fields (item_count, received_count,
--   variance_flag, variance_pct, hold_reason) that are NOT columns on
--   warehouse_transfers. This view exposes them server-side so the FE shape
--   becomes registry-driven instead of seed-driven.
--
-- Field projection contract:
--   id              = warehouse_transfers.id
--   organization_id = warehouse_transfers.organization_id
--   transfer_code   = warehouse_transfers.transfer_code
--   from_branch_id  = warehouse_transfers.from_branch_id
--   to_branch_id    = warehouse_transfers.to_branch_id
--   status          = warehouse_transfers.status
--   dispatched_at   = warehouse_transfers.dispatched_at
--   received_at     = warehouse_transfers.received_at
--   posted_at       = COALESCE(received_at, dispatched_at)  (most-recent
--                     state-transition timestamp; mirrors the
--                     v_settlement_batch_summary.posted_at projection
--                     pattern so the FE can render a unified "Updated"
--                     column without per-transfer status branching).
--   item_count      = COUNT(warehouse_transfer_items)
--   received_count  = COUNT(DISTINCT scan_events.shipment_id) WHERE
--                     scan_events.warehouse_transfer_id = transfer.id AND
--                     scan_events.scan_type = 'warehouse_checkpoint' AND
--                     scan_events.metadata->>'checkpoint' = 'destination_scan_in'
--   variance_count  = item_count - received_count (clamped >= 0)
--   variance_flag   = (variance_count > 0) AND status IN
--                     ('received', 'reconciled', 'on_hold')
--                     (in_transit / planned / draft are NOT flagged because
--                     the transfer hasn't reached the receiving branch yet —
--                     "missing" items there just mean "not yet scanned in")
--   hold_reason     = warehouse_transfers.metadata->>'hold_reason'
--
-- Notes:
--   * SSOT remains public.warehouse_transfers; this view is read-only.
--   * RLS is enforced by the underlying tables (warehouse_transfers /
--     warehouse_transfer_items / scan_events). Service-only direct grant on
--     the view (mirrors v_feature_flag_summary baseline); FE reads through
--     the resource registry seam.
--   * Idempotent: pure view; safe to re-run.
--
-- Cross-references:
--   - SSOT inventory: apps/console-v2/__audit__/SCHEMA-DRIFT/PLATFORM.md §10
--   - FE shape: apps/console-v2/src/modules/platform/warehouse.tsx
--   - Canonical table: 202601251130_warehouse_transfers_handling_units_v1.sql

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301500_v_warehouse_transfer_summary'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_warehouse_transfer_summary;

CREATE VIEW public.v_warehouse_transfer_summary
  WITH (security_invoker = true)
AS
WITH item_counts AS (
  SELECT
    wti.transfer_id,
    COUNT(*) AS item_count
  FROM public.warehouse_transfer_items wti
  GROUP BY wti.transfer_id
),
receipt_counts AS (
  SELECT
    se.warehouse_transfer_id AS transfer_id,
    COUNT(DISTINCT se.shipment_id) AS received_count
  FROM public.scan_events se
  WHERE se.warehouse_transfer_id IS NOT NULL
    AND se.scan_type = 'warehouse_checkpoint'
    AND lower(COALESCE(se.metadata->>'checkpoint', '')) = 'destination_scan_in'
    AND se.shipment_id IS NOT NULL
  GROUP BY se.warehouse_transfer_id
)
SELECT
  wt.id,
  wt.organization_id,
  wt.transfer_code,
  wt.from_branch_id,
  wt.to_branch_id,
  wt.status,
  wt.dispatched_at,
  wt.received_at,
  -- posted_at: most-recent state-transition timestamp.
  COALESCE(wt.received_at, wt.dispatched_at) AS posted_at,
  COALESCE(ic.item_count, 0)::INT AS item_count,
  COALESCE(rc.received_count, 0)::INT AS received_count,
  GREATEST(
    COALESCE(ic.item_count, 0)::INT - COALESCE(rc.received_count, 0)::INT,
    0
  ) AS variance_count,
  (
    COALESCE(ic.item_count, 0) > COALESCE(rc.received_count, 0)
    AND wt.status IN ('received', 'reconciled', 'on_hold')
  ) AS variance_flag,
  -- Surface metadata-stored hold reason for the operator drawer; canonical
  -- chain-of-custody live state is in tasks/workflow events but the
  -- metadata stop-gap unblocks the FE drift remediation.
  NULLIF(btrim(COALESCE(wt.metadata->>'hold_reason', '')), '') AS hold_reason,
  wt.created_at,
  wt.updated_at
FROM public.warehouse_transfers wt
LEFT JOIN item_counts ic ON ic.transfer_id = wt.id
LEFT JOIN receipt_counts rc ON rc.transfer_id = wt.id;

COMMENT ON VIEW public.v_warehouse_transfer_summary IS
  'FE-friendly projection of warehouse_transfers with derived aggregates (item_count, received_count, variance_count, variance_flag, posted_at, hold_reason). Sources: warehouse_transfers + warehouse_transfer_items + scan_events. Read-only; SSOT remains warehouse_transfers; mutations go through warehouse_transfer_execute_v1 / record_scan_event_v1.';

-- Read access mirrors the underlying RLS posture: service-role baseline plus
-- authenticated SELECT (FE consumes via resource registry seam). Tenant
-- isolation is enforced by the underlying tables' SELECT policies.
REVOKE ALL ON public.v_warehouse_transfer_summary FROM PUBLIC;
REVOKE ALL ON public.v_warehouse_transfer_summary FROM anon;
REVOKE ALL ON public.v_warehouse_transfer_summary FROM authenticated;
GRANT SELECT ON public.v_warehouse_transfer_summary TO authenticated;
GRANT SELECT ON public.v_warehouse_transfer_summary TO service_role;

SELECT pg_advisory_unlock(hashtext('202604301500_v_warehouse_transfer_summary'));
COMMIT;
