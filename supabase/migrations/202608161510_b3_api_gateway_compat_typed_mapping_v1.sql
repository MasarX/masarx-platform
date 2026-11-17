-- API Gateway compatibility route mapping and typed mutation guard.
-- Keeps /api provider-mirror traffic workflow-engine-first, applies only
-- route-bound Mapping Studio profiles, and preserves original redacted readback.

BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

SELECT pg_advisory_lock(hashtext('202607151330_api_gateway_compat_typed_mapping_v1'));

-------------------------------------------------------------------------------
-- Row-driven mapping taxonomy
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable
)
VALUES (
  'mapping_type',
  'Mapping artifact type taxonomy for Mapping Studio.',
  'engineering',
  'tier_2',
  TRUE
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable,
    updated_at = now();

WITH definition AS (
  SELECT id
  FROM public.lookup_definitions
  WHERE category = 'mapping_type'
  LIMIT 1
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  definition.id,
  'api_gateway_inbound',
  'API Gateway inbound',
  'Tenant-scoped API Gateway request mapping before workflow/provider dispatch.',
  70,
  FALSE,
  'active',
  jsonb_build_object(
    'target_family', 'external_intake',
    'artifact', 'api_gateway_request_mapping'
  )
FROM definition
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    status = 'active',
    metadata = public.deep_merge_jsonb(
      COALESCE(public.lookup_values.metadata, '{}'::jsonb),
      EXCLUDED.metadata
    ),
    updated_at = now();

WITH target_rows(value) AS (
  VALUES
    ('shipments.create'),
    ('shipments.update'),
    ('shipments.update_status'),
    ('shipment.delete'),
    ('shipments.cancel'),
    ('shipments.reschedule')
)
UPDATE public.lookup_values lv
SET metadata = jsonb_set(
      COALESCE(lv.metadata, '{}'::jsonb),
      '{allowed_mapping_types}',
      (
        SELECT jsonb_agg(item ORDER BY item)
        FROM (
          SELECT DISTINCT item
          FROM (
            SELECT jsonb_array_elements_text(
              COALESCE(lv.metadata->'allowed_mapping_types', '[]'::jsonb)
            ) AS item
            UNION ALL
            SELECT 'api_gateway_inbound'
          ) allowed
        ) deduped
      ),
      TRUE
    ),
    updated_at = now()
FROM target_rows, public.lookup_definitions ld
WHERE ld.id = lv.lookup_definition_id
  AND ld.category = 'mapping_target'
  AND lv.value = target_rows.value;

-------------------------------------------------------------------------------
-- Canonical intent and mapping compatibility
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_gateway_mapping_target_intent_v1(p_target TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT CASE lower(NULLIF(btrim(COALESCE(p_target, '')), ''))
    WHEN 'shipments.create' THEN 'shipment.create'
    WHEN 'shipment.create' THEN 'shipment.create'
    WHEN 'shipment_create' THEN 'shipment.create'
    WHEN 'shipments.update' THEN 'shipment.update'
    WHEN 'shipment.update' THEN 'shipment.update'
    WHEN 'shipment_update' THEN 'shipment.update'
    WHEN 'shipments.update_status' THEN 'update.status'
    WHEN 'shipments.update.status' THEN 'update.status'
    WHEN 'shipment.update_status' THEN 'update.status'
    WHEN 'shipment.update.status' THEN 'update.status'
    WHEN 'update.status' THEN 'update.status'
    WHEN 'shipments.cancel' THEN 'shipment.delete'
    WHEN 'shipments.canceled' THEN 'shipment.delete'
    WHEN 'shipments.cancelled' THEN 'shipment.delete'
    WHEN 'shipments.delete' THEN 'shipment.delete'
    WHEN 'shipment.cancel' THEN 'shipment.delete'
    WHEN 'shipment.canceled' THEN 'shipment.delete'
    WHEN 'shipment.cancelled' THEN 'shipment.delete'
    WHEN 'shipment.delete' THEN 'shipment.delete'
    WHEN 'shipment_delete' THEN 'shipment.delete'
    WHEN 'shipments.reschedule' THEN 'shipment.reschedule'
    WHEN 'shipments.rescheduled' THEN 'shipment.reschedule'
    WHEN 'shipment.reschedule' THEN 'shipment.reschedule'
    WHEN 'shipment.rescheduled' THEN 'shipment.reschedule'
    WHEN 'shipment_reschedule' THEN 'shipment.reschedule'
    ELSE COALESCE(lower(NULLIF(btrim(COALESCE(p_target, '')), '')), '')
  END;
$function$;

CREATE OR REPLACE FUNCTION public.api_gateway_mapping_intents_compatible_v1(
  p_route_intent TEXT,
  p_mapping_intent TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT CASE
    WHEN NULLIF(btrim(COALESCE(p_route_intent, '')), '') IS NULL THEN FALSE
    WHEN NULLIF(btrim(COALESCE(p_mapping_intent, '')), '') IS NULL THEN FALSE
    WHEN lower(p_route_intent) = lower(p_mapping_intent) THEN TRUE
    WHEN lower(p_route_intent) = 'shipment.update'
      AND lower(p_mapping_intent) LIKE 'update.%' THEN TRUE
    ELSE FALSE
  END;
$function$;

-------------------------------------------------------------------------------
-- Route-bound mapping resolution and application
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_gateway_route_request_mapping_v1(
  p_route public.api_routes,
  p_organization_id UUID DEFAULT NULL,
  p_client_id UUID DEFAULT NULL,
  p_sender_id UUID DEFAULT NULL,
  p_source_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB := COALESCE(p_route.policy, '{}'::jsonb);
  v_mapping_ref JSONB;
  v_mapping_id UUID;
  v_mapping_key TEXT;
  v_mapping_type TEXT;
  v_mapping_row public.mapping_configs%ROWTYPE;
  v_mapping_config JSONB;
  v_target TEXT;
  v_route_intent TEXT;
  v_mapping_intent TEXT;
BEGIN
  v_mapping_ref := COALESCE(
    v_policy->'request_mapping',
    v_policy #> '{mapping_studio,request_mapping}',
    v_policy #> '{mapping_studio,request_config,request_mapping}',
    '{}'::jsonb
  );
  v_mapping_id := COALESCE(
    public.mapping_studio_try_uuid_v1(v_mapping_ref->>'mapping_config_id'),
    public.mapping_studio_try_uuid_v1(v_policy #>> '{request_mapping,mapping_config_id}'),
    public.mapping_studio_try_uuid_v1(v_policy #>> '{mapping_studio,request_mapping_config_id}')
  );
  v_mapping_key := COALESCE(
    NULLIF(btrim(v_mapping_ref->>'mapping_key'), ''),
    NULLIF(btrim(v_policy #>> '{request_mapping,mapping_key}'), ''),
    NULLIF(btrim(v_policy #>> '{mapping_studio,request_mapping_key}'), '')
  );
  v_mapping_type := COALESCE(
    NULLIF(btrim(v_mapping_ref->>'mapping_type'), ''),
    NULLIF(btrim(v_policy #>> '{request_mapping,mapping_type}'), ''),
    'api_gateway_inbound'
  );

  IF v_mapping_id IS NULL AND v_mapping_key IS NULL THEN
    RETURN jsonb_build_object('resolved', FALSE, 'reason', 'not_configured');
  END IF;
  IF v_mapping_type <> 'api_gateway_inbound' THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'resolved', FALSE,
      'error', 'unsupported_mapping_type',
      'mapping_type', v_mapping_type,
      'mapping_config_id', v_mapping_id,
      'mapping_key', v_mapping_key
    ));
  END IF;

  SELECT *
  INTO v_mapping_row
  FROM public.mapping_configs mc
  WHERE mc.mapping_type = v_mapping_type
    AND (
      (v_mapping_id IS NOT NULL AND mc.id = v_mapping_id)
      OR (v_mapping_id IS NULL AND mc.mapping_key = v_mapping_key)
    )
    AND (mc.organization_id IS NULL OR mc.organization_id = p_organization_id)
  ORDER BY CASE WHEN mc.organization_id = p_organization_id THEN 0 ELSE 1 END,
           mc.updated_at DESC
  LIMIT 1;

  IF v_mapping_row.id IS NULL THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'resolved', FALSE,
      'error', 'mapping_config_not_found',
      'mapping_type', v_mapping_type,
      'mapping_config_id', v_mapping_id,
      'mapping_key', v_mapping_key
    ));
  END IF;

  v_mapping_config := COALESCE(v_mapping_row.mapping_config, '{}'::jsonb);
  IF COALESCE((v_mapping_config->>'enabled')::BOOLEAN, TRUE) IS FALSE THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'resolved', FALSE,
      'error', 'mapping_config_disabled',
      'mapping_type', v_mapping_type,
      'mapping_config_id', v_mapping_row.id,
      'mapping_key', v_mapping_row.mapping_key
    ));
  END IF;

  v_target := COALESCE(NULLIF(v_mapping_config->>'target', ''), NULLIF(v_mapping_ref->>'target', ''));
  v_route_intent := public.api_gateway_route_canonical_intent_v1(v_policy);
  v_mapping_intent := public.api_gateway_mapping_target_intent_v1(v_target);
  IF public.api_gateway_mapping_intents_compatible_v1(v_route_intent, v_mapping_intent) IS FALSE THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'resolved', FALSE,
      'error', 'mapping_target_mismatch',
      'mapping_config_id', v_mapping_row.id,
      'mapping_key', v_mapping_row.mapping_key,
      'mapping_type', v_mapping_type,
      'mapping_target', v_target,
      'route_intent', v_route_intent,
      'mapping_intent', v_mapping_intent
    ));
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'resolved', TRUE,
    'mapping_config_id', v_mapping_row.id,
    'mapping_key', v_mapping_row.mapping_key,
    'mapping_type', v_mapping_row.mapping_type,
    'mapping_target', v_target,
    'route_intent', v_route_intent,
    'mapping_intent', v_mapping_intent,
    'route_id', p_route.id,
    'route_scope_type', p_route.scope_type,
    'route_scope_id', p_route.scope_id,
    'context', jsonb_strip_nulls(jsonb_build_object(
      'organization_id', p_organization_id,
      'client_id', p_client_id,
      'sender_id', p_sender_id,
      'source_id', p_source_id
    )),
    'mapping_config', v_mapping_config
  ));
END;
$function$;

CREATE OR REPLACE FUNCTION public.api_gateway_apply_request_mapping_v1(
  p_route public.api_routes,
  p_organization_id UUID,
  p_client_id UUID,
  p_sender_id UUID,
  p_source_id UUID,
  p_body JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_mapping JSONB;
  v_mapping_id UUID;
  v_payload JSONB := COALESCE(p_body, '{}'::jsonb);
BEGIN
  v_mapping := public.api_gateway_route_request_mapping_v1(
    p_route, p_organization_id, p_client_id, p_sender_id, p_source_id
  );
  IF COALESCE((v_mapping->>'resolved')::BOOLEAN, FALSE) IS FALSE THEN
    IF v_mapping ? 'error' THEN
      RETURN jsonb_strip_nulls(jsonb_build_object(
        'ok', FALSE,
        'error', v_mapping->>'error',
        'mapping', v_mapping - 'mapping_config'
      ));
    END IF;
    RETURN jsonb_build_object(
      'ok', TRUE,
      'mapped', FALSE,
      'payload', v_payload,
      'mapping', v_mapping
    );
  END IF;

  v_mapping_id := public.mapping_studio_try_uuid_v1(v_mapping->>'mapping_config_id');
  IF v_mapping_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', 'mapping_config_id_missing',
      'mapping', v_mapping - 'mapping_config'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'mapped', TRUE,
    'payload', public.apply_mapping_config(v_payload, v_mapping_id),
    'mapping', v_mapping - 'mapping_config'
  );
EXCEPTION
  WHEN others THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'ok', FALSE,
      'error', 'mapping_application_failed',
      'message', SQLERRM,
      'mapping', COALESCE(v_mapping, '{}'::jsonb) - 'mapping_config'
    ));
END;
$function$;

-------------------------------------------------------------------------------
-- Workflow-engine-first defaults for typed compatibility mutations
-------------------------------------------------------------------------------

INSERT INTO public.workflow_templates (
  id, name, description, version, status, scope_type, scope_id, notes
)
VALUES (
  '99990000-0000-0000-0000-000000790401',
  'api_gateway_shipment_mutation_default_v1',
  'Default workflow for typed API Gateway compatibility shipment mutations.',
  1,
  'active',
  'global',
  NULL,
  'One row-driven provider dispatch workflow shared by update, delete/cancel, reschedule, and typed update routes.'
)
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description,
    status = EXCLUDED.status,
    scope_type = EXCLUDED.scope_type,
    scope_id = EXCLUDED.scope_id,
    notes = EXCLUDED.notes,
    updated_at = now();

INSERT INTO public.workflow_template_steps (
  id, workflow_template_id, sequence_order, operation_name,
  operation_settings_category, transition_condition, handler_key,
  handler_version, metadata, manual_action_required, enabled
)
SELECT
  '99990000-0000-0000-0000-000000790411'::uuid,
  wt.id,
  1,
  'dispatch_mutation',
  'workflow',
  'always',
  'api_gateway_dispatch_outbound',
  'v1',
  '{}'::jsonb,
  FALSE,
  TRUE
FROM public.workflow_templates wt
WHERE wt.name = 'api_gateway_shipment_mutation_default_v1'
  AND wt.status = 'active'
ORDER BY wt.updated_at DESC
LIMIT 1
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

CREATE OR REPLACE FUNCTION public.api_gateway_shipment_mutation_default_workflow_template_v1(p_intent TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT CASE
    WHEN lower(COALESCE(p_intent, '')) IN (
      'shipment.update', 'shipment.delete', 'shipment.reschedule',
      'update.status', 'update.address', 'update.geocode', 'update.driver',
      'update.action', 'update.attachment'
    ) THEN 'api_gateway_shipment_mutation_default_v1'
    ELSE NULL
  END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_api_gateway_shipment_mutation_workflow_defaults_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB := COALESCE(NEW.policy, '{}'::jsonb);
  v_intent TEXT;
  v_template_name TEXT;
  v_workflow_enabled BOOLEAN;
BEGIN
  IF COALESCE(NEW.enabled, FALSE) IS NOT TRUE THEN
    NEW.policy := v_policy;
    RETURN NEW;
  END IF;

  v_intent := public.api_gateway_route_canonical_intent_v1(v_policy);
  v_template_name := public.api_gateway_shipment_mutation_default_workflow_template_v1(v_intent);
  IF v_template_name IS NULL THEN
    NEW.policy := v_policy;
    RETURN NEW;
  END IF;

  BEGIN
    v_workflow_enabled := COALESCE((v_policy #>> '{workflow,enabled}')::BOOLEAN, FALSE);
  EXCEPTION WHEN others THEN
    v_workflow_enabled := FALSE;
  END;

  IF (v_policy ? 'workflow') IS FALSE THEN
    v_policy := jsonb_set(
      v_policy,
      '{workflow}',
      jsonb_build_object('enabled', TRUE, 'template_name', v_template_name),
      TRUE
    );
  ELSE
    IF v_workflow_enabled IS NOT TRUE THEN
      RAISE EXCEPTION 'enabled shipment mutation API Gateway routes must use workflow.enabled=true'
        USING ERRCODE = '23514';
    END IF;
    IF NULLIF(v_policy #>> '{workflow,template_name}', '') IS NULL
       AND NULLIF(v_policy #>> '{workflow,template_id}', '') IS NULL THEN
      v_policy := jsonb_set(v_policy, '{workflow,template_name}', to_jsonb(v_template_name), TRUE);
    END IF;
  END IF;

  IF NULLIF(v_policy #>> '{delivery,mode}', '') IS NULL THEN
    v_policy := jsonb_set(v_policy, '{delivery,mode}', to_jsonb('accepted_async'::TEXT), TRUE);
  END IF;
  IF NULLIF(v_policy #>> '{delivery,status_code}', '') IS NULL THEN
    v_policy := jsonb_set(v_policy, '{delivery,status_code}', to_jsonb(202), TRUE);
  END IF;
  NEW.policy := v_policy;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_api_routes_shipment_mutation_workflow_defaults_v1 ON public.api_routes;
CREATE TRIGGER trg_api_routes_shipment_mutation_workflow_defaults_v1
BEFORE INSERT OR UPDATE OF enabled, policy ON public.api_routes
FOR EACH ROW
EXECUTE FUNCTION public.apply_api_gateway_shipment_mutation_workflow_defaults_v1();

UPDATE public.api_routes r
SET policy = public.deep_merge_jsonb(
      COALESCE(r.policy, '{}'::jsonb),
      jsonb_build_object(
        'delivery', jsonb_build_object('mode', 'accepted_async', 'status_code', 202),
        'workflow', jsonb_build_object(
          'enabled', TRUE,
          'template_name', public.api_gateway_shipment_mutation_default_workflow_template_v1(
            public.api_gateway_route_canonical_intent_v1(COALESCE(r.policy, '{}'::jsonb))
          )
        )
      )
    ),
    updated_at = now()
WHERE r.enabled = TRUE
  AND public.api_gateway_shipment_mutation_default_workflow_template_v1(
        public.api_gateway_route_canonical_intent_v1(COALESCE(r.policy, '{}'::jsonb))
      ) IS NOT NULL
  AND (COALESCE(r.policy, '{}'::jsonb) ? 'workflow') IS FALSE;

-------------------------------------------------------------------------------
-- Tenant-safe route binding RPC
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_upsert_api_gateway_route_mapping_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := COALESCE(
    public.mapping_studio_try_uuid_v1(p_args->>'organization_id'),
    public.current_user_org_id()
  );
  v_route_id UUID := public.mapping_studio_try_uuid_v1(p_args->>'api_route_id');
  v_mapping_id UUID := public.mapping_studio_try_uuid_v1(p_args->>'mapping_config_id');
  v_route public.api_routes%ROWTYPE;
  v_mapping public.mapping_configs%ROWTYPE;
  v_target TEXT;
  v_scope_type TEXT;
  v_route_intent TEXT;
  v_mapping_intent TEXT;
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'ui_upsert_api_gateway_route_mapping_v1 requires object args';
  END IF;
  IF v_org_id IS NULL OR v_route_id IS NULL OR v_mapping_id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_api_gateway_route_mapping_v1 requires organization, api_route_id, and mapping_config_id';
  END IF;

  PERFORM public.assert_capability_v1('api_gateway.write', 'tenant', v_org_id);
  PERFORM public.assert_capability_v1('mappings.write', 'tenant', v_org_id);

  SELECT * INTO v_route FROM public.api_routes WHERE id = v_route_id LIMIT 1;
  IF v_route.id IS NULL THEN
    RAISE EXCEPTION 'api_gateway route % is not available in this tenant scope', v_route_id;
  END IF;

  SELECT *
  INTO v_mapping
  FROM public.mapping_configs
  WHERE id = v_mapping_id
    AND mapping_type = 'api_gateway_inbound'
    AND (organization_id IS NULL OR organization_id = v_org_id)
  LIMIT 1;
  IF v_mapping.id IS NULL THEN
    RAISE EXCEPTION 'api_gateway_inbound mapping config % is not available in this tenant scope', v_mapping_id;
  END IF;

  v_target := COALESCE(NULLIF(v_mapping.mapping_config->>'target', ''), NULLIF(p_args->>'target', ''));
  v_scope_type := lower(COALESCE(NULLIF(v_route.scope_type, ''), 'global'));
  v_route_intent := public.api_gateway_route_canonical_intent_v1(COALESCE(v_route.policy, '{}'::jsonb));
  v_mapping_intent := public.api_gateway_mapping_target_intent_v1(v_target);

  IF v_scope_type = 'global' THEN
    IF public.user_has_capability_v1('system.write', 'tenant', v_org_id) IS FALSE THEN
      RAISE EXCEPTION 'api_gateway global route % is service-managed for tenant mapping', v_route_id;
    END IF;
  ELSIF v_scope_type = 'tenant' THEN
    IF v_route.scope_id IS DISTINCT FROM v_org_id THEN
      RAISE EXCEPTION 'api_gateway tenant route % is not owned by organization %', v_route_id, v_org_id;
    END IF;
  ELSIF v_scope_type = 'client' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.clients c
      WHERE c.id = v_route.scope_id AND c.organization_id = v_org_id
    ) THEN
      RAISE EXCEPTION 'api_gateway client route % is not owned by organization %', v_route_id, v_org_id;
    END IF;
  ELSIF v_scope_type = 'sender' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
      WHERE s.id = v_route.scope_id AND c.organization_id = v_org_id
    ) THEN
      RAISE EXCEPTION 'api_gateway sender route % is not owned by organization %', v_route_id, v_org_id;
    END IF;
  ELSIF v_scope_type = 'source' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.webhook_sources ws
      WHERE ws.id = v_route.scope_id AND ws.organization_id = v_org_id
    ) THEN
      RAISE EXCEPTION 'api_gateway source route % is not owned by organization %', v_route_id, v_org_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'api_gateway route % has unsupported scope_type %', v_route_id, v_scope_type;
  END IF;

  IF public.api_gateway_mapping_intents_compatible_v1(v_route_intent, v_mapping_intent) IS FALSE THEN
    RAISE EXCEPTION 'api_gateway mapping target % is incompatible with route intent %',
      COALESCE(v_target, ''), COALESCE(v_route_intent, '');
  END IF;

  UPDATE public.api_routes
  SET policy = public.deep_merge_jsonb(
        COALESCE(policy, '{}'::jsonb),
        jsonb_build_object(
          'request_mapping',
          jsonb_strip_nulls(jsonb_build_object(
            'mapping_config_id', v_mapping.id,
            'mapping_key', v_mapping.mapping_key,
            'mapping_type', v_mapping.mapping_type,
            'target', v_target,
            'route_intent', v_route_intent,
            'mapping_intent', v_mapping_intent,
            'route_scope_type', v_scope_type,
            'route_scope_id', v_route.scope_id,
            'saved_at', now(),
            'saved_by', v_user_id
          ))
        )
      ),
      updated_at = now()
  WHERE id = v_route.id
  RETURNING * INTO v_route;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'api_route_id', v_route.id,
    'mapping_config_id', v_mapping.id,
    'mapping_key', v_mapping.mapping_key,
    'mapping_type', v_mapping.mapping_type,
    'mapping_target', v_target,
    'route_intent', v_route_intent,
    'mapping_intent', v_mapping_intent,
    'route_scope_type', v_scope_type,
    'route_scope_id', v_route.scope_id,
    'policy', v_route.policy
  ));
END;
$function$;

CREATE OR REPLACE FUNCTION api.ui_upsert_api_gateway_route_mapping_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO api, public, extensions, pg_temp
AS $function$
  SELECT public.ui_upsert_api_gateway_route_mapping_v1(p_args);
$function$;

-------------------------------------------------------------------------------
-- One rate-limited, redacted rejection path used before provider dispatch
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_gateway_reject_before_dispatch_v1(
  p_organization_id UUID,
  p_client_id UUID,
  p_sender_id UUID,
  p_source_id UUID,
  p_rate_limit_per_hour INTEGER,
  p_route public.api_routes,
  p_settings_resolution_id UUID,
  p_method TEXT,
  p_path TEXT,
  p_query_string TEXT,
  p_headers JSONB,
  p_body JSONB,
  p_status INTEGER,
  p_error TEXT,
  p_decision_point TEXT,
  p_decision_inputs JSONB,
  p_decision_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_corr UUID;
  v_corr_text TEXT;
  v_query TEXT := COALESCE(p_query_string, '');
  v_count INTEGER;
  v_rate_limit INTEGER := COALESCE(p_rate_limit_per_hour, 0);
  v_request_id UUID;
  v_safe_headers JSONB;
  v_safe_body JSONB;
  v_auth_fields JSONB := COALESCE(p_route.policy #> '{auth,fields}', '{}'::jsonb);
BEGIN
  v_corr_text := COALESCE(
    NULLIF(p_headers->>'x-correlation-id', ''),
    NULLIF(p_headers->>'x-request-id', '')
  );
  IF v_corr_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_corr := v_corr_text::UUID;
  ELSE
    v_corr := COALESCE(public.current_correlation_id(), gen_random_uuid());
  END IF;
  PERFORM set_config('request.correlation_id', v_corr::TEXT, TRUE);

  IF left(v_query, 1) = '?' THEN
    v_query := substring(v_query FROM 2);
  END IF;

  IF v_rate_limit > 0 THEN
    INSERT INTO public.api_gateway_rate_limits(source_id, window_start, request_count, updated_at)
    VALUES (p_source_id, date_trunc('hour', v_now), 1, v_now)
    ON CONFLICT (source_id, window_start) DO UPDATE
    SET request_count = public.api_gateway_rate_limits.request_count + 1,
        updated_at = EXCLUDED.updated_at
    RETURNING request_count INTO v_count;
    IF v_count > v_rate_limit THEN
      RETURN jsonb_build_object(
        'action', 'error',
        'status', 429,
        'headers', jsonb_build_object('content-type', 'application/json'),
        'body', jsonb_build_object('error', 'rate_limited'),
        'correlation_id', v_corr
      );
    END IF;
  END IF;

  v_safe_headers := public.redact_sensitive_headers(COALESCE(p_headers, '{}'::jsonb))
    - 'x-webhook-token' - 'x-internal-edge-token';
  v_safe_body := COALESCE(p_body, '{}'::jsonb);
  IF COALESCE(p_route.policy #>> '{auth,mode}', '') = 'body_fields'
     AND jsonb_typeof(v_safe_body) = 'object'
     AND jsonb_typeof(v_auth_fields) = 'object' THEN
    SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
    INTO v_safe_body
    FROM jsonb_each(v_safe_body) entry
    WHERE entry.key NOT IN (SELECT key FROM jsonb_each_text(v_auth_fields));
  END IF;
  v_safe_body := public.redact_sensitive_json(v_safe_body);

  INSERT INTO public.api_gateway_requests (
    organization_id, client_id, sender_id, source_id, correlation_id,
    route_id, settings_resolution_id, method, path, query_string,
    request_headers, request_body, received_at, created_at, updated_at
  ) VALUES (
    p_organization_id, p_client_id, p_sender_id, p_source_id, v_corr,
    p_route.id, p_settings_resolution_id, upper(COALESCE(p_method, '')), p_path, NULLIF(v_query, ''),
    v_safe_headers, v_safe_body, v_now, v_now, v_now
  ) RETURNING id INTO v_request_id;

  PERFORM public.log_decision(
    p_organization_id := p_organization_id,
    p_decision_category := CASE
      WHEN p_decision_point = 'api_gateway_source_sender_client_checked'
        THEN 'settings_resolution'
      ELSE 'transformation'
    END,
    p_resource_type := 'api_gateway_request',
    p_resource_id := v_request_id,
    p_decision_point := p_decision_point,
    p_decision_outcome := 'rejected',
    p_performed_by_system := 'api_gateway',
    p_correlation_id := v_corr,
    p_decision_inputs := COALESCE(p_decision_inputs, '{}'::jsonb),
    p_decision_reason := p_decision_reason,
    p_settings_resolution_id := p_settings_resolution_id
  );

  RETURN jsonb_build_object(
    'action', 'error',
    'status', p_status,
    'headers', jsonb_build_object('content-type', 'application/json'),
    'body', jsonb_build_object('error', p_error, 'api_gateway_request_id', v_request_id),
    'api_gateway_request_id', v_request_id,
    'correlation_id', v_corr
  );
END;
$function$;

-------------------------------------------------------------------------------
-- Stable composition seam: preserve the latest intake as a private base, then
-- apply this batch once at the public entrypoint without redefining prior logic.
-------------------------------------------------------------------------------

DO $guard$
BEGIN
  IF to_regprocedure('public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 is required before compatibility mapping';
  END IF;
  IF to_regprocedure('public.workflow_intake_api_gateway_base_v1(text,text,text,text,jsonb,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_base_v1 already exists';
  END IF;
END;
$guard$;

ALTER FUNCTION public.workflow_intake_api_gateway_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB)
  RENAME TO workflow_intake_api_gateway_base_v1;

REVOKE ALL ON FUNCTION public.workflow_intake_api_gateway_base_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated, edge_api_gateway_role, service_role;

CREATE OR REPLACE FUNCTION public.workflow_intake_api_gateway_v1(
  p_token TEXT,
  p_method TEXT,
  p_path TEXT,
  p_query_string TEXT DEFAULT NULL,
  p_headers JSONB DEFAULT '{}'::jsonb,
  p_body JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_source RECORD;
  v_route_resolution JSONB;
  v_route public.api_routes%ROWTYPE;
  v_route_intent TEXT;
  v_source_binding_ok BOOLEAN;
  v_mapping JSONB;
  v_mapped_body JSONB;
  v_original_safe_body JSONB;
  v_result JSONB;
  v_request_id UUID;
  v_outbound_id UUID;
  v_workflow_run_id UUID;
  v_mapping_lineage JSONB;
  v_settings_resolution_id UUID;
  v_auth_fields JSONB;
  v_rate_limit_per_hour INTEGER;
BEGIN
  SELECT token_source.*
  INTO v_source
  FROM public.get_webhook_source_by_token(p_token) token_source
  LIMIT 1;

  IF v_source.id IS NULL OR COALESCE(v_source.enabled, FALSE) IS FALSE THEN
    RETURN public.workflow_intake_api_gateway_base_v1(
      p_token, p_method, p_path, p_query_string, p_headers, p_body
    );
  END IF;

  SELECT ws.rate_limit_per_hour
  INTO v_rate_limit_per_hour
  FROM public.webhook_sources ws
  WHERE ws.id = v_source.id;

  v_route_resolution := public.resolve_api_route_v1(
    upper(COALESCE(p_method, '')),
    public.normalize_api_path(p_path),
    v_source.organization_id,
    v_source.client_id,
    v_source.sender_id,
    v_source.id
  );
  IF COALESCE((v_route_resolution->>'found')::BOOLEAN, FALSE) IS FALSE THEN
    RETURN public.workflow_intake_api_gateway_base_v1(
      p_token, p_method, p_path, p_query_string, p_headers, p_body
    );
  END IF;

  v_settings_resolution_id := public.mapping_studio_try_uuid_v1(
    v_route_resolution->>'settings_resolution_id'
  );
  SELECT * INTO v_route
  FROM public.api_routes
  WHERE id = public.mapping_studio_try_uuid_v1(v_route_resolution->>'route_id');

  IF v_route.id IS NULL THEN
    RETURN public.workflow_intake_api_gateway_base_v1(
      p_token, p_method, p_path, p_query_string, p_headers, p_body
    );
  END IF;

  v_route_intent := public.api_gateway_route_canonical_intent_v1(COALESCE(v_route.policy, '{}'::jsonb));
  IF v_route_intent IN ('shipment.create', 'shipment.update', 'shipment.delete', 'shipment.reschedule')
     OR v_route_intent LIKE 'update.%' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
      WHERE s.id = v_source.sender_id
        AND c.id = v_source.client_id
        AND c.organization_id = v_source.organization_id
        AND COALESCE(s.status, 'active') = 'active'
        AND COALESCE(c.status, 'active') = 'active'
    ) INTO v_source_binding_ok;

    IF COALESCE(v_source_binding_ok, FALSE) IS FALSE THEN
      RETURN public.api_gateway_reject_before_dispatch_v1(
        v_source.organization_id,
        v_source.client_id,
        v_source.sender_id,
        v_source.id,
        v_rate_limit_per_hour,
        v_route,
        v_settings_resolution_id,
        p_method,
        public.normalize_api_path(p_path),
        p_query_string,
        p_headers,
        p_body,
        400,
        'api_gateway_source_missing_sender_client',
        'api_gateway_source_sender_client_checked',
        jsonb_strip_nulls(jsonb_build_object(
          'method', upper(COALESCE(p_method, '')),
          'path', public.normalize_api_path(p_path),
          'route_id', v_route.id,
          'route_name', v_route.route_name,
          'canonical_intent', v_route_intent,
          'source_id', v_source.id,
          'sender_id', v_source.sender_id,
          'client_id', v_source.client_id
        )),
        'API Gateway shipment mutation source must be bound to an active sender/client before dispatch.'
      );
    END IF;
  END IF;

  v_mapping := public.api_gateway_apply_request_mapping_v1(
    v_route,
    v_source.organization_id,
    v_source.client_id,
    v_source.sender_id,
    v_source.id,
    p_body
  );
  IF COALESCE((v_mapping->>'ok')::BOOLEAN, FALSE) IS FALSE THEN
    RETURN public.api_gateway_reject_before_dispatch_v1(
      v_source.organization_id,
      v_source.client_id,
      v_source.sender_id,
      v_source.id,
      v_rate_limit_per_hour,
      v_route,
      v_settings_resolution_id,
      p_method,
      public.normalize_api_path(p_path),
      p_query_string,
      p_headers,
      p_body,
      422,
      COALESCE(v_mapping->>'error', 'api_gateway_request_mapping_failed'),
      'api_gateway_request_mapping',
      jsonb_strip_nulls(jsonb_build_object(
        'route_id', v_route.id,
        'route_name', v_route.route_name,
        'mapping', COALESCE(v_mapping->'mapping', '{}'::jsonb),
        'error', v_mapping->>'error'
      )),
      'API Gateway request mapping failed closed before provider dispatch.'
    );
  END IF;

  IF COALESCE((v_mapping->>'mapped')::BOOLEAN, FALSE) IS FALSE THEN
    RETURN public.workflow_intake_api_gateway_base_v1(
      p_token, p_method, p_path, p_query_string, p_headers, p_body
    );
  END IF;

  v_mapped_body := COALESCE(v_mapping->'payload', '{}'::jsonb);
  v_result := public.workflow_intake_api_gateway_base_v1(
    p_token, p_method, p_path, p_query_string, p_headers, v_mapped_body
  );

  v_request_id := public.mapping_studio_try_uuid_v1(v_result->>'api_gateway_request_id');
  IF v_request_id IS NULL THEN
    RETURN v_result;
  END IF;

  v_original_safe_body := COALESCE(p_body, '{}'::jsonb);
  v_auth_fields := COALESCE(v_route.policy #> '{auth,fields}', '{}'::jsonb);
  IF COALESCE(v_route.policy #>> '{auth,mode}', '') = 'body_fields'
     AND jsonb_typeof(v_original_safe_body) = 'object'
     AND jsonb_typeof(v_auth_fields) = 'object' THEN
    SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
    INTO v_original_safe_body
    FROM jsonb_each(v_original_safe_body) entry
    WHERE entry.key NOT IN (SELECT key FROM jsonb_each_text(v_auth_fields));
  END IF;
  v_original_safe_body := public.redact_sensitive_json(v_original_safe_body);
  v_mapping_lineage := COALESCE(v_mapping->'mapping', '{}'::jsonb);
  UPDATE public.api_gateway_requests
  SET request_body = v_original_safe_body,
      updated_at = now()
  WHERE id = v_request_id;

  PERFORM public.log_decision(
    p_organization_id := v_source.organization_id,
    p_decision_category := 'transformation',
    p_resource_type := 'api_gateway_request',
    p_resource_id := v_request_id,
    p_decision_point := 'api_gateway_request_mapping',
    p_decision_outcome := 'applied',
    p_performed_by_system := 'api_gateway',
    p_correlation_id := public.mapping_studio_try_uuid_v1(v_result->>'correlation_id'),
    p_decision_inputs := jsonb_build_object(
      'route_id', v_route.id,
      'route_name', v_route.route_name,
      'mapping', v_mapping_lineage
    ),
    p_decision_reason := 'API Gateway request mapping applied before workflow/provider dispatch.',
    p_settings_resolution_id := v_settings_resolution_id
  );

  v_outbound_id := public.mapping_studio_try_uuid_v1(v_result->>'outbound_call_id');
  IF v_outbound_id IS NOT NULL THEN
    UPDATE public.outbound_calls
    SET context = public.deep_merge_jsonb(
          COALESCE(context, '{}'::jsonb),
          jsonb_build_object(
            'api_gateway_request_mapping', v_mapping_lineage,
            'api_gateway_request_mapping_applied', TRUE
          )
        )
    WHERE id = v_outbound_id;
  END IF;

  v_workflow_run_id := public.mapping_studio_try_uuid_v1(v_result->>'workflow_run_id');
  IF v_workflow_run_id IS NOT NULL THEN
    UPDATE public.workflow_runs
    SET context = public.deep_merge_jsonb(
          COALESCE(context, '{}'::jsonb),
          jsonb_build_object(
            'payload', public.redact_sensitive_json(v_mapped_body),
            'transformed_payload', public.redact_sensitive_json(v_mapped_body),
            'api_gateway', jsonb_build_object(
              'api_gateway_request_mapping', v_mapping_lineage,
              'api_gateway_request_mapping_applied', TRUE
            )
          )
        ),
        updated_at = now()
    WHERE id = v_workflow_run_id;
  END IF;

  RETURN v_result;
END;
$function$;

-------------------------------------------------------------------------------
-- Least privilege
-------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.api_gateway_route_canonical_intent_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.api_gateway_mapping_target_intent_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.api_gateway_mapping_intents_compatible_v1(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.api_gateway_route_request_mapping_v1(public.api_routes, UUID, UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.api_gateway_apply_request_mapping_v1(public.api_routes, UUID, UUID, UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.api_gateway_reject_before_dispatch_v1(UUID, UUID, UUID, UUID, INTEGER, public.api_routes, UUID, TEXT, TEXT, TEXT, JSONB, JSONB, INTEGER, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_upsert_api_gateway_route_mapping_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_upsert_api_gateway_route_mapping_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.workflow_intake_api_gateway_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.api_gateway_route_canonical_intent_v1(JSONB) TO authenticated, service_role, edge_api_gateway_role;
GRANT EXECUTE ON FUNCTION public.api_gateway_mapping_target_intent_v1(TEXT) TO authenticated, service_role, edge_api_gateway_role;
GRANT EXECUTE ON FUNCTION public.api_gateway_mapping_intents_compatible_v1(TEXT, TEXT) TO authenticated, service_role, edge_api_gateway_role;
GRANT EXECUTE ON FUNCTION public.api_gateway_route_request_mapping_v1(public.api_routes, UUID, UUID, UUID, UUID) TO service_role, edge_api_gateway_role;
GRANT EXECUTE ON FUNCTION public.api_gateway_apply_request_mapping_v1(public.api_routes, UUID, UUID, UUID, UUID, JSONB) TO service_role, edge_api_gateway_role;
GRANT EXECUTE ON FUNCTION public.ui_upsert_api_gateway_route_mapping_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_upsert_api_gateway_route_mapping_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_intake_api_gateway_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) TO service_role, edge_api_gateway_role;

COMMENT ON FUNCTION public.workflow_intake_api_gateway_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) IS
  'Public API Gateway intake composition: typed mutation source guard, route-bound request mapping, original redacted readback, then the private canonical intake base.';
COMMENT ON FUNCTION public.workflow_intake_api_gateway_base_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) IS
  'Private latest canonical API Gateway intake implementation. Call through workflow_intake_api_gateway_v1.';

SELECT pg_advisory_unlock(hashtext('202607151330_api_gateway_compat_typed_mapping_v1'));

COMMIT;
