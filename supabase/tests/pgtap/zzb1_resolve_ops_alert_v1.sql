-- pgTAP: public.resolve_ops_alert_v1 contract
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

CREATE TEMP TABLE b1_res_result (
  result jsonb NOT NULL
) ON COMMIT DROP;
GRANT ALL ON b1_res_result TO authenticated;

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b801';
  v_ops UUID := '00000000-0000-0000-0000-00000000b811';
  v_sender UUID := '00000000-0000-0000-0000-00000000b812';
  v_alert UUID := gen_random_uuid();
  v_correlation UUID := gen_random_uuid();
  v_now TIMESTAMPTZ := now();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B1 Resolve Org', 'b1-res-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b1-res-ops-' || left(v_ops::text, 8) || '@example.com', 'B1 Res Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b1-res-sender-' || left(v_sender::text, 8) || '@example.com', 'B1 Res Sender', 'client_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.ops_alerts (id, organization_id, alert_type, severity, message, created_at)
  VALUES (v_alert, v_org, 'b1-res-test', 'error', 'pgtap resolve target', v_now);

  PERFORM set_config('test.b1_res_org', v_org::text, true);
  PERFORM set_config('test.b1_res_ops', v_ops::text, true);
  PERFORM set_config('test.b1_res_sender', v_sender::text, true);
  PERFORM set_config('test.b1_res_alert', v_alert::text, true);
  PERFORM set_config('test.b1_res_correlation', v_correlation::text, true);
  PERFORM set_config('test.b1_res_now', v_now::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_res_ops'), true);
SET LOCAL ROLE authenticated;
INSERT INTO b1_res_result(result)
SELECT public.resolve_ops_alert_v1(jsonb_build_object(
  'ops_alert_id', current_setting('test.b1_res_alert'),
  'organization_id', current_setting('test.b1_res_org'),
  'created_at', current_setting('test.b1_res_now'),
  'resolution_notes', 'pgtap resolved',
  'correlation_id', current_setting('test.b1_res_correlation')
));
SELECT ok(
  (SELECT (result->>'ok')::bool FROM b1_res_result),
  'ops_admin can resolve_ops_alert_v1'
);
RESET ROLE;

-- 2) Console readback exposes the persisted resolved state
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_res_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b1_res_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (api.ui_get_resource_v1('ops_alerts', current_setting('test.b1_res_alert')::uuid)->>'resolved_at') IS NOT NULL,
  'api.ui_get_resource_v1 exposes resolved_at after resolve_ops_alert_v1'
);
SELECT is(
  api.ui_get_resource_v1('ops_alerts', current_setting('test.b1_res_alert')::uuid)->>'resolved_by_user_id',
  current_setting('test.b1_res_ops'),
  'api.ui_get_resource_v1 exposes resolved_by_user_id after resolve_ops_alert_v1'
);
SELECT is(
  api.ui_get_resource_v1('ops_alerts', current_setting('test.b1_res_alert')::uuid)->>'resolution_notes',
  'pgtap resolved',
  'api.ui_get_resource_v1 exposes resolution_notes after resolve_ops_alert_v1'
);
SELECT is(
  alert->'details'->>'resolved_at',
  alert->>'resolved_at',
  'notification readback keeps the resolved timestamp alias'
)
FROM (SELECT api.ui_get_resource_v1(
  'ops_alerts', current_setting('test.b1_res_alert')::uuid
) AS alert) readback;
RESET ROLE;

-- 5) Caller-provided correlation is returned and shared across ledgers
SET LOCAL ROLE postgres;
SELECT is(
  (SELECT result->>'correlation_id' FROM b1_res_result),
  current_setting('test.b1_res_correlation'),
  'resolve_ops_alert_v1 returns the caller-provided UUID correlation id'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.ops_alert_events e
     WHERE e.ops_alert_id::text = current_setting('test.b1_res_alert')
       AND e.event_type = 'resolved'
       AND e.correlation_id = current_setting('test.b1_res_correlation')
  ),
  'resolve_ops_alert_v1 writes the same UUID correlation to ops_alert_events'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.decision_log d
     WHERE d.resource_id::text = current_setting('test.b1_res_alert')
       AND d.decision_category = 'alerts.resolve'
       AND d.correlation_id::text = current_setting('test.b1_res_correlation')
  )
  AND EXISTS (
    SELECT 1
      FROM public.domain_events de
     WHERE de.resource_id::text = current_setting('test.b1_res_alert')
       AND de.event_type = 'ops_alert.resolved'
       AND de.correlation_id::text = current_setting('test.b1_res_correlation')
  ),
  'resolve_ops_alert_v1 writes the same UUID correlation to decision_log and domain_events'
);
RESET ROLE;

-- 8) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_res_sender'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b1_res_sender'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.resolve_ops_alert_v1(jsonb_build_object(
       'ops_alert_id', current_setting('test.b1_res_alert')
     )) $$,
  '42501',
  NULL,
  'non-ops user denied resolve_ops_alert_v1'
);
RESET ROLE;

-- 9) Audit ledger appended
SET LOCAL ROLE postgres;
SELECT ok(
  (SELECT COUNT(*) FROM public.ops_alert_events
    WHERE ops_alert_id = current_setting('test.b1_res_alert')::uuid
      AND event_type = 'resolved') >= 1,
  'resolve_ops_alert_v1 appends ops_alert_events row (audit ledger)'
);
RESET ROLE;

-- 10) Resolve correlation no longer casts from random hex text
SELECT ok(
  position('encode(gen_random_bytes(8), ''hex'')' in pg_get_functiondef('public.resolve_ops_alert_v1(jsonb)'::regprocedure)) = 0,
  'resolve_ops_alert_v1 uses UUID correlation instead of random hex text cast'
);

-- 11) RLS isolation
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.ops_alert_events', 'insert'),
  'authenticated cannot bypass RPC to write ops_alert_events directly'
);

SELECT * FROM finish();
ROLLBACK;
