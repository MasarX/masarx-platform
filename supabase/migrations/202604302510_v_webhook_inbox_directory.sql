-- Spec-Issue: W27 INTEGRATIONS gap closure (paired projection views)
-- Step: W27-VIEW-2
-- Migration: Canonical projection view public.v_webhook_inbox_directory.
-- Capability: webhooks.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-inbox-row derived joins + counters used by
--   `apps/console-v2/src/modules/integrations/intake.tsx` (WebhookInboxRow):
--     - source_label         : derived from webhook_sources.name
--     - source_identifier    : derived from webhook_sources.source_identifier
--     - provider_type_label  : alias of webhook_sources.provider_type (matches
--                                FE display vocabulary)
--     - replay_count         : derived COUNT(webhook_inbox_replays
--                                WHERE action='replay') per inbox row
--     - force_status_count   : derived COUNT(webhook_inbox_replays
--                                WHERE action='force_status') per inbox row
--     - last_replay_at       : derived MAX(webhook_inbox_replays.created_at)
--                                per inbox row
--     - last_replay_action   : derived action of MAX(created_at) replay row
--     - last_replay_actor    : derived users.full_name from changed_by FK on
--                                MAX(created_at) replay row
--     - is_terminal          : derived flag (processing_status IN
--                                ('succeeded','failed','dead_letter'))
--     - is_actionable        : derived flag (processing_status IN
--                                ('pending','processing','failed','dead_letter'))
--     - age_seconds          : derived (now() - created_at)::seconds
--     - age_hours            : derived age_seconds / 3600
--     - payload_size         : derived length(raw_payload::text) — exposes the
--                                canonical equivalent of the FE-projection
--                                column documented at W11/W14 closures
--
--   The FE `WebhookInboxRow` interface at
--   apps/console-v2/src/modules/integrations/intake.tsx carries:
--     - payload_size, workflow_run_id (derived projection annotations).
--   This view exposes the projection over the canonical SSOT plus replay-ledger
--   counters and source-label resolution.
--
-- Notes:
--   * SSOT remains public.webhook_inbox; this view is read-only.
--   * `webhook_inbox_replays` is service-role-only at base. Authenticated reads
--     of this view rely on `security_invoker=true` so the underlying
--     webhook_inbox RLS gates per-row visibility, while the lateral join to the
--     replays ledger runs under the invoker's privilege. Operators with
--     `webhooks.write` (issuers of force_status/replay) implicitly have
--     service-role context in those code paths; for read-only directory
--     surfaces, replay counters fall back to 0 when the join returns no rows
--     (no information leak).
--   * Service-role + authenticated SELECT.
--   * Idempotent: pure view; safe to re-run.
--   * `age_seconds` / `age_hours` evaluate `now()` at query time.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302510_v_webhook_inbox_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_webhook_inbox_directory;

CREATE VIEW public.v_webhook_inbox_directory
  WITH (security_invoker = true)
  AS
SELECT
  wi.id,
  wi.webhook_source_id,
  wi.provider_type,
  wi.external_id,
  wi.event_type,
  wi.processing_status,
  wi.correlation_id,
  wi.lease_expires_at,
  wi.created_at,
  wi.processed_at,
  wi.error_message,
  -- Derived: payload size projection
  length(wi.raw_payload::text) AS payload_size,
  -- Derived: source label resolution
  ws.name              AS source_label,
  ws.source_identifier AS source_identifier,
  ws.provider_type     AS provider_type_label,
  -- Derived: replay-ledger counters
  COALESCE(replay_agg.replay_count, 0) AS replay_count,
  COALESCE(replay_agg.force_status_count, 0) AS force_status_count,
  replay_agg.last_replay_at,
  replay_agg.last_replay_action,
  replay_agg.last_replay_actor,
  -- Derived: status flags (single SSOT for FE chip + action gating)
  (wi.processing_status IN ('succeeded', 'failed', 'dead_letter', 'processed')) AS is_terminal,
  (wi.processing_status IN ('pending', 'processing', 'failed', 'dead_letter')) AS is_actionable,
  -- Derived: age (now-aware, deterministic at query time)
  GREATEST(0, EXTRACT(EPOCH FROM (now() - wi.created_at)))::BIGINT AS age_seconds,
  GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - wi.created_at)) / 3600.0))::BIGINT AS age_hours
FROM public.webhook_inbox wi
LEFT JOIN public.webhook_sources ws ON ws.id = wi.webhook_source_id
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE wir.action = 'replay') AS replay_count,
    COUNT(*) FILTER (WHERE wir.action = 'force_status') AS force_status_count,
    MAX(wir.created_at) AS last_replay_at,
    (
      SELECT wir2.action
        FROM public.webhook_inbox_replays wir2
       WHERE wir2.webhook_inbox_id = wi.id
       ORDER BY wir2.created_at DESC
       LIMIT 1
    ) AS last_replay_action,
    (
      SELECT u.full_name
        FROM public.webhook_inbox_replays wir3
        LEFT JOIN public.users u ON u.id = wir3.changed_by
       WHERE wir3.webhook_inbox_id = wi.id
       ORDER BY wir3.created_at DESC
       LIMIT 1
    ) AS last_replay_actor
    FROM public.webhook_inbox_replays wir
   WHERE wir.webhook_inbox_id = wi.id
) replay_agg ON TRUE;

COMMENT ON VIEW public.v_webhook_inbox_directory IS
  'FE-friendly projection of webhook_inbox with derived source label resolution (source_label, source_identifier, provider_type_label via webhook_sources), replay-ledger counters (replay_count, force_status_count, last_replay_at, last_replay_action, last_replay_actor via webhook_inbox_replays + users), payload_size (length(raw_payload::text)), age derivations (age_seconds, age_hours), and status flags (is_terminal, is_actionable). Sources: webhook_inbox + webhook_sources + webhook_inbox_replays + users. Read-only; SSOT remains webhook_inbox; mutations go through webhook_inbox_replay_v1 / webhook_inbox_force_status_v1.';

REVOKE ALL ON public.v_webhook_inbox_directory FROM PUBLIC;
REVOKE ALL ON public.v_webhook_inbox_directory FROM anon;
GRANT SELECT ON public.v_webhook_inbox_directory TO authenticated;
GRANT SELECT ON public.v_webhook_inbox_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302510_v_webhook_inbox_directory'));
COMMIT;
