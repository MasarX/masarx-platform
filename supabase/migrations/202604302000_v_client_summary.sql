-- Spec-Issue: W21 CUSTOMERS gap closure (paired projection views)
-- Step: W21-VIEW-1
-- Migration: Canonical projection view public.v_client_summary.
-- Capability: clients.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-client derived counters used by
--   `apps/console-v2/src/modules/customers/clients.tsx` (ClientRow surface):
--     - sender_count       : COUNT(public.senders WHERE client_id matches AND status='active').
--     - recipient_count    : COUNT(public.recipients WHERE client_id matches).
--     - active_shipments   : COUNT(public.shipments WHERE client_id matches AND
--                            status NOT IN ('delivered','cancelled','returned_to_sender')).
--     - total_shipments    : COUNT(public.shipments WHERE client_id matches).
--     - last_shipment_at   : MAX(shipments.created_at) for this client.
--     - contract_active    : derived BOOLEAN — TRUE when status='active' AND
--                            (contract_end_date IS NULL OR contract_end_date >= today).
--     - has_warehouse      : derived BOOLEAN — TRUE when warehouse_address_id IS NOT NULL.
--     - account_manager_id : passthrough from public.clients.
--     - billing_settings   : passthrough from public.clients (JSONB).
--     - settings_override  : passthrough from public.clients (JSONB).
--     - updated_at         : passthrough from public.clients.
--
--   The FE `ClientRow` interface (apps/console-v2/src/modules/customers/clients.tsx)
--   currently surfaces these derived counters from inline FE-side joins or
--   keeps them as `editable: false` placeholders. Moving the derivations to a
--   canonical view closes GAP-CL-CONTRACTS / GAP-CL-WAREHOUSE-ADDR /
--   GAP-CL-BILLING-SETTINGS surface-bind gaps without inventing FE-only fields.
--
-- Notes:
--   * SSOT remains public.clients; this view is read-only.
--   * RLS is enforced by the underlying tables (clients / senders /
--     recipients / shipments). Tenant isolation comes from the underlying
--     tables' SELECT policies, which scope rows to caller's organization.
--   * Service-role + authenticated SELECT (mirrors v_branch_summary +
--     v_zone_summary baselines).
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302000_v_client_summary'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_client_summary;

CREATE VIEW public.v_client_summary AS
WITH snd AS (
  -- Active sender count per client.
  SELECT
    s.client_id,
    COUNT(*)::INT AS sender_count
  FROM public.senders s
  WHERE s.status = 'active'
  GROUP BY s.client_id
),
rcp AS (
  -- Recipient count per client.
  SELECT
    r.client_id,
    COUNT(*)::INT AS recipient_count
  FROM public.recipients r
  GROUP BY r.client_id
),
ship_active AS (
  -- Active shipments anchored to this client (not in terminal states).
  SELECT
    sh.client_id,
    COUNT(*)::INT AS active_shipments
  FROM public.shipments sh
  WHERE sh.status NOT IN ('delivered', 'cancelled', 'returned_to_sender')
  GROUP BY sh.client_id
),
ship_total AS (
  -- Total shipments + last shipment timestamp per client.
  SELECT
    sh.client_id,
    COUNT(*)::INT AS total_shipments,
    MAX(sh.created_at) AS last_shipment_at
  FROM public.shipments sh
  GROUP BY sh.client_id
)
SELECT
  c.id              AS client_id,
  c.id              AS id,
  c.organization_id,
  c.name,
  c.slug,
  c.sla_tier,
  c.status,
  c.account_manager_id,
  c.contract_start_date,
  c.contract_end_date,
  c.suspension_reason,
  c.warehouse_address_id,
  c.billing_settings,
  c.settings_override,
  c.updated_at,
  COALESCE(snd.sender_count, 0)        AS sender_count,
  COALESCE(rcp.recipient_count, 0)     AS recipient_count,
  COALESCE(ship_active.active_shipments, 0) AS active_shipments,
  COALESCE(ship_total.total_shipments, 0)   AS total_shipments,
  ship_total.last_shipment_at,
  -- Derived contract_active: status active AND contract dates valid.
  (c.status = 'active'
    AND (c.contract_end_date IS NULL OR c.contract_end_date >= CURRENT_DATE))
    AS contract_active,
  -- Derived has_warehouse: presence of default warehouse address.
  (c.warehouse_address_id IS NOT NULL) AS has_warehouse
FROM public.clients c
LEFT JOIN snd        ON snd.client_id = c.id
LEFT JOIN rcp        ON rcp.client_id = c.id
LEFT JOIN ship_active ON ship_active.client_id = c.id
LEFT JOIN ship_total  ON ship_total.client_id = c.id;

COMMENT ON VIEW public.v_client_summary IS
  'FE-friendly projection of clients with derived counters (sender_count, recipient_count, active_shipments, total_shipments, last_shipment_at, contract_active, has_warehouse). Sources: clients + senders + recipients + shipments. Read-only; SSOT remains clients; mutations go through client_create_v1 / client_update_v1 / client_suspend_v1 / client_reactivate_v1.';

REVOKE ALL ON public.v_client_summary FROM PUBLIC;
REVOKE ALL ON public.v_client_summary FROM anon;
REVOKE ALL ON public.v_client_summary FROM authenticated;
GRANT SELECT ON public.v_client_summary TO authenticated;
GRANT SELECT ON public.v_client_summary TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302000_v_client_summary'));
COMMIT;
