-- pgTAP coverage for Mobile V2 auth OTP verifier
-- (verify_fieldops_otp_v1 + updated submit_fieldops_auth_otp_v1)
--
-- Closes the audit finding that submit_fieldops_auth_otp_v1 used to
-- accept any [0-9]{6} string and write 'authenticated' to decision_log.
-- After 202605131200_fieldops_auth_otp_verifier_v1.sql, the verifier is
-- policy-driven and fail-closed; this test enforces the contract.
--
-- ALSO closes the engineering audit MINOR follow-up #3: ladder
-- precedence — a tenant-scope row must beat the global-scope default
-- when the resolver context carries organization_id.
--
-- Assertions:
--   1) verify_fieldops_otp_v1 exists, SECDEF, granted to authenticated, not anon
--   2) verifier returns FALSE for non-6-digit input (format precondition)
--   3) verifier returns FALSE when mobile_auth_policy.test_otp is null
--      (default fail-closed posture)
--   4) verifier returns TRUE when a global test_otp is configured + matches
--   5) verifier returns FALSE for unmatched otp against configured test_otp
--   6) submit_fieldops_auth_otp_v1 still exists + references the verifier
--      in its body (regression guard against accidental verifier removal)
--   7) Migration registered the category in settings_category_registry
--      with allowed_scopes including both 'global' and 'tenant'
--   ...and the trace-context tests (TODO when SECDEF auth.uid() can be
--   mocked in pgTAP — currently covered by unit tests on the FE side)
--
-- All in one transaction; ROLLBACK at end keeps the test DB clean.

SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(15);

-- ===========================================================================
-- A) Existence + SECDEF + grants
-- ===========================================================================

SELECT has_function('public', 'verify_fieldops_otp_v1',
  ARRAY['text','text'],
  'public.verify_fieldops_otp_v1 exists');

SELECT ok(
  (SELECT prosecdef
     FROM pg_proc
    WHERE proname = 'verify_fieldops_otp_v1'
      AND pronamespace = 'public'::regnamespace
    LIMIT 1),
  'public.verify_fieldops_otp_v1 is SECURITY DEFINER'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM information_schema.role_routine_grants
     WHERE specific_schema = 'public'
       AND routine_name = 'verify_fieldops_otp_v1'
       AND grantee = 'authenticated'
       AND privilege_type = 'EXECUTE'
  ),
  'authenticated has EXECUTE on public.verify_fieldops_otp_v1'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM information_schema.role_routine_grants
     WHERE specific_schema = 'public'
       AND routine_name = 'verify_fieldops_otp_v1'
       AND grantee = 'anon'
  ),
  'anon does NOT have EXECUTE on public.verify_fieldops_otp_v1'
);

-- ===========================================================================
-- B) Verifier — format precondition
-- ===========================================================================

SELECT is(
  public.verify_fieldops_otp_v1('DRV-2041', 'abc'),
  FALSE,
  'verify rejects non-6-digit otp'
);

SELECT is(
  public.verify_fieldops_otp_v1('DRV-2041', '12345'),
  FALSE,
  'verify rejects too-short otp'
);

-- ===========================================================================
-- C) Verifier — policy resolution (global default fail-closed)
-- ===========================================================================

-- The seeded global policy is `{provider:test, test_otp:null}` → fail closed
-- regardless of OTP value.
SELECT is(
  public.verify_fieldops_otp_v1('DRV-2041', '123456'),
  FALSE,
  'verify rejects any otp when policy.test_otp is null (fail-closed default)'
);

-- ===========================================================================
-- C2) Migration projection — the global mobile_auth_policy default is
--     mirrored into public.settings (migration 202605161200) so the
--     canonical resolver, which reads public.settings JOIN
--     settings_versions, can surface it.
-- ===========================================================================

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
     WHERE category = 'mobile_auth_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
  ),
  'mobile_auth_policy global default is projected into public.settings'
);

-- ===========================================================================
-- D) Verifier — global policy with explicit test_otp accepts the match
-- ===========================================================================

-- Roll the seeded global default forward: end the prior version + insert a
-- new global version with a real test_otp. The unique-current index keys
-- on (category, scope_type, scope_id) WHERE effective_until IS NULL AND
-- approved_at IS NOT NULL, so closing effective_until on the prior row is
-- required before the insert.

UPDATE public.settings_versions
   SET effective_until = now()
 WHERE category = 'mobile_auth_policy'
   AND scope_type = 'global'
   AND scope_id IS NULL
   AND effective_until IS NULL
   AND approved_at IS NOT NULL;

INSERT INTO public.settings_versions (
  category, scope_type, scope_id, version, value, approved_at, effective_from
)
SELECT 'mobile_auth_policy', 'global', NULL,
       (SELECT COALESCE(MAX(version), 0) + 1
          FROM public.settings_versions
         WHERE category = 'mobile_auth_policy'
           AND scope_type = 'global'
           AND scope_id IS NULL),
       jsonb_build_object(
         'provider', 'test',
         'test_otp', '654321',
         'edge_fn_name', NULL
       ),
       now(),
       now();

