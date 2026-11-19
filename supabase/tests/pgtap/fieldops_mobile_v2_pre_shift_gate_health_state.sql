-- pgTAP: Mobile V2 pre-shift gate returns a health-reflecting state.
--
-- Guards the fix in migration
-- 202605160000_fieldops_pre_shift_gate_health_state_v1.sql:
-- pass_fieldops_pre_shift_gate_v1 must return state=blocked (and record a
-- blocked_health decision_outcome) when the driver attests health_ok=false,
-- rather than always reporting a clearance.
--
-- Structural assertion over `pg_get_functiondef` — no auth context needed,
-- so it runs in any migrated DB. A regression that reverts the function to
-- an unconditional 'cleared' result fails here.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SELECT plan(2);

SELECT ok(
  pg_get_functiondef(
    'public.pass_fieldops_pre_shift_gate_v1(text, boolean, uuid)'::regprocedure
  ) LIKE '%p_health_ok THEN ''cleared'' ELSE ''blocked''%',
  'pass_fieldops_pre_shift_gate_v1 returns state=blocked when the driver fails the health check'
);

SELECT ok(
  pg_get_functiondef(
    'public.pass_fieldops_pre_shift_gate_v1(text, boolean, uuid)'::regprocedure
  ) LIKE '%blocked_health%',
  'pass_fieldops_pre_shift_gate_v1 records a blocked_health decision_outcome when the driver fails the health check'
);

SELECT * FROM finish();
ROLLBACK;
