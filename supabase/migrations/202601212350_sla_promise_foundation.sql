-- Plan: PLAN-202601-sla-promise-foundation / Step: S04
-- Migration: SLA + promise foundation (policy + branch resource scope + workflow handler)
-- Date: 2026-01-21
--
-- Goals:
--   - Enable branch-aware, ladder-resolved promise computation (row-driven; no hardcoding).
--   - Introduce shipment_promise_policy settings category with global defaults + schema contract.
--   - Add shipments projection columns for branch_id + promise timestamps.
--   - Add workflow handler `promise_assign` and wire into workflow_geocoding_standard.
--
-- Notes:
--   - Promise history is SSOT via shipment_actions; shipments holds the current projection.
--   - Branch overrides use settings scope_type='resource' with category-specific validation.
BEGIN;
SELECT pg_advisory_lock(hashtext('202601212350_sla_promise_foundation'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 0) Resource scope validation: category-specific resource table (row-driven)
-------------------------------------------------------------------------------

ALTER TABLE public.settings_category_registry
  ADD COLUMN IF NOT EXISTS resource_scope_rel REGCLASS;

COMMENT ON COLUMN public.settings_category_registry.resource_scope_rel IS
  'When scope_type=resource, the table used to validate scope_id for this category (category-specific; NULL defaults to providers).';

CREATE OR REPLACE FUNCTION public.validate_settings_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  scope_valid BOOLEAN := false;
  v_allowed_scopes JSONB;
  v_resource_rel REGCLASS;
BEGIN
  -- Category governance (optional): restrict which scopes may exist for a category.
  SELECT scr.allowed_scopes, scr.resource_scope_rel
    INTO v_allowed_scopes, v_resource_rel
    FROM public.settings_category_registry scr
   WHERE scr.category = NEW.category
   LIMIT 1;

  IF v_allowed_scopes IS NOT NULL AND jsonb_typeof(v_allowed_scopes) = 'array' THEN
    IF NOT (v_allowed_scopes ? NEW.scope_type) THEN
      RAISE EXCEPTION 'Scope "%" is not allowed for category "%"', NEW.scope_type, NEW.category
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Scope correctness: validate the referenced entity exists (or NULL for global).
  IF NEW.scope_type = 'global' THEN
    IF NEW.scope_id IS NULL THEN
      scope_valid := true;
    END IF;
  ELSIF NEW.scope_type = 'tenant' THEN
    SELECT TRUE INTO scope_valid FROM public.organizations WHERE id = NEW.scope_id;
  ELSIF NEW.scope_type = 'client' THEN
    SELECT TRUE INTO scope_valid FROM public.clients WHERE id = NEW.scope_id;
  ELSIF NEW.scope_type = 'sender' THEN
    SELECT TRUE INTO scope_valid FROM public.senders WHERE id = NEW.scope_id;
  ELSIF NEW.scope_type = 'source' THEN
    SELECT TRUE INTO scope_valid FROM public.webhook_sources WHERE id = NEW.scope_id;
  ELSIF NEW.scope_type = 'resource' THEN
    -- Default legacy behavior is "providers"; category-specific resource semantics must be row-driven.
    IF v_resource_rel IS NOT NULL THEN
      EXECUTE format('SELECT TRUE FROM %s WHERE id = $1', v_resource_rel)
        INTO scope_valid
        USING NEW.scope_id;
    ELSE
      SELECT TRUE INTO scope_valid FROM public.providers WHERE id = NEW.scope_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported scope_type %', NEW.scope_type USING ERRCODE = '23514';
  END IF;

  IF NOT scope_valid THEN
    RAISE EXCEPTION 'Invalid scope %/% for % record %', NEW.scope_type, NEW.scope_id, TG_TABLE_NAME, NEW.id
      USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'settings' THEN
    PERFORM 1
    FROM public.settings_versions sv
    WHERE sv.id = NEW.settings_version_id
      AND sv.scope_type = NEW.scope_type
      AND sv.scope_hash = NEW.scope_hash;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'settings row % references version % with mismatched scope', NEW.id, NEW.settings_version_id
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-------------------------------------------------------------------------------
-- 1) shipment_promise_policy: category registry metadata + schema contract
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
VALUES (
  'shipment_promise_policy',
  'Promise/SLA computation policy for shipments (workflow-engine; branch-aware via resource scope).',
  TRUE,
  TRUE,
  TRUE,
  'skip',
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

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'shipment_promise_policy',
  1,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Shipment Promise Policy",
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "version": { "type": "integer", "minimum": 1 },
      "enabled": { "type": ["boolean", "null"] },
      "timezone": { "type": ["string", "null"] },
      "use_branch_timezone": { "type": ["boolean", "null"] },
      "cutoff_time": { "type": ["string", "null"] },
      "default_service_level": { "type": ["string", "null"] },
      "default_transit_days": { "type": ["integer", "null"], "minimum": 0 },
      "service_level_transit_days": {
        "type": ["object", "null"],
        "additionalProperties": { "type": "integer", "minimum": 0 }
      },
      "delivery_window_start": { "type": ["string", "null"] },
      "delivery_window_end": { "type": ["string", "null"] }
    }
  }'::jsonb,
  'Policy-driven shipment promise computation (cutoffs, transit days, delivery windows) resolved via the settings ladder with branch overrides (resource scope).',
  '[
    {
      "version": 1,
      "enabled": true,
      "timezone": "UTC",
      "use_branch_timezone": true,
      "cutoff_time": "16:00",
      "default_service_level": "standard",
      "default_transit_days": 2,
      "service_level_transit_days": { "economy": 3, "standard": 2, "premium": 1, "express": 0 },
      "delivery_window_start": "09:00",
      "delivery_window_end": "18:00"
    }
  ]'::jsonb,
  TRUE
)
ON CONFLICT (category, version)
DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE;

