-- Repair v_shipment_directory risk projection to use the current
-- shipment_status lookup value `delivery_failed` instead of obsolete
-- `failed_attempt`.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031670_shipment_directory_risk_status_repair_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE VIEW public.v_shipment_directory
WITH (security_invoker = true)
AS
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
    COUNT(*)::INT AS scan_event_count,
    MAX(captured_at) AS last_scan_at
  FROM public.scan_events
  WHERE shipment_id IS NOT NULL
  GROUP BY shipment_id
),
comms_counts AS (
  SELECT
    oc.shipment_id,
    COUNT(*)::INT AS comms_attempt_count
  FROM public.comms_attempts ca
  JOIN public.outbound_calls oc ON oc.id = ca.outbound_call_id
  WHERE oc.shipment_id IS NOT NULL
  GROUP BY oc.shipment_id
),
active_tasks AS (
  SELECT
    resource_id AS shipment_id,
    COUNT(*)::INT AS active_task_count
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
  da.city AS destination_city,
  da.district AS destination_district,
  oa.city AS origin_city,
  oa.district AS origin_district,
  c.name AS client_label,
  sn.name AS sender_label,
  rc.name AS recipient_label,
  COALESCE(bc.box_actual_count, 0) AS box_actual_count,
  COALESCE(lc.label_count, 0) AS label_count,
  COALESCE(sr.scan_event_count, 0) AS scan_event_count,
  sr.last_scan_at,
  COALESCE(cc.comms_attempt_count, 0) AS comms_attempt_count,
  COALESCE(at.active_task_count, 0) AS active_task_count,
  (
    s.status = 'delivery_failed'
    OR (
      s.status = 'out_for_delivery'
      AND s.promised_delivery_date IS NOT NULL
      AND s.promised_delivery_date < CURRENT_DATE
    )
  ) AS is_at_risk
FROM public.shipments s
LEFT JOIN public.addresses da
  ON da.id = s.destination_address_id AND da.client_id = s.client_id
LEFT JOIN public.addresses oa
  ON oa.id = s.origin_address_id AND oa.client_id = s.client_id
LEFT JOIN public.clients c ON c.id = s.client_id
LEFT JOIN public.senders sn ON sn.id = s.sender_id
LEFT JOIN public.recipients rc ON rc.id = s.recipient_id
LEFT JOIN box_counts bc ON bc.shipment_id = s.id
LEFT JOIN label_counts lc ON lc.shipment_id = s.id
LEFT JOIN scan_rollup sr ON sr.shipment_id = s.id
LEFT JOIN comms_counts cc ON cc.shipment_id = s.id
LEFT JOIN active_tasks at ON at.shipment_id = s.id;

COMMENT ON VIEW public.v_shipment_directory IS
  'FE-friendly projection of shipments with address/counterparty labels, derived counters, and is_at_risk based on delivery_failed status or overdue out_for_delivery shipments. Read-only; SSOT remains shipments; mutations go through canonical shipment workflow/RPC paths.';

REVOKE ALL ON public.v_shipment_directory FROM PUBLIC;
REVOKE ALL ON public.v_shipment_directory FROM anon;
REVOKE ALL ON public.v_shipment_directory FROM authenticated;
GRANT SELECT ON public.v_shipment_directory TO authenticated;
GRANT SELECT ON public.v_shipment_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202605031670_shipment_directory_risk_status_repair_v1'));
COMMIT;
