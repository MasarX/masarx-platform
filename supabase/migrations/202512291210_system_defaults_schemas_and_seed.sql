-- Plan: PLAN-202512-system-defaults-prod-ready / Step: S03
-- Migration: System-default schemas + global seed (missing categories)
-- Purpose:
--   - Register missing schema_registry contracts for settings categories used at runtime.
--   - Split legacy reminder template config out of communications_policy into a dedicated category.
--   - Seed missing global defaults safely (data-driven via schema_registry.examples[0]).
-- Notes:
--   - This migration is additive and safe to apply on existing environments.
--   - JSON schema validation is enforced in CI/tests; DB enforces schema presence only.
BEGIN;

SET search_path TO public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 0) Category registry metadata (SSOT)
-- ---------------------------------------------------------------------------
INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES (
  'comms_scheduling_policy',
  'Scheduled outbound communications workflows (campaign/reminder template routing)',
  TRUE,
  TRUE,
  TRUE,
  'skip',
  '["global","tenant","client","sender"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  updated_at = now();

-- Ensure all categories referenced by schema_registry inserts exist in the registry.
INSERT INTO public.settings_category_registry (category)
VALUES
  ('communications_policy'),
  ('comms_reply_policy'),
  ('provider_callback_policy'),
  ('delivery_routing_policy'),
  ('provider_defaults'),
  ('whatsapp_compliance_policy'),
  ('ops_oncall_alerting'),
  ('ops_cron_health_policy'),
  ('ops_queue_health_policy'),
  ('ops_sweeper_policy')
ON CONFLICT (category) DO NOTHING;

-- Ensure key policy categories are marked as side-effecting + default-required.
UPDATE public.settings_category_registry
SET
  requires_global_default = TRUE,
  side_effecting = TRUE,
  safe_missing_behavior = 'skip',
  updated_at = now()
WHERE category IN (
  'communications_policy',
  'comms_reply_policy',
  'provider_callback_policy',
  'delivery_routing_policy',
  'ops_oncall_alerting'
);

UPDATE public.settings_category_registry
SET
  requires_global_default = TRUE,
  side_effecting = FALSE,
  updated_at = now()
WHERE category IN (
  'provider_defaults',
  'whatsapp_compliance_policy',
  'ops_cron_health_policy',
  'ops_queue_health_policy',
  'ops_sweeper_policy'
);

-- ---------------------------------------------------------------------------
-- 1) schema_registry contracts (missing)
-- ---------------------------------------------------------------------------
-- 1.1 comms_scheduling_policy (v1): reminder/campaign template routing
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'comms_scheduling_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'default_timezone', jsonb_build_object('type', 'string'),
      'templates', jsonb_build_object(
        'type', 'object',
        'additionalProperties', jsonb_build_object(
          'type', 'object',
          'additionalProperties', TRUE,
          'properties', jsonb_build_object(
            'workflow_template_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
            'channel', jsonb_build_object('type', 'string'),
            'stop_flag_path', jsonb_build_object('type', 'string'),
            'enabled', jsonb_build_object('type', 'boolean')
          )
        )
      )
    )
  ),
  'Outbound communications scheduling templates (reminders/campaigns) resolved via the settings ladder.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'default_timezone', 'UTC',
      'templates', jsonb_build_object()
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

-- 1.2 communications_policy (v2): channel/provider routing (NOT reminders)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'communications_policy',
  2,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object('type', 'boolean'),
      'channels', jsonb_build_object(
        'type', 'array',
        'items', jsonb_build_object(
          'type', 'object',
          'additionalProperties', TRUE,
          'properties', jsonb_build_object(
            'channel', jsonb_build_object('type', 'string'),
            'provider_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
            'template_key', jsonb_build_object('type', 'string')
          )
        )
      )
    )
  ),
  'Outbound communications channel/provider routing policy (WhatsApp/SMS/etc).',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'enabled', FALSE,
      'channels', jsonb_build_array()
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

-- 1.3 comms_reply_policy (v1): inbound reply handling (two-way)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'comms_reply_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'enabled', jsonb_build_object('type', 'boolean'),
      'auth_config_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
      'dry_run', jsonb_build_object('type', 'boolean'),
      'dispatch', jsonb_build_object('type', 'object', 'additionalProperties', TRUE),
      'intents', jsonb_build_object('type', 'object', 'additionalProperties', TRUE),
      'reply_rate_limit', jsonb_build_object('type', 'object', 'additionalProperties', TRUE)
    )
  ),
  'Inbound reply policy (intent mapping, dispatch mode, rate limits) resolved via ladder (Global<Tenant<Client<Sender<Source).',
  jsonb_build_array(jsonb_build_object('enabled', FALSE)),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

