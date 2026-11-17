-- Plan: B02 Pickup & first-mile handoff
-- Migration: Pickup batch 2 foundation v1
-- Date: 2026-03-19
--
-- Purpose:
--   - Add the canonical pickup request / wave / assignment RPCs.
--   - Keep pickup execution row-driven via pickup_policy + existing route/task workflows.
--   - Extend generic route-run workflow handlers so context-carried idempotency can safely dedupe route creation
--     and stop-task fanout when higher-level APIs retry the same orchestration.
--   - Add pickup-specific stop outcomes, follow-up tasks, and reporting views.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603191130_pickup_batch2_foundation_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Shared auth + pickup policy helpers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.request_is_service_role_v1()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;

  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');
  RETURN v_role = 'service_role';
END;
$function$;

COMMENT ON FUNCTION public.request_is_service_role_v1()
  IS 'Return TRUE when the current request JWT role is service_role.';
REVOKE ALL ON FUNCTION public.request_is_service_role_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_is_service_role_v1() FROM anon;
GRANT EXECUTE ON FUNCTION public.request_is_service_role_v1() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pickup_policy_default_v1()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN jsonb_build_object(
    'version', 1,
    'request', jsonb_build_object(
      'shipment_status', 'pickup_requested',
      'validation_status', 'pending',
      'default_box_count', 1,
      'tracking_prefix', 'PU',
      'require_window', TRUE
    ),
    'wave', jsonb_build_object(
      'allowed_shipment_statuses', jsonb_build_array('pickup_requested'),
      'shipment_status', 'pickup_scheduled',
      'route_run_status', 'planned',
      'inline_budget_ms', 1500,
      'inline_max_steps', 8
    ),
    'assignment', jsonb_build_object(
      'require_driver_or_partner', TRUE,
      'allow_partner_assignment', TRUE,
      'enforce_capacity', FALSE,
      'default_capacity_boxes', 100
    ),
    'failure', jsonb_build_object(
      'reschedule_reasons', jsonb_build_array(
        'no_answer',
        'phone_unreachable',
        'business_closed',
        'sender_unavailable',
        'pickup_not_ready'
      ),
      'escalation_reasons', jsonb_build_array(
        'address_not_found',
        'address_incorrect',
        'payment_issue',
        'package_damaged',
        'package_lost',
        'customer_refused',
        'access_restricted',
        'quantity_mismatch',
        'other'
      ),
      'followup', jsonb_build_object(
        'reschedule_task_type_key', 'dispatch_reschedule_pickup',
        'escalation_task_type_key', 'dispatch_pickup_escalation_review'
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.pickup_policy_default_v1()
  IS 'Return the canonical default pickup_policy payload used when no scoped override exists.';
REVOKE ALL ON FUNCTION public.pickup_policy_default_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pickup_policy_default_v1() FROM anon;
GRANT EXECUTE ON FUNCTION public.pickup_policy_default_v1() TO authenticated, service_role;

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
  'pickup_policy',
  'Pickup request/wave/assignment policy for first-mile orchestration.',
  TRUE,
  TRUE,
  FALSE,
  'hard_fail',
  '["global","tenant","client","sender","resource"]'::jsonb,
  'public.branches'::regclass
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    requires_schema = EXCLUDED.requires_schema,
    requires_global_default = EXCLUDED.requires_global_default,
    side_effecting = EXCLUDED.side_effecting,
    safe_missing_behavior = EXCLUDED.safe_missing_behavior,
    allowed_scopes = EXCLUDED.allowed_scopes,
    resource_scope_rel = EXCLUDED.resource_scope_rel;

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'pickup_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'request', jsonb_build_object('type', 'object', 'additionalProperties', TRUE),
      'wave', jsonb_build_object('type', 'object', 'additionalProperties', TRUE),
      'assignment', jsonb_build_object('type', 'object', 'additionalProperties', TRUE),
      'failure', jsonb_build_object('type', 'object', 'additionalProperties', TRUE)
    )
  ),
  'Pickup orchestration policy for request intake, wave grouping, assignment, and failure follow-up.',
  jsonb_build_array(public.pickup_policy_default_v1()),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE;

WITH payload AS (
  SELECT public.pickup_policy_default_v1() AS value
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
    'pickup_policy',
    'global',
    NULL::uuid,
    1,
    payload.value,
    1,
    'Seed global pickup_policy',
    now(),
    now()
  FROM payload
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'pickup_policy'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (
  category,
  scope_type,
  scope_id,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  'pickup_policy',
  'global',
  NULL::uuid,
  inserted.id,
  inserted.value,
  now()
FROM inserted
ON CONFLICT (category, scope_type, scope_hash) DO NOTHING;

CREATE OR REPLACE FUNCTION public.resolve_pickup_policy(
  p_context JSONB DEFAULT '{}'::jsonb
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
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_default JSONB := public.pickup_policy_default_v1();
BEGIN
  RETURN QUERY
  WITH resolved AS (
    SELECT *
      FROM public.resolve_settings_row_from_policy_context_v1(
        'pickup_policy',
        COALESCE(p_context, '{}'::jsonb)
      )
     LIMIT 1
  )
  SELECT
    resolved.settings_id,
    resolved.settings_version_id,
    resolved.scope_type,
    resolved.scope_id,
    public.jsonb_deep_merge(v_default, COALESCE(resolved.value, '{}'::jsonb)) AS value,
    COALESCE(resolved.version, 1) AS version,
    COALESCE(resolved.scope_path, '[]'::jsonb) AS scope_path
  FROM resolved
  UNION ALL
  SELECT
    NULL::uuid,
    NULL::uuid,
    'global'::text,
    NULL::uuid,
    v_default,
    1,
    jsonb_build_array(jsonb_build_object('scope_type', 'global', 'scope_id', NULL))
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.resolve_settings_row_from_policy_context_v1(
      'pickup_policy',
      COALESCE(p_context, '{}'::jsonb)
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.resolve_pickup_policy(JSONB)
  IS 'Resolve pickup_policy through the canonical scope ladder and deep-merge the platform default.';
REVOKE ALL ON FUNCTION public.resolve_pickup_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_pickup_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_pickup_policy(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pickup_generate_tracking_number_v1(
  p_client_id UUID,
  p_prefix TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_prefix TEXT := upper(left(COALESCE(NULLIF(regexp_replace(COALESCE(p_prefix, ''), '[^A-Za-z0-9]', '', 'g'), ''), 'PU'), 6));
  v_seed TEXT := COALESCE(NULLIF(btrim(COALESCE(p_idempotency_key, '')), ''), gen_random_uuid()::text);
BEGIN
  RETURN format(
    '%s%s',
    v_prefix,
    upper(substr(encode(digest(format('%s|%s', COALESCE(p_client_id::text, ''), v_seed), 'sha256'), 'hex'), 1, 18))
  );
END;
$function$;

COMMENT ON FUNCTION public.pickup_generate_tracking_number_v1(UUID, TEXT, TEXT)
  IS 'Generate a pickup tracking number from the configured prefix and a deterministic idempotency seed when present.';
REVOKE ALL ON FUNCTION public.pickup_generate_tracking_number_v1(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pickup_generate_tracking_number_v1(UUID, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.pickup_generate_tracking_number_v1(UUID, TEXT, TEXT) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 2) Pickup statuses, exception reasons, and follow-up task catalog
-------------------------------------------------------------------------------

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, status)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  FALSE,
  'active'
FROM public.lookup_definitions ld
JOIN (
  VALUES
    ('pickup_requested', 'Pickup Requested', 'Pickup request captured and waiting for wave planning', 16),
    ('pickup_scheduled', 'Pickup Scheduled', 'Pickup request grouped into a pickup wave and scheduled', 17),
    ('pickup_failed', 'Pickup Failed', 'Pickup execution failed and requires reschedule or escalation', 46)
) AS v(value, label, description, sort_order)
  ON ld.category = 'shipment_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  FALSE,
  v.metadata::jsonb
FROM public.lookup_definitions ld
JOIN (
  VALUES
    ('sender_unavailable', 'Sender Unavailable', 'Pickup contact was unavailable during the requested window', 110, '{"recommended_followup_task_type_key":"dispatch_reschedule_pickup","class":"pickup"}'),
    ('pickup_not_ready', 'Pickup Not Ready', 'Shipment was not ready for handover at pickup time', 120, '{"recommended_followup_task_type_key":"dispatch_reschedule_pickup","class":"pickup"}'),
    ('access_restricted', 'Access Restricted', 'Driver could not gain access to the pickup location', 130, '{"recommended_followup_task_type_key":"dispatch_pickup_escalation_review","class":"pickup"}'),
    ('quantity_mismatch', 'Quantity Mismatch', 'Confirmed pickup quantity did not match the requested quantity', 140, '{"recommended_followup_task_type_key":"dispatch_pickup_escalation_review","class":"pickup"}')
  ) AS v(value, label, description, sort_order, metadata)
  ON ld.category = 'dispatch_exception_reason'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_existing JSONB := NULL;
  v_policy JSONB := '{}'::jsonb;
  v_task_types JSONB := '[]'::jsonb;
  v_prev_task_types JSONB := '[]'::jsonb;
  v_desired JSONB := jsonb_build_array(
    jsonb_build_object('key', 'dispatch_reschedule_pickup', 'name', 'Dispatch Reschedule Pickup', 'default_priority', 50, 'default_queue_key', 'dispatch', 'enabled', TRUE),
    jsonb_build_object('key', 'dispatch_pickup_escalation_review', 'name', 'Dispatch Pickup Escalation Review', 'default_priority', 50, 'default_queue_key', 'dispatch', 'enabled', TRUE)
  );
  v_item JSONB;
  v_key TEXT;
  v_sv_id UUID := gen_random_uuid();
  v_next_version INT := 1;
BEGIN
  SELECT s.cached_value
    INTO v_existing
    FROM public.settings s
   WHERE s.category = 'task_type_catalog'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_existing IS NULL OR jsonb_typeof(v_existing) <> 'object' THEN
    v_existing := '{}'::jsonb;
  END IF;

  v_task_types := COALESCE(v_existing->'task_types', '[]'::jsonb);
  IF jsonb_typeof(v_task_types) <> 'array' THEN
    v_task_types := '[]'::jsonb;
  END IF;
  v_prev_task_types := v_task_types;

  FOR v_item IN
    SELECT * FROM jsonb_array_elements(v_desired)
  LOOP
    v_key := lower(NULLIF(btrim(COALESCE(v_item->>'key', '')), ''));
    IF v_key IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_task_types) e
      WHERE lower(NULLIF(btrim(COALESCE(e->>'key', '')), '')) = v_key
    ) THEN
      v_task_types := v_task_types || jsonb_build_array(v_item);
    END IF;
  END LOOP;

  IF v_task_types IS NOT DISTINCT FROM v_prev_task_types THEN
    RETURN;
  END IF;

  v_policy := jsonb_set(v_existing, '{task_types}', v_task_types, TRUE);

  UPDATE public.settings_versions
     SET effective_until = workflow_now()
   WHERE category = 'task_type_catalog'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
     AND effective_until IS NULL
     AND approved_at IS NOT NULL;

  SELECT COALESCE(MAX(version) + 1, 1)
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'task_type_catalog'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash;

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
  ) VALUES (
    v_sv_id,
    'task_type_catalog',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_next_version,
    v_policy,
    1,
    'Add pickup operational task types to task_type_catalog',
    workflow_now(),
    workflow_now()
  );

  INSERT INTO public.settings (
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  VALUES (
    'task_type_catalog',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_sv_id,
    v_policy,
    workflow_now()
  )
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;
END;
$do$;

-------------------------------------------------------------------------------
-- 3) Pickup stop outcome policies + task completion effects
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_existing_policy JSONB := NULL;
  v_policy JSONB := '{}'::jsonb;
  v_existing_map JSONB := NULL;
  v_map JSONB := '{}'::jsonb;
  v_additions JSONB := jsonb_build_object(
    'no_answer', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_reschedule_pickup', 'resource_id_source', 'shipment')
      )
    ),
    'phone_unreachable', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_reschedule_pickup', 'resource_id_source', 'shipment')
      )
    ),
    'business_closed', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_reschedule_pickup', 'resource_id_source', 'shipment')
      )
    ),
    'sender_unavailable', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_reschedule_pickup', 'resource_id_source', 'shipment')
      )
    ),
    'pickup_not_ready', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_reschedule_pickup', 'resource_id_source', 'shipment')
      )
    ),
    'address_not_found', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_pickup_escalation_review', 'resource_id_source', 'shipment')
      )
    ),
    'address_incorrect', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_pickup_escalation_review', 'resource_id_source', 'shipment')
      )
    ),
    'payment_issue', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_pickup_escalation_review', 'resource_id_source', 'shipment')
      )
    ),
    'package_damaged', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_pickup_escalation_review', 'resource_id_source', 'shipment')
      )
    ),
    'package_lost', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_pickup_escalation_review', 'resource_id_source', 'shipment')
      )
    ),
    'customer_refused', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_pickup_escalation_review', 'resource_id_source', 'shipment')
      )
    ),
    'access_restricted', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_pickup_escalation_review', 'resource_id_source', 'shipment')
      )
    ),
    'quantity_mismatch', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_pickup_escalation_review', 'resource_id_source', 'shipment')
      )
    ),
    'other', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_pickup_escalation_review', 'resource_id_source', 'shipment')
      )
    )
  );
  v_k TEXT;
  v_v JSONB;
  v_sv_id UUID := gen_random_uuid();
  v_next_version INT := 1;
