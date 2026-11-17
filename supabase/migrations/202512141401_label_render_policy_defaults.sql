-- Migration: label_render_policy (settings ladder defaults) + compose_label_payload wiring
-- Purpose:
--  - Add schema + global defaults for label behavior (header branding mode, text defaults, metrics thresholds, Arabic flags).
--  - Ensure per-shipment overrides are honoured only when explicitly present (shipment metadata wins).
--  - Keep SSOT + override ladder via resolve_settings().

BEGIN;

SET search_path TO public, pg_temp;

-- =============================================================================
-- Section 1: schema_registry (label_render_policy)
-- =============================================================================

WITH policy_schema AS (
  SELECT $$
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "label_render_policy.schema.json",
    "title": "label_render_policy",
    "type": "object",
    "required": ["version", "header_brand_mode", "text_defaults"],
    "additionalProperties": false,
    "properties": {
      "version": { "type": "integer", "minimum": 1 },
      "header_brand_mode": { "type": "string", "enum": ["logo", "text"] },
      "text_defaults": {
        "type": "object",
        "required": ["font_regular", "font_bold", "min_font_size", "line_height_factor", "overflow"],
        "additionalProperties": false,
        "properties": {
          "font_regular": { "type": "string", "minLength": 1 },
          "font_bold": { "type": "string", "minLength": 1 },
          "min_font_size": { "type": "number", "exclusiveMinimum": 0 },
          "line_height_factor": { "type": "number", "minimum": 0.8, "maximum": 2.0 },
          "overflow": { "type": "string", "enum": ["shrink", "ellipsis"] }
        }
      },
      "metrics": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "window_minutes": { "type": "integer", "minimum": 1 },
          "min_samples": { "type": "integer", "minimum": 1 },
          "slo_p95_render_ms": { "type": "integer", "minimum": 1 },
          "slo_p95_total_ms": { "type": "integer", "minimum": 1 }
        }
      },
      "arabic": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "enabled": { "type": "boolean" },
          "font_asset_regular": { "type": "string" },
          "font_asset_bold": { "type": "string" }
        }
      }
    }
  }
  $$::jsonb AS schema_doc,
  $$
  [
    {
      "version": 1,
      "header_brand_mode": "logo",
      "text_defaults": {
        "font_regular": "Helvetica",
        "font_bold": "Helvetica-Bold",
        "min_font_size": 6,
        "line_height_factor": 1.1,
        "overflow": "shrink"
      },
      "metrics": {
        "window_minutes": 60,
        "min_samples": 25,
        "slo_p95_render_ms": 4000,
        "slo_p95_total_ms": 8000
      },
      "arabic": {
        "enabled": false,
        "font_asset_regular": "fonts/noto-naskh-arabic-regular.ttf",
        "font_asset_bold": "fonts/noto-naskh-arabic-bold.ttf"
      }
    }
  ]
  $$::jsonb AS examples
)
INSERT INTO schema_registry (id, category, version, schema, description, examples, is_active, created_at)
SELECT
  'bbbb0000-0000-0000-0000-000000001901',
  'label_render_policy',
  1,
  policy_schema.schema_doc,
  'Label rendering defaults resolved via settings ladder (branding mode, text defaults, metrics thresholds, optional Arabic shaping).',
  policy_schema.examples,
  TRUE,
  workflow_now()
FROM policy_schema
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE,
    created_at = workflow_now();

-- =============================================================================
-- Section 2: Global defaults (settings_versions + settings)
-- =============================================================================

