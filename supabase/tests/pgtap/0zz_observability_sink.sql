-- pgTAP: Unified observability sink view exists

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

SELECT has_view('public', 'observability_sink_v', 'observability_sink_v view exists');

-- Use psql variables so partition pruning can treat bounds as constants.
SELECT
  gen_random_uuid() AS org_id,
  date_trunc('month', now()) AS window_start,
  date_trunc('month', now()) + interval '1 month' AS window_end
\gset

INSERT INTO public.audit_table_changes (
  organization_id,
  schema_name,
  table_name,
  op,
  pk,
  created_at
)
VALUES (
  :'org_id'::uuid,
  'public',
  'pgtap_sink_audit_test',
  'UPDATE',
  jsonb_build_object('id', gen_random_uuid()),
  now()
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.observability_sink_v s
    WHERE s.event_source = 'audit_table_changes'
      AND s.organization_id = :'org_id'::uuid
      AND s.resource_type = 'pgtap_sink_audit_test'
      AND s.event_time >= :'window_start'::timestamptz
      AND s.event_time < :'window_end'::timestamptz
  ),
  'observability_sink_v includes audit_table_changes events'
);

SELECT finish();

ROLLBACK;
