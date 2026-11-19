-- Spec-Issue: W26 SUPPORT gap closure (paired projection views)
-- Step: W26-VIEW-1
-- Migration: Canonical projection view public.v_support_case_directory.
-- Capability: support.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-case derived joins + counters used by
--   `apps/console-v2/src/modules/support/cases.tsx` (SupportCaseRow):
--     - client_label             : derived from clients.name
--     - client_slug              : derived from clients.slug
--     - sender_label             : derived from senders.name (when sender_id set)
--     - sender_brand_label       : derived from senders.brand_name
--     - assignee_label           : derived from users.full_name (assigned operator)
--     - recipient_id             : polymorphic projection — resource_id when
--                                   resource_type='recipient' (FE retains the
--                                   typed alias; canonical schema uses
--                                   `(resource_type, resource_id)`)
--     - related_shipment_id      : polymorphic projection — resource_id when
--                                   resource_type='shipment'
--     - recipient_label          : derived from recipients.name (when polymorphic
--                                   resource resolves to a recipient row)
--     - recipient_phone          : derived from recipients.phone_number
--     - shipment_tracking_number : derived from shipments.tracking_number (when
--                                   polymorphic resource resolves to a shipment)
--     - age_seconds              : EXTRACT(EPOCH FROM (now() - opened_at))
--     - age_hours                : age_seconds / 3600 (BIGINT)
--     - is_open                  : status IN ('open','in_progress')
--     - is_terminal              : status IN ('resolved','closed','canceled')
--     - resolution_label         : human-readable status_reason fallback
--                                   (status_reason OR derived from status)
--
--   The FE `SupportCaseRow` interface at apps/console-v2/src/modules/support/cases.tsx
--   carries polymorphic alias shadows (`recipient_id`, `related_shipment_id`)
--   plus 6 derived/joined surface fields (`subject` / `channel` / `tags` are
--   already canonical columns post-B3; W26 adds the missing label/age/status
--   projections so the FE no longer needs in-memory client/sender/recipient
--   re-resolution per case row).
--
-- Notes:
--   * SSOT remains public.support_cases; this view is read-only.
--   * Reuses the canonical computed fields from v_support_case_summary
--     (last_message_at / message_count / sla_breached) by JOINing the summary
--     view directly, so deriving the FE-friendly cases payload only requires
--     this single read seam.
--   * RLS is enforced by the underlying tables (support_cases / support_messages
--     / clients / senders / recipients / shipments / users) via
--     `security_invoker = true`.
--   * Service-role + authenticated SELECT (mirrors v_support_case_summary baseline).
--   * Idempotent: pure view; safe to re-run.
--   * `age_seconds` / `age_hours` evaluate `now()` at query time — callers receive
--     a deterministic per-row state at read time.
--   * Polymorphic projections are defensive: missing recipient/shipment rows
--     produce NULL labels (no error path).

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302400_v_support_case_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_support_case_directory;

CREATE VIEW public.v_support_case_directory
  WITH (security_invoker = true)
  AS
SELECT
  sc.id,
  sc.organization_id,
  sc.client_id,
  sc.sender_id,
  sc.resource_type,
  sc.resource_id,
  -- Polymorphic alias shadows for the FE row interface — collapse the
  -- canonical (resource_type, resource_id) pair to typed FE fields.
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
  -- Derived joins (foreign label resolution)
  c.name              AS client_label,
  c.slug              AS client_slug,
  s.name              AS sender_label,
  s.brand_name        AS sender_brand_label,
  -- Polymorphic recipient resolution
  CASE WHEN sc.resource_type = 'recipient' THEN r.name         ELSE NULL END
    AS recipient_label,
  CASE WHEN sc.resource_type = 'recipient' THEN r.phone_number ELSE NULL END
    AS recipient_phone,
  -- Polymorphic shipment resolution
  CASE WHEN sc.resource_type = 'shipment' THEN sh.tracking_number ELSE NULL END
    AS shipment_tracking_number,
  -- Assignee label resolution
  u.full_name         AS assignee_label,
  -- Computed fields from v_support_case_summary baseline (B3 W3-2 closure)
  vss.last_message_at,
  vss.message_count,
  vss.sla_breached,
  -- Age derivations (now-aware, deterministic at query time)
  GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(sc.opened_at, sc.created_at))))::BIGINT
    AS age_seconds,
  GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(sc.opened_at, sc.created_at))) / 3600.0))::BIGINT
    AS age_hours,
  -- Status booleans (single source of truth across queue chip + KPI tiles)
  (sc.status IN ('open', 'in_progress'))                       AS is_open,
  (sc.status IN ('resolved', 'closed', 'canceled'))            AS is_terminal,
  -- Resolution label: prefer canonical status_reason, fall back to status when
  -- terminal so the FE always has a non-null chip target for resolved cases.
  CASE
    WHEN sc.status_reason IS NOT NULL AND btrim(sc.status_reason) <> ''
      THEN sc.status_reason
    WHEN sc.status IN ('resolved', 'closed', 'canceled')
      THEN sc.status
    ELSE NULL
  END                                                          AS resolution_label
FROM public.support_cases sc
LEFT JOIN public.v_support_case_summary vss ON vss.id = sc.id
LEFT JOIN public.clients c    ON c.id = sc.client_id
LEFT JOIN public.senders s    ON s.id = sc.sender_id
LEFT JOIN public.users   u    ON u.id = sc.assigned_to
LEFT JOIN public.recipients r ON r.id = sc.resource_id AND sc.resource_type = 'recipient'
LEFT JOIN public.shipments sh ON sh.id = sc.resource_id AND sc.resource_type = 'shipment';

COMMENT ON VIEW public.v_support_case_directory IS
  'FE-friendly projection of support_cases with derived joins (client_label, client_slug, sender_label, sender_brand_label, assignee_label), polymorphic resource projections (recipient_id, related_shipment_id, recipient_label, recipient_phone, shipment_tracking_number), summary computed fields (last_message_at, message_count, sla_breached via v_support_case_summary), age derivations (age_seconds, age_hours), and status booleans (is_open, is_terminal, resolution_label). Sources: support_cases + v_support_case_summary + clients + senders + recipients + shipments + users. Read-only; SSOT remains support_cases; mutations go through create_support_case_v1 / update_support_case_v1 / assign_support_case_v1 / bulk_assign_support_cases_v1 / resolve_support_case_v1 / bulk_resolve_support_cases_v1 / reopen_support_case_v1 / send_support_message_v1 / add_support_tag_v1.';

REVOKE ALL ON public.v_support_case_directory FROM PUBLIC;
REVOKE ALL ON public.v_support_case_directory FROM anon;
GRANT SELECT ON public.v_support_case_directory TO authenticated;
GRANT SELECT ON public.v_support_case_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302400_v_support_case_directory'));
COMMIT;
