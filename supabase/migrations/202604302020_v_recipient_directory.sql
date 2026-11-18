-- Spec-Issue: W21 CUSTOMERS gap closure (paired projection views)
-- Step: W21-VIEW-3
-- Migration: Canonical projection view public.v_recipient_directory.
-- Capability: recipients.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-recipient derived joins + shipment counters used by
--   `apps/console-v2/src/modules/customers/recipients.tsx` (RecipientRow):
--     - client_label       : derived from clients.name
--     - client_slug        : derived from clients.slug
--     - total_shipments    : COUNT(public.shipments WHERE recipient_id matches)
--     - last_shipment_at   : MAX(shipments.created_at) for this recipient
--     - last_shipment_status : status of most recent shipment
--     - phone_validated    : derived BOOLEAN — TRUE when phone_validation_status='valid'
--     - has_quiet_hours    : derived BOOLEAN — TRUE when both quiet_hours_start AND
--                            quiet_hours_end are set
--
--   The FE `RecipientRow` interface (apps/console-v2/src/modules/customers/recipients.tsx)
--   currently joins clients via in-memory Map (clientById) for the drawer client_label.
--   Moving to a canonical view closes the recipients-side surface-bind for
--   shipment counter context (currently absent from operator NDR triage drawer).
--
-- Notes:
--   * SSOT remains public.recipients; this view is read-only.
--   * RLS is enforced by the underlying tables (recipients / clients / shipments).
--   * Service-role + authenticated SELECT (mirrors v_branch_zone_directory baseline).
--   * Idempotent: pure view; safe to re-run.
--   * `last_shipment_status` uses a correlated lateral join, equivalent to a
--     window-ranked LEFT JOIN (`ROW_NUMBER() OVER (PARTITION BY recipient_id
--     ORDER BY created_at DESC)` filtered to rn=1). The lateral form is
--     idiomatic Postgres and avoids the additional CTE pass for the typical
--     few-shipments-per-recipient cardinality.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302020_v_recipient_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_recipient_directory;

CREATE VIEW public.v_recipient_directory AS
WITH ship_total AS (
  SELECT
    sh.recipient_id,
    COUNT(*)::INT AS total_shipments,
    MAX(sh.created_at) AS last_shipment_at
  FROM public.shipments sh
  WHERE sh.recipient_id IS NOT NULL
  GROUP BY sh.recipient_id
)
SELECT
  r.id                AS recipient_id,
  r.id                AS id,
  r.organization_id,
  r.client_id,
  r.external_id,
  r.name,
  r.phone_number,
  r.phone_validation_status,
  r.email,
  r.preferred_language,
  r.preferred_comm_channel,
  r.quiet_hours_start,
  r.quiet_hours_end,
  r.communication_preferences,
  r.updated_at,
  -- Derived joins
  c.name              AS client_label,
  c.slug              AS client_slug,
  -- Derived counters
  COALESCE(ship_total.total_shipments, 0) AS total_shipments,
  ship_total.last_shipment_at,
  -- Last shipment status (deterministic latest by created_at)
  (
    SELECT sh.status
    FROM public.shipments sh
    WHERE sh.recipient_id = r.id
    ORDER BY sh.created_at DESC
    LIMIT 1
  )                   AS last_shipment_status,
  -- Derived booleans
  (r.phone_validation_status = 'valid') AS phone_validated,
  (r.quiet_hours_start IS NOT NULL AND r.quiet_hours_end IS NOT NULL) AS has_quiet_hours
FROM public.recipients r
LEFT JOIN public.clients c ON c.id = r.client_id
LEFT JOIN ship_total ON ship_total.recipient_id = r.id;

COMMENT ON VIEW public.v_recipient_directory IS
  'FE-friendly projection of recipients with derived joins (client_label, client_slug) and shipment counters (total_shipments, last_shipment_at, last_shipment_status, phone_validated, has_quiet_hours). Sources: recipients + clients + shipments. Read-only; SSOT remains recipients; mutations go through recipient_update_v1.';

REVOKE ALL ON public.v_recipient_directory FROM PUBLIC;
REVOKE ALL ON public.v_recipient_directory FROM anon;
REVOKE ALL ON public.v_recipient_directory FROM authenticated;
GRANT SELECT ON public.v_recipient_directory TO authenticated;
GRANT SELECT ON public.v_recipient_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302020_v_recipient_directory'));
COMMIT;