-- Seed global defaults (idempotent).
WITH upsert AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', true,
    'timezone', 'UTC',
    'use_branch_timezone', true,
    'cutoff_time', '16:00',
    'default_service_level', 'standard',
    'default_transit_days', 2,
    'service_level_transit_days', jsonb_build_object(
      'economy', 3,
      'standard', 2,
      'premium', 1,
      'express', 0
    ),
    'delivery_window_start', '09:00',
    'delivery_window_end', '18:00'
  ) AS body
)
INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, approved_at)
SELECT 'shipment_promise_policy', 'global', NULL, 1, body, 1, now()
FROM upsert
ON CONFLICT DO NOTHING;

INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT sv.category, sv.scope_type, sv.scope_id, sv.id, sv.value, now()
FROM public.settings_versions sv
WHERE sv.category = 'shipment_promise_policy'
  AND sv.scope_type = 'global'
  AND sv.scope_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = sv.category
      AND s.scope_type = sv.scope_type
      AND s.scope_id IS NULL
  );

-------------------------------------------------------------------------------
-- 2) Lookup hygiene: service_level + sla_tier
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('service_level', 'Service level for shipment SLA/promise policy', 'operations', 'tier_1', FALSE),
  ('sla_tier', 'SLA tier classification for reporting/analytics', 'operations', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default)
