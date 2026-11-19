-- pgTAP: public.simulate_binding_dispatch_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b616';
  v_ops UUID := '00000000-0000-0000-0000-00000000b761';
  v_sender UUID := '00000000-0000-0000-0000-00000000b762';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 WB Sim Org', 'b6-wb-sim-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-wb-sim-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 WB Sim Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-wb-sim-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 WB Sim Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_wb_sim_org', v_org::text, true);
  PERFORM set_config('test.b6_wb_sim_ops', v_ops::text, true);
  PERFORM set_config('test.b6_wb_sim_sender', v_sender::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_wb_sim_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.simulate_binding_dispatch_v1(jsonb_build_object(
      'binding_key', 'b6_sim_binding',
      'stage_key', 'pre_dispatch',
      'scope_type', 'tenant'
    ))->>'ok')::bool
  ),
  'ops_admin can simulate_binding_dispatch_v1'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_wb_sim_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.simulate_binding_dispatch_v1(jsonb_build_object(
       'binding_key', 'b6_sim_binding',
       'stage_key', 'pre_dispatch',
       'scope_type', 'tenant'
     )) $$,
  '42501',
  NULL,
  'non-admin user denied simulate_binding_dispatch_v1'
);
RESET ROLE;

-- 3) Ladder/audit: simulation audit row recorded
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.workflow_binding_simulations
     WHERE binding_key = 'b6_sim_binding'
       AND stage_key = 'pre_dispatch'
  ),
  'simulate_binding_dispatch_v1 wrote workflow_binding_simulations row'
);

-- 4) RLS isolation
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.workflow_binding_simulations', 'select'),
  'authenticated has no SELECT on workflow_binding_simulations (service-only)'
);

SELECT * FROM finish();
ROLLBACK;