BEGIN
  SELECT s.cached_value
    INTO v_existing_policy
    FROM public.settings s
   WHERE s.category = 'dispatch_stop_policy'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_existing_policy IS NULL OR jsonb_typeof(v_existing_policy) <> 'object' THEN
    v_existing_policy := '{}'::jsonb;
  END IF;

  v_policy := v_existing_policy;

  IF jsonb_typeof(v_policy->'stop_kind_map') <> 'object' THEN
    v_policy := jsonb_set(v_policy, '{stop_kind_map}', '{}'::jsonb, TRUE);
  END IF;
  IF jsonb_typeof(v_policy #> '{stop_kind_map,pickup}') <> 'object' THEN
    v_policy := jsonb_set(
      v_policy,
      '{stop_kind_map,pickup}',
      jsonb_build_object(
        'shipment_status', 'in_transit',
        'action_type', 'status_change',
        'action_category', 'operational'
      ),
      TRUE
    );
  END IF;

  v_existing_map := v_policy #> '{stop_kind_map,pickup,outcome_map}';
  v_map := COALESCE(v_existing_map, '{}'::jsonb);
  IF jsonb_typeof(v_map) <> 'object' THEN
    v_map := '{}'::jsonb;
  END IF;

  FOR v_k, v_v IN
    SELECT key, value FROM jsonb_each(v_additions)
  LOOP
    IF NOT (v_map ? v_k) THEN
      v_map := jsonb_set(v_map, ARRAY[v_k], v_v, TRUE);
    END IF;
  END LOOP;

  IF v_existing_map IS NOT DISTINCT FROM v_map THEN
    RETURN;
  END IF;

  v_policy := jsonb_set(v_policy, '{stop_kind_map,pickup,outcome_map}', v_map, TRUE);

  UPDATE public.settings_versions
     SET effective_until = workflow_now()
   WHERE category = 'dispatch_stop_policy'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
     AND effective_until IS NULL
     AND approved_at IS NOT NULL;

  SELECT COALESCE(MAX(version) + 1, 1)
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'dispatch_stop_policy'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash;

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
  ) VALUES (
    v_sv_id,
    'dispatch_stop_policy',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_next_version,
    v_policy,
    1,
    'Add pickup stop outcome policies and follow-up defaults',
    workflow_now(),
    workflow_now()
  );

  INSERT INTO public.settings (
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  VALUES (
    'dispatch_stop_policy',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_sv_id,
    v_policy,
    workflow_now()
  )
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;
END;
$do$;

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_existing JSONB := NULL;
  v_policy JSONB := '{}'::jsonb;
  v_task_map JSONB := '{}'::jsonb;
  v_prev_task_map JSONB := '{}'::jsonb;
  v_sv_id UUID := gen_random_uuid();
  v_next_version INT := 1;
BEGIN
  SELECT s.cached_value
    INTO v_existing
    FROM public.settings s
   WHERE s.category = 'task_completion_effects_policy'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_existing IS NULL OR jsonb_typeof(v_existing) <> 'object' THEN
    v_existing := '{}'::jsonb;
  END IF;

  v_task_map := COALESCE(v_existing->'task_type_map', '{}'::jsonb);
  IF jsonb_typeof(v_task_map) <> 'object' THEN
    v_task_map := '{}'::jsonb;
  END IF;
  v_prev_task_map := v_task_map;

  IF NOT (v_task_map ? 'dispatch_reschedule_pickup') THEN
    v_task_map := jsonb_set(v_task_map, '{dispatch_reschedule_pickup}', jsonb_build_object('shipment_status', 'pickup_requested'), TRUE);
  END IF;
  IF NOT (v_task_map ? 'dispatch_pickup_escalation_review') THEN
    v_task_map := jsonb_set(v_task_map, '{dispatch_pickup_escalation_review}', jsonb_build_object('shipment_status', 'pickup_failed'), TRUE);
  END IF;

  IF v_task_map IS NOT DISTINCT FROM v_prev_task_map THEN
    RETURN;
  END IF;

  v_policy := jsonb_set(v_existing, '{task_type_map}', v_task_map, TRUE);

  UPDATE public.settings_versions
     SET effective_until = workflow_now()
   WHERE category = 'task_completion_effects_policy'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
     AND effective_until IS NULL
     AND approved_at IS NOT NULL;

  SELECT COALESCE(MAX(version) + 1, 1)
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'task_completion_effects_policy'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash;

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
  ) VALUES (
    v_sv_id,
    'task_completion_effects_policy',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_next_version,
    v_policy,
    1,
    'Add pickup follow-up task completion effects',
    workflow_now(),
    workflow_now()
  );

  INSERT INTO public.settings (
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  VALUES (
    'task_completion_effects_policy',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_sv_id,
    v_policy,
    workflow_now()
  )
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;
END;
$do$;

DO $do$
DECLARE
  v_template_id UUID := NULL;
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_existing JSONB := NULL;
  v_policy JSONB := '{}'::jsonb;
  v_events JSONB := '{}'::jsonb;
  v_prev_events JSONB := '{}'::jsonb;
  v_sv_id UUID := gen_random_uuid();
  v_next_version INT := 1;
BEGIN
  SELECT wt.id
    INTO v_template_id
    FROM public.workflow_templates wt
   WHERE wt.name = 'task_completion_effects_v1'
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'pickup_batch2_foundation_v1: task_completion_effects_v1 template missing';
  END IF;

  SELECT s.cached_value
    INTO v_existing
    FROM public.settings s
   WHERE s.category = 'domain_event_policy'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_existing IS NULL OR jsonb_typeof(v_existing) <> 'object' THEN
    v_existing := '{"events":{}}'::jsonb;
  END IF;

  v_events := COALESCE(v_existing->'events', '{}'::jsonb);
  IF jsonb_typeof(v_events) <> 'object' THEN
    v_events := '{}'::jsonb;
  END IF;
  v_prev_events := v_events;

  IF COALESCE(v_events #>> '{task.completed.dispatch_reschedule_pickup,workflow_template_id}', '') = '' THEN
    v_events := jsonb_set(
      v_events,
      '{task.completed.dispatch_reschedule_pickup}',
      jsonb_build_object('workflow_template_id', v_template_id::text),
      TRUE
    );
  END IF;

  IF COALESCE(v_events #>> '{task.completed.dispatch_pickup_escalation_review,workflow_template_id}', '') = '' THEN
    v_events := jsonb_set(
      v_events,
      '{task.completed.dispatch_pickup_escalation_review}',
      jsonb_build_object('workflow_template_id', v_template_id::text),
      TRUE
    );
  END IF;

  IF v_events IS NOT DISTINCT FROM v_prev_events THEN
    RETURN;
  END IF;

  v_policy := jsonb_set(v_existing, '{events}', v_events, TRUE);

  UPDATE public.settings_versions
     SET effective_until = workflow_now()
   WHERE category = 'domain_event_policy'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
     AND effective_until IS NULL
     AND approved_at IS NOT NULL;

  SELECT COALESCE(MAX(version) + 1, 1)
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'domain_event_policy'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash;

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
  ) VALUES (
    v_sv_id,
    'domain_event_policy',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_next_version,
    v_policy,
    1,
    'Wire pickup follow-up task completion events to task_completion_effects_v1',
    workflow_now(),
    workflow_now()
  );

  INSERT INTO public.settings (
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  VALUES (
    'domain_event_policy',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_sv_id,
    v_policy,
    workflow_now()
  )
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;
END;
$do$;

-------------------------------------------------------------------------------
-- 4) Generic route-run workflow idempotency improvements
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_route_run_create_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_meta JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);

  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'dispatch');
  v_stops_path TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'stops_jsonpath', '')), ''), '$.stops');

  v_org_id UUID := NULL;
  v_branch_id UUID := NULL;
  v_driver_user_id UUID := NULL;
  v_vehicle_id UUID := NULL;

  v_planned_date DATE := NULL;
  v_planned_start_at TIMESTAMPTZ := NULL;
  v_planned_end_at TIMESTAMPTZ := NULL;

  v_status TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'status', '')), ''));
  v_idempotency_key TEXT := COALESCE(
    NULLIF(btrim(COALESCE(v_meta->>'idempotency_key', '')), ''),
    NULLIF(btrim(COALESCE(v_ctx->>'idempotency_key', '')), ''),
    format('workflow_run:%s:step:%s', p_run.id, p_step.id)
  );

  v_stops JSONB := NULL;
  v_created RECORD;
  v_resp public.workflow_handler_response;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  BEGIN v_org_id := NULLIF(v_ctx->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  BEGIN v_branch_id := NULLIF(v_ctx->>'branch_id', '')::uuid; EXCEPTION WHEN others THEN v_branch_id := NULL; END;
  BEGIN v_driver_user_id := NULLIF(v_ctx->>'driver_user_id', '')::uuid; EXCEPTION WHEN others THEN v_driver_user_id := NULL; END;
  BEGIN v_vehicle_id := NULLIF(v_ctx->>'vehicle_id', '')::uuid; EXCEPTION WHEN others THEN v_vehicle_id := NULL; END;

  BEGIN v_planned_date := NULLIF(v_ctx->>'planned_date', '')::date; EXCEPTION WHEN others THEN v_planned_date := NULL; END;
  BEGIN v_planned_start_at := NULLIF(v_ctx->>'planned_start_at', '')::timestamptz; EXCEPTION WHEN others THEN v_planned_start_at := NULL; END;
  BEGIN v_planned_end_at := NULLIF(v_ctx->>'planned_end_at', '')::timestamptz; EXCEPTION WHEN others THEN v_planned_end_at := NULL; END;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'route_run_create: organization_id missing from workflow context (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  v_stops := public.safe_jsonpath_query_first(v_ctx, v_stops_path);
  IF v_stops IS NULL OR jsonb_typeof(v_stops) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'route_run_create: stops_jsonpath did not resolve to array (path=% workflow_run_id=% step_id=%)', v_stops_path, p_run.id, p_step.id;
  END IF;

  SELECT *
    INTO v_created
    FROM public.create_route_run_v1(
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'branch_id', v_branch_id,
        'driver_user_id', v_driver_user_id,
        'vehicle_id', v_vehicle_id,
        'status', COALESCE(v_status, 'planned'),
        'planned_date', v_planned_date,
        'planned_start_at', v_planned_start_at,
        'planned_end_at', v_planned_end_at,
        'idempotency_key', v_idempotency_key,
        'stops', v_stops,
        'metadata', COALESCE(v_meta->'route_run_metadata', '{}'::jsonb)
      ))
    )
    LIMIT 1;

  v_resp.status := 'completed';
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'route_run_id', v_created.route_run_id,
    'stop_ids', to_jsonb(v_created.stop_ids),
    'created', v_created.created
  ));
  v_resp.context_patch := jsonb_build_object(
    v_context_key,
    jsonb_strip_nulls(jsonb_build_object(
      'route_run_id', v_created.route_run_id,
      'stop_ids', to_jsonb(v_created.stop_ids),
      'created', v_created.created
    ))
  );

  RETURN v_resp;