SELECT ld.id, v.value, v.label, v.description, v.sort_order, v.is_default
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('economy', 'Economy', 'Economy service level', 10, FALSE),
  ('standard', 'Standard', 'Standard service level', 20, TRUE),
  ('premium', 'Premium', 'Premium service level', 30, FALSE),
  ('express', 'Express', 'Express service level', 40, FALSE)
) AS v(value, label, description, sort_order, is_default)
WHERE ld.category = 'service_level'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default)
SELECT ld.id, v.value, v.label, v.description, v.sort_order, v.is_default
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('economy', 'Economy', 'Economy SLA tier', 10, FALSE),
  ('standard', 'Standard', 'Standard SLA tier', 20, TRUE),
  ('premium', 'Premium', 'Premium SLA tier', 30, FALSE)
) AS v(value, label, description, sort_order, is_default)
WHERE ld.category = 'sla_tier'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 3) Shipments projection: branch + promise columns
-------------------------------------------------------------------------------

ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS branch_id UUID,
  ADD COLUMN IF NOT EXISTS promised_delivery_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS promised_window_start_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS promised_window_end_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS promise_computed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS promise_settings_resolution_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conname = 'shipments_branch_id_fkey'
      AND c.conrelid = 'public.shipments'::regclass
  ) THEN
    ALTER TABLE public.shipments
      ADD CONSTRAINT shipments_branch_id_fkey
      FOREIGN KEY (branch_id)
      REFERENCES public.branches(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shipments_branch_id
  ON public.shipments(branch_id)
  WHERE branch_id IS NOT NULL;

COMMENT ON COLUMN public.shipments.branch_id IS
  'Derived branch assignment (projection) resolved from zone_id via branch_zones.';
COMMENT ON COLUMN public.shipments.promised_delivery_at IS
  'Computed promised delivery timestamp (timestamptz) from shipment_promise_policy.';
COMMENT ON COLUMN public.shipments.promised_window_start_at IS
  'Computed promised delivery window start (timestamptz) from shipment_promise_policy.';
COMMENT ON COLUMN public.shipments.promised_window_end_at IS
  'Computed promised delivery window end (timestamptz) from shipment_promise_policy.';
COMMENT ON COLUMN public.shipments.promise_computed_at IS
  'When promise fields were last computed by workflow handler.';
COMMENT ON COLUMN public.shipments.promise_settings_resolution_id IS
  'settings_resolution_log id for the winning shipment_promise_policy resolution (no FK; partitioned log).';

-------------------------------------------------------------------------------
-- 4) Category-specific resolver: branch-aware resource precedence
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_shipment_promise_policy(
  p_context JSONB
)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_resource_id UUID := NULL;
  v_source_id UUID := NULL;
  v_sender_id UUID := NULL;
  v_client_id UUID := NULL;
  v_org_id UUID := NULL;
  v_scope_path JSONB := '[]'::jsonb;