-- 1.4 ops_oncall_alerting (v1): on-call delivery config (tenant-scoped opt-in)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'ops_oncall_alerting',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'enabled', jsonb_build_object('type', 'boolean'),
      'min_severity', jsonb_build_object('type', 'string'),
      'whatsapp', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'enabled', jsonb_build_object('type', 'boolean'),
          'to_phone', jsonb_build_object('type', 'string'),
          'provider_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
          'provider_name', jsonb_build_object('type', 'string'),
          'api_key_header', jsonb_build_object('type', 'string'),
          'url', jsonb_build_object('type', 'string'),
          'url_path', jsonb_build_object('type', 'string'),
          'priority', jsonb_build_object('type', 'integer', 'minimum', 0),
          'max_retries', jsonb_build_object('type', 'integer', 'minimum', 0),
          'message_prefix', jsonb_build_object('type', 'string'),
          'messaging_product', jsonb_build_object('type', 'string')
        )
      )
    )
  ),
  'Tenant opt-in on-call delivery configuration for alert dispatch (external side effects).',
  jsonb_build_array(jsonb_build_object('enabled', FALSE)),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

-- 1.5 provider_defaults (v1): provider-specific defaults used in mappings (resource scope)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'provider_defaults',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'default_recipient', jsonb_build_object('type', 'string'),
      'messaging_product', jsonb_build_object('type', 'string'),
      'whatsapp', jsonb_build_object('type', 'object', 'additionalProperties', TRUE)
    )
  ),
  'Provider-specific defaults (resource scope) injected into request mapping scope.',
  jsonb_build_array(jsonb_build_object()),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

-- 1.6 provider_callback_policy (v1): inbound provider callbacks routing (safe disabled by default)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'provider_callback_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'enabled', jsonb_build_object('type', 'boolean'),
      'callback_url', jsonb_build_object('type', 'string')
    )
  ),
  'Provider callback routing policy (inbound receipts/status callbacks).',
  jsonb_build_array(jsonb_build_object('enabled', FALSE)),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

-- 1.7 delivery_routing_policy (v1): 3PL routing policy (safe disabled by default)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'delivery_routing_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'enabled', jsonb_build_object('type', 'boolean'),
      'provider_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
      'retry', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'max_attempts', jsonb_build_object('type', 'integer', 'minimum', 0),
          'backoff_seconds', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'integer', 'minimum', 0))
        )
      )
    )
  ),
  'Delivery routing policy (3PL provider selection + retries) resolved via ladder.',
  jsonb_build_array(jsonb_build_object('enabled', FALSE)),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

-- 1.8 ops_cron_health_policy (v1): cron job staleness monitoring (global, internal)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'ops_cron_health_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'enabled', jsonb_build_object('type', 'boolean'),
      'repeat_minutes', jsonb_build_object('type', 'integer', 'minimum', 1),
      'jobs', jsonb_build_object(
        'type', 'array',
        'items', jsonb_build_object(
          'type', 'object',
          'additionalProperties', TRUE,
          'properties', jsonb_build_object(
            'jobname', jsonb_build_object('type', 'string'),
            'max_staleness_minutes', jsonb_build_object('type', 'integer', 'minimum', 0),
            'severity', jsonb_build_object('type', 'string')
          )
        )
      )
    )
  ),
  'Ops cron health monitoring policy (global).',
  jsonb_build_array(jsonb_build_object('enabled', TRUE, 'repeat_minutes', 60, 'jobs', jsonb_build_array())),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

-- 1.9 ops_queue_health_policy (v1): backlog/worker staleness monitoring (global, internal)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'ops_queue_health_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'enabled', jsonb_build_object('type', 'boolean'),
      'repeat_minutes', jsonb_build_object('type', 'integer', 'minimum', 1),
      'alert_dispatch_backlog', jsonb_build_object('type', 'object', 'additionalProperties', TRUE),
      'outbound_calls_backlog', jsonb_build_object('type', 'object', 'additionalProperties', TRUE),
      'worker_health', jsonb_build_object('type', 'object', 'additionalProperties', TRUE)
    )
  ),
  'Ops queue health monitoring policy (global).',
  jsonb_build_array(jsonb_build_object('enabled', TRUE, 'repeat_minutes', 60)),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

-- 1.10 ops_sweeper_policy (v1): cron SSOT reconciliation (global, internal)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'ops_sweeper_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'enabled', jsonb_build_object('type', 'boolean'),
      'tasks', jsonb_build_object(
        'type', 'array',
        'items', jsonb_build_object(
          'type', 'object',
          'additionalProperties', TRUE,
          'properties', jsonb_build_object(
            'task_key', jsonb_build_object('type', 'string'),
            'enabled', jsonb_build_object('type', 'boolean'),
            'handler_key', jsonb_build_object('type', 'string'),
            'arguments', jsonb_build_object('type', 'object', 'additionalProperties', TRUE)
          )
        )
      )
    )
  ),
  'Ops sweeper policy (global) used to reconcile cron SSOT (ensure required jobs exist).',
  jsonb_build_array(jsonb_build_object('enabled', TRUE, 'tasks', jsonb_build_array())),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

