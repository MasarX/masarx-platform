BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.v_support_case_directory
  WITH (security_invoker = true)
  AS
SELECT
  sc.id,
  sc.organization_id,
  sc.client_id,
  sc.sender_id,
  sc.resource_type,
  sc.resource_id,
  CASE WHEN sc.resource_type = 'recipient' THEN sc.resource_id ELSE NULL END
    AS recipient_id,
  CASE WHEN sc.resource_type = 'shipment' THEN sc.resource_id ELSE NULL END
    AS related_shipment_id,
  sc.status,
  sc.status_reason,
  sc.priority,
  sc.subject,
  sc.channel,
  sc.tags,
  sc.assigned_to,
  sc.assigned_at,
  sc.sla_minutes,
  sc.sla_due_at,
  sc.opened_at,
  sc.resolved_at,
  sc.closed_at,
  sc.idempotency_key,
  sc.version,
  sc.metadata,
  sc.created_at,
  sc.updated_at,
  c.name       AS client_label,
  c.slug       AS client_slug,
  s.name       AS sender_label,
  s.brand_name AS sender_brand_label,
  CASE WHEN sc.resource_type = 'recipient' THEN r.name         ELSE NULL END
    AS recipient_label,
  CASE WHEN sc.resource_type = 'recipient' THEN r.phone_number ELSE NULL END
    AS recipient_phone,
  CASE WHEN sc.resource_type = 'shipment' THEN sh.tracking_number ELSE NULL END
    AS shipment_tracking_number,
  u.full_name AS assignee_label,
  vss.last_message_at,
  vss.message_count,
  vss.sla_breached,
  GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(sc.opened_at, sc.created_at))))::BIGINT
    AS age_seconds,
  GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(sc.opened_at, sc.created_at))) / 3600.0))::BIGINT
    AS age_hours,
  (sc.status IN ('open', 'in_progress'))            AS is_open,
  (sc.status IN ('resolved', 'closed', 'canceled')) AS is_terminal,
  CASE
    WHEN sc.status IN ('resolved', 'closed', 'canceled')
      AND sc.status_reason IS NOT NULL
      AND btrim(sc.status_reason) <> ''
      THEN sc.status_reason
    WHEN sc.status IN ('resolved', 'closed', 'canceled')
      THEN sc.status
    ELSE NULL
  END AS resolution_label
FROM public.support_cases sc
LEFT JOIN public.v_support_case_summary vss ON vss.id = sc.id
LEFT JOIN public.clients c    ON c.id = sc.client_id
LEFT JOIN public.senders s    ON s.id = sc.sender_id
LEFT JOIN public.users   u    ON u.id = sc.assigned_to
LEFT JOIN public.recipients r ON r.id = sc.resource_id AND sc.resource_type = 'recipient'
LEFT JOIN public.shipments sh ON sh.id = sc.resource_id AND sc.resource_type = 'shipment';

COMMENT ON VIEW public.v_support_case_directory IS
  'FE-friendly projection of support_cases with derived joins, polymorphic resource projections, summary computed fields, age derivations, status booleans, and terminal-only resolution_label. Sources: support_cases + v_support_case_summary + clients + senders + recipients + shipments + users. Read-only; SSOT remains support_cases; mutations go through support case lifecycle RPCs.';

REVOKE ALL ON public.v_support_case_directory FROM PUBLIC;
REVOKE ALL ON public.v_support_case_directory FROM anon;
GRANT SELECT ON public.v_support_case_directory TO authenticated;
GRANT SELECT ON public.v_support_case_directory TO service_role;

COMMIT;