BEGIN
  IF p_context IS NULL OR jsonb_typeof(p_context) <> 'object' THEN
    RETURN QUERY
    SELECT * FROM public.resolve_settings_row('shipment_promise_policy', 'global', NULL) LIMIT 1;
    RETURN;
  END IF;

  BEGIN v_resource_id := NULLIF(p_context->>'resource_id', '')::UUID; EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  BEGIN v_source_id := NULLIF(p_context->>'webhook_source_id', '')::UUID; EXCEPTION WHEN others THEN v_source_id := NULL; END;
  BEGIN v_sender_id := NULLIF(p_context->>'sender_id', '')::UUID; EXCEPTION WHEN others THEN v_sender_id := NULL; END;
  BEGIN v_client_id := NULLIF(p_context->>'client_id', '')::UUID; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_org_id := NULLIF(p_context->>'organization_id', '')::UUID; EXCEPTION WHEN others THEN v_org_id := NULL; END;

  -- Derive chain when higher context is not provided.
  IF v_source_id IS NOT NULL AND v_sender_id IS NULL THEN
    SELECT ws.sender_id, ws.organization_id
      INTO v_sender_id, v_org_id
      FROM public.webhook_sources ws
     WHERE ws.id = v_source_id;
  END IF;

  IF v_sender_id IS NOT NULL AND v_client_id IS NULL THEN
    SELECT s.client_id
      INTO v_client_id
      FROM public.senders s
     WHERE s.id = v_sender_id;
  END IF;

  IF v_client_id IS NOT NULL AND v_org_id IS NULL THEN
    SELECT c.organization_id
      INTO v_org_id
      FROM public.clients c
     WHERE c.id = v_client_id;
  END IF;

  IF v_resource_id IS NOT NULL AND v_org_id IS NULL THEN
    SELECT b.organization_id
      INTO v_org_id
      FROM public.branches b
     WHERE b.id = v_resource_id;
  END IF;

  -- Build evaluated scope path (highest precedence -> lowest).
  IF v_resource_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type', 'resource', 'scope_id', v_resource_id));
  END IF;
  IF v_source_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type', 'source', 'scope_id', v_source_id));
  END IF;
  IF v_sender_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type', 'sender', 'scope_id', v_sender_id));
  END IF;
  IF v_client_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type', 'client', 'scope_id', v_client_id));
  END IF;
  IF v_org_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type', 'tenant', 'scope_id', v_org_id));
  END IF;
  v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type', 'global', 'scope_id', NULL));

  RETURN QUERY
  SELECT ranked.id, ranked.settings_version_id, ranked.scope_type, ranked.scope_id, ranked.cached_value, ranked.version, v_scope_path
  FROM (
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 1 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE v_resource_id IS NOT NULL
       AND s.category = 'shipment_promise_policy'
       AND s.scope_type = 'resource'
       AND s.scope_id = v_resource_id

    UNION ALL
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 2 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE v_source_id IS NOT NULL
       AND s.category = 'shipment_promise_policy'
       AND s.scope_type = 'source'
       AND s.scope_id = v_source_id

    UNION ALL
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 3 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE v_sender_id IS NOT NULL
       AND s.category = 'shipment_promise_policy'
       AND s.scope_type = 'sender'
       AND s.scope_id = v_sender_id

    UNION ALL
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 4 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE v_client_id IS NOT NULL
       AND s.category = 'shipment_promise_policy'
       AND s.scope_type = 'client'
       AND s.scope_id = v_client_id

    UNION ALL
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 5 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE v_org_id IS NOT NULL
       AND s.category = 'shipment_promise_policy'
       AND s.scope_type = 'tenant'
       AND s.scope_id = v_org_id

    UNION ALL
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 6 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'shipment_promise_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
  ) ranked
  ORDER BY ranked.priority, ranked.id
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_shipment_promise_policy(JSONB) IS
  'Resolve shipment_promise_policy with precedence: resource(branch) > source > sender > client > tenant > global; returns settings row + evaluated scope_path.';

