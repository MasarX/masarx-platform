-- Migration: project the mobile_auth_policy global default into public.settings
-- Date: 2026-05-16
-- Spec: MasarX Mobile FieldOps V2 — closes engineering re-audit finding I1
--   (docs/ops/evidence/2026-05-16/mobile-v2-fieldops-audit-cycle-2/README.md).
--
--   `202605131200_fieldops_auth_otp_verifier_v1.sql` seeded the
--   `mobile_auth_policy` global default into `public.settings_versions`
--   ONLY. The canonical resolver `resolve_settings_row_from_policy_context_v1`
--   reads exclusively from `public.settings JOIN public.settings_versions`
--   (the denormalised "active view"), so a bare `settings_versions` row is
--   never surfaced. The effect: `verify_fieldops_otp_v1` resolves NULL and
--   fail-closes for every call regardless of the configured provider /
--   test_otp, and operators have no working opt-in path.
--
--   This migration projects the current global `mobile_auth_policy` version
--   into `public.settings`, matching the dual-write pattern every other
--   policy seed uses (e.g. `202602061130_mobile_attestation_policy...`).
--
--   AGENTS.md compliance:
--   - Idempotent: `WHERE NOT EXISTS` guard (the global row has scope_id NULL,
--     where a plain `ON CONFLICT` target is unreliable under SQL NULL
--     semantics — the same reason the attestation seed uses NOT EXISTS).
--   - Append-only: no historical migration file is edited.
--   - Zero hardcoding: the projected value is read from the existing
--     `settings_versions` row, not re-stated here.
--   - Advisory-locked to serialise concurrent apply.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605161200_fieldops_auth_otp_policy_settings_projection_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- Project the current global mobile_auth_policy version into public.settings
-- so the canonical resolver can surface it. The partial unique-current index
-- on settings_versions guarantees at most one row matches the predicate.
INSERT INTO public.settings (
  category, scope_type, scope_id, settings_version_id, cached_value, last_updated
)
SELECT sv.category, sv.scope_type, sv.scope_id, sv.id, sv.value, now()
  FROM public.settings_versions sv
 WHERE sv.category = 'mobile_auth_policy'
   AND sv.scope_type = 'global'
   AND sv.scope_id IS NULL
   AND sv.effective_until IS NULL
   AND sv.approved_at IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM public.settings s
      WHERE s.category = 'mobile_auth_policy'
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
   );

SELECT pg_advisory_unlock(hashtext('202605161200_fieldops_auth_otp_policy_settings_projection_v1'));
COMMIT;
