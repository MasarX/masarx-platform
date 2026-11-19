-- Console V2 workflow-template authoring requires these lookup rows at runtime.
-- The frontend intentionally fails loud when they are absent, so shared/local
-- databases must seed the canonical rows rather than falling back in code.

BEGIN;
SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  (
    'workflow_branch_kind',
    'Workflow template step branch taxonomy consumed by Console V2 workflow canvas lane layout and branch labels.',
    'engineering',
    'tier_1',
    FALSE
  ),
  (
    'condition_operator_by_type',
    'Condition operator allowlist per inferred workflow trigger field type consumed by Console V2 condition builders.',
    'engineering',
    'tier_1',
    FALSE
  ),
  (
    'workflow_step_action',
    'Workflow template step action palette consumed by Console V2 workflow studio.',
    'engineering',
    'tier_1',
    FALSE
  )
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable,
    updated_at = now();

WITH rows(category, value, label, sort_order, is_default, metadata) AS (
  VALUES
    ('workflow_branch_kind', 'main', 'Main', 10, TRUE, '{"tone":"neutral","lane_index":0,"label":"main","is_keyboard_secondary":false,"is_error_branch":false,"is_default":true}'::jsonb),
    ('workflow_branch_kind', 'error', 'On error', 20, FALSE, '{"tone":"danger","lane_index":1,"label":"on error","is_keyboard_secondary":true,"is_error_branch":true}'::jsonb),
    ('workflow_branch_kind', 'manual', 'Manual', 30, FALSE, '{"tone":"warn","lane_index":1,"label":"manual","is_keyboard_secondary":true,"is_error_branch":false}'::jsonb),
    ('workflow_step_action', 'duplicate', 'Duplicate step', 10, FALSE, '{"section":"Edit","handler_kind":"duplicate"}'::jsonb),
    ('workflow_step_action', 'delete', 'Delete step', 20, FALSE, '{"section":"Edit","handler_kind":"delete"}'::jsonb),
    ('workflow_step_action', 'convert_error', 'Convert to error branch', 30, FALSE, '{"section":"Branch","handler_kind":"convert_error"}'::jsonb),
    ('workflow_step_action', 'pin_sample', 'Pin sample data', 40, FALSE, '{"section":"Data","handler_kind":"pin_sample"}'::jsonb),
    ('workflow_step_action', 'view_runs', 'View runs that hit this step', 50, FALSE, '{"section":"Telemetry","handler_kind":"view_runs"}'::jsonb),
    ('workflow_step_action', 'decision_trail', 'Decision trail', 60, FALSE, '{"section":"Audit","handler_kind":"decision_trail"}'::jsonb),

    ('condition_operator_by_type', 'string:equals', 'String · equals', 10, FALSE, '{"tone":"neutral","field_type":"string","operator":"equals"}'::jsonb),
    ('condition_operator_by_type', 'string:not_equals', 'String · not equals', 20, FALSE, '{"tone":"neutral","field_type":"string","operator":"not_equals"}'::jsonb),
    ('condition_operator_by_type', 'string:in', 'String · in', 30, FALSE, '{"tone":"neutral","field_type":"string","operator":"in"}'::jsonb),
    ('condition_operator_by_type', 'string:not_in', 'String · not in', 40, FALSE, '{"tone":"neutral","field_type":"string","operator":"not_in"}'::jsonb),
    ('condition_operator_by_type', 'string:matches', 'String · matches', 50, FALSE, '{"tone":"neutral","field_type":"string","operator":"matches"}'::jsonb),
    ('condition_operator_by_type', 'string:exists', 'String · exists', 60, FALSE, '{"tone":"neutral","field_type":"string","operator":"exists"}'::jsonb),
    ('condition_operator_by_type', 'string:not_exists', 'String · not exists', 70, FALSE, '{"tone":"neutral","field_type":"string","operator":"not_exists"}'::jsonb),

    ('condition_operator_by_type', 'number:equals', 'Number · equals', 80, FALSE, '{"tone":"neutral","field_type":"number","operator":"equals"}'::jsonb),
    ('condition_operator_by_type', 'number:not_equals', 'Number · not equals', 90, FALSE, '{"tone":"neutral","field_type":"number","operator":"not_equals"}'::jsonb),
    ('condition_operator_by_type', 'number:gt', 'Number · gt', 100, FALSE, '{"tone":"neutral","field_type":"number","operator":"gt"}'::jsonb),
    ('condition_operator_by_type', 'number:gte', 'Number · gte', 110, FALSE, '{"tone":"neutral","field_type":"number","operator":"gte"}'::jsonb),
    ('condition_operator_by_type', 'number:lt', 'Number · lt', 120, FALSE, '{"tone":"neutral","field_type":"number","operator":"lt"}'::jsonb),
    ('condition_operator_by_type', 'number:lte', 'Number · lte', 130, FALSE, '{"tone":"neutral","field_type":"number","operator":"lte"}'::jsonb),
    ('condition_operator_by_type', 'number:exists', 'Number · exists', 140, FALSE, '{"tone":"neutral","field_type":"number","operator":"exists"}'::jsonb),
    ('condition_operator_by_type', 'number:not_exists', 'Number · not exists', 150, FALSE, '{"tone":"neutral","field_type":"number","operator":"not_exists"}'::jsonb),

    ('condition_operator_by_type', 'boolean:equals', 'Boolean · equals', 160, FALSE, '{"tone":"neutral","field_type":"boolean","operator":"equals"}'::jsonb),
    ('condition_operator_by_type', 'boolean:not_equals', 'Boolean · not equals', 170, FALSE, '{"tone":"neutral","field_type":"boolean","operator":"not_equals"}'::jsonb),
    ('condition_operator_by_type', 'boolean:exists', 'Boolean · exists', 180, FALSE, '{"tone":"neutral","field_type":"boolean","operator":"exists"}'::jsonb),
    ('condition_operator_by_type', 'boolean:not_exists', 'Boolean · not exists', 190, FALSE, '{"tone":"neutral","field_type":"boolean","operator":"not_exists"}'::jsonb),

    ('condition_operator_by_type', 'unknown:equals', 'Any · equals', 200, FALSE, '{"tone":"neutral","field_type":"unknown","operator":"equals"}'::jsonb),
    ('condition_operator_by_type', 'unknown:not_equals', 'Any · not equals', 210, FALSE, '{"tone":"neutral","field_type":"unknown","operator":"not_equals"}'::jsonb),
    ('condition_operator_by_type', 'unknown:in', 'Any · in', 220, FALSE, '{"tone":"neutral","field_type":"unknown","operator":"in"}'::jsonb),
    ('condition_operator_by_type', 'unknown:not_in', 'Any · not in', 230, FALSE, '{"tone":"neutral","field_type":"unknown","operator":"not_in"}'::jsonb),
    ('condition_operator_by_type', 'unknown:matches', 'Any · matches', 240, FALSE, '{"tone":"neutral","field_type":"unknown","operator":"matches"}'::jsonb),
    ('condition_operator_by_type', 'unknown:gt', 'Any · gt', 250, FALSE, '{"tone":"neutral","field_type":"unknown","operator":"gt"}'::jsonb),
    ('condition_operator_by_type', 'unknown:gte', 'Any · gte', 260, FALSE, '{"tone":"neutral","field_type":"unknown","operator":"gte"}'::jsonb),
    ('condition_operator_by_type', 'unknown:lt', 'Any · lt', 270, FALSE, '{"tone":"neutral","field_type":"unknown","operator":"lt"}'::jsonb),
    ('condition_operator_by_type', 'unknown:lte', 'Any · lte', 280, FALSE, '{"tone":"neutral","field_type":"unknown","operator":"lte"}'::jsonb),
    ('condition_operator_by_type', 'unknown:exists', 'Any · exists', 290, FALSE, '{"tone":"neutral","field_type":"unknown","operator":"exists"}'::jsonb),
    ('condition_operator_by_type', 'unknown:not_exists', 'Any · not exists', 300, FALSE, '{"tone":"neutral","field_type":"unknown","operator":"not_exists"}'::jsonb)
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  ld.id,
  rows.value,
  rows.label,
  rows.sort_order,
  rows.is_default,
  'active',
  rows.metadata
FROM rows
JOIN public.lookup_definitions ld
  ON ld.category = rows.category
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = 'active',
    metadata = EXCLUDED.metadata,
    retired_at = NULL,
    updated_at = now();

COMMIT;
