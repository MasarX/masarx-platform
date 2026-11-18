-- pgTAP coverage for submit_fieldops_auth_otp_via_edge_v1.
--
-- Closes engineering re-audit P1 (2026-05-13): edge function path was
-- missing; this wrapper RPC is the only entry point the edge function
-- calls. Verifies signature, grants, security posture, and basic
-- routing through verify_fieldops_otp_v1's edge_fn branch.
--
-- Companion to the edge function in
-- `supabase/functions/fieldops-otp-verifier/index.ts`.

BEGIN;
SELECT plan(8);

-- 1) Public function exists with the documented signature.
SELECT has_function(
  'public',
  'submit_fieldops_auth_otp_via_edge_v1',
  ARRAY['text', 'text', 'boolean', 'uuid', 'uuid'],
  'public.submit_fieldops_auth_otp_via_edge_v1(text, text, boolean, uuid, uuid) exists'
);

-- 2) api.* SECURITY INVOKER mirror exists.
SELECT has_function(
  'api',
  'submit_fieldops_auth_otp_via_edge_v1',
  ARRAY['text', 'text', 'boolean', 'uuid', 'uuid'],
  'api.submit_fieldops_auth_otp_via_edge_v1 mirror exists'
);

-- 3) Public function is SECURITY DEFINER (can set_config across roles).
SELECT is(
  (SELECT prosecdef
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'submit_fieldops_auth_otp_via_edge_v1'),
  TRUE,
  'public.submit_fieldops_auth_otp_via_edge_v1 is SECURITY DEFINER'
);

-- 4) api.* mirror is SECURITY INVOKER (caller's RBAC applies via service_role).
SELECT is(
  (SELECT prosecdef
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'api'
      AND p.proname = 'submit_fieldops_auth_otp_via_edge_v1'),
  FALSE,
  'api.submit_fieldops_auth_otp_via_edge_v1 is SECURITY INVOKER'
);

-- 5) anon CANNOT execute (closed by default).
SELECT is(
  has_function_privilege(
    'anon',
    'public.submit_fieldops_auth_otp_via_edge_v1(text, text, boolean, uuid, uuid)',
    'EXECUTE'
  ),
  FALSE,
  'anon cannot execute public.submit_fieldops_auth_otp_via_edge_v1'
);

-- 6) authenticated CANNOT execute (edge-function-only).
SELECT is(
  has_function_privilege(
    'authenticated',
    'public.submit_fieldops_auth_otp_via_edge_v1(text, text, boolean, uuid, uuid)',
    'EXECUTE'
  ),
  FALSE,
  'authenticated cannot execute public.submit_fieldops_auth_otp_via_edge_v1 (edge-function only)'
);

-- 7) service_role CAN execute (the edge function calls with service key).
SELECT is(
  has_function_privilege(
    'service_role',
    'public.submit_fieldops_auth_otp_via_edge_v1(text, text, boolean, uuid, uuid)',
    'EXECUTE'
  ),
  TRUE,
  'service_role can execute public.submit_fieldops_auth_otp_via_edge_v1'
);

-- 8) search_path is pinned to safe schema set.
SELECT is(
  (SELECT proconfig::text[]
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'submit_fieldops_auth_otp_via_edge_v1'),
  ARRAY['search_path=public, extensions, pg_temp'],
  'public.submit_fieldops_auth_otp_via_edge_v1 has pinned search_path'
);

SELECT * FROM finish();
ROLLBACK;