-------------------------------------------------------------------------------
-- 5) Promise compute helper (reusable, fully parameterized)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.compute_shipment_promise_v1(
  p_now TIMESTAMPTZ,
  p_timezone TEXT,
  p_service_level TEXT,
  p_policy JSONB,
  p_promised_delivery_date DATE DEFAULT NULL
)
RETURNS TABLE (
  promised_delivery_date DATE,
  promised_window_start_at TIMESTAMPTZ,
  promised_window_end_at TIMESTAMPTZ,
  promised_delivery_at TIMESTAMPTZ,
  debug JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB := COALESCE(p_policy, '{}'::jsonb);
  v_tz TEXT := COALESCE(NULLIF(p_timezone, ''), NULLIF(v_policy->>'timezone', ''), 'UTC');
  v_service_level TEXT := COALESCE(NULLIF(p_service_level, ''), NULLIF(v_policy->>'default_service_level', ''));

  v_cutoff_text TEXT := NULLIF(v_policy->>'cutoff_time', '');
  v_window_start_text TEXT := NULLIF(v_policy->>'delivery_window_start', '');
  v_window_end_text TEXT := NULLIF(v_policy->>'delivery_window_end', '');

  v_cutoff TIME;
  v_window_start TIME;
  v_window_end TIME;

  v_default_transit_days INT;
  v_transit_days INT;

  v_local_now TIMESTAMP;
  v_base_date DATE;
  v_after_cutoff BOOLEAN := FALSE;
  v_local_window_start TIMESTAMP;
  v_local_window_end TIMESTAMP;
BEGIN
  IF p_now IS NULL THEN
    p_now := now();
  END IF;

  BEGIN
    v_cutoff := CASE WHEN v_cutoff_text IS NULL THEN NULL ELSE v_cutoff_text::time END;
  EXCEPTION
    WHEN others THEN
      v_cutoff := NULL;
  END;

  BEGIN
    v_window_start := CASE WHEN v_window_start_text IS NULL THEN NULL ELSE v_window_start_text::time END;
  EXCEPTION
    WHEN others THEN
      v_window_start := NULL;
  END;

  BEGIN
    v_window_end := CASE WHEN v_window_end_text IS NULL THEN NULL ELSE v_window_end_text::time END;
  EXCEPTION
    WHEN others THEN
      v_window_end := NULL;
  END;

  v_local_now := p_now AT TIME ZONE v_tz;

  IF p_promised_delivery_date IS NOT NULL THEN
    promised_delivery_date := p_promised_delivery_date;
  ELSE
    BEGIN
      v_default_transit_days := NULLIF(v_policy->>'default_transit_days', '')::INT;
    EXCEPTION
      WHEN others THEN
        v_default_transit_days := NULL;
    END;

    BEGIN
      v_transit_days := NULLIF((v_policy->'service_level_transit_days'->>v_service_level), '')::INT;
    EXCEPTION
      WHEN others THEN
        v_transit_days := NULL;
    END;

    v_transit_days := COALESCE(v_transit_days, v_default_transit_days);

    IF v_transit_days IS NULL THEN
      promised_delivery_date := NULL;
    ELSE
      v_base_date := v_local_now::date;
      IF v_cutoff IS NOT NULL AND (v_local_now::time >= v_cutoff) THEN
        v_base_date := v_base_date + 1;
        v_after_cutoff := TRUE;
      END IF;

      promised_delivery_date := v_base_date + v_transit_days;
    END IF;
  END IF;

  IF promised_delivery_date IS NOT NULL AND v_window_start IS NOT NULL THEN
    v_local_window_start := promised_delivery_date::timestamp + v_window_start;
    promised_window_start_at := v_local_window_start AT TIME ZONE v_tz;
  ELSE
    promised_window_start_at := NULL;
  END IF;

  IF promised_delivery_date IS NOT NULL AND v_window_end IS NOT NULL THEN
    v_local_window_end := promised_delivery_date::timestamp + v_window_end;
    promised_window_end_at := v_local_window_end AT TIME ZONE v_tz;
  ELSE
    promised_window_end_at := NULL;
  END IF;

  promised_delivery_at := COALESCE(promised_window_end_at, promised_window_start_at);

  debug := jsonb_strip_nulls(jsonb_build_object(
    'timezone', v_tz,
    'service_level', v_service_level,
    'after_cutoff', v_after_cutoff,
    'cutoff_time', v_cutoff_text,
    'delivery_window_start', v_window_start_text,
    'delivery_window_end', v_window_end_text
  ));

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.compute_shipment_promise_v1(TIMESTAMPTZ, TEXT, TEXT, JSONB, DATE) IS
  'Compute shipment promise (date + window) using policy-driven cutoffs/transit/window and a given timezone; uses p_promised_delivery_date when provided.';

-------------------------------------------------------------------------------
-- 6) Workflow handler: promise_assign (shipments projection + shipment_actions SSOT)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_promise_assign_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_ctx RECORD;
  v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_policy_ctx JSONB := '{}'::jsonb;
  v_webhook_id UUID;
  v_webhook_source_id UUID;
  v_policy_row RECORD;
  v_has_policy_row BOOLEAN := FALSE;
  v_policy JSONB := '{}'::jsonb;
  v_enabled BOOLEAN := TRUE;
  v_zone_id UUID;
  v_branch_id UUID;
  v_branch_tz TEXT;
  v_ship_service_level TEXT;
  v_existing_promised_date DATE;
  v_promise RECORD;
  v_settings_resolution_id UUID := NULL;
  v_now TIMESTAMPTZ := public.workflow_now();
  v_updated INT := 0;
  v_response public.workflow_handler_response;
  v_reason TEXT := NULL;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  SELECT * INTO v_ctx FROM public.geocoding_extract_context(p_run);

  IF v_ctx.organization_id IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('assigned', FALSE, 'reason', 'organization_missing');
    RETURN v_response;
  END IF;

  IF v_ctx.shipment_id IS NULL OR v_ctx.client_id IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('assigned', FALSE, 'reason', 'shipment_missing');
    RETURN v_response;
  END IF;

  -- Best-effort: include webhook_source_id (top of ladder) when available.
  v_webhook_id := NULL;
  BEGIN
    v_webhook_id := NULLIF(v_context->>'webhook_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_webhook_id := NULL;
  END;

  IF v_webhook_id IS NOT NULL THEN
    SELECT wi.webhook_source_id
      INTO v_webhook_source_id
      FROM public.webhook_inbox wi
     WHERE wi.id = v_webhook_id;
  END IF;

  -- Load shipment fields needed for zone/branch + promise.
  SELECT s.zone_id, s.service_level, s.promised_delivery_date
    INTO v_zone_id, v_ship_service_level, v_existing_promised_date
    FROM public.shipments s
   WHERE s.id = v_ctx.shipment_id
     AND s.client_id = v_ctx.client_id
   LIMIT 1;

  IF NOT FOUND THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('assigned', FALSE, 'reason', 'shipment_missing');
    RETURN v_response;
  END IF;

  IF v_zone_id IS NULL THEN
    v_reason := 'zone_missing';
    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object('assigned', FALSE, 'reason', v_reason));
    RETURN v_response;
  END IF;

  v_branch_id := public.resolve_branch_id_for_zone(v_zone_id);

  IF v_branch_id IS NULL THEN
    v_reason := 'branch_unmapped';
    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'assigned', FALSE,
      'reason', v_reason,
      'zone_id', v_zone_id
    ));
    RETURN v_response;
  END IF;

  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_ctx.organization_id,
    'client_id', v_ctx.client_id,
    'sender_id', v_ctx.sender_id,
    'webhook_source_id', v_webhook_source_id,
    'resource_id', v_branch_id
  ));

  SELECT *
    INTO v_policy_row
    FROM public.resolve_shipment_promise_policy(v_policy_ctx)
   LIMIT 1;

  v_has_policy_row := FOUND;

  IF v_has_policy_row AND v_policy_row.value IS NOT NULL THEN
    v_policy := v_policy_row.value;
  END IF;

  BEGIN
    v_enabled := COALESCE((v_policy->>'enabled')::BOOLEAN, TRUE);
  EXCEPTION
    WHEN others THEN
      v_enabled := TRUE;
  END;

  IF NOT v_enabled THEN
    v_reason := 'policy_disabled';
    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object('assigned', FALSE, 'reason', v_reason));
    RETURN v_response;
  END IF;

  -- Determine timezone: branch timezone when enabled + present; otherwise policy timezone (or UTC).
  v_branch_tz := NULL;
  BEGIN
    IF COALESCE((v_policy->>'use_branch_timezone')::BOOLEAN, TRUE) THEN
      SELECT b.timezone INTO v_branch_tz FROM public.branches b WHERE b.id = v_branch_id;
    END IF;
  EXCEPTION
    WHEN others THEN
      v_branch_tz := NULL;
  END;

  v_branch_tz := COALESCE(NULLIF(v_branch_tz, ''), NULLIF(v_policy->>'timezone', ''), 'UTC');

  SELECT *
    INTO v_promise
    FROM public.compute_shipment_promise_v1(
      p_now := v_now,
      p_timezone := v_branch_tz,
      p_service_level := v_ship_service_level,
      p_policy := v_policy,
      p_promised_delivery_date := v_existing_promised_date
    )
   LIMIT 1;

  IF v_promise.promised_delivery_date IS NULL THEN
    v_reason := 'promise_uncomputable';
    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'assigned', FALSE,
      'reason', v_reason,
      'settings_policy', v_policy
    ));
    RETURN v_response;
  END IF;

  -- Record settings provenance when available.
  IF v_has_policy_row AND v_policy_row.settings_id IS NOT NULL THEN
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_ctx.organization_id,
      p_category := 'shipment_promise_policy',
      p_winning_scope_type := COALESCE(v_policy_row.scope_type, 'global'),
      p_winning_scope_id := v_policy_row.scope_id,
      p_winning_settings_id := v_policy_row.settings_id,
      p_winning_settings_version_id := v_policy_row.settings_version_id,
      p_winning_version := COALESCE(v_policy_row.version, 1),
      p_scope_path := COALESCE(v_policy_row.scope_path, '[]'::jsonb),
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'workflow_run_id', p_step.workflow_run_id,
        'workflow_step_id', p_step.id,
        'shipment_id', v_ctx.shipment_id,
        'shipment_client_id', v_ctx.client_id,
        'zone_id', v_zone_id,
        'branch_id', v_branch_id,
        'policy_context', v_policy_ctx,
        'promise_debug', v_promise.debug
      )),
      p_merge_notes := NULL
    );
  END IF;

  UPDATE public.shipments s
  SET branch_id = v_branch_id,
      promised_delivery_date = COALESCE(s.promised_delivery_date, v_promise.promised_delivery_date),
      promised_delivery_at = v_promise.promised_delivery_at,
      promised_window_start_at = v_promise.promised_window_start_at,
      promised_window_end_at = v_promise.promised_window_end_at,
      promise_computed_at = v_now,
      promise_settings_resolution_id = v_settings_resolution_id,
      updated_at = v_now,
      version = s.version + 1
  WHERE s.id = v_ctx.shipment_id
    AND s.client_id = v_ctx.client_id
    AND (
      s.branch_id IS DISTINCT FROM v_branch_id
      OR s.promised_delivery_at IS DISTINCT FROM v_promise.promised_delivery_at
      OR s.promised_window_start_at IS DISTINCT FROM v_promise.promised_window_start_at
      OR s.promised_window_end_at IS DISTINCT FROM v_promise.promised_window_end_at
      OR s.promise_settings_resolution_id IS DISTINCT FROM v_settings_resolution_id
      OR (s.promised_delivery_date IS NULL AND v_promise.promised_delivery_date IS NOT NULL)
    );

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated > 0 THEN
    INSERT INTO public.shipment_actions (
      id,
      shipment_id,
      organization_id,
      client_id,
      action_type,
      action_category,
      action_data,
      timestamp,
      created_at,
      performed_by_system
    )
    VALUES (
      gen_random_uuid(),
      v_ctx.shipment_id,
      v_ctx.organization_id,
      v_ctx.client_id,
      'promise_assigned',
      'operational',
      jsonb_strip_nulls(jsonb_build_object(
        'zone_id', v_zone_id,
        'branch_id', v_branch_id,
        'promised_delivery_date', v_promise.promised_delivery_date,
        'promised_delivery_at', v_promise.promised_delivery_at,
        'promised_window_start_at', v_promise.promised_window_start_at,
        'promised_window_end_at', v_promise.promised_window_end_at,
        'settings_resolution_id', v_settings_resolution_id,
        'workflow_run_id', p_step.workflow_run_id
      )),
      v_now,
      v_now,
      'workflow_engine'
    );
  END IF;

  v_response.status := 'completed';
  v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'assigned', (v_updated > 0),
    'reason', CASE WHEN v_updated > 0 THEN NULL ELSE 'no_change' END,
    'zone_id', v_zone_id,
    'branch_id', v_branch_id,
    'promised_delivery_date', v_promise.promised_delivery_date,
    'promised_delivery_at', v_promise.promised_delivery_at,
    'promised_window_start_at', v_promise.promised_window_start_at,
    'promised_window_end_at', v_promise.promised_window_end_at,
    'settings_resolution_id', v_settings_resolution_id
  ));
  v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
    'shipment', jsonb_build_object(
      'branch_id', v_branch_id,
      'promised_delivery_date', v_promise.promised_delivery_date,
      'promised_delivery_at', v_promise.promised_delivery_at,
      'promised_window_start_at', v_promise.promised_window_start_at,
      'promised_window_end_at', v_promise.promised_window_end_at
    )
  ));

  RETURN v_response;
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_promise_assign_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  SET search_path TO workflow_handlers, public, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_promise_assign_v1(public.workflow_run_steps, public.workflow_runs, JSONB) IS
  'Compute and persist shipment promise fields (branch-aware) using shipment_promise_policy resolved via ladder.';

