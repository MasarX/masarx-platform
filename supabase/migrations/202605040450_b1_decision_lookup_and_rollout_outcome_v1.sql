-- Complete Phase B1 decision-log lookup coverage and remove dynamic rollout
-- percentages from the lookup-constrained decision_outcome column.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031540_b1_decision_lookup_and_rollout_outcome_v1'));
SET search_path TO public, extensions, pg_temp;

WITH categories(value, label, sort_order) AS (
  VALUES
    ('access_policy.request', 'Access Policy Request', 1200),
    ('alerts.create', 'Alerts Create', 1210),
    ('alerts.delete', 'Alerts Delete', 1220),
    ('alerts.pause', 'Alerts Pause', 1230),
    ('alerts.resolve', 'Alerts Resolve', 1240),
    ('alerts.resume', 'Alerts Resume', 1250),
    ('alerts.update', 'Alerts Update', 1260),
    ('feature_flags.kill_switch', 'Feature Flags Kill Switch', 1270),
    ('feature_flags.rollout', 'Feature Flags Rollout', 1280),
    ('feature_flags.toggle', 'Feature Flags Toggle', 1290),
    ('warehouse.execute', 'Warehouse Execute', 1300)
),
definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'decision_category'
   LIMIT 1
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  d.id,
  c.value,
  c.label,
  'Decision category emitted by canonical Phase B1 RPCs.',
  c.sort_order,
  FALSE,
  'active',
  jsonb_build_object('source', 'b1_decision_lookup_and_rollout_outcome_v1')
FROM definition d
CROSS JOIN categories c
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

WITH outcomes(value, label, sort_order) AS (
  VALUES
    ('deleted', 'Deleted', 1590),
    ('engaged', 'Engaged', 1600),
    ('paused', 'Paused', 1610),
    ('pending', 'Pending', 1620),
    ('released', 'Released', 1630),
    ('resumed', 'Resumed', 1640),
    ('rollout_changed', 'Rollout Changed', 1650)
),
definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'decision_outcome'
   LIMIT 1
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  d.id,
  o.value,
  o.label,
  'Decision outcome emitted by canonical Phase B1 RPCs.',
  o.sort_order,
  FALSE,
  'active',
  jsonb_build_object('source', 'b1_decision_lookup_and_rollout_outcome_v1')
FROM definition d
CROSS JOIN outcomes o
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

DO $$
DECLARE
  v_definition TEXT;
BEGIN
  SELECT pg_get_functiondef('public.set_rollout_v1(jsonb)'::regprocedure)
    INTO v_definition;

  v_definition := replace(
    v_definition,
    '''set_rollout_v1'', v_target_rollout::text,',
    '''set_rollout_v1'', ''rollout_changed'','
  );

  EXECUTE v_definition;
END $$;

SELECT pg_advisory_unlock(hashtext('202605031540_b1_decision_lookup_and_rollout_outcome_v1'));
COMMIT;