END;
$function$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_task_enqueue_many_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_meta JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);

  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'tasks_many');
  v_items_path TEXT := NULLIF(btrim(COALESCE(v_meta->>'items_jsonpath', '')), '');
  v_task_type_key TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'task_type_key', '')), ''));
  v_resource_type TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'resource_type', '')), ''));
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'actor_system', '')), ''), 'workflow_engine');
  v_idempotency_prefix TEXT := COALESCE(
    NULLIF(btrim(COALESCE(v_meta->>'idempotency_prefix', '')), ''),
    NULLIF(btrim(COALESCE(v_ctx->>'idempotency_key', '')), ''),
    format('workflow_run:%s:step:%s', p_run.id, p_step.id)
  );

  v_org_id UUID := NULL;
  v_items JSONB := NULL;
  v_item JSONB;

  v_i INT := 0;
  v_resource_id UUID := NULL;
  v_idempotency_key TEXT := NULL;

  v_task_metadata_base JSONB := COALESCE(v_meta->'task_metadata', '{}'::jsonb);
  v_task_metadata JSONB := '{}'::jsonb;

  v_created RECORD;

  v_task_ids UUID[] := '{}'::uuid[];
  v_task_event_ids UUID[] := '{}'::uuid[];
  v_task_workflow_run_ids UUID[] := '{}'::uuid[];

  v_resp public.workflow_handler_response;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  IF v_items_path IS NULL THEN
    RAISE EXCEPTION 'task_enqueue_many: missing metadata.items_jsonpath (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;
  IF v_task_type_key IS NULL THEN
    RAISE EXCEPTION 'task_enqueue_many: missing metadata.task_type_key (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;
  IF v_resource_type IS NULL THEN
    RAISE EXCEPTION 'task_enqueue_many: missing metadata.resource_type (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  BEGIN v_org_id := NULLIF(v_ctx->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'task_enqueue_many: organization_id missing from workflow context (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  v_items := public.safe_jsonpath_query_first(v_ctx, v_items_path);
  IF v_items IS NULL OR jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'task_enqueue_many: items_jsonpath did not resolve to array (path=% workflow_run_id=% step_id=%)', v_items_path, p_run.id, p_step.id;
  END IF;

  IF jsonb_typeof(v_task_metadata_base) IS DISTINCT FROM 'object' THEN
    v_task_metadata_base := '{}'::jsonb;
  END IF;

  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(v_items) AS t(value)
  LOOP
    v_i := v_i + 1;

    v_resource_id := NULL;
    IF jsonb_typeof(v_item) = 'string' THEN
      BEGIN v_resource_id := NULLIF(trim(both '"' FROM v_item::text), '')::uuid; EXCEPTION WHEN others THEN v_resource_id := NULL; END;
    ELSIF jsonb_typeof(v_item) = 'object' THEN
      BEGIN v_resource_id := NULLIF(v_item->>'resource_id', '')::uuid; EXCEPTION WHEN others THEN v_resource_id := NULL; END;
    END IF;

    IF v_resource_id IS NULL THEN
      RAISE EXCEPTION 'task_enqueue_many: item % missing resource_id/uuid', v_i USING ERRCODE = '23514';
    END IF;

    v_idempotency_key := format('%s:item:%s', v_idempotency_prefix, v_resource_id);

    v_task_metadata := public.jsonb_deep_merge(
      v_task_metadata_base,
      jsonb_strip_nulls(jsonb_build_object(
        'parent_workflow_run_id', p_run.id,
        'parent_workflow_step_id', p_step.id,
        'fanout_index', v_i
      ))
    );

    SELECT *
      INTO v_created
      FROM public.create_task_system_v1(
        jsonb_strip_nulls(jsonb_build_object(
          'task_type_key', v_task_type_key,
          'context', jsonb_build_object('organization_id', v_org_id),
          'resource_type', v_resource_type,
          'resource_id', v_resource_id,
          'idempotency_key', v_idempotency_key,
          'metadata', v_task_metadata,
          'actor_system', v_actor_system
        ))
      )
      LIMIT 1;

    IF v_created.task_id IS NULL THEN
      RAISE EXCEPTION 'task_enqueue_many: create_task_system_v1 returned NULL task_id (idx=% resource_id=%)', v_i, v_resource_id
        USING ERRCODE = '23514';
    END IF;

    v_task_ids := array_append(v_task_ids, v_created.task_id);
    v_task_event_ids := array_append(v_task_event_ids, v_created.task_event_id);
    v_task_workflow_run_ids := array_append(v_task_workflow_run_ids, v_created.workflow_run_id);
  END LOOP;

  v_resp.status := 'completed';
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'count', v_i,
    'task_ids', to_jsonb(v_task_ids),
    'task_event_ids', to_jsonb(v_task_event_ids),
    'task_workflow_run_ids', to_jsonb(v_task_workflow_run_ids)
  ));
  v_resp.context_patch := jsonb_build_object(
    v_context_key,
    jsonb_strip_nulls(jsonb_build_object(
      'count', v_i,
      'task_ids', to_jsonb(v_task_ids),
      'task_event_ids', to_jsonb(v_task_event_ids),
      'task_workflow_run_ids', to_jsonb(v_task_workflow_run_ids)
    ))
  );

  RETURN v_resp;
END;
$function$;

