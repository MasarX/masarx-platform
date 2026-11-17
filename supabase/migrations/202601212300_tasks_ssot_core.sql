-- Plan: PLAN-202601-tasks-ssot-core / Step: S04
-- Migration: Task SSOT core foundation (schema + policies + RPC)
-- Date: 2026-01-21

BEGIN;
SELECT pg_advisory_lock(hashtext('202601212300_tasks_ssot_core'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Settings category registry (SSOT governance)
-------------------------------------------------------------------------------

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES
  (
    'task_policy',
    'Task routing + queue defaults (row-driven; resolved via ladder).',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source"]'::jsonb
  ),
  (
    'task_sla_policy',
    'Task SLA defaults + escalation timings (row-driven; resolved via ladder).',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source"]'::jsonb
  ),
  (
    'task_workflow_policy',
    'Task event -> workflow template mapping (row-driven; resolved via ladder).',
    TRUE,
    TRUE,
    FALSE,
    'return_null',
    '["global","tenant","client","sender","source"]'::jsonb
  )
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    requires_schema = EXCLUDED.requires_schema,
    requires_global_default = EXCLUDED.requires_global_default,
    side_effecting = EXCLUDED.side_effecting,
    safe_missing_behavior = EXCLUDED.safe_missing_behavior,
    allowed_scopes = EXCLUDED.allowed_scopes;

-------------------------------------------------------------------------------
-- 2) Schema registry (policy schemas)
-------------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES
  (
    'task_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'initial_status', jsonb_build_object('type', 'string'),
        'default_priority', jsonb_build_object('type', 'integer', 'minimum', 0),
        'default_queue_key', jsonb_build_object('type', 'string')
      )
    ),
    'Task policy (routing + queue defaults) resolved via the settings ladder.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'initial_status', 'open',
        'default_priority', 50,
        'default_queue_key', 'default'
      )
    ),
    TRUE
  ),
  (
    'task_sla_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'default_sla_minutes', jsonb_build_object('type', 'integer', 'minimum', 0),
        'escalate_after_minutes', jsonb_build_object('type', 'integer', 'minimum', 0)
      )
    ),
    'Task SLA policy (default SLA + escalation timings) resolved via the settings ladder.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'default_sla_minutes', 1440
      )
    ),
    TRUE
  ),
  (
    'task_workflow_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'events', jsonb_build_object(
          'type', 'object',
          'additionalProperties', TRUE
        )
      )
    ),
    'Task -> workflow mapping policy. Defaults to no workflow; configured per tenant/client/sender/source via ladder.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'events', jsonb_build_object()
      )
    ),
    TRUE
  )
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE;

-------------------------------------------------------------------------------
-- 3) Seed global defaults (no hardcoding in code paths)
-------------------------------------------------------------------------------

-- task_policy (global)
WITH payload AS (
  SELECT jsonb_build_object(
    'version', 1,
    'initial_status', 'open',
    'default_priority', 50,
    'default_queue_key', 'default'
  ) AS value
),
inserted AS (
  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  SELECT
    'task_policy',
    'global',
    NULL::uuid,
    1,
    payload.value,
    1,
    'Seed global task_policy',
    now(),
    now()
  FROM payload
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'task_policy'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT
  'task_policy',
  'global',
  NULL::uuid,
  inserted.id,
  inserted.value,
  now()
FROM inserted
ON CONFLICT (category, scope_type, scope_hash)
DO NOTHING;

-- task_sla_policy (global)
WITH payload AS (
  SELECT jsonb_build_object(
    'version', 1,
    'default_sla_minutes', 1440
  ) AS value
),
inserted AS (
  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  SELECT
    'task_sla_policy',
    'global',
    NULL::uuid,
    1,
    payload.value,
    1,
    'Seed global task_sla_policy',
    now(),
    now()
  FROM payload
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'task_sla_policy'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT
  'task_sla_policy',
  'global',
  NULL::uuid,
  inserted.id,
  inserted.value,
  now()
FROM inserted
ON CONFLICT (category, scope_type, scope_hash)
DO NOTHING;

-- task_workflow_policy (global) - defaults to no workflow.
WITH payload AS (
  SELECT jsonb_build_object(
    'version', 1,
    'events', jsonb_build_object()
  ) AS value
),
inserted AS (
  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  SELECT
    'task_workflow_policy',
    'global',
    NULL::uuid,
    1,
    payload.value,
    1,
    'Seed global task_workflow_policy',
    now(),
    now()
  FROM payload
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'task_workflow_policy'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT
  'task_workflow_policy',
  'global',
  NULL::uuid,
  inserted.id,
  inserted.value,
  now()
FROM inserted
ON CONFLICT (category, scope_type, scope_hash)
DO NOTHING;

-------------------------------------------------------------------------------
-- 4) Tables (task_types, tasks, task_events) + RLS policies
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.task_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  default_priority INT NOT NULL DEFAULT 50,
  default_queue_key TEXT,
  default_workflow_template_id UUID,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_types_key_ck CHECK (btrim(key) <> '' AND key = lower(key)),
  CONSTRAINT task_types_priority_ck CHECK (default_priority >= 0),
  CONSTRAINT task_types_unique_key UNIQUE (organization_id, key)
);

COMMENT ON TABLE public.task_types
  IS 'Row-driven task contracts (catalog) per organization. Universal work unit foundation.';
COMMENT ON COLUMN public.task_types.key
  IS 'Stable per-organization task type key (lowercase).';

CREATE INDEX IF NOT EXISTS idx_task_types_org_enabled
  ON public.task_types (organization_id, enabled, key);

ALTER TABLE public.task_types ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.task_types FROM PUBLIC;
REVOKE ALL ON TABLE public.task_types FROM anon;
REVOKE ALL ON TABLE public.task_types FROM authenticated;

DROP POLICY IF EXISTS task_types_select ON public.task_types;
CREATE POLICY task_types_select ON public.task_types
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR organization_id = public.current_user_org_id()
  );