WITH default_policy AS (
  SELECT $$
  {
    "version": 1,
    "header_brand_mode": "logo",
    "text_defaults": {
      "font_regular": "Helvetica",
      "font_bold": "Helvetica-Bold",
      "min_font_size": 6,
      "line_height_factor": 1.1,
      "overflow": "shrink"
    },
    "metrics": {
      "window_minutes": 60,
      "min_samples": 25,
      "slo_p95_render_ms": 4000,
      "slo_p95_total_ms": 8000
    },
    "arabic": {
      "enabled": false,
      "font_asset_regular": "fonts/noto-naskh-arabic-regular.ttf",
      "font_asset_bold": "fonts/noto-naskh-arabic-bold.ttf"
    }
  }
  $$::jsonb AS payload
)
INSERT INTO settings_versions (
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
  '77770000-0000-0000-0000-000000001901',
  'label_render_policy',
  'global',
  NULL,
  '00000000-0000-0000-0000-000000000000'::uuid,
  1,
  default_policy.payload,
  1,
  'Initial label_render_policy baseline (branding mode + text defaults + metrics + arabic flag)',
  workflow_now(),
  workflow_now()
FROM default_policy
ON CONFLICT (id, scope_hash) DO UPDATE
SET value = EXCLUDED.value,
    change_reason = EXCLUDED.change_reason,
    approved_at = EXCLUDED.approved_at,
    effective_from = EXCLUDED.effective_from;

WITH default_policy AS (
  SELECT $$
  {
    "version": 1,
    "header_brand_mode": "logo",
    "text_defaults": {
      "font_regular": "Helvetica",
      "font_bold": "Helvetica-Bold",
      "min_font_size": 6,
      "line_height_factor": 1.1,
      "overflow": "shrink"
    },
    "metrics": {
      "window_minutes": 60,
      "min_samples": 25,
      "slo_p95_render_ms": 4000,
      "slo_p95_total_ms": 8000
    },
    "arabic": {
      "enabled": false,
      "font_asset_regular": "fonts/noto-naskh-arabic-regular.ttf",
      "font_asset_bold": "fonts/noto-naskh-arabic-bold.ttf"
    }
  }
  $$::jsonb AS payload
)
INSERT INTO settings (
  id,
  category,
  scope_type,
  scope_id,
  scope_hash,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  '66660000-0000-0000-0000-000000001901',
  'label_render_policy',
  'global',
  NULL,
  '00000000-0000-0000-0000-000000000000'::uuid,
  '77770000-0000-0000-0000-000000001901',
  default_policy.payload,
  workflow_now()
FROM default_policy
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

-- =============================================================================
-- Section 3: compose_label_payload: merge resolved label_render_policy + default header_brand_mode
-- =============================================================================

CREATE OR REPLACE FUNCTION compose_label_payload(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_job label_jobs%ROWTYPE;
  v_sender_id UUID;
  v_policy JSONB;
  v_payload JSONB;
  v_shipment_metadata JSONB;
  v_explicit_header_mode TEXT;
  v_effective_header_mode TEXT;
BEGIN
  SELECT *
  INTO v_job
  FROM label_jobs
  WHERE id = p_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Label job % not found', p_job_id;
  END IF;

  IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
    IF current_user_org_id() IS NULL OR current_user_org_id() <> v_job.organization_id THEN
      RAISE EXCEPTION 'Access denied for label job %', p_job_id;
    END IF;
  END IF;

  SELECT sender_id
  INTO v_sender_id
  FROM shipments
  WHERE id = v_job.shipment_id;

  IF v_sender_id IS NOT NULL THEN
    v_policy := resolve_settings('label_render_policy', 'sender', v_sender_id);
  ELSIF v_job.client_id IS NOT NULL THEN
    v_policy := resolve_settings('label_render_policy', 'client', v_job.client_id);
  ELSIF v_job.organization_id IS NOT NULL THEN
    v_policy := resolve_settings('label_render_policy', 'tenant', v_job.organization_id);
  ELSE
    v_policy := resolve_settings('label_render_policy', 'global', NULL);
  END IF;

  IF v_policy IS NULL THEN
    v_policy := resolve_settings('label_render_policy', 'global', NULL);
  END IF;
  IF v_policy IS NULL THEN
    RAISE EXCEPTION 'label_render_policy missing (global) - seed defaults before rendering';
  END IF;

  SELECT to_jsonb(payload)
  INTO v_payload
  FROM shipment_label_payload_v payload
  WHERE payload.shipment_id = v_job.shipment_id
    AND (
      v_job.shipment_box_id IS NULL
      OR payload.shipment_box_id = v_job.shipment_box_id
    )
  ORDER BY payload.box_number NULLS FIRST
  LIMIT 1;

  v_payload := COALESCE(v_payload, '{}'::jsonb);

  -- Persist resolved policy in the payload for renderers/tests.
  v_payload := jsonb_set(v_payload, '{label_render_policy}', v_policy, TRUE);

  v_shipment_metadata := v_payload->'shipment_metadata';
  IF v_shipment_metadata IS NULL OR jsonb_typeof(v_shipment_metadata) <> 'object' THEN
    v_shipment_metadata := '{}'::jsonb;
  END IF;

  v_explicit_header_mode := NULLIF(trim(COALESCE(
    v_shipment_metadata->>'header_brand_mode',
    v_shipment_metadata->>'headerBrandMode'
  )), '');

  v_effective_header_mode := v_explicit_header_mode;
  IF v_effective_header_mode IS NULL THEN
    v_effective_header_mode := NULLIF(trim(v_policy->>'header_brand_mode'), '');
  END IF;

  IF v_effective_header_mode IS NULL THEN
    RAISE EXCEPTION 'label_render_policy.header_brand_mode missing (global) - seed defaults before rendering';
  END IF;

  -- Canonicalize key into shipment_metadata for template render_if paths.
  v_shipment_metadata := jsonb_set(v_shipment_metadata, '{header_brand_mode}', to_jsonb(v_effective_header_mode), TRUE);
  v_payload := jsonb_set(v_payload, '{shipment_metadata}', v_shipment_metadata, TRUE);

  RETURN jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id,
      'organization_id', v_job.organization_id,
      'client_id', v_job.client_id,
      'shipment_id', v_job.shipment_id,
      'shipment_box_id', v_job.shipment_box_id,
      'label_type', v_job.label_type,
      'attempts', v_job.attempts,
      'max_attempts', v_job.max_attempts,
      'template', v_job.template_snapshot,
      'renderer_hint', v_job.renderer_hint,
      'retry_state', v_job.retry_state
    ),
    'payload', v_payload
  );
END;
$$;

COMMENT ON FUNCTION compose_label_payload(UUID)
  IS 'Return canonical payload + template snapshot for a label job (includes resolved label_render_policy + derived defaults).';

COMMIT;

