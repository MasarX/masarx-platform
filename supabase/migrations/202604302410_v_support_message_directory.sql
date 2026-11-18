-- Spec-Issue: W26 SUPPORT gap closure (paired projection views)
-- Step: W26-VIEW-2
-- Migration: Canonical projection view public.v_support_message_directory.
-- Capability: support.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-message derived joins + flags used by
--   `apps/console-v2/src/modules/support/cases.tsx` (SupportMessageRow):
--     - sent_at        : alias for canonical `created_at` (FE retains the
--                         `sent_at` UI vocabulary while live cutover stays a
--                         single getSupabaseClient() branch flip)
--     - author_role    : derived enum {operator, customer, system} from
--                         direction + actor (operator → outbound + actor_user_id,
--                         customer → inbound, system → internal OR no actor)
--     - author_user_id : alias for canonical `actor_user_id` (FE retains the
--                         `author_user_id` UI vocabulary)
--     - author_label   : derived from users.full_name OR actor_system OR
--                         'system' (so FE never renders a null name)
--     - has_artifact   : BOOLEAN — TRUE when artifact_id IS NOT NULL
--
--   The FE `SupportMessageRow` interface at apps/console-v2/src/modules/support/cases.tsx
--   currently keeps `sent_at`, `author_role`, `author_user_id`, `author_name` as
--   FE-only projection keys. This view exposes canonical SSOT columns plus the
--   derived joins/role under stable keys so the live cutover stays transparent.
--
-- Notes:
--   * SSOT remains public.support_messages; this view is read-only.
--   * Underlying RLS is enforced via `security_invoker = true`, so the existing
--     support_messages_select policy governs access transparently.
--   * Service-role + authenticated SELECT (mirrors v_support_case_summary baseline).
--   * Idempotent: pure view; safe to re-run.
--   * `author_role` derivation is the single source of truth across queue +
--     thread + drawer renders so MessageThread bubble alignment is row-driven
--     by canonical message direction + actor.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302410_v_support_message_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_support_message_directory;

CREATE VIEW public.v_support_message_directory
  WITH (security_invoker = true)
  AS
SELECT
  sm.id,
  sm.support_case_id,
  sm.organization_id,
  sm.direction,
  sm.channel,
  sm.actor_user_id,
  sm.actor_system,
  sm.body,
  sm.artifact_id,
  sm.metadata,
  sm.created_at,
  -- FE alias shadows
  sm.created_at AS sent_at,
  sm.actor_user_id AS author_user_id,
  -- Derived author role (single SSOT for MessageThread bubble alignment)
  --   operator : outbound from a real actor
  --   customer : inbound (from outside)
  --   system   : internal (workflow/automation) OR no actor at all
  CASE
    WHEN sm.direction = 'outbound' AND sm.actor_user_id IS NOT NULL THEN 'operator'
    WHEN sm.direction = 'inbound'                                    THEN 'customer'
    WHEN sm.direction = 'internal'                                   THEN 'system'
    WHEN sm.actor_user_id IS NULL AND sm.actor_system IS NOT NULL    THEN 'system'
    ELSE 'system'
  END AS author_role,
  -- Author label resolution (FE renders this directly; never null in practice)
  COALESCE(u.full_name, sm.actor_system, 'system') AS author_label,
  -- Convenience flags for surfaces that count attachments without a join hop
  (sm.artifact_id IS NOT NULL) AS has_artifact
FROM public.support_messages sm
LEFT JOIN public.users u ON u.id = sm.actor_user_id;

COMMENT ON VIEW public.v_support_message_directory IS
  'FE-friendly projection of support_messages with FE alias shadows (sent_at, author_user_id), derived author_role enum (operator/customer/system from direction + actor), and resolved author_label (users.full_name OR actor_system OR ''system''). Sources: support_messages + users. Read-only; SSOT remains support_messages; mutations go through send_support_message_v1.';

REVOKE ALL ON public.v_support_message_directory FROM PUBLIC;
REVOKE ALL ON public.v_support_message_directory FROM anon;
GRANT SELECT ON public.v_support_message_directory TO authenticated;
GRANT SELECT ON public.v_support_message_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302410_v_support_message_directory'));
COMMIT;
