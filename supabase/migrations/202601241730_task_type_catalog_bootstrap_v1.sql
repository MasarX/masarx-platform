-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Task type catalog + auto-provisioning for system workflows
-- Date: 2026-01-24
--
-- Why:
--   - System workflows create tasks by `task_type_key`, but `task_types` is an org-scoped catalog and currently requires manual provisioning.
--   - Enterprise readiness requires row-driven defaults and zero manual setup for system-required task types.
--   - Introduce `task_type_catalog` as a settings category (ladder-resolved) and a service-only auto-provision hook used by `create_task_system_v1`.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601241730_task_type_catalog_bootstrap_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Settings category registry: task_type_catalog
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
VALUES (
  'task_type_catalog',
  'Default task_types templates for organization provisioning (row-driven; resolved via ladder).',
  TRUE,
  TRUE,
  FALSE,
  'hard_fail',
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
-- 2) Schema registry: task_type_catalog v1
-------------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'task_type_catalog',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'task_types', jsonb_build_object(
        'type', 'array',
        'items', jsonb_build_object(
          'type', 'object',
          'additionalProperties', TRUE,
          'properties', jsonb_build_object(
            'key', jsonb_build_object('type', 'string'),
            'name', jsonb_build_object('type', 'string'),
            'description', jsonb_build_object('type', 'string'),
            'default_priority', jsonb_build_object('type', 'integer', 'minimum', 0),
            'default_queue_key', jsonb_build_object('type', 'string'),
            'enabled', jsonb_build_object('type', 'boolean'),
            'metadata', jsonb_build_object('type', 'object', 'additionalProperties', TRUE)
          )
        )
      )
    )
  ),
  'Default task type templates. Used by service-only provisioning helpers to ensure required task_types exist per organization without hardcoding.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'task_types', jsonb_build_array(
        jsonb_build_object('key', 'route_stop_execute', 'name', 'Route Stop Execute', 'default_priority', 50, 'default_queue_key', 'default', 'enabled', TRUE),
        jsonb_build_object('key', 'dispatch_exception_review', 'name', 'Dispatch Exception Review', 'default_priority', 50, 'default_queue_key', 'default', 'enabled', TRUE),
        jsonb_build_object('key', 'cod_cash_handover', 'name', 'COD Cash Handover', 'default_priority', 50, 'default_queue_key', 'default', 'enabled', TRUE),
        jsonb_build_object('key', 'cod_cashier_count', 'name', 'COD Cashier Count', 'default_priority', 50, 'default_queue_key', 'default', 'enabled', TRUE),
        jsonb_build_object('key', 'cod_manager_approval', 'name', 'COD Manager Approval', 'default_priority', 50, 'default_queue_key', 'default', 'enabled', TRUE),
        jsonb_build_object('key', 'bank_deposit_slip_create', 'name', 'Bank Deposit Slip Create', 'default_priority', 50, 'default_queue_key', 'default', 'enabled', TRUE),
        jsonb_build_object('key', 'bank_deposit_bank_match', 'name', 'Bank Deposit Bank Match', 'default_priority', 50, 'default_queue_key', 'default', 'enabled', TRUE),
        jsonb_build_object('key', 'bank_deposit_manager_approval', 'name', 'Bank Deposit Manager Approval', 'default_priority', 50, 'default_queue_key', 'default', 'enabled', TRUE)
      )
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
-- 3) Seed global default: task_type_catalog (insert-only)
-------------------------------------------------------------------------------