DROP POLICY IF EXISTS task_types_service_policy ON public.task_types;
CREATE POLICY task_types_service_policy ON public.task_types
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.task_types TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_types TO service_role;

DROP TRIGGER IF EXISTS trg_task_types_set_updated_at ON public.task_types;
CREATE TRIGGER trg_task_types_set_updated_at
  BEFORE UPDATE ON public.task_types
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  sender_id UUID REFERENCES public.senders(id) ON DELETE SET NULL,
  task_type_id UUID NOT NULL REFERENCES public.task_types(id) ON DELETE RESTRICT,
  resource_type TEXT,
  resource_id UUID,
  status TEXT NOT NULL,
  status_reason TEXT,
  priority INT NOT NULL,
  queue_key TEXT,
  assigned_to UUID REFERENCES public.users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ,
  sla_minutes INT,
  sla_due_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  workflow_run_id UUID,
  idempotency_key TEXT,
  version INT NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tasks_status_ck CHECK (btrim(status) <> '' AND status = lower(status)),
  CONSTRAINT tasks_priority_ck CHECK (priority >= 0),
  CONSTRAINT tasks_version_ck CHECK (version > 0)
);

COMMENT ON TABLE public.tasks
  IS 'Task current-state projection (query-optimized). Updates occur only via canonical RPCs.';
COMMENT ON COLUMN public.tasks.resource_type
  IS 'Logical resource type (shipment, address, vehicle, invoice, etc.).';
COMMENT ON COLUMN public.tasks.workflow_run_id
  IS 'Primary workflow run managing this task (optional; may be NULL). Soft link (no FK).';

CREATE INDEX IF NOT EXISTS idx_tasks_org_queue_status
  ON public.tasks (organization_id, queue_key, status, priority DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_org_status
  ON public.tasks (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned
  ON public.tasks (organization_id, assigned_to, assigned_at DESC)
  WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_sla_due
  ON public.tasks (organization_id, sla_due_at)
  WHERE sla_due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_resource
  ON public.tasks (resource_type, resource_id)
  WHERE resource_type IS NOT NULL AND resource_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_org_idempotency
  ON public.tasks (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tasks FROM PUBLIC;
REVOKE ALL ON TABLE public.tasks FROM anon;
REVOKE ALL ON TABLE public.tasks FROM authenticated;

DROP POLICY IF EXISTS tasks_select ON public.tasks;
CREATE POLICY tasks_select ON public.tasks
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
    OR (
      public.current_user_scope_type() = 'client'
      AND client_id = public.current_user_client_id()
    )
    OR (
      public.current_user_scope_type() = 'sender'
      AND sender_id = public.current_user_sender_id()
    )
  );

DROP POLICY IF EXISTS tasks_service_policy ON public.tasks;
CREATE POLICY tasks_service_policy ON public.tasks
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.tasks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO service_role;

DROP TRIGGER IF EXISTS trg_tasks_set_updated_at ON public.tasks;
CREATE TRIGGER trg_tasks_set_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.task_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  actor_system TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  task_version INT NOT NULL,
  decision_log_id UUID,
  settings_resolution_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_events_event_type_ck CHECK (btrim(event_type) <> '' AND event_type = lower(event_type)),
  CONSTRAINT task_events_task_version_ck CHECK (task_version > 0)
);

COMMENT ON TABLE public.task_events
  IS 'Immutable task event ledger (SSOT). Event trail is authoritative; tasks is the projection.';
COMMENT ON COLUMN public.task_events.settings_resolution_id
  IS 'Optional provenance pointer for the policy resolution that shaped this event.';

CREATE INDEX IF NOT EXISTS idx_task_events_task_created
  ON public.task_events (task_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_events_task_version
  ON public.task_events (task_id, task_version);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_events_idempotency
  ON public.task_events (task_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';
CREATE INDEX IF NOT EXISTS idx_task_events_org_created
  ON public.task_events (organization_id, created_at DESC);

ALTER TABLE public.task_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.task_events FROM PUBLIC;
REVOKE ALL ON TABLE public.task_events FROM anon;
REVOKE ALL ON TABLE public.task_events FROM authenticated;

DROP POLICY IF EXISTS task_events_select ON public.task_events;
CREATE POLICY task_events_select ON public.task_events
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
    OR (
      public.current_user_scope_type() = 'client'
      AND EXISTS (
        SELECT 1
        FROM public.tasks t
        WHERE t.id = task_events.task_id
          AND t.client_id = public.current_user_client_id()
      )
    )
    OR (
      public.current_user_scope_type() = 'sender'
      AND EXISTS (
        SELECT 1
        FROM public.tasks t
        WHERE t.id = task_events.task_id
          AND t.sender_id = public.current_user_sender_id()
      )
    )
  );

DROP POLICY IF EXISTS task_events_service_policy ON public.task_events;
CREATE POLICY task_events_service_policy ON public.task_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.task_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_events TO service_role;

SELECT pg_advisory_unlock(hashtext('202601212300_tasks_ssot_core'));
COMMIT;
