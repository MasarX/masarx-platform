-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S99
-- Purpose:
-- - Remove literal enum CHECK constraints from workflow binding substrate tables.
-- - Enforce workflow binding taxonomies through lookup contracts (row-driven).

BEGIN;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  (
    'workflow_binding_entrypoint_type',
    'Allowed entrypoint types for workflow binding registry rows.',
    'platform_owner',
    'admin_only',
    TRUE
  ),
  (
    'workflow_binding_execution_kind',
    'Current execution shape classifications for business actions in workflow binding registry.',
    'platform_owner',
    'admin_only',
    TRUE
  ),
  (
    'workflow_binding_configurability_status',
    'Configurability posture for workflow binding registry rows.',
    'platform_owner',
    'admin_only',
    TRUE
  ),
  (
    'workflow_binding_dispatch_outcome',
    'Allowed outcomes for workflow binding dispatch ledger rows.',
    'platform_owner',
    'admin_only',
    TRUE
  )
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, status)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  'active'
FROM public.lookup_definitions ld
JOIN (
  VALUES
    ('workflow_binding_entrypoint_type', 'edge', 'Edge', 'Browser or public edge ingress entrypoint.', 10, FALSE),
    ('workflow_binding_entrypoint_type', 'rpc', 'RPC', 'Database RPC or API entrypoint.', 20, TRUE),
    ('workflow_binding_entrypoint_type', 'ui_command', 'UI command', 'UI command registry entrypoint.', 30, FALSE),
    ('workflow_binding_entrypoint_type', 'workflow_handler', 'Workflow handler', 'Workflow handler initiated entrypoint.', 40, FALSE),
    ('workflow_binding_entrypoint_type', 'domain_event', 'Domain event', 'Domain event initiated entrypoint.', 50, FALSE),
    ('workflow_binding_entrypoint_type', 'field_ops', 'Field Ops', 'Field Ops app initiated entrypoint.', 60, FALSE),
    ('workflow_binding_execution_kind', 'workflow_native', 'Workflow native', 'Action already executes natively through workflow.', 10, TRUE),
    ('workflow_binding_execution_kind', 'hybrid_task_backed', 'Hybrid task backed', 'Action uses workflow follow-ups while preserving canonical business handlers.', 20, FALSE),
    ('workflow_binding_execution_kind', 'direct_rpc', 'Direct RPC', 'Action is still directly launched via RPC.', 30, FALSE),
    ('workflow_binding_execution_kind', 'direct_edge', 'Direct edge', 'Action is still directly launched via edge facade.', 40, FALSE),
    ('workflow_binding_execution_kind', 'direct_resource_mutation', 'Direct resource mutation', 'Action still mutates a resource outside workflow binding orchestration.', 50, FALSE),
    ('workflow_binding_configurability_status', 'workflow_configurable', 'Workflow configurable', 'Behavior is configurable through workflow binding templates.', 10, TRUE),
    ('workflow_binding_configurability_status', 'policy_only', 'Policy only', 'Behavior is row-driven by policy but not workflow-editable yet.', 20, FALSE),
    ('workflow_binding_configurability_status', 'not_configurable', 'Not configurable', 'Behavior is not yet configurable.', 30, FALSE),
    ('workflow_binding_dispatch_outcome', 'started', 'Started', 'Workflow binding dispatch started.', 10, TRUE),
    ('workflow_binding_dispatch_outcome', 'completed', 'Completed', 'Workflow binding dispatch completed.', 20, FALSE),
    ('workflow_binding_dispatch_outcome', 'waiting', 'Waiting', 'Workflow binding dispatch is waiting on workflow progression.', 30, FALSE),
    ('workflow_binding_dispatch_outcome', 'failed', 'Failed', 'Workflow binding dispatch failed.', 40, FALSE)
) AS v(category, value, label, description, sort_order, is_default)
  ON v.category = ld.category
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  status = EXCLUDED.status;

ALTER TABLE public.workflow_binding_registry
  DROP CONSTRAINT IF EXISTS workflow_binding_registry_entrypoint_type_ck,
  DROP CONSTRAINT IF EXISTS workflow_binding_registry_execution_kind_ck,
  DROP CONSTRAINT IF EXISTS workflow_binding_registry_configurability_ck;

ALTER TABLE public.workflow_binding_registry
  ADD CONSTRAINT workflow_binding_registry_entrypoint_type_ck
  CHECK (public.is_active_lookup_value_v1('workflow_binding_entrypoint_type', entrypoint_type, TRUE)),
  ADD CONSTRAINT workflow_binding_registry_execution_kind_ck
  CHECK (public.is_active_lookup_value_v1('workflow_binding_execution_kind', current_execution_kind, TRUE)),
  ADD CONSTRAINT workflow_binding_registry_configurability_ck
  CHECK (public.is_active_lookup_value_v1('workflow_binding_configurability_status', configurability_status, TRUE));

ALTER TABLE public.workflow_binding_dispatches
  DROP CONSTRAINT IF EXISTS workflow_binding_dispatches_outcome_ck;

ALTER TABLE public.workflow_binding_dispatches
  ADD CONSTRAINT workflow_binding_dispatches_outcome_ck
  CHECK (public.is_active_lookup_value_v1('workflow_binding_dispatch_outcome', outcome, TRUE));

COMMIT;
