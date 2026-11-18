-- Console V2 route-plan lifecycle stepper metadata.
-- Keeps the planning stepper row-driven through lookup metadata instead of
-- frontend literal stage arrays.

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  sort_order,
  is_default,
  metadata
)
SELECT
  ld.id,
  v.value,
  v.label,
  v.sort_order,
  v.is_default,
  jsonb_build_object(
    'tone', v.tone,
    'stage', v.stage,
    'stepper_rank', v.stepper_rank,
    'is_lifecycle_stepper', v.is_lifecycle_stepper,
    'is_sla_breach_eligible', v.is_sla_breach_eligible
  )
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('draft',     'Draft',     10, FALSE, 'neutral', 'draft',     10, TRUE,  FALSE),
  ('solved',    'Solved',    20, FALSE, 'info',    'solved',    20, TRUE,  FALSE),
  ('frozen',    'Frozen',    30, FALSE, 'info',    'frozen',    30, TRUE,  FALSE),
  ('published', 'Published', 40, FALSE, 'good',    'published', 40, TRUE,  TRUE),
  ('applied',   'Applied',   50, FALSE, 'good',    'applied',   50, TRUE,  FALSE),
  ('executing', 'Executing', 60, FALSE, 'info',    'executing', 60, TRUE,  FALSE),
  ('archived',  'Archived',  70, FALSE, 'neutral', 'draft',     70, FALSE, FALSE),
  ('created',   'Created',   11, FALSE, 'neutral', 'draft',     11, FALSE, FALSE),
  ('submitted', 'Submitted', 12, FALSE, 'info',    'draft',     12, FALSE, FALSE),
  ('failed',    'Failed',    80, FALSE, 'danger',  'draft',     80, FALSE, FALSE),
  ('canceled',  'Canceled',  90, FALSE, 'neutral', 'draft',     90, FALSE, FALSE)
) AS v(value, label, sort_order, is_default, tone, stage, stepper_rank, is_lifecycle_stepper, is_sla_breach_eligible)
WHERE ld.category = 'route_plan_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();