-------------------------------------------------------------------------------
-- 5) Pickup request / wave / assignment RPCs
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_pickup_request_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_user_id UUID := auth.uid();
  v_service_role BOOLEAN := public.request_is_service_role_v1();
  v_is_platform BOOLEAN := public.is_platform_user();

  v_org_id UUID := NULL;
  v_client_id UUID := NULL;
  v_sender_id UUID := NULL;
  v_branch_id UUID := NULL;
  v_requested_window_start_at TIMESTAMPTZ := NULL;
  v_requested_window_end_at TIMESTAMPTZ := NULL;

  v_policy_row RECORD;
  v_policy JSONB := public.pickup_policy_default_v1();
  v_request_policy JSONB := '{}'::jsonb;

  v_tracking_number TEXT := NULL;
  v_client_reference_number TEXT := NULL;
  v_carrier_reference_number TEXT := NULL;
  v_idempotency_key TEXT := NULL;
  v_status TEXT := NULL;
  v_validation_status TEXT := NULL;
  v_box_count INT := 1;

  v_origin_address JSONB := '{}'::jsonb;
  v_origin_address_id UUID := NULL;
  v_metadata JSONB := '{}'::jsonb;
  v_pickup_request JSONB := '{}'::jsonb;
  v_reference_map JSONB := '{}'::jsonb;

  v_duplicate RECORD;
  v_shipment_id UUID := NULL;
  v_action_id UUID := NULL;
