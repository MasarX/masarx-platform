-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Mobile telemetry policy registry v1 (mobile_ingest_policy + location_tracking_policy + scan_policy + pod_policy)
-- Date: 2026-01-25
--
-- Goals:
--   - Keep mobile/device ingest, tracking, scan, and POD requirements row-driven via the settings ladder.
--   - Provide versioned JSON schemas + safe global defaults (no hardcoding in app/handlers).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601251030_mobile_telemetry_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Settings categories (ladder-resolved; branch-aware via resource scope)
-------------------------------------------------------------------------------

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes,
  resource_scope_rel
)
VALUES
  (
    'mobile_ingest_policy',
    'Mobile/device ingest controls (enabled flags, accepted event types, routing decisions) resolved via ladder; branch-aware via resource scope.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  ),
  (
    'location_tracking_policy',
    'Location tracking policy (sampling/retention/min interval/accuracy thresholds) resolved via ladder; branch-aware via resource scope.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  ),
  (
    'scan_policy',
    'Scan policy (required scan points, allowed scan types, workflow mapping) resolved via ladder; branch-aware via resource scope.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  ),
  (
    'pod_policy',
    'Proof-of-delivery evidence policy (required photo/signature/OTP per outcome/service level; redaction/retention) resolved via ladder; branch-aware via resource scope.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  )
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  resource_scope_rel = EXCLUDED.resource_scope_rel,
  updated_at = now();

-------------------------------------------------------------------------------
-- 2) Schema registry (minimal v1 contracts; extend via versioning)
-------------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES
  (
    'mobile_ingest_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Mobile Ingest Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'enabled', jsonb_build_object('type', 'boolean'),
        'max_payload_bytes', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 0),
        'require_device', jsonb_build_object('type', jsonb_build_array('boolean','null')),
        'accepted_event_types', jsonb_build_object('type', jsonb_build_array('array','null'), 'items', jsonb_build_object('type', 'string')),
        'log_decisions', jsonb_build_object('type', jsonb_build_array('boolean','null'))
      )
    ),
    'Mobile/device ingest controls for telemetry + evidence events. Row-driven; resolved via ladder.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'require_device', TRUE,
        'accepted_event_types', jsonb_build_array('location_ping','scan_event'),
        'log_decisions', FALSE
      )
    ),
    TRUE
  ),
  (
    'location_tracking_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Location Tracking Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'enabled', jsonb_build_object('type', 'boolean'),
        'min_interval_seconds', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 0),
        'min_accuracy_m', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 0),
        'max_accuracy_m', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 0),
        'retention_days', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 0)
      )
    ),
    'Location tracking policy (sampling + quality thresholds). Enforced best-effort; audited.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'min_interval_seconds', 15,
        'max_accuracy_m', 200
      )
    ),
    TRUE
  ),
  (
    'scan_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Scan Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'enabled', jsonb_build_object('type', 'boolean'),
        'accepted_scan_types', jsonb_build_object('type', jsonb_build_array('array','null'), 'items', jsonb_build_object('type', 'string')),
        'enqueue_domain_event', jsonb_build_object('type', jsonb_build_array('boolean','null')),
        'domain_event_type', jsonb_build_object('type', jsonb_build_array('string','null'))
      )
    ),
    'Warehouse/driver scan policy (scan types + optional workflow mapping).',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'accepted_scan_types', jsonb_build_array('pickup','sort','load','unload','delivery_attempt','delivered'),
        'enqueue_domain_event', FALSE
      )
    ),
    TRUE
  ),
  (
    'pod_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'POD Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'enabled', jsonb_build_object('type', 'boolean'),
        'requirements', jsonb_build_object(
          'type', jsonb_build_array('object','null'),
          'additionalProperties', TRUE
        ),
        'redaction', jsonb_build_object('type', jsonb_build_array('object','null'), 'additionalProperties', TRUE),
        'retention_days', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 0)
      )
    ),
    'Proof-of-delivery requirements (photo/signature/OTP) by outcome/service level; evidence retention/redaction metadata.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'requirements', jsonb_build_object(
          'delivered', jsonb_build_object('photo', TRUE, 'signature', FALSE, 'otp', FALSE)
        )
      )
    ),
    TRUE
  )
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = EXCLUDED.is_active,
  updated_at = now();

-------------------------------------------------------------------------------
-- 3) Safe global defaults (settings_versions + settings cache)
-------------------------------------------------------------------------------

WITH policy_upsert AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', TRUE,
    'require_device', TRUE,
    'accepted_event_types', jsonb_build_array('location_ping','scan_event'),
    'log_decisions', FALSE
  ) AS body
),
tracking_upsert AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', TRUE,
    'min_interval_seconds', 15,
    'max_accuracy_m', 200
  ) AS body
),
scan_upsert AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', TRUE,
    'accepted_scan_types', jsonb_build_array('pickup','sort','load','unload','delivery_attempt','delivered'),
    'enqueue_domain_event', FALSE
  ) AS body
),
pod_upsert AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', TRUE,
    'requirements', jsonb_build_object(
      'delivered', jsonb_build_object('photo', TRUE, 'signature', FALSE, 'otp', FALSE)
    )
  ) AS body
),
inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'mobile_ingest_policy', 'global', NULL, 1, policy_upsert.body, 1, now() FROM policy_upsert
  ON CONFLICT DO NOTHING
  RETURNING category, scope_type, scope_id, id, value
),
inserted2 AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'location_tracking_policy', 'global', NULL, 1, tracking_upsert.body, 1, now() FROM tracking_upsert
  ON CONFLICT DO NOTHING
  RETURNING category, scope_type, scope_id, id, value
),
inserted3 AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'scan_policy', 'global', NULL, 1, scan_upsert.body, 1, now() FROM scan_upsert
  ON CONFLICT DO NOTHING
  RETURNING category, scope_type, scope_id, id, value
),
inserted4 AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'pod_policy', 'global', NULL, 1, pod_upsert.body, 1, now() FROM pod_upsert
  ON CONFLICT DO NOTHING
  RETURNING category, scope_type, scope_id, id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT sv.category, sv.scope_type, sv.scope_id, sv.id, sv.value, now()
FROM (
  SELECT * FROM inserted
  UNION ALL SELECT * FROM inserted2
  UNION ALL SELECT * FROM inserted3
  UNION ALL SELECT * FROM inserted4
) sv
WHERE NOT EXISTS (
  SELECT 1
  FROM public.settings s
  WHERE s.category = sv.category
    AND s.scope_type = sv.scope_type
    AND s.scope_id IS NULL
);

SELECT pg_advisory_unlock(hashtext('202601251030_mobile_telemetry_v1'));
COMMIT;
