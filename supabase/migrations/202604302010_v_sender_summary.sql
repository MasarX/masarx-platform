-- Spec-Issue: W21 CUSTOMERS gap closure (paired projection views)
-- Step: W21-VIEW-2
-- Migration: Canonical projection view public.v_sender_summary.
-- Capability: senders.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-sender derived counters used by
--   `apps/console-v2/src/modules/customers/senders.tsx` (SenderRow surface):
--     - client_label       : derived from clients.name (nullable join)
--     - client_slug        : derived from clients.slug (nullable join)
--     - total_shipments    : COUNT(public.shipments WHERE sender_id matches)
--     - active_shipments   : COUNT(public.shipments WHERE sender_id matches AND
--                            status NOT IN ('delivered','cancelled','returned_to_sender'))
--     - last_shipment_at   : MAX(shipments.created_at) for this sender
--     - has_warehouse      : derived BOOLEAN — TRUE when warehouse_address_id IS NOT NULL
--     - effective_warehouse_id : COALESCE(senders.warehouse_address_id,
--                                clients.warehouse_address_id) — surfaces the
--                                inheritance ladder (sender override → client default)
--     - sla_tier_inherited : passthrough from clients.sla_tier (sender does not
--                            have its own sla_tier; inherits from client)
--     - organization_id_resolved : resolved via clients.organization_id (senders
--                                table has no organization_id column per
--                                schema-drift §3 closure)
--
--   The FE `SenderRow` interface (apps/console-v2/src/modules/customers/senders.tsx)
--   currently joins clients via in-memory Map (clientById) for these derivations.
--   Moving to a canonical view closes GAP-SE-WAREHOUSE-ADDR / GAP-SE-INTAKE-DEEPLINK
--   surface-bind context without inventing FE-only fields.
--
-- Notes:
--   * SSOT remains public.senders; this view is read-only.
--   * RLS is enforced by the underlying tables (senders / clients / shipments).
--   * Service-role + authenticated SELECT (mirrors v_branch_summary baseline).
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302010_v_sender_summary'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_sender_summary;

CREATE VIEW public.v_sender_summary AS
WITH ship_active AS (
  SELECT
    sh.sender_id,
    COUNT(*)::INT AS active_shipments
  FROM public.shipments sh
  WHERE sh.sender_id IS NOT NULL
    AND sh.status NOT IN ('delivered', 'cancelled', 'returned_to_sender')
  GROUP BY sh.sender_id
),
ship_total AS (
  SELECT
    sh.sender_id,
    COUNT(*)::INT AS total_shipments,
    MAX(sh.created_at) AS last_shipment_at
  FROM public.shipments sh
  WHERE sh.sender_id IS NOT NULL
  GROUP BY sh.sender_id
)
SELECT
  s.id              AS sender_id,
  s.id              AS id,
  s.client_id,
  s.name,
  s.brand_name,
  s.auto_provisioned,
  s.auto_recreate,
  s.warehouse_address_id,
  s.settings_override,
  s.status,
  s.updated_at,
  -- Derived joins from clients
  c.name            AS client_label,
  c.slug            AS client_slug,
  c.sla_tier        AS sla_tier_inherited,
  c.organization_id AS organization_id_resolved,
  -- Effective warehouse: sender override or client default
  COALESCE(s.warehouse_address_id, c.warehouse_address_id) AS effective_warehouse_id,
  (s.warehouse_address_id IS NOT NULL) AS has_warehouse,
  -- Derived shipment counters
  COALESCE(ship_active.active_shipments, 0) AS active_shipments,
  COALESCE(ship_total.total_shipments, 0)   AS total_shipments,
  ship_total.last_shipment_at
FROM public.senders s
LEFT JOIN public.clients c ON c.id = s.client_id
LEFT JOIN ship_active ON ship_active.sender_id = s.id
LEFT JOIN ship_total  ON ship_total.sender_id = s.id;

COMMENT ON VIEW public.v_sender_summary IS
  'FE-friendly projection of senders with derived joins (client_label, client_slug, organization_id_resolved, sla_tier_inherited, effective_warehouse_id) and shipment counters (active_shipments, total_shipments, last_shipment_at). Sources: senders + clients + shipments. Read-only; SSOT remains senders; mutations go through sender_create_v1 / sender_update_v1 / sender_suspend_v1 / sender_reactivate_v1.';

REVOKE ALL ON public.v_sender_summary FROM PUBLIC;
REVOKE ALL ON public.v_sender_summary FROM anon;
REVOKE ALL ON public.v_sender_summary FROM authenticated;
GRANT SELECT ON public.v_sender_summary TO authenticated;
GRANT SELECT ON public.v_sender_summary TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302010_v_sender_summary'));
COMMIT;