-- Repoint public.settings at the new current global version. The canonical
-- resolver reads public.settings JOIN settings_versions, so the active
-- "settings" row must follow the version roll-forward — otherwise the
-- resolver keeps surfacing the prior value. The global settings row is
-- created by migration 202605161200_fieldops_auth_otp_policy_settings_
-- projection_v1.sql.
UPDATE public.settings s
   SET settings_version_id = sv.id,
       cached_value = sv.value,
       last_updated = now()
  FROM public.settings_versions sv
 WHERE sv.category = 'mobile_auth_policy'
   AND sv.scope_type = 'global'
   AND sv.scope_id IS NULL
   AND sv.effective_until IS NULL
   AND sv.approved_at IS NOT NULL
   AND s.category = 'mobile_auth_policy'
   AND s.scope_type = 'global'
   AND s.scope_id IS NULL;

SELECT is(
  public.verify_fieldops_otp_v1('DRV-2041', '654321'),
  TRUE,
  'verify accepts otp matching global policy.test_otp'
);

SELECT is(
  public.verify_fieldops_otp_v1('DRV-2041', '111111'),
  FALSE,
  'verify rejects otp not matching global policy.test_otp'
);

-- ===========================================================================
-- E) submit_fieldops_auth_otp_v1 wrapping the verifier
-- ===========================================================================

SELECT has_function('public', 'submit_fieldops_auth_otp_v1',
  ARRAY['text','text','uuid'],
  'public.submit_fieldops_auth_otp_v1 still exists with verifier wired');

SELECT ok(
  (SELECT pg_get_functiondef(p.oid) LIKE '%verify_fieldops_otp_v1%'
     FROM pg_proc p
    WHERE proname = 'submit_fieldops_auth_otp_v1'
      AND pronamespace = 'public'::regnamespace
    LIMIT 1),
  'submit_fieldops_auth_otp_v1 body references verify_fieldops_otp_v1'
);

-- ===========================================================================
-- F) Category registry — allowed_scopes covers tenant override path
-- ===========================================================================

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
     WHERE category = 'mobile_auth_policy'
       AND allowed_scopes @> '["global"]'::jsonb
       AND allowed_scopes @> '["tenant"]'::jsonb
  ),
  'mobile_auth_policy registry row exists with allowed_scopes including global+tenant'
);

-- ===========================================================================
-- G) Ladder precedence — tenant override beats global default
-- ===========================================================================
--
-- We cannot easily run the verifier under a specific auth.uid() inside
-- pgTAP, so we exercise the resolver directly with an explicit
-- organization_id context. A tenant-scope row that pins a different
-- test_otp must surface ahead of the global row.

DO $$
DECLARE
  v_tenant UUID;
  v_resolved JSONB;
BEGIN
  -- Pick an arbitrary existing organization for the tenant scope. If
  -- the test DB has none, synthesize a UUID — the resolver should still
  -- return the row keyed by exact scope_id match.
  v_tenant := gen_random_uuid();

  INSERT INTO public.settings_versions (
    category, scope_type, scope_id, scope_hash, version, value, approved_at, effective_from
  ) VALUES (
    'mobile_auth_policy', 'tenant', v_tenant, v_tenant,
    1,
    jsonb_build_object(
      'provider', 'test',
      'test_otp', '999000',
      'edge_fn_name', NULL
    ),
    now(),
    now()
  );

  -- Project the tenant version into public.settings so the canonical
  -- resolver (public.settings JOIN settings_versions) surfaces it ahead
  -- of the global default.
  INSERT INTO public.settings (
    category, scope_type, scope_id, scope_hash, settings_version_id, cached_value, last_updated
  )
  SELECT sv.category, sv.scope_type, sv.scope_id, sv.scope_hash, sv.id, sv.value, now()
    FROM public.settings_versions sv
   WHERE sv.category = 'mobile_auth_policy'
     AND sv.scope_type = 'tenant'
     AND sv.scope_id = v_tenant
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;

  SELECT r.value INTO v_resolved
    FROM public.resolve_settings_row_from_policy_context_v1(
           'mobile_auth_policy',
           jsonb_build_object('organization_id', v_tenant)
         ) AS r
   LIMIT 1;

  PERFORM is(
    v_resolved->>'test_otp', '999000',
    'tenant override surfaces ahead of global default'
  );

  -- Without the org context, the global default still applies.
  SELECT r.value INTO v_resolved
    FROM public.resolve_settings_row_from_policy_context_v1(
           'mobile_auth_policy',
           '{}'::jsonb
         ) AS r
   LIMIT 1;

  PERFORM is(
    v_resolved->>'test_otp', '654321',
    'no-org context falls back to global default'
  );
END $$;

SELECT * FROM finish();
ROLLBACK;
