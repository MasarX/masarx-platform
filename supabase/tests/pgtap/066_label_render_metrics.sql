-- Test Suite: label render metrics views + SLO check function presence

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT ok(
  to_regclass('public.label_render_job_timings_v') IS NOT NULL,
  'label_render_job_timings_v exists'
);

SELECT ok(
  to_regclass('public.label_bundle_merge_metrics_v') IS NOT NULL,
  'label_bundle_merge_metrics_v exists'
);

SELECT ok(
  to_regprocedure('public.label_render_metrics_window(uuid,integer)') IS NOT NULL,
  'label_render_metrics_window(uuid, integer) exists'
);

SELECT ok(
  to_regprocedure('public.check_label_render_slo_and_log(uuid)') IS NOT NULL,
  'check_label_render_slo_and_log(uuid) exists'
);

SELECT * FROM finish();

ROLLBACK;