WITH payload AS (
  SELECT jsonb_build_object(
    'version', 1,
    'task_types', jsonb_build_array(
      jsonb_build_object('key', 'route_stop_execute', 'name', 'Route Stop Execute', 'default_priority', 50, 'default_queue_key', 'default', 'enabled', TRUE),
      jsonb_build_object('key', 'dispatch_exception_review', 'name', 'Dispatch Exception Review', 'default_priority', 50, 'default_queue_key', 'default', 'enabled', TRUE),
      jsonb_build_object('key', 'cod_cash_handover', 'name', 'COD Cash Handover', 'default_priority', 50, 'default_queue_key', 'default', 'enabled', TRUE),
      jsonb_build_object('key', 'cod_cashier_count', 'name', 'COD Cashier Count', 'default_priority', 50, 'default_queue_key', 'default', 'enabled', TRUE),
      jsonb_build_object('key', 'cod_manager_approval', 'name', 'COD Manager Approval', 'default_priority', 50, 'default_queue_key', 'default', 'enabled', TRUE),
      jsonb_build_object('key', 'bank_deposit_slip_create', 'name', 'Bank Deposit Slip Create', 'default_priority', 50, 'default_queue_key', 'default', 'enabled', TRUE),
      jsonb_build_object('key', 'bank_deposit_bank_match', 'name', 'Bank Deposit Bank Match', 'default_priority', 50, 'default_queue_key', 'default', 'enabled', TRUE),
      jsonb_build_object('key', 'bank_deposit_manager_approval', 'name', 'Bank Deposit Manager Approval', 'default_priority', 50, 'default_queue_key', 'default', 'enabled', TRUE)
    )
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
    'task_type_catalog',
    'global',
    NULL::uuid,
    1,
    payload.value,
    1,
    'Seed global task_type_catalog',
    now(),
    now()
  FROM payload
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'task_type_catalog'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT
  'task_type_catalog',
  'global',
  NULL::uuid,
  inserted.id,
  inserted.value,
  now()
FROM inserted
ON CONFLICT (category, scope_type, scope_hash)
DO NOTHING;

-------------------------------------------------------------------------------
-- 4) Service-only helper: ensure_task_type_from_catalog_v1
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ensure_task_type_from_catalog_v1(
  p_organization_id UUID,
  p_task_type_key TEXT,
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := p_organization_id;
  v_key TEXT := lower(NULLIF(btrim(COALESCE(p_task_type_key, '')), ''));
  v_ctx JSONB := COALESCE(p_context, '{}'::jsonb);
  v_claims JSONB := NULL;
  v_role TEXT := NULL;

  v_existing_id UUID := NULL;

  v_row RECORD;
  v_catalog JSONB := '{}'::jsonb;
  v_items JSONB := '[]'::jsonb;
  v_item JSONB;

  v_item_key TEXT := NULL;
  v_name TEXT := NULL;
  v_description TEXT := NULL;
  v_default_priority INT := NULL;
  v_default_queue_key TEXT := NULL;
  v_enabled BOOLEAN := TRUE;
  v_metadata JSONB := '{}'::jsonb;
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;
  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF session_user IS DISTINCT FROM 'postgres'
     AND session_user IS DISTINCT FROM 'supabase_admin'
     AND v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'ensure_task_type_from_catalog_v1 requires service_role context';
  END IF;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ensure_task_type_from_catalog_v1 requires organization_id' USING ERRCODE = '23514';
  END IF;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'ensure_task_type_from_catalog_v1 requires task_type_key' USING ERRCODE = '23514';
  END IF;

  SELECT tt.id
    INTO v_existing_id
    FROM public.task_types tt
   WHERE tt.organization_id = v_org_id
     AND tt.key = v_key
   LIMIT 1;
  IF FOUND THEN
    RETURN v_existing_id;
  END IF;

  IF jsonb_typeof(v_ctx) <> 'object' THEN
    v_ctx := '{}'::jsonb;
  END IF;

  v_ctx := jsonb_strip_nulls(v_ctx || jsonb_build_object('organization_id', v_org_id));

  SELECT *
    INTO v_row
    FROM public.resolve_settings_row_from_policy_context_v1('task_type_catalog', v_ctx)
   LIMIT 1;

  v_catalog := COALESCE(v_row.value, '{}'::jsonb);
  IF jsonb_typeof(v_catalog) <> 'object' THEN
    v_catalog := '{}'::jsonb;
  END IF;

  v_items := COALESCE(v_catalog->'task_types', '[]'::jsonb);
  IF jsonb_typeof(v_items) <> 'array' THEN
    v_items := '[]'::jsonb;
  END IF;

  FOR v_item IN
    SELECT * FROM jsonb_array_elements(v_items)
  LOOP
    v_item_key := lower(NULLIF(btrim(COALESCE(v_item->>'key', '')), ''));
    IF v_item_key = v_key THEN
      v_name := NULLIF(btrim(COALESCE(v_item->>'name', '')), '');
      v_description := NULLIF(btrim(COALESCE(v_item->>'description', '')), '');
      BEGIN v_default_priority := NULLIF(v_item->>'default_priority', '')::int; EXCEPTION WHEN others THEN v_default_priority := NULL; END;
      v_default_queue_key := NULLIF(btrim(COALESCE(v_item->>'default_queue_key', '')), '');
      BEGIN v_enabled := COALESCE(NULLIF(v_item->>'enabled', '')::boolean, TRUE); EXCEPTION WHEN others THEN v_enabled := TRUE; END;
      v_metadata := COALESCE(v_item->'metadata', '{}'::jsonb);
      EXIT;
    END IF;
  END LOOP;

  IF v_name IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_default_priority IS NULL THEN
    v_default_priority := 50;
  END IF;
  IF jsonb_typeof(v_metadata) <> 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  INSERT INTO public.task_types (
    organization_id,
    key,
    name,
    description,
    default_priority,
    default_queue_key,
    enabled,
    metadata
  ) VALUES (
    v_org_id,
    v_key,
    v_name,
    v_description,
    v_default_priority,
    v_default_queue_key,
    v_enabled,
    v_metadata
  )
  ON CONFLICT (organization_id, key) DO NOTHING
  RETURNING id INTO v_existing_id;

  IF v_existing_id IS NULL THEN
    SELECT tt.id
      INTO v_existing_id
      FROM public.task_types tt
     WHERE tt.organization_id = v_org_id
       AND tt.key = v_key
     LIMIT 1;
  END IF;

  RETURN v_existing_id;
END;
$function$;

COMMENT ON FUNCTION public.ensure_task_type_from_catalog_v1(UUID, TEXT, JSONB)
  IS 'Service-only helper: ensure a task_types row exists for (org, key) by provisioning from resolved task_type_catalog settings. Insert-only (does not overwrite custom task_types).';

REVOKE ALL ON FUNCTION public.ensure_task_type_from_catalog_v1(UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_task_type_from_catalog_v1(UUID, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.ensure_task_type_from_catalog_v1(UUID, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_task_type_from_catalog_v1(UUID, TEXT, JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 5) Auto-provision hook: create_task_system_v1 ensures task_types from catalog
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_task_system_v1(
  p_payload JSONB
)
RETURNS TABLE (
  task_id UUID,
  task_event_id UUID,
  workflow_run_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_input JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_claims JSONB := NULL;
  v_role TEXT := NULL;

  v_task_type_key TEXT := NULL;
  v_context JSONB := '{}'::jsonb;
  v_resource_type TEXT := NULL;
  v_resource_id UUID := NULL;
  v_queue_key TEXT := NULL;
  v_priority INT := NULL;
  v_sla_minutes INT := NULL;
  v_idempotency_key TEXT := NULL;
  v_metadata JSONB := '{}'::jsonb;
  v_actor_system TEXT := NULL;

  v_prev_actor_system TEXT := COALESCE(current_setting('app.actor_system', true), '');
  v_org_id UUID := NULL;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'create_task_system_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;
  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF session_user IS DISTINCT FROM 'postgres'
     AND session_user IS DISTINCT FROM 'supabase_admin'
     AND v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'create_task_system_v1 requires service_role context';
  END IF;

  v_task_type_key := lower(NULLIF(btrim(COALESCE(v_input->>'task_type_key', '')), ''));
  IF v_task_type_key IS NULL THEN
    RAISE EXCEPTION 'create_task_system_v1 requires task_type_key' USING ERRCODE = '23514';
  END IF;

  v_context := COALESCE(v_input->'context', '{}'::jsonb);
  v_resource_type := NULLIF(btrim(COALESCE(v_input->>'resource_type', '')), '');
  BEGIN v_resource_id := NULLIF(v_input->>'resource_id', '')::uuid; EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  v_queue_key := NULLIF(btrim(COALESCE(v_input->>'queue_key', '')), '');
  BEGIN v_priority := NULLIF(v_input->>'priority', '')::int; EXCEPTION WHEN others THEN v_priority := NULL; END;
  BEGIN v_sla_minutes := NULLIF(v_input->>'sla_minutes', '')::int; EXCEPTION WHEN others THEN v_sla_minutes := NULL; END;
  v_idempotency_key := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_metadata := COALESCE(v_input->'metadata', '{}'::jsonb);
  v_actor_system := NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), '');

  -- Ensure the task_type exists for the target organization (insert-only) using row-driven task_type_catalog.
  BEGIN v_org_id := NULLIF(v_context->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  IF v_org_id IS NOT NULL THEN
    PERFORM public.ensure_task_type_from_catalog_v1(v_org_id, v_task_type_key, v_context);
  END IF;

  PERFORM set_config('app.actor_system', COALESCE(v_actor_system, ''), true);
  BEGIN
    RETURN QUERY
    SELECT *
    FROM public.create_task_v1(
      v_task_type_key,
      v_context,
      v_resource_type,
      v_resource_id,
      v_queue_key,
      v_priority,
      v_sla_minutes,
      v_idempotency_key,
      v_metadata
    );
  EXCEPTION
    WHEN others THEN
      PERFORM set_config('app.actor_system', v_prev_actor_system, true);
      RAISE;
  END;

  PERFORM set_config('app.actor_system', v_prev_actor_system, true);
END;
$$;

COMMENT ON FUNCTION public.create_task_system_v1(JSONB)
  IS 'Service-only wrapper to create a task via create_task_v1, optionally setting actor_system for the task_events ledger. Ensures task_types exist via row-driven task_type_catalog (insert-only).';

REVOKE ALL ON FUNCTION public.create_task_system_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_task_system_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.create_task_system_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_task_system_v1(JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202601241730_task_type_catalog_bootstrap_v1'));
COMMIT;