BEGIN
  IF jsonb_typeof(v_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'create_pickup_request_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_org_id := NULLIF(v_input->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  BEGIN v_client_id := NULLIF(v_input->>'client_id', '')::uuid; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_sender_id := NULLIF(v_input->>'sender_id', '')::uuid; EXCEPTION WHEN others THEN v_sender_id := NULL; END;
  BEGIN v_branch_id := NULLIF(v_input->>'branch_id', '')::uuid; EXCEPTION WHEN others THEN v_branch_id := NULL; END;
  BEGIN v_requested_window_start_at := COALESCE(NULLIF(v_input->>'requested_window_start_at', '')::timestamptz, NULLIF(v_input#>>'{requested_window,start_at}', '')::timestamptz); EXCEPTION WHEN others THEN v_requested_window_start_at := NULL; END;
  BEGIN v_requested_window_end_at := COALESCE(NULLIF(v_input->>'requested_window_end_at', '')::timestamptz, NULLIF(v_input#>>'{requested_window,end_at}', '')::timestamptz); EXCEPTION WHEN others THEN v_requested_window_end_at := NULL; END;

  v_client_reference_number := NULLIF(btrim(COALESCE(v_input->>'client_reference_number', '')), '');
  v_carrier_reference_number := NULLIF(btrim(COALESCE(v_input->>'carrier_reference_number', '')), '');
  v_tracking_number := NULLIF(btrim(COALESCE(v_input->>'tracking_number', '')), '');
  v_idempotency_key := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  BEGIN v_box_count := COALESCE(NULLIF(v_input->>'box_count', '')::int, 1); EXCEPTION WHEN others THEN v_box_count := 1; END;

  IF v_org_id IS NULL OR v_client_id IS NULL THEN
    RAISE EXCEPTION 'create_pickup_request_v1 requires organization_id and client_id' USING ERRCODE = '23514';
  END IF;

  IF NOT v_service_role THEN
    IF v_user_id IS NULL THEN
      RAISE EXCEPTION 'create_pickup_request_v1 requires an authenticated user' USING ERRCODE = '42501';
    END IF;
    IF NOT v_is_platform AND public.current_user_scope_type() IS DISTINCT FROM 'tenant' THEN
      RAISE EXCEPTION 'create_pickup_request_v1 requires tenant/platform write scope' USING ERRCODE = '42501';
    END IF;
    IF NOT v_is_platform AND public.current_user_org_id() IS DISTINCT FROM v_org_id THEN
      RAISE EXCEPTION 'create_pickup_request_v1 organization mismatch for current tenant scope' USING ERRCODE = '42501';
    END IF;
    IF NOT public.user_has_permission_v1('shipments.write', v_org_id) THEN
      RAISE EXCEPTION 'create_pickup_request_v1 requires shipments.write permission' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT *
    INTO v_policy_row
    FROM public.resolve_pickup_policy(
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'client_id', v_client_id,
        'sender_id', v_sender_id,
        'resource_id', v_branch_id
      ))
    )
   LIMIT 1;

  IF v_policy_row.value IS NOT NULL THEN
    v_policy := v_policy_row.value;
  END IF;

  v_request_policy := COALESCE(v_policy->'request', '{}'::jsonb);
  IF jsonb_typeof(v_request_policy) IS DISTINCT FROM 'object' THEN
    v_request_policy := '{}'::jsonb;
  END IF;

  v_status := lower(COALESCE(NULLIF(btrim(COALESCE(v_request_policy->>'shipment_status', '')), ''), 'pickup_requested'));
  v_validation_status := lower(COALESCE(NULLIF(btrim(COALESCE(v_request_policy->>'validation_status', '')), ''), 'pending'));

  BEGIN
    v_box_count := COALESCE(NULLIF(v_input->>'box_count', '')::int, NULLIF(v_request_policy->>'default_box_count', '')::int, 1);
  EXCEPTION WHEN others THEN
    v_box_count := 1;
  END;
  IF v_box_count < 1 THEN
    RAISE EXCEPTION 'create_pickup_request_v1 box_count must be greater than zero' USING ERRCODE = '23514';
  END IF;

  IF COALESCE((v_request_policy->>'require_window')::boolean, TRUE) THEN
    IF v_requested_window_start_at IS NULL OR v_requested_window_end_at IS NULL THEN
      RAISE EXCEPTION 'create_pickup_request_v1 requires requested pickup window' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF v_requested_window_start_at IS NOT NULL
     AND v_requested_window_end_at IS NOT NULL
     AND v_requested_window_end_at < v_requested_window_start_at THEN
    RAISE EXCEPTION 'create_pickup_request_v1 requested window end must be after start' USING ERRCODE = '23514';
  END IF;

  v_origin_address := COALESCE(v_input->'origin_address', '{}'::jsonb);
  IF jsonb_typeof(v_origin_address) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'create_pickup_request_v1 requires origin_address object' USING ERRCODE = '23514';
  END IF;

  IF v_tracking_number IS NULL THEN
    v_tracking_number := public.pickup_generate_tracking_number_v1(
      v_client_id,
      NULLIF(btrim(COALESCE(v_request_policy->>'tracking_prefix', '')), ''),
      v_idempotency_key
    );
  END IF;

  SELECT *
    INTO v_duplicate
    FROM public.resolve_shipment_create_duplicate_v1(
      v_client_id,
      v_tracking_number,
      v_client_reference_number
    )
   LIMIT 1;

  IF v_duplicate.shipment_id IS NOT NULL THEN
    SELECT s.id, s.origin_address_id
      INTO v_shipment_id, v_origin_address_id
      FROM public.shipments s
     WHERE s.id = v_duplicate.shipment_id
       AND s.client_id = v_client_id
       AND s.organization_id = v_org_id
     LIMIT 1;

    IF v_shipment_id IS NULL THEN
      RAISE EXCEPTION 'create_pickup_request_v1 duplicate resolved outside requested org/client scope' USING ERRCODE = '23514';
    END IF;

    RETURN jsonb_strip_nulls(jsonb_build_object(
      'shipment_id', v_shipment_id,
      'tracking_number', v_duplicate.tracking_number,
      'origin_address_id', v_origin_address_id,
      'created', FALSE,
      'operation', v_duplicate.operation,
      'matched_on', v_duplicate.matched_on
    ));
  END IF;

  INSERT INTO public.addresses (
    organization_id,
    client_id,
    raw_input,
    normalized_line1,
    normalized_line2,
    district,
    city,
    province,
    postal_code,
    country,
    building_number,
    additional_directions,
    validation_status
  ) VALUES (
    v_org_id,
    v_client_id,
    COALESCE(NULLIF(v_origin_address->>'raw_input', ''), v_origin_address::text),
    NULLIF(v_origin_address->>'line1', ''),
    NULLIF(v_origin_address->>'line2', ''),
    NULLIF(v_origin_address->>'district', ''),
    NULLIF(v_origin_address->>'city', ''),
    NULLIF(v_origin_address->>'province', ''),
    NULLIF(v_origin_address->>'postal_code', ''),
    NULLIF(v_origin_address->>'country', ''),
    NULLIF(v_origin_address->>'building_number', ''),
    NULLIF(v_origin_address->>'additional_directions', ''),
    v_validation_status
  )
  RETURNING id INTO v_origin_address_id;

  v_metadata := COALESCE(v_input->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  v_pickup_request := jsonb_strip_nulls(jsonb_build_object(
    'requested_window_start_at', v_requested_window_start_at,
    'requested_window_end_at', v_requested_window_end_at,
    'requested_by_user_id', v_user_id,
    'idempotency_key', v_idempotency_key,
    'origin_address_id', v_origin_address_id,
    'branch_id', v_branch_id
  ));

  INSERT INTO public.shipments (
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    carrier_reference_number,
    client_reference_number,
    box_count,
    status,
    origin_address_id,
    promised_window_start_at,
    promised_window_end_at,
    metadata
  ) VALUES (
    v_org_id,
    v_client_id,
    v_sender_id,
    'pickup',
    v_tracking_number,
    v_carrier_reference_number,
    v_client_reference_number,
    v_box_count,
    v_status,
    v_origin_address_id,
    v_requested_window_start_at,
    v_requested_window_end_at,
    public.jsonb_deep_merge(
      jsonb_build_object('pickup_request', v_pickup_request),
      v_metadata
    )
  )
  RETURNING id INTO v_shipment_id;

  v_reference_map := public.merge_shipment_reference_patch_v1(
    jsonb_strip_nulls(jsonb_build_object(
      'client_reference_number', v_client_reference_number,
      'carrier_reference_number', v_carrier_reference_number
    ))
  );

  IF jsonb_typeof(v_reference_map) = 'object'
     AND EXISTS (SELECT 1 FROM jsonb_each(v_reference_map)) THEN
    PERFORM public.sync_shipment_reference_numbers_v1(
      v_org_id,
      v_client_id,
      v_shipment_id,
      v_reference_map,
      'pickup_request',
      NULL,
      jsonb_build_object('source', 'create_pickup_request_v1')
    );
  END IF;

  v_action_id := workflow_handlers.record_shipment_action_v1(
    v_shipment_id,
    'pickup_request',
    'operational',
    jsonb_strip_nulls(jsonb_build_object(
      'origin_address_id', v_origin_address_id,
      'requested_window_start_at', v_requested_window_start_at,
      'requested_window_end_at', v_requested_window_end_at,
      'idempotency_key', v_idempotency_key
    )),
    NULL,
    v_status,
    'public.create_pickup_request_v1',
    NULL
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_shipment_id,
    'tracking_number', v_tracking_number,
    'origin_address_id', v_origin_address_id,
    'shipment_action_id', v_action_id,
    'created', TRUE,
    'operation', 'created'
  ));
END;
$function$;

COMMENT ON FUNCTION public.create_pickup_request_v1(JSONB)
  IS 'Create a pickup shipment request, materialize the pickup address, and record the request in shipment_actions. Duplicates are resolved only through the approved shipment-create keys.';
REVOKE ALL ON FUNCTION public.create_pickup_request_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_pickup_request_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_pickup_request_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_pickup_wave_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_user_id UUID := auth.uid();
  v_service_role BOOLEAN := public.request_is_service_role_v1();
  v_is_platform BOOLEAN := public.is_platform_user();

  v_org_id UUID := NULL;
  v_branch_id UUID := NULL;
  v_planned_date DATE := NULL;
  v_planned_start_at TIMESTAMPTZ := NULL;
  v_planned_end_at TIMESTAMPTZ := NULL;
  v_idempotency_key TEXT := NULL;
  v_metadata JSONB := '{}'::jsonb;

  v_policy_row RECORD;
  v_policy JSONB := public.pickup_policy_default_v1();
  v_wave_policy JSONB := '{}'::jsonb;
  v_allowed_statuses JSONB := '[]'::jsonb;
  v_new_status TEXT := 'pickup_scheduled';
  v_inline_budget_ms INT := 1500;
  v_inline_max_steps INT := 8;

  v_shipment_ids UUID[] := '{}'::uuid[];
  v_shipment_id UUID;
  v_item JSONB;
  v_ship_count INT := 0;
  v_missing_count INT := 0;
  v_invalid_count INT := 0;
  v_stop_exists_count INT := 0;
  v_existing_shipment_count INT := 0;
  v_existing_match_count INT := 0;

  v_workflow_template_id UUID := NULL;
  v_workflow_run_id UUID := NULL;
  v_progress JSONB := '{}'::jsonb;
  v_route_run_id UUID := NULL;
  v_stop_ids_json JSONB := '[]'::jsonb;
  v_route_run_created BOOLEAN := TRUE;
BEGIN
  IF jsonb_typeof(v_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'create_pickup_wave_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_org_id := NULLIF(v_input->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  BEGIN v_branch_id := NULLIF(v_input->>'branch_id', '')::uuid; EXCEPTION WHEN others THEN v_branch_id := NULL; END;
  BEGIN v_planned_date := NULLIF(v_input->>'planned_date', '')::date; EXCEPTION WHEN others THEN v_planned_date := NULL; END;
  BEGIN v_planned_start_at := NULLIF(v_input->>'planned_start_at', '')::timestamptz; EXCEPTION WHEN others THEN v_planned_start_at := NULL; END;
  BEGIN v_planned_end_at := NULLIF(v_input->>'planned_end_at', '')::timestamptz; EXCEPTION WHEN others THEN v_planned_end_at := NULL; END;
  v_idempotency_key := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_metadata := COALESCE(v_input->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'create_pickup_wave_v1 requires organization_id' USING ERRCODE = '23514';
  END IF;

  IF NOT v_service_role THEN
    IF v_user_id IS NULL THEN
      RAISE EXCEPTION 'create_pickup_wave_v1 requires an authenticated user' USING ERRCODE = '42501';
    END IF;
    IF NOT v_is_platform AND public.current_user_scope_type() IS DISTINCT FROM 'tenant' THEN
      RAISE EXCEPTION 'create_pickup_wave_v1 requires tenant/platform write scope' USING ERRCODE = '42501';
    END IF;
    IF NOT v_is_platform AND public.current_user_org_id() IS DISTINCT FROM v_org_id THEN
      RAISE EXCEPTION 'create_pickup_wave_v1 organization mismatch for current tenant scope' USING ERRCODE = '42501';
    END IF;
    IF NOT public.user_has_permission_v1('fleet.write', v_org_id) THEN
      RAISE EXCEPTION 'create_pickup_wave_v1 requires fleet.write permission' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF jsonb_typeof(v_input->'shipment_ids') = 'array' THEN
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_input->'shipment_ids') AS t(value)
    LOOP
      BEGIN
        IF jsonb_typeof(v_item) = 'string' THEN
          v_shipment_id := NULLIF(trim(both '"' FROM v_item::text), '')::uuid;
        ELSE
          v_shipment_id := NULLIF(v_item->>'shipment_id', '')::uuid;
        END IF;
      EXCEPTION WHEN others THEN
        v_shipment_id := NULL;
      END;

      IF v_shipment_id IS NULL THEN
        RAISE EXCEPTION 'create_pickup_wave_v1 shipment_ids must contain UUID values' USING ERRCODE = '23514';
      END IF;

      IF NOT (v_shipment_id = ANY(v_shipment_ids)) THEN
        v_shipment_ids := array_append(v_shipment_ids, v_shipment_id);
      END IF;
    END LOOP;
  END IF;

  IF COALESCE(array_length(v_shipment_ids, 1), 0) < 1 THEN
    RAISE EXCEPTION 'create_pickup_wave_v1 requires shipment_ids' USING ERRCODE = '23514';
  END IF;

  IF v_idempotency_key IS NULL THEN
    v_idempotency_key := encode(
      digest(
        format(
          '%s|%s|%s|%s|%s',
          v_org_id,
          COALESCE(v_branch_id::text, ''),
          array_to_string(ARRAY(SELECT x::text FROM unnest(v_shipment_ids) AS x ORDER BY x::text), ','),
          COALESCE(v_planned_start_at::text, ''),
          COALESCE(v_planned_end_at::text, '')
        ),
        'sha256'
      ),
      'hex'
    );
  END IF;

  BEGIN
    SELECT
      rr.id,
      NULLIF(rr.metadata #>> '{pickup_wave,workflow_run_id}', '')::uuid
      INTO v_route_run_id, v_workflow_run_id
      FROM public.route_runs rr
     WHERE rr.organization_id = v_org_id
       AND COALESCE(rr.metadata #>> '{pickup_wave,idempotency_key}', '') = v_idempotency_key
     ORDER BY rr.created_at DESC
     LIMIT 1;
  EXCEPTION WHEN others THEN
    v_route_run_id := NULL;
    v_workflow_run_id := NULL;
  END;

  IF v_route_run_id IS NULL THEN
    SELECT rs.route_run_id
      INTO v_route_run_id
      FROM public.route_stops rs
      JOIN public.route_runs rr
        ON rr.id = rs.route_run_id
       AND rr.organization_id = rs.organization_id
     WHERE rs.organization_id = v_org_id
       AND rs.shipment_id = ANY(v_shipment_ids)
       AND COALESCE(rs.metadata->>'pickup_wave_idempotency_key', '') = v_idempotency_key
     ORDER BY rr.created_at DESC, rs.sequence_order
     LIMIT 1;
  END IF;

  IF v_route_run_id IS NOT NULL THEN
    SELECT
      COUNT(*)::int,
      COUNT(*) FILTER (WHERE rs.shipment_id = ANY(v_shipment_ids))::int
      INTO v_existing_shipment_count, v_existing_match_count
      FROM public.route_stops rs
     WHERE rs.route_run_id = v_route_run_id
       AND rs.organization_id = v_org_id
       AND lower(rs.stop_kind) = 'pickup';

    IF v_existing_shipment_count <> array_length(v_shipment_ids, 1)
       OR v_existing_match_count <> array_length(v_shipment_ids, 1) THEN
      RAISE EXCEPTION 'create_pickup_wave_v1 idempotency_key reuse with different shipment set' USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(jsonb_agg(to_jsonb(rs.id) ORDER BY rs.sequence_order), '[]'::jsonb)
      INTO v_stop_ids_json
      FROM public.route_stops rs
     WHERE rs.route_run_id = v_route_run_id
       AND rs.organization_id = v_org_id
       AND lower(rs.stop_kind) = 'pickup';

    RETURN jsonb_strip_nulls(jsonb_build_object(
      'route_run_id', v_route_run_id,
      'workflow_run_id', v_workflow_run_id,
      'stop_ids', v_stop_ids_json,
      'shipment_ids', to_jsonb(v_shipment_ids),
      'shipment_count', array_length(v_shipment_ids, 1),
      'created', FALSE
    ));
  END IF;

  SELECT *
    INTO v_policy_row
    FROM public.resolve_pickup_policy(
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'resource_id', v_branch_id
      ))
    )
   LIMIT 1;

  IF v_policy_row.value IS NOT NULL THEN
    v_policy := v_policy_row.value;
  END IF;

  v_wave_policy := COALESCE(v_policy->'wave', '{}'::jsonb);
  IF jsonb_typeof(v_wave_policy) IS DISTINCT FROM 'object' THEN
    v_wave_policy := '{}'::jsonb;
  END IF;

  v_allowed_statuses := COALESCE(v_wave_policy->'allowed_shipment_statuses', jsonb_build_array('pickup_requested'));
  v_new_status := lower(COALESCE(NULLIF(btrim(COALESCE(v_wave_policy->>'shipment_status', '')), ''), 'pickup_scheduled'));
  BEGIN v_inline_budget_ms := COALESCE(NULLIF(v_wave_policy->>'inline_budget_ms', '')::int, 1500); EXCEPTION WHEN others THEN v_inline_budget_ms := 1500; END;
  BEGIN v_inline_max_steps := COALESCE(NULLIF(v_wave_policy->>'inline_max_steps', '')::int, 8); EXCEPTION WHEN others THEN v_inline_max_steps := 8; END;

  SELECT COUNT(*)
    INTO v_ship_count
    FROM public.shipments s
   WHERE s.id = ANY(v_shipment_ids)
     AND s.organization_id = v_org_id;

  IF v_ship_count <> array_length(v_shipment_ids, 1) THEN
    v_missing_count := array_length(v_shipment_ids, 1) - COALESCE(v_ship_count, 0);
    RAISE EXCEPTION 'create_pickup_wave_v1 shipment count mismatch (% missing)', v_missing_count USING ERRCODE = '23503';
  END IF;

  SELECT COUNT(*)
    INTO v_invalid_count
    FROM public.shipments s
   WHERE s.id = ANY(v_shipment_ids)
     AND s.organization_id = v_org_id
     AND (
       lower(COALESCE(s.service_type, '')) <> 'pickup'
       OR NOT workflow_handlers.shipment_status_allowed_v1(s.status, v_allowed_statuses)
     );

  IF v_invalid_count > 0 THEN
    RAISE EXCEPTION 'create_pickup_wave_v1 contains shipments outside pickup/allowed-status contract' USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*)
    INTO v_stop_exists_count
    FROM public.route_stops rs
    JOIN public.route_runs rr
      ON rr.id = rs.route_run_id
     AND rr.organization_id = rs.organization_id
   WHERE rs.organization_id = v_org_id
     AND rs.shipment_id = ANY(v_shipment_ids)
     AND lower(rs.stop_kind) = 'pickup'
     AND lower(COALESCE(rr.status, '')) IN ('planned', 'in_progress');

  IF v_stop_exists_count > 0 THEN
    RAISE EXCEPTION 'create_pickup_wave_v1 detected existing active pickup stop(s) for one or more shipments' USING ERRCODE = '23514';
  END IF;

  SELECT wt.id
    INTO v_workflow_template_id
    FROM public.workflow_templates wt
   WHERE wt.name = 'dispatch_route_run_v1'
     AND wt.status = 'active'
   ORDER BY wt.version DESC, wt.updated_at DESC NULLS LAST
   LIMIT 1;

  IF v_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'create_pickup_wave_v1 requires workflow template dispatch_route_run_v1';
  END IF;

  v_workflow_run_id := public.start_workflow_run(
    v_workflow_template_id,
    jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_org_id,
      'branch_id', v_branch_id,
      'planned_date', v_planned_date,
      'planned_start_at', v_planned_start_at,
      'planned_end_at', v_planned_end_at,
      'idempotency_key', format('pickup_wave:%s', v_idempotency_key),
      'stops', (
        SELECT jsonb_agg(
          jsonb_strip_nulls(jsonb_build_object(
            'client_id', s.client_id,
            'shipment_id', s.id,
            'stop_kind', 'pickup',
            'planned_window_start_at', COALESCE(s.promised_window_start_at, v_planned_start_at),
            'planned_window_end_at', COALESCE(s.promised_window_end_at, v_planned_end_at),
            'metadata', jsonb_strip_nulls(jsonb_build_object(
              'pickup_wave_idempotency_key', v_idempotency_key,
              'requested_status', s.status
            ))
          ))
          ORDER BY COALESCE(s.promised_window_start_at, v_planned_start_at, s.created_at), s.created_at, s.id
        )
        FROM public.shipments s
        WHERE s.id = ANY(v_shipment_ids)
      )
    ))
  );

  v_progress := public.progress_workflow_run_until_wait_v1(
    v_workflow_run_id,
    jsonb_build_object('source', 'create_pickup_wave_v1'),
    v_inline_budget_ms,
    v_inline_max_steps
  );

  IF lower(COALESCE(v_progress->>'status', '')) = 'failed' THEN
    RAISE EXCEPTION 'create_pickup_wave_v1 workflow failed: %', COALESCE(v_progress->>'error', 'workflow_failed');
  END IF;

  SELECT
    NULLIF(wr.context #>> '{dispatch,route_run_id}', '')::uuid,
    COALESCE(wr.context #> '{dispatch,stop_ids}', '[]'::jsonb),
    COALESCE((wr.context #>> '{dispatch,created}')::boolean, TRUE)
    INTO v_route_run_id, v_stop_ids_json, v_route_run_created
    FROM public.workflow_runs wr
   WHERE wr.id = v_workflow_run_id
   LIMIT 1;

  IF v_route_run_id IS NULL THEN
    RAISE EXCEPTION 'create_pickup_wave_v1 did not materialize route_run_id';
  END IF;

  UPDATE public.route_runs rr
     SET metadata = public.jsonb_deep_merge(
           COALESCE(rr.metadata, '{}'::jsonb),
           jsonb_strip_nulls(jsonb_build_object(
             'pickup_wave', jsonb_build_object(
               'wave_kind', 'pickup',
               'shipment_ids', to_jsonb(v_shipment_ids),
               'shipment_count', array_length(v_shipment_ids, 1),
               'idempotency_key', v_idempotency_key,
               'workflow_run_id', v_workflow_run_id,
               'created_by_user_id', v_user_id
             ),
             'metadata', v_metadata
           ))
         ),
         updated_at = now()
   WHERE rr.id = v_route_run_id
     AND rr.organization_id = v_org_id;

  UPDATE public.shipments s
     SET status = v_new_status,
         status_updated_at = now(),
         updated_at = now()
   WHERE s.id = ANY(v_shipment_ids)
     AND s.organization_id = v_org_id;

  INSERT INTO public.shipment_actions (
    shipment_id,
    organization_id,
    client_id,
    action_type,
    action_category,
    canonical_status,
    performed_by_user_id,
    performed_by_system,
    action_data,
    timestamp
  )
  SELECT
    s.id,
    s.organization_id,
    s.client_id,
    'pickup_wave_create',
    'operational',
    v_new_status,
    v_user_id,
    'public.create_pickup_wave_v1',
    jsonb_strip_nulls(jsonb_build_object(
      'route_run_id', v_route_run_id,
      'workflow_run_id', v_workflow_run_id,
      'idempotency_key', v_idempotency_key
    )),
    now()
  FROM public.shipments s
  WHERE s.id = ANY(v_shipment_ids)
    AND s.organization_id = v_org_id;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'route_run_id', v_route_run_id,
    'workflow_run_id', v_workflow_run_id,
    'stop_ids', v_stop_ids_json,
    'shipment_ids', to_jsonb(v_shipment_ids),
    'shipment_count', array_length(v_shipment_ids, 1),
    'created', v_route_run_created
  ));
END;
$function$;

COMMENT ON FUNCTION public.create_pickup_wave_v1(JSONB)
  IS 'Group pickup shipments into an idempotent route-run workflow, reuse generic route/task orchestration, and project pickup_scheduled onto the grouped shipments.';
REVOKE ALL ON FUNCTION public.create_pickup_wave_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_pickup_wave_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_pickup_wave_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.assign_pickup_wave_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_user_id UUID := auth.uid();
  v_service_role BOOLEAN := public.request_is_service_role_v1();
  v_is_platform BOOLEAN := public.is_platform_user();

  v_route_run_id UUID := NULL;
  v_org_id UUID := NULL;
  v_driver_user_id UUID := NULL;
  v_vehicle_id UUID := NULL;
  v_idempotency_key TEXT := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_partner JSONB := COALESCE(v_input->'partner', '{}'::jsonb);
  v_metadata JSONB := COALESCE(v_input->'metadata', '{}'::jsonb);

  v_route_run RECORD;
  v_pickup_stop_count INT := 0;
  v_total_box_count INT := 0;

  v_policy_row RECORD;
  v_policy JSONB := public.pickup_policy_default_v1();
  v_assignment_policy JSONB := '{}'::jsonb;
  v_require_driver_or_partner BOOLEAN := TRUE;
  v_allow_partner_assignment BOOLEAN := TRUE;
  v_enforce_capacity BOOLEAN := FALSE;
  v_default_capacity_boxes INT := 100;

  v_partner_capacity_boxes INT := NULL;
  v_vehicle_capacity_boxes INT := NULL;
  v_driver_status TEXT := NULL;
  v_vehicle_status TEXT := NULL;
  v_assignment_mode TEXT := NULL;
  v_has_partner BOOLEAN := FALSE;
BEGIN
  IF jsonb_typeof(v_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'assign_pickup_wave_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_route_run_id := NULLIF(v_input->>'route_run_id', '')::uuid; EXCEPTION WHEN others THEN v_route_run_id := NULL; END;
  BEGIN v_org_id := NULLIF(v_input->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  BEGIN v_driver_user_id := NULLIF(v_input->>'driver_user_id', '')::uuid; EXCEPTION WHEN others THEN v_driver_user_id := NULL; END;
  BEGIN v_vehicle_id := NULLIF(v_input->>'vehicle_id', '')::uuid; EXCEPTION WHEN others THEN v_vehicle_id := NULL; END;

  IF jsonb_typeof(v_partner) IS DISTINCT FROM 'object' THEN
    v_partner := '{}'::jsonb;
  END IF;
  v_has_partner := EXISTS (SELECT 1 FROM jsonb_each(v_partner));
  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  IF v_route_run_id IS NULL THEN
    RAISE EXCEPTION 'assign_pickup_wave_v1 requires route_run_id' USING ERRCODE = '23514';
  END IF;

  SELECT rr.*
    INTO v_route_run
    FROM public.route_runs rr
   WHERE rr.id = v_route_run_id
   LIMIT 1;

  IF v_route_run.id IS NULL THEN
    RAISE EXCEPTION 'assign_pickup_wave_v1 route_run not found: %', v_route_run_id USING ERRCODE = '23503';
  END IF;

  v_org_id := COALESCE(v_org_id, v_route_run.organization_id);
  IF v_org_id IS DISTINCT FROM v_route_run.organization_id THEN
    RAISE EXCEPTION 'assign_pickup_wave_v1 organization mismatch for route_run %', v_route_run_id USING ERRCODE = '23514';
  END IF;

  IF NOT v_service_role THEN
    IF v_user_id IS NULL THEN
      RAISE EXCEPTION 'assign_pickup_wave_v1 requires an authenticated user' USING ERRCODE = '42501';
    END IF;
    IF NOT v_is_platform AND public.current_user_scope_type() IS DISTINCT FROM 'tenant' THEN
      RAISE EXCEPTION 'assign_pickup_wave_v1 requires tenant/platform write scope' USING ERRCODE = '42501';
    END IF;
    IF NOT v_is_platform AND public.current_user_org_id() IS DISTINCT FROM v_org_id THEN
      RAISE EXCEPTION 'assign_pickup_wave_v1 organization mismatch for current tenant scope' USING ERRCODE = '42501';
    END IF;
    IF NOT public.user_has_permission_v1('fleet.write', v_org_id) THEN
      RAISE EXCEPTION 'assign_pickup_wave_v1 requires fleet.write permission' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT COUNT(*), COALESCE(SUM(s.box_count), 0)
    INTO v_pickup_stop_count, v_total_box_count
    FROM public.route_stops rs
    JOIN public.shipments s
      ON s.id = rs.shipment_id
     AND s.client_id = rs.client_id
   WHERE rs.route_run_id = v_route_run_id
     AND rs.organization_id = v_org_id
     AND lower(rs.stop_kind) = 'pickup';

  IF v_pickup_stop_count < 1 THEN
    RAISE EXCEPTION 'assign_pickup_wave_v1 route_run % is not a pickup wave', v_route_run_id USING ERRCODE = '23514';
  END IF;

  IF lower(COALESCE(v_route_run.status, '')) IN ('completed', 'canceled') THEN
    RAISE EXCEPTION 'assign_pickup_wave_v1 cannot assign terminal route_run status %', v_route_run.status USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_policy_row
    FROM public.resolve_pickup_policy(
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'resource_id', v_route_run.branch_id
      ))
    )
   LIMIT 1;

  IF v_policy_row.value IS NOT NULL THEN
    v_policy := v_policy_row.value;
  END IF;

  v_assignment_policy := COALESCE(v_policy->'assignment', '{}'::jsonb);
  IF jsonb_typeof(v_assignment_policy) IS DISTINCT FROM 'object' THEN
    v_assignment_policy := '{}'::jsonb;
  END IF;

  BEGIN v_require_driver_or_partner := COALESCE((v_assignment_policy->>'require_driver_or_partner')::boolean, TRUE); EXCEPTION WHEN others THEN v_require_driver_or_partner := TRUE; END;
  BEGIN v_allow_partner_assignment := COALESCE((v_assignment_policy->>'allow_partner_assignment')::boolean, TRUE); EXCEPTION WHEN others THEN v_allow_partner_assignment := TRUE; END;
  BEGIN v_enforce_capacity := COALESCE((v_assignment_policy->>'enforce_capacity')::boolean, FALSE); EXCEPTION WHEN others THEN v_enforce_capacity := FALSE; END;
  BEGIN v_default_capacity_boxes := COALESCE(NULLIF(v_assignment_policy->>'default_capacity_boxes', '')::int, 100); EXCEPTION WHEN others THEN v_default_capacity_boxes := 100; END;

  IF v_driver_user_id IS NOT NULL AND v_has_partner THEN
    RAISE EXCEPTION 'assign_pickup_wave_v1 supports either internal driver assignment or partner assignment, not both' USING ERRCODE = '23514';
  END IF;

  IF v_driver_user_id IS NULL AND NOT v_has_partner AND v_require_driver_or_partner THEN
    RAISE EXCEPTION 'assign_pickup_wave_v1 requires driver_user_id or partner assignment' USING ERRCODE = '23514';
  END IF;

  IF v_has_partner THEN
    IF NOT v_allow_partner_assignment THEN
      RAISE EXCEPTION 'assign_pickup_wave_v1 partner assignment is disabled by policy' USING ERRCODE = '42501';
    END IF;
    IF NULLIF(btrim(COALESCE(v_partner->>'partner_name', v_partner->>'name', '')), '') IS NULL
       AND NULLIF(btrim(COALESCE(v_partner->>'partner_id', '')), '') IS NULL THEN
      RAISE EXCEPTION 'assign_pickup_wave_v1 partner assignment requires partner_id or partner_name' USING ERRCODE = '23514';
    END IF;
    BEGIN v_partner_capacity_boxes := COALESCE(NULLIF(v_partner->>'capacity_boxes', '')::int, NULLIF(v_partner#>>'{capacity,boxes}', '')::int); EXCEPTION WHEN others THEN v_partner_capacity_boxes := NULL; END;
    v_assignment_mode := 'partner';
  ELSE
    IF v_driver_user_id IS NOT NULL THEN
      SELECT lower(COALESCE(u.status, ''))
        INTO v_driver_status
        FROM public.users u
       WHERE u.id = v_driver_user_id
         AND u.organization_id = v_org_id
       LIMIT 1;

      IF v_driver_status IS NULL THEN
        RAISE EXCEPTION 'assign_pickup_wave_v1 driver not found: %', v_driver_user_id USING ERRCODE = '23503';
      END IF;
      IF v_driver_status <> 'active' THEN
        RAISE EXCEPTION 'assign_pickup_wave_v1 driver is not active: %', v_driver_status USING ERRCODE = '23514';
      END IF;
    END IF;

    IF v_vehicle_id IS NOT NULL THEN
      SELECT
        lower(COALESCE(v.status, '')),
        COALESCE(
          CASE WHEN v.metadata ? 'capacity_boxes' THEN NULLIF(v.metadata->>'capacity_boxes', '')::int ELSE NULL END,
          CASE WHEN v.metadata #> '{capacity,boxes}' IS NOT NULL THEN NULLIF(v.metadata#>>'{capacity,boxes}', '')::int ELSE NULL END,
          CASE WHEN vt.metadata ? 'capacity_boxes' THEN NULLIF(vt.metadata->>'capacity_boxes', '')::int ELSE NULL END,
          CASE WHEN vt.metadata #> '{capacity,boxes}' IS NOT NULL THEN NULLIF(vt.metadata#>>'{capacity,boxes}', '')::int ELSE NULL END,
          v_default_capacity_boxes
        )
        INTO v_vehicle_status, v_vehicle_capacity_boxes
        FROM public.vehicles v
        LEFT JOIN public.vehicle_types vt
          ON vt.id = v.vehicle_type_id
       WHERE v.id = v_vehicle_id
         AND v.organization_id = v_org_id
       LIMIT 1;

      IF v_vehicle_status IS NULL THEN
        RAISE EXCEPTION 'assign_pickup_wave_v1 vehicle not found: %', v_vehicle_id USING ERRCODE = '23503';
      END IF;
      IF v_vehicle_status <> 'active' THEN
        RAISE EXCEPTION 'assign_pickup_wave_v1 vehicle is not active: %', v_vehicle_status USING ERRCODE = '23514';
      END IF;
    END IF;

    v_assignment_mode := CASE
      WHEN v_driver_user_id IS NOT NULL THEN 'internal_driver'
      ELSE 'unassigned'
    END;
  END IF;

  IF v_enforce_capacity THEN
    IF v_assignment_mode = 'partner' AND v_partner_capacity_boxes IS NOT NULL AND v_total_box_count > v_partner_capacity_boxes THEN
      RAISE EXCEPTION 'assign_pickup_wave_v1 partner capacity exceeded (% boxes > % capacity)', v_total_box_count, v_partner_capacity_boxes USING ERRCODE = '23514';
    END IF;
    IF v_assignment_mode <> 'partner'
       AND v_vehicle_id IS NOT NULL
       AND COALESCE(v_vehicle_capacity_boxes, v_default_capacity_boxes) IS NOT NULL
       AND v_total_box_count > COALESCE(v_vehicle_capacity_boxes, v_default_capacity_boxes) THEN
      RAISE EXCEPTION 'assign_pickup_wave_v1 vehicle capacity exceeded (% boxes > % capacity)', v_total_box_count, COALESCE(v_vehicle_capacity_boxes, v_default_capacity_boxes) USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_idempotency_key IS NOT NULL
     AND COALESCE(v_route_run.metadata #>> '{pickup_assignment,idempotency_key}', '') = v_idempotency_key THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'route_run_id', v_route_run_id,
      'assignment_mode', COALESCE(v_route_run.metadata #>> '{pickup_assignment,assignment_mode}', v_assignment_mode),
      'driver_user_id', v_route_run.driver_user_id,
      'vehicle_id', v_route_run.vehicle_id,
      'partner', v_route_run.metadata #> '{pickup_assignment,partner}',
      'box_count', v_total_box_count,
      'created', FALSE
    ));
  END IF;

  UPDATE public.route_runs rr
     SET driver_user_id = CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_driver_user_id END,
         vehicle_id = CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_vehicle_id END,
         metadata = public.jsonb_deep_merge(
           COALESCE(rr.metadata, '{}'::jsonb),
           jsonb_strip_nulls(jsonb_build_object(
             'pickup_assignment', jsonb_strip_nulls(jsonb_build_object(
               'assignment_mode', v_assignment_mode,
               'driver_user_id', CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_driver_user_id END,
               'vehicle_id', CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_vehicle_id END,
               'partner', CASE WHEN v_assignment_mode = 'partner' THEN v_partner ELSE NULL END,
               'box_count', v_total_box_count,
               'idempotency_key', v_idempotency_key,
               'assigned_by_user_id', v_user_id,
               'assigned_at', now()
             )),
             'metadata', v_metadata
           ))
         ),
         updated_at = now()
   WHERE rr.id = v_route_run_id
     AND rr.organization_id = v_org_id;

  UPDATE public.shipments s
     SET driver_user_id = CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_driver_user_id END,
         updated_at = now(),
         metadata = public.jsonb_deep_merge(
           COALESCE(s.metadata, '{}'::jsonb),
           jsonb_strip_nulls(jsonb_build_object(
             'pickup_assignment', jsonb_strip_nulls(jsonb_build_object(
               'route_run_id', v_route_run_id,
               'assignment_mode', v_assignment_mode,
               'partner', CASE WHEN v_assignment_mode = 'partner' THEN v_partner ELSE NULL END
             ))
           ))
         )
   WHERE EXISTS (
     SELECT 1
     FROM public.route_stops rs
     WHERE rs.route_run_id = v_route_run_id
       AND rs.organization_id = v_org_id
       AND rs.shipment_id = s.id
       AND rs.client_id = s.client_id
       AND lower(rs.stop_kind) = 'pickup'
   );

  INSERT INTO public.shipment_actions (
    shipment_id,
    organization_id,
    client_id,
    action_type,
    action_category,
    canonical_status,
    performed_by_user_id,
    performed_by_system,
    action_data,
    timestamp
  )
  SELECT
    s.id,
    s.organization_id,
    s.client_id,
    'pickup_wave_assign',
    'operational',
    s.status,
    v_user_id,
    'public.assign_pickup_wave_v1',
    jsonb_strip_nulls(jsonb_build_object(
      'route_run_id', v_route_run_id,
      'assignment_mode', v_assignment_mode,
      'driver_user_id', CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_driver_user_id END,
      'vehicle_id', CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_vehicle_id END,
      'partner', CASE WHEN v_assignment_mode = 'partner' THEN v_partner ELSE NULL END,
      'idempotency_key', v_idempotency_key
    )),
    now()
  FROM public.shipments s
  WHERE EXISTS (
    SELECT 1
    FROM public.route_stops rs
    WHERE rs.route_run_id = v_route_run_id
      AND rs.organization_id = v_org_id
      AND rs.shipment_id = s.id
      AND rs.client_id = s.client_id
      AND lower(rs.stop_kind) = 'pickup'
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'route_run_id', v_route_run_id,
    'assignment_mode', v_assignment_mode,
    'driver_user_id', CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_driver_user_id END,
    'vehicle_id', CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_vehicle_id END,
    'partner', CASE WHEN v_assignment_mode = 'partner' THEN v_partner ELSE NULL END,
    'box_count', v_total_box_count,
    'created', TRUE
  ));
END;
$function$;

COMMENT ON FUNCTION public.assign_pickup_wave_v1(JSONB)
  IS 'Assign a pickup wave to an internal driver/vehicle or an external partner while keeping assignment metadata and shipment audit rows in sync.';
REVOKE ALL ON FUNCTION public.assign_pickup_wave_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_pickup_wave_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.assign_pickup_wave_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 6) Pickup operational views for Portal / Console / reporting
-------------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.pickup_requests
WITH (security_invoker = true) AS
WITH latest_pickup_stop AS (
  SELECT DISTINCT ON (rs.shipment_id, rs.client_id)
    rs.shipment_id,
    rs.client_id,
    rs.id AS route_stop_id,
    rs.route_run_id,
    rs.sequence_order,
    rs.planned_window_start_at,
    rs.planned_window_end_at,
    rr.status AS route_run_status,
    rr.planned_date,
    rr.planned_start_at,
    rr.planned_end_at,
    rr.driver_user_id,
    rr.vehicle_id,
    rr.metadata -> 'pickup_assignment' AS pickup_assignment
  FROM public.route_stops rs
  JOIN public.route_runs rr
    ON rr.id = rs.route_run_id
   AND rr.organization_id = rs.organization_id
  WHERE lower(rs.stop_kind) = 'pickup'
  ORDER BY rs.shipment_id, rs.client_id, COALESCE(rr.planned_start_at, rr.created_at) DESC, rs.sequence_order
),
latest_exception AS (
  SELECT DISTINCT ON (sa.shipment_id)
    sa.shipment_id,
    sa.timestamp AS failed_at,
    COALESCE(sa.action_data #>> '{task_event_payload,status_reason}', sa.action_data->>'status_reason') AS failure_reason,
    sa.action_data AS failure_action_data
  FROM public.shipment_actions sa
  WHERE lower(COALESCE(sa.action_category, '')) = 'exception'
  ORDER BY sa.shipment_id, sa.timestamp DESC, sa.created_at DESC
)
SELECT
  s.organization_id,
  s.client_id,
  s.sender_id,
  s.id AS shipment_id,
  s.tracking_number,
  s.client_reference_number,
  s.carrier_reference_number,
  s.status,
  s.box_count,
  s.promised_window_start_at AS requested_window_start_at,
  s.promised_window_end_at AS requested_window_end_at,
  s.origin_address_id,
  a.normalized_line1 AS origin_line1,
  a.normalized_line2 AS origin_line2,
  a.city AS origin_city,
  a.province AS origin_province,
  a.country AS origin_country,
  a.additional_directions AS origin_additional_directions,
  lps.route_stop_id,
  lps.route_run_id,
  lps.sequence_order,
  lps.route_run_status,
  lps.planned_date,
  lps.planned_start_at,
  lps.planned_end_at,
  lps.driver_user_id,
  lps.vehicle_id,
  lps.pickup_assignment,
  le.failed_at,
  le.failure_reason,
  le.failure_action_data,
  s.metadata -> 'pickup_request' AS pickup_request
FROM public.shipments s
LEFT JOIN public.addresses a
  ON a.id = s.origin_address_id
 AND a.client_id = s.client_id
LEFT JOIN latest_pickup_stop lps
  ON lps.shipment_id = s.id
 AND lps.client_id = s.client_id
LEFT JOIN latest_exception le
  ON le.shipment_id = s.id
WHERE lower(COALESCE(s.service_type, '')) = 'pickup';

CREATE OR REPLACE VIEW public.pickup_waves
WITH (security_invoker = true) AS
SELECT
  rr.organization_id,
  rr.branch_id,
  rr.id AS route_run_id,
  rr.status,
  rr.planned_date,
  rr.planned_start_at,
  rr.planned_end_at,
  rr.started_at,
  rr.ended_at,
  rr.driver_user_id,
  rr.vehicle_id,
  rr.metadata -> 'pickup_wave' AS pickup_wave,
  rr.metadata -> 'pickup_assignment' AS pickup_assignment,
  COUNT(*) FILTER (WHERE lower(rs.stop_kind) = 'pickup') AS pickup_stop_count,
  COALESCE(SUM(s.box_count) FILTER (WHERE lower(rs.stop_kind) = 'pickup'), 0) AS total_box_count,
  jsonb_agg(
    jsonb_strip_nulls(jsonb_build_object(
      'shipment_id', s.id,
      'client_id', s.client_id,
      'tracking_number', s.tracking_number,
      'status', s.status,
      'sequence_order', rs.sequence_order
    ))
    ORDER BY rs.sequence_order
  ) FILTER (WHERE rs.id IS NOT NULL) AS shipments
FROM public.route_runs rr
JOIN public.route_stops rs
  ON rs.route_run_id = rr.id
 AND rs.organization_id = rr.organization_id
JOIN public.shipments s
  ON s.id = rs.shipment_id
 AND s.client_id = rs.client_id
WHERE lower(rs.stop_kind) = 'pickup'
GROUP BY
  rr.organization_id,
  rr.branch_id,
  rr.id,
  rr.status,
  rr.planned_date,
  rr.planned_start_at,
  rr.planned_end_at,
  rr.started_at,
  rr.ended_at,
  rr.driver_user_id,
  rr.vehicle_id,
  rr.metadata;

CREATE OR REPLACE VIEW public.pickup_failures
WITH (security_invoker = true) AS
WITH followup_tasks AS (
  SELECT
    t.organization_id,
    t.resource_id AS shipment_id,
    jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'task_id', t.id,
        'task_type_key', tt.key,
        'status', t.status,
        'queue_key', t.queue_key,
        'priority', t.priority,
        'created_at', t.created_at
      ))
      ORDER BY t.created_at DESC
    ) AS tasks
  FROM public.tasks t
  JOIN public.task_types tt
    ON tt.id = t.task_type_id
  WHERE lower(COALESCE(t.resource_type, '')) = 'shipment'
    AND lower(COALESCE(tt.key, '')) IN ('dispatch_reschedule_pickup', 'dispatch_pickup_escalation_review')
  GROUP BY t.organization_id, t.resource_id
),
latest_exception AS (
  SELECT DISTINCT ON (sa.shipment_id)
    sa.shipment_id,
    sa.timestamp AS failed_at,
    COALESCE(sa.action_data #>> '{task_event_payload,status_reason}', sa.action_data->>'status_reason') AS failure_reason,
    sa.action_data AS failure_action_data
  FROM public.shipment_actions sa
  WHERE lower(COALESCE(sa.action_category, '')) = 'exception'
  ORDER BY sa.shipment_id, sa.timestamp DESC, sa.created_at DESC
)
SELECT
  s.organization_id,
  s.client_id,
  s.sender_id,
  s.id AS shipment_id,
  s.tracking_number,
  s.status,
  le.failed_at,
  le.failure_reason,
  le.failure_action_data,
  ft.tasks AS followup_tasks,
  s.metadata -> 'pickup_request' AS pickup_request
FROM public.shipments s
LEFT JOIN latest_exception le
  ON le.shipment_id = s.id
LEFT JOIN followup_tasks ft
  ON ft.organization_id = s.organization_id
 AND ft.shipment_id = s.id
WHERE lower(COALESCE(s.service_type, '')) = 'pickup'
  AND (
    lower(COALESCE(s.status, '')) = 'pickup_failed'
    OR ft.tasks IS NOT NULL
  );

COMMENT ON VIEW public.pickup_requests
  IS 'Pickup shipment request projection with latest wave and failure context for Console/Portal operations.';
COMMENT ON VIEW public.pickup_waves
  IS 'Pickup route-run projection with aggregated shipment and assignment context.';
COMMENT ON VIEW public.pickup_failures
  IS 'Pickup failure projection with latest failure reason and open follow-up tasks.';

REVOKE ALL ON public.pickup_requests FROM PUBLIC;
REVOKE ALL ON public.pickup_requests FROM anon;
GRANT SELECT ON public.pickup_requests TO authenticated, service_role;

REVOKE ALL ON public.pickup_waves FROM PUBLIC;
REVOKE ALL ON public.pickup_waves FROM anon;
GRANT SELECT ON public.pickup_waves TO authenticated, service_role;

REVOKE ALL ON public.pickup_failures FROM PUBLIC;
REVOKE ALL ON public.pickup_failures FROM anon;
GRANT SELECT ON public.pickup_failures TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603191130_pickup_batch2_foundation_v1'));
COMMIT;
