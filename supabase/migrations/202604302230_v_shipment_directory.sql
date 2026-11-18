-- Spec-Issue: W24 OPERATIONS gap closure (paired projection views)
-- Step: W24-VIEW-1
-- Migration: Canonical projection view public.v_shipment_directory.
-- Capability: shipments.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-shipment derived counters + joined labels used by
--   `apps/console-v2/src/modules/operate/shipments.tsx` (Shipment surface +
--   the related-rail drawer tabs):
--     - destination_city   : projection — addresses.city via FK join through
--                            destination_address_id (the FE has long
--                            documented this as a "derived projection alias
--                            from addresses.city"; canonical resolution).
--     - origin_city        : projection — addresses.city via origin_address_id.
--     - client_label       : projection — clients.name via FK join.
--     - sender_label       : projection — senders.name via FK join.
--     - recipient_label    : projection — recipients.name via FK join.
--     - box_actual_count   : projection — COUNT(shipment_boxes WHERE
--                            shipment_id matches). Compared against the
--                            canonical `shipments.box_count` to surface
--                            divergence between header count and physical
--                            boxes.
--     - label_count        : projection — COUNT(labels WHERE shipment_id
--                            matches).
--     - scan_event_count   : projection — COUNT(scan_events WHERE
--                            shipment_id matches).
--     - last_scan_at       : projection — MAX(scan_events.captured_at) per
--                            shipment_id. NULL when no scans.
--     - comms_attempt_count: projection — COUNT(comms_attempts WHERE
--                            shipment_id matches).
--     - active_task_count  : projection — COUNT(tasks WHERE
--                            resource_type='shipment' AND resource_id matches
--                            AND status NOT IN canonical terminal states).
--     - is_at_risk         : derived — TRUE when status='failed_attempt' OR
--                            status='out_for_delivery' AND
--                            promised_delivery_date < CURRENT_DATE. Mirrors
--                            the FE `isShipmentRisk()` helper exported from
--                            `apps/console-v2/src/modules/operate/shipments.tsx`
--                            so a future canonical
--                            `resolve_shipment_risk_v1` can replace both
--                            seams without surface drift.
--
--   The FE `Shipment` interface in `shipments.tsx` keeps the canonical
--   columns; reading counter context through this seam removes the need to
--   issue per-row aggregate queries from the drawer renderers and gives the
--   tracking-map / operate dashboards a stable label projection (no JSONB
--   gymnastics in render code). Production cutover is a single
--   getSupabaseClient() branch flip in
--   `ui_list_resource_v1('shipment_directory')`.
--
-- Notes:
--   * SSOT remains public.shipments; this view is read-only.
--   * RLS is enforced by the underlying tables (shipments, addresses,
--     clients, senders, recipients, shipment_boxes, labels, scan_events,
--     comms_attempts, tasks).
--   * Service-role + authenticated SELECT (mirrors W20/W21/W22/W23 paired
--     projection grants).
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302230_v_shipment_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_shipment_directory;

CREATE VIEW public.v_shipment_directory AS
WITH box_counts AS (
  SELECT shipment_id, COUNT(*)::INT AS box_actual_count
  FROM public.shipment_boxes
  GROUP BY shipment_id
),
label_counts AS (
  SELECT shipment_id, COUNT(*)::INT AS label_count
  FROM public.labels
  GROUP BY shipment_id
),
scan_rollup AS (
  SELECT
    shipment_id,
    COUNT(*)::INT                  AS scan_event_count,
    MAX(captured_at)               AS last_scan_at
  FROM public.scan_events
  WHERE shipment_id IS NOT NULL
  GROUP BY shipment_id
),
comms_counts AS (
  -- comms_attempts joins to a parent outbound_calls row which carries the
  -- canonical shipment_id (see migration 202510110005_communications.sql:73,
  -- 134-189). Counter is on attempts to mirror what the FE drawer renders.
  SELECT
    oc.shipment_id,
    COUNT(*)::INT AS comms_attempt_count
  FROM public.comms_attempts ca
  JOIN public.outbound_calls oc ON oc.id = ca.outbound_call_id
  WHERE oc.shipment_id IS NOT NULL
  GROUP BY oc.shipment_id
),
active_tasks AS (
  -- Active = not in a terminal state. Tasks SSOT migration
  -- 202601212300_tasks_ssot_core.sql defines canonical terminal states
  -- (completed, cancelled, rejected, expired); we keep the set inline so
  -- the projection is self-contained and reviewable. `tasks.resource_id`
  -- is already UUID per the migration so no cast is needed.
  SELECT
    resource_id                                  AS shipment_id,
    COUNT(*)::INT                                AS active_task_count
  FROM public.tasks
  WHERE resource_type = 'shipment'
    AND resource_id IS NOT NULL
    AND status NOT IN ('completed', 'cancelled', 'rejected', 'expired')
  GROUP BY resource_id
)
SELECT
  s.id,
  s.client_id,
  s.organization_id,
  s.sender_id,
  s.recipient_id,
  s.tracking_number,
  s.client_reference_number,
  s.carrier_reference_number,
  s.service_type,
  s.service_level,
  s.status,
  s.status_updated_at,
  s.cod_amount,
  s.cod_currency,
  s.declared_value,
  s.box_count,
  s.promised_delivery_date,
  s.priority_score,
  s.origin_address_id,
  s.destination_address_id,
  s.metadata,
  s.created_at,
  s.updated_at,
  -- Address projections (canonical resolution of `destination_city` /
  -- `origin_city` aliases the FE has long carried).
  da.city                                              AS destination_city,
  da.district                                          AS destination_district,
  oa.city                                              AS origin_city,
  oa.district                                          AS origin_district,
  -- Counterparty label projections.
  c.name                                               AS client_label,
  sn.name                                              AS sender_label,
  rc.name                                              AS recipient_label,
  -- Counter projections (derived from canonical event/child tables).
  COALESCE(bc.box_actual_count, 0)                     AS box_actual_count,
  COALESCE(lc.label_count, 0)                          AS label_count,
  COALESCE(sr.scan_event_count, 0)                     AS scan_event_count,
  sr.last_scan_at,
  COALESCE(cc.comms_attempt_count, 0)                  AS comms_attempt_count,
  COALESCE(at.active_task_count, 0)                    AS active_task_count,
  -- Derived risk projection mirrors the FE `isShipmentRisk()` helper.
  (
    s.status = 'failed_attempt'
    OR (
      s.status = 'out_for_delivery'
      AND s.promised_delivery_date IS NOT NULL
      AND s.promised_delivery_date < CURRENT_DATE
    )
  )                                                    AS is_at_risk
FROM public.shipments s
LEFT JOIN public.addresses da
  ON da.id = s.destination_address_id AND da.client_id = s.client_id
LEFT JOIN public.addresses oa
  ON oa.id = s.origin_address_id AND oa.client_id = s.client_id
LEFT JOIN public.clients c       ON c.id = s.client_id
LEFT JOIN public.senders sn      ON sn.id = s.sender_id
LEFT JOIN public.recipients rc   ON rc.id = s.recipient_id
LEFT JOIN box_counts bc          ON bc.shipment_id = s.id
LEFT JOIN label_counts lc        ON lc.shipment_id = s.id
LEFT JOIN scan_rollup sr         ON sr.shipment_id = s.id
LEFT JOIN comms_counts cc        ON cc.shipment_id = s.id
LEFT JOIN active_tasks at        ON at.shipment_id = s.id;

COMMENT ON VIEW public.v_shipment_directory IS
  'FE-friendly projection of shipments with destination/origin city + district (addresses join), counterparty labels (clients.name, senders.name, recipients.name), per-shipment derived counters (box_actual_count, label_count, scan_event_count, last_scan_at, comms_attempt_count, active_task_count), and is_at_risk derived flag mirroring isShipmentRisk() FE helper. Sources: shipments + addresses + clients + senders + recipients + shipment_boxes + labels + scan_events + comms_attempts + tasks. Read-only; SSOT remains shipments; mutations go through shipment_amend_cancel_v1 / ui_execute_shipment_resort_v1 / ui_execute_shipment_batch_operation_v1 / start_workflow_run(tpl_create_shipment).';

REVOKE ALL ON public.v_shipment_directory FROM PUBLIC;
REVOKE ALL ON public.v_shipment_directory FROM anon;
REVOKE ALL ON public.v_shipment_directory FROM authenticated;
GRANT SELECT ON public.v_shipment_directory TO authenticated;
GRANT SELECT ON public.v_shipment_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302230_v_shipment_directory'));
COMMIT;