INSERT INTO public.operation_handlers AS oh (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES (
  'promise_assign',
  'workflow_handlers',
  'execute_promise_assign_v1',
  '(public.workflow_run_steps,public.workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Compute shipment promise (date/window) from policy with branch override (resource scope).',
  'docs/ops/plans/PLAN-202601-sla-promise-foundation.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

-------------------------------------------------------------------------------
-- 7) Wire step into workflow_geocoding_standard (before finalize_outcome)
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_template_id UUID;
  v_insert_at INT;
  v_has_promise BOOLEAN := FALSE;
  v_promise_step_id UUID := '99990000-0000-0000-0000-000000410022'::uuid;
BEGIN
  SELECT id INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'workflow_geocoding_standard'
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE NOTICE 'workflow_geocoding_standard not found; skipping promise_assign step insertion';
    RETURN;
  END IF;

  SELECT TRUE INTO v_has_promise
  FROM public.workflow_template_steps
  WHERE workflow_template_id = v_template_id
    AND operation_name = 'promise_assign'
  LIMIT 1;

  IF v_has_promise THEN
    UPDATE public.workflow_template_steps
    SET handler_key = 'promise_assign',
        handler_version = 'v1',
        operation_settings_category = COALESCE(operation_settings_category, 'routing'),
        transition_condition = 'always',
        enabled = TRUE,
        updated_at = now()
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'promise_assign';

    PERFORM public.workflow_refresh_steps_checksum(v_template_id);
    RETURN;
  END IF;

  SELECT sequence_order
  INTO v_insert_at
  FROM public.workflow_template_steps
  WHERE workflow_template_id = v_template_id
    AND operation_name = 'finalize_outcome'
  ORDER BY sequence_order
  LIMIT 1;

  IF v_insert_at IS NULL THEN
    SELECT COALESCE(MAX(sequence_order), 0) + 1
    INTO v_insert_at
    FROM public.workflow_template_steps
    WHERE workflow_template_id = v_template_id;
  END IF;

  UPDATE public.workflow_template_steps
  SET sequence_order = sequence_order + 1
  WHERE workflow_template_id = v_template_id
    AND sequence_order >= v_insert_at;

  INSERT INTO public.workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    handler_key,
    handler_version,
    metadata,
    manual_action_required,
    enabled
  )
  VALUES (
    v_promise_step_id,
    v_template_id,
    v_insert_at,
    'promise_assign',
    'routing',
    'always',
    'promise_assign',
    'v1',
    jsonb_build_object('decision_log_event', 'routing.promise_assign'),
    FALSE,
    TRUE
  )
  ON CONFLICT (id) DO UPDATE
  SET workflow_template_id = EXCLUDED.workflow_template_id,
      sequence_order = EXCLUDED.sequence_order,
      operation_name = EXCLUDED.operation_name,
      operation_settings_category = EXCLUDED.operation_settings_category,
      transition_condition = EXCLUDED.transition_condition,
      handler_key = EXCLUDED.handler_key,
      handler_version = EXCLUDED.handler_version,
      metadata = EXCLUDED.metadata,
      manual_action_required = EXCLUDED.manual_action_required,
      enabled = EXCLUDED.enabled,
      updated_at = now();

  PERFORM public.workflow_refresh_steps_checksum(v_template_id);
END $$;

SELECT pg_advisory_unlock(hashtext('202601212350_sla_promise_foundation'));
COMMIT;