-- 1.11 whatsapp_compliance_policy (v1): freeform session enforcement
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'whatsapp_compliance_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'required', jsonb_build_array(
      'enforce_text_session',
      'session_window_seconds',
      'allow_webhook_session_evidence',
      'allow_freeform_outside_session_sources'
    ),
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enforce_text_session', jsonb_build_object('type', 'boolean'),
      'session_window_seconds', jsonb_build_object('type', 'integer', 'minimum', 1),
      'allow_webhook_session_evidence', jsonb_build_object('type', 'boolean'),
      'allow_freeform_outside_session_sources', jsonb_build_object(
        'type', 'array',
        'items', jsonb_build_object('type', 'string')
      )
    )
  ),
  'WhatsApp compliance policy (freeform text allowed only inside session window unless explicitly permitted).',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'enforce_text_session', TRUE,
      'session_window_seconds', 86400,
      'allow_webhook_session_evidence', TRUE,
      'allow_freeform_outside_session_sources', jsonb_build_array('dispatch_alert_trigger')
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

-- ---------------------------------------------------------------------------
-- 2) Split: move legacy reminder routing out of communications_policy
-- ---------------------------------------------------------------------------
-- Migrate any template-based communications_policy rows (legacy reminder schema)
-- into comms_scheduling_policy while preserving scope and versions.
UPDATE public.settings_versions
SET
  category = 'comms_scheduling_policy',
  schema_version = 1
WHERE category = 'communications_policy'
  AND (value ? 'templates')
  AND NOT (value ? 'channels');

UPDATE public.settings
SET category = 'comms_scheduling_policy'
WHERE category = 'communications_policy'
  AND (cached_value ? 'templates')
  AND NOT (cached_value ? 'channels');

-- If a legacy communications_policy schema exists, deprecate it (reminders moved).
UPDATE public.schema_registry
SET is_active = FALSE,
    deprecated_at = COALESCE(deprecated_at, now()),
    description = COALESCE(description, '') || ' (deprecated: reminder routing moved to comms_scheduling_policy)'
WHERE category = 'communications_policy'
  AND version = 1
  AND is_active = TRUE;

-- Align schema_version for any remaining communications_policy rows (channel routing) to v2.
UPDATE public.settings_versions
SET schema_version = 2
WHERE category = 'communications_policy'
  AND (value ? 'channels')
  AND COALESCE(schema_version, 0) <> 2;

-- ---------------------------------------------------------------------------
-- 3) Global defaults: make default-required categories explicit and seed when missing
-- ---------------------------------------------------------------------------
-- Best practice: every registered category has a global baseline to eliminate NULL fallbacks.
UPDATE public.settings_category_registry
SET requires_global_default = TRUE,
    updated_at = now()
WHERE requires_global_default = FALSE;

WITH latest_active_schema AS (
  SELECT DISTINCT ON (sr.category)
    sr.category,
    sr.version AS schema_version,
    sr.examples
  FROM public.schema_registry sr
  WHERE sr.is_active = TRUE
  ORDER BY sr.category, sr.version DESC
),
seed_targets AS (
  SELECT
    scr.category,
    las.schema_version,
    (las.examples->0) AS value
  FROM public.settings_category_registry scr
  JOIN latest_active_schema las ON las.category = scr.category
  WHERE scr.requires_global_default = TRUE
    AND las.examples IS NOT NULL
    AND jsonb_typeof(las.examples) = 'array'
    AND (las.examples->0) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.settings s
      WHERE s.category = scr.category
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
      LIMIT 1
    )
),
existing_current_versions AS (
  SELECT
    t.category,
    sv.id AS settings_version_id,
    sv.value AS value
  FROM seed_targets t
  LEFT JOIN LATERAL (
    SELECT sv.id, sv.value
    FROM public.settings_versions sv
    WHERE sv.category = t.category
      AND sv.scope_type = 'global'
      AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND sv.effective_until IS NULL
      AND sv.approved_at IS NOT NULL
    ORDER BY sv.effective_from DESC NULLS LAST, sv.created_at DESC NULLS LAST
    LIMIT 1
  ) sv ON TRUE
),
inserted_versions AS (
  INSERT INTO public.settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  SELECT
    gen_random_uuid(),
    t.category,
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    1,
    t.value,
    t.schema_version,
    'Seed global default from schema_registry.examples[0]',
    now(),
    now()
  FROM seed_targets t
  JOIN existing_current_versions e ON e.category = t.category
  WHERE e.settings_version_id IS NULL
  RETURNING category, id, value
),
resolved_versions AS (
  SELECT
    e.category,
    COALESCE(e.settings_version_id, i.id) AS settings_version_id,
    COALESCE(e.value, i.value) AS value
  FROM existing_current_versions e
  LEFT JOIN inserted_versions i ON i.category = e.category
)
INSERT INTO public.settings (
  category,
  scope_type,
  scope_id,
  scope_hash,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  v.category,
  'global',
  NULL,
  '00000000-0000-0000-0000-000000000000'::uuid,
  v.settings_version_id,
  v.value,
  now()
FROM resolved_versions v
WHERE v.settings_version_id IS NOT NULL
ON CONFLICT (category, scope_type, scope_hash)
DO NOTHING;

COMMIT;
