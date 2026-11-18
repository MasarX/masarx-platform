-- API Gateway request mapping resolution.
-- Lets tenant/client-scoped API routes bind Mapping Studio request profiles
-- and applies the selected mapping before provider dispatch while preserving
-- the original redacted request readback.

BEGIN;

SET search_path TO public, extensions, pg_temp;

SELECT pg_advisory_lock(hashtext('202605300730_api_gateway_request_mapping_resolution_v1'));

ALTER TABLE public.mapping_configs
  DROP CONSTRAINT IF EXISTS mapping_configs_type_check;

ALTER TABLE public.mapping_configs
  ADD CONSTRAINT mapping_configs_type_check
  CHECK (
    mapping_type IN (
      'provider_response',
      'webhook_inbound',
      'webhook_outbound',
      'event_extraction',
      'webhook_response',
      'tabular_import',
      'api_gateway_inbound'
    )
  );

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable,
  organization_id,
  scope_type
)
VALUES (
  'mapping_type',
  'Mapping artifact type taxonomy (mirrors public.mapping_configs.mapping_type).',
  'engineering',
  'tier_2',
  TRUE,
  NULL,
  'global'
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
  'Tenant/client API Gateway request payload mapping before provider dispatch.',
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
    metadata = public.deep_merge_jsonb(COALESCE(public.lookup_values.metadata, '{}'::jsonb), EXCLUDED.metadata),
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
            SELECT jsonb_array_elements_text(COALESCE(lv.metadata->'allowed_mapping_types', '[]'::jsonb)) AS item
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

CREATE OR REPLACE FUNCTION public.redact_sensitive_json(p_value JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_out JSONB;
  v_entry RECORD;
  v_key_lower TEXT;
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(p_value) = 'object' THEN
    v_out := '{}'::jsonb;
    FOR v_entry IN SELECT key, value FROM jsonb_each(p_value) LOOP
      v_key_lower := lower(v_entry.key);
      IF v_key_lower IN (
        'api_key',
        'apikey',
        'authorization',
        'credential',
        'password',
        'private_key',
        'secret',
        'token',
        'access_token',
        'refresh_token',
        'signing_secret',
        'shared_secret'
      )
      OR v_key_lower LIKE '%token%'
      OR v_key_lower LIKE '%secret%'
      OR v_key_lower LIKE '%password%'
      OR v_key_lower LIKE '%credential%'
      OR v_key_lower LIKE '%private%key%'
      THEN
        v_out := v_out || jsonb_build_object(v_entry.key, 'REDACTED');
      ELSE
        v_out := v_out || jsonb_build_object(v_entry.key, public.redact_sensitive_json(v_entry.value));
      END IF;
    END LOOP;
    RETURN v_out;
  END IF;

  IF jsonb_typeof(p_value) = 'array' THEN
    v_out := '[]'::jsonb;
    FOR v_entry IN
      SELECT value, ordinality
      FROM jsonb_array_elements(p_value) WITH ORDINALITY AS arr(value, ordinality)
    LOOP
      v_out := v_out || jsonb_build_array(public.redact_sensitive_json(v_entry.value));
    END LOOP;
    RETURN v_out;
  END IF;

  RETURN p_value;
END;
$function$;

COMMENT ON FUNCTION public.redact_sensitive_json(JSONB)
  IS 'Recursively redact sensitive JSON keys including token, password, secret, credential, api_key, and private-key variants for safe persistence/logging.';

INSERT INTO public.workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type,
  scope_id,
  notes
)
VALUES
(
  '99990000-0000-0000-0000-000000790201',
  'api_gateway_shipment_update_default_v1',
  'Default API Gateway shipment-update workflow: dispatch provider update through workflow-engine outbound handling.',
  1,
  'active',
  'global',
  NULL,
  'Generic API Gateway shipment update path. Route-specific workflows may override this in api_routes.policy.workflow.template_name.'
),
(
  '99990000-0000-0000-0000-000000790301',
  'api_gateway_shipment_cancel_default_v1',
  'Default API Gateway shipment-cancel workflow: dispatch provider cancel/delete through workflow-engine outbound handling.',
  1,
  'active',
  'global',
  NULL,
  'Generic API Gateway shipment cancel/delete path. Route-specific workflows may override this in api_routes.policy.workflow.template_name.'
)
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description,
    status = EXCLUDED.status,
    scope_type = EXCLUDED.scope_type,
    scope_id = EXCLUDED.scope_id,
    notes = EXCLUDED.notes,
    updated_at = now();

DO $do$
DECLARE
  v_update_template_id UUID;
  v_cancel_template_id UUID;
BEGIN
  SELECT id
    INTO v_update_template_id
    FROM public.workflow_templates
   WHERE name = 'api_gateway_shipment_update_default_v1'
     AND status = 'active'
   ORDER BY updated_at DESC
   LIMIT 1;

  SELECT id
    INTO v_cancel_template_id
    FROM public.workflow_templates
   WHERE name = 'api_gateway_shipment_cancel_default_v1'
     AND status = 'active'
   ORDER BY updated_at DESC
   LIMIT 1;

  IF v_update_template_id IS NULL THEN
    RAISE EXCEPTION 'api_gateway_shipment_update_default_v1 template missing after upsert';
  END IF;

  IF v_cancel_template_id IS NULL THEN
    RAISE EXCEPTION 'api_gateway_shipment_cancel_default_v1 template missing after upsert';
  END IF;

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
  VALUES
    (
      '99990000-0000-0000-0000-000000790211'::uuid,
      v_update_template_id,
      1,
      'dispatch_update',
      'workflow',
      'always',
      'api_gateway_dispatch_outbound',
      'v1',
      '{}'::jsonb,
      FALSE,
      TRUE
    ),
    (
      '99990000-0000-0000-0000-000000790311'::uuid,
      v_cancel_template_id,
      1,
      'dispatch_cancel',
      'workflow',
      'always',
      'api_gateway_dispatch_outbound',
      'v1',
      '{}'::jsonb,
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
END;
$do$;

CREATE OR REPLACE FUNCTION public.api_gateway_shipment_mutation_default_workflow_template_v1(p_intent TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT CASE
    WHEN lower(COALESCE(p_intent, '')) = 'shipment.delete'
      THEN 'api_gateway_shipment_cancel_default_v1'
    WHEN lower(COALESCE(p_intent, '')) IN (
      'shipment.update',
      'update.status',
      'update.address',
      'update.geocode',
      'update.driver',
      'update.action',
      'update.attachment'
    )
      THEN 'api_gateway_shipment_update_default_v1'
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
  EXCEPTION
    WHEN others THEN
      v_workflow_enabled := FALSE;
  END;

  IF (v_policy ? 'workflow') IS FALSE THEN
    v_policy := jsonb_set(
      v_policy,
      '{workflow}',
      jsonb_build_object(
        'enabled', TRUE,
        'template_name', v_template_name
      ),
      TRUE
    );
  ELSE
    IF v_workflow_enabled IS NOT TRUE THEN
      RAISE EXCEPTION 'enabled shipment mutation API Gateway routes must use workflow.enabled=true'
        USING ERRCODE = '23514';
    END IF;

    IF NULLIF(v_policy #>> '{workflow,template_name}', '') IS NULL
       AND NULLIF(v_policy #>> '{workflow,template_id}', '') IS NULL THEN
      v_policy := jsonb_set(
        v_policy,
        '{workflow,template_name}',
        to_jsonb(v_template_name),
        TRUE
      );
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

COMMENT ON FUNCTION public.apply_api_gateway_shipment_mutation_workflow_defaults_v1()
  IS 'Before-insert/update guard for API Gateway shipment update/cancel routes: mutation ingress is workflow-engine-first by default.';

DROP TRIGGER IF EXISTS trg_api_routes_shipment_mutation_workflow_defaults_v1 ON public.api_routes;
CREATE TRIGGER trg_api_routes_shipment_mutation_workflow_defaults_v1
BEFORE INSERT OR UPDATE OF enabled, policy ON public.api_routes
FOR EACH ROW
EXECUTE FUNCTION public.apply_api_gateway_shipment_mutation_workflow_defaults_v1();

UPDATE public.api_routes r
   SET policy = public.jsonb_deep_merge(
       COALESCE(r.policy, '{}'::jsonb),
       jsonb_build_object(
         'delivery', jsonb_build_object(
           'mode', 'accepted_async',
           'status_code', 202,
           'headers', jsonb_build_object('content-type', 'application/json')
         ),
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

CREATE OR REPLACE FUNCTION public.api_gateway_mapping_target_intent_v1(p_target TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $$
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
$$;

CREATE OR REPLACE FUNCTION public.api_gateway_mapping_intents_compatible_v1(
  p_route_intent TEXT,
  p_mapping_intent TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT CASE
    WHEN NULLIF(btrim(COALESCE(p_route_intent, '')), '') IS NULL THEN FALSE
    WHEN NULLIF(btrim(COALESCE(p_mapping_intent, '')), '') IS NULL THEN FALSE
    WHEN lower(p_route_intent) = lower(p_mapping_intent) THEN TRUE
    WHEN lower(p_route_intent) = 'shipment.update'
      AND lower(p_mapping_intent) LIKE 'update.%' THEN TRUE
    ELSE FALSE
  END;
$$;

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
  v_mapping_ref JSONB := '{}'::jsonb;
  v_mapping_id UUID;
  v_mapping_key TEXT;
  v_mapping_type TEXT := 'api_gateway_inbound';
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

  v_target := COALESCE(
    NULLIF(v_mapping_config->>'target', ''),
    NULLIF(v_mapping_ref->>'target', '')
  );
  v_route_intent := public.api_gateway_route_canonical_intent_v1(v_policy);
  v_mapping_intent := public.api_gateway_mapping_target_intent_v1(v_target);

  IF public.api_gateway_mapping_intents_compatible_v1(v_route_intent, v_mapping_intent) IS FALSE THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'resolved', FALSE,
      'error', 'mapping_target_mismatch',
      'mapping_type', v_mapping_type,
      'mapping_config_id', v_mapping_row.id,
      'mapping_key', v_mapping_row.mapping_key,
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
    p_route,
    p_organization_id,
    p_client_id,
    p_sender_id,
    p_source_id
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

CREATE OR REPLACE FUNCTION public.ui_upsert_api_gateway_route_mapping_v1(
  p_args JSONB
)
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
  v_mapping_config JSONB;
  v_target TEXT;
  v_scope_type TEXT;
  v_route_intent TEXT;
  v_mapping_intent TEXT;
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'ui_upsert_api_gateway_route_mapping_v1 requires object args';
  END IF;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_api_gateway_route_mapping_v1 requires organization context';
  END IF;
  IF v_route_id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_api_gateway_route_mapping_v1 requires api_route_id';
  END IF;
  IF v_mapping_id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_api_gateway_route_mapping_v1 requires mapping_config_id';
  END IF;

  PERFORM public.assert_capability_v1('api_gateway.write', 'tenant', v_org_id);
  PERFORM public.assert_capability_v1('mappings.write', 'tenant', v_org_id);

  SELECT *
    INTO v_route
    FROM public.api_routes
   WHERE id = v_route_id
   LIMIT 1;

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

  v_mapping_config := COALESCE(v_mapping.mapping_config, '{}'::jsonb);
  v_target := COALESCE(NULLIF(v_mapping_config->>'target', ''), NULLIF(p_args->>'target', ''));
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
      SELECT 1
        FROM public.clients c
       WHERE c.id = v_route.scope_id
         AND c.organization_id = v_org_id
    ) THEN
      RAISE EXCEPTION 'api_gateway client route % is not owned by organization %', v_route_id, v_org_id;
    END IF;
  ELSIF v_scope_type = 'sender' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE s.id = v_route.scope_id
         AND c.organization_id = v_org_id
    ) THEN
      RAISE EXCEPTION 'api_gateway sender route % is not owned by organization %', v_route_id, v_org_id;
    END IF;
  ELSIF v_scope_type = 'source' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.webhook_sources ws
       WHERE ws.id = v_route.scope_id
         AND ws.organization_id = v_org_id
    ) THEN
      RAISE EXCEPTION 'api_gateway source route % is not owned by organization %', v_route_id, v_org_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'api_gateway route % has unsupported scope_type %', v_route_id, v_scope_type;
  END IF;

  IF public.api_gateway_mapping_intents_compatible_v1(v_route_intent, v_mapping_intent) IS FALSE THEN
    RAISE EXCEPTION 'api_gateway mapping target % is incompatible with route intent %', COALESCE(v_target, ''), COALESCE(v_route_intent, '');
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
AS $$
  SELECT public.ui_upsert_api_gateway_route_mapping_v1(p_args);
$$;

REVOKE ALL ON FUNCTION public.api_gateway_route_request_mapping_v1(public.api_routes, UUID, UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.api_gateway_apply_request_mapping_v1(public.api_routes, UUID, UUID, UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.api_gateway_mapping_target_intent_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.api_gateway_mapping_intents_compatible_v1(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_upsert_api_gateway_route_mapping_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_upsert_api_gateway_route_mapping_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.api_gateway_route_request_mapping_v1(public.api_routes, UUID, UUID, UUID, UUID) TO service_role, edge_api_gateway_role;
GRANT EXECUTE ON FUNCTION public.api_gateway_apply_request_mapping_v1(public.api_routes, UUID, UUID, UUID, UUID, JSONB) TO service_role, edge_api_gateway_role;
GRANT EXECUTE ON FUNCTION public.api_gateway_mapping_target_intent_v1(TEXT) TO authenticated, service_role, edge_api_gateway_role;
GRANT EXECUTE ON FUNCTION public.api_gateway_mapping_intents_compatible_v1(TEXT, TEXT) TO authenticated, service_role, edge_api_gateway_role;
GRANT EXECUTE ON FUNCTION public.ui_upsert_api_gateway_route_mapping_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_upsert_api_gateway_route_mapping_v1(JSONB) TO authenticated, service_role;

DO $patch$
DECLARE
  v_def TEXT;
  v_next TEXT;
  v_marker TEXT := E'  v_safe_body JSONB;\n';
  v_insert_after_request TEXT := E'  RETURNING id INTO v_request_id;\n\n  -- Build outbound call spec (provider proxy).';
  v_mapping_block TEXT := E'  RETURNING id INTO v_request_id;\n\n  v_request_mapping := public.api_gateway_apply_request_mapping_v1(\n    v_route_row,\n    v_org,\n    v_client,\n    v_sender,\n    v_source.id,\n    v_body\n  );\n\n  IF COALESCE((v_request_mapping->>''ok'')::BOOLEAN, FALSE) IS FALSE THEN\n    PERFORM public.log_decision(\n      p_organization_id := v_org,\n      p_decision_category := ''transformation'',\n      p_resource_type := ''api_gateway_request'',\n      p_resource_id := v_request_id,\n      p_decision_point := ''api_gateway_request_mapping'',\n      p_decision_outcome := ''rejected'',\n      p_performed_by_system := ''api_gateway'',\n      p_correlation_id := v_corr,\n      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(\n        ''route_id'', v_route_id,\n        ''route_name'', v_route_row.route_name,\n        ''mapping'', COALESCE(v_request_mapping->''mapping'', ''{}''::jsonb),\n        ''error'', v_request_mapping->>''error''\n      )),\n      p_decision_reason := ''API Gateway request mapping failed closed before provider dispatch.'',\n      p_settings_resolution_id := v_settings_resolution_id\n    );\n\n    RETURN jsonb_strip_nulls(jsonb_build_object(\n      ''action'', ''error'',\n      ''status'', 422,\n      ''headers'', jsonb_build_object(''content-type'', ''application/json''),\n      ''body'', jsonb_build_object(\n        ''error'', COALESCE(v_request_mapping->>''error'', ''api_gateway_request_mapping_failed''),\n        ''api_gateway_request_id'', v_request_id,\n        ''correlation_id'', v_corr\n      ),\n      ''api_gateway_request_id'', v_request_id,\n      ''correlation_id'', v_corr\n    ));\n  END IF;\n\n  v_outbound_body := COALESCE(v_request_mapping->''payload'', v_body, ''{}''::jsonb);\n  v_safe_outbound_body := public.redact_sensitive_json(COALESCE(v_outbound_body, ''{}''::jsonb));\n\n  IF COALESCE((v_request_mapping->>''mapped'')::BOOLEAN, FALSE) THEN\n    PERFORM public.log_decision(\n      p_organization_id := v_org,\n      p_decision_category := ''transformation'',\n      p_resource_type := ''api_gateway_request'',\n      p_resource_id := v_request_id,\n      p_decision_point := ''api_gateway_request_mapping'',\n      p_decision_outcome := ''applied'',\n      p_performed_by_system := ''api_gateway'',\n      p_correlation_id := v_corr,\n      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(\n        ''route_id'', v_route_id,\n        ''route_name'', v_route_row.route_name,\n        ''mapping'', COALESCE(v_request_mapping->''mapping'', ''{}''::jsonb)\n      )),\n      p_decision_reason := ''API Gateway request mapping applied before provider dispatch.'',\n      p_settings_resolution_id := v_settings_resolution_id\n    );\n  END IF;\n\n  -- Build outbound call spec (provider proxy).';
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 definition not found';
  END IF;

  IF position('public.api_gateway_apply_request_mapping_v1(' IN v_def) > 0
     AND position('COALESCE(v_safe_outbound_body, v_safe_body, ''{}''::jsonb)' IN v_def) > 0
     AND position('''api_gateway_request_mapping'', COALESCE(v_request_mapping->''mapping'', ''{}''::jsonb)' IN v_def) > 0
     AND position('p_decision_outcome := ''applied''' IN v_def) > 0 THEN
    RAISE NOTICE 'workflow_intake_api_gateway_v1 already applies API Gateway request mapping with body/context/decision lineage';
    RETURN;
  END IF;
  IF position('public.api_gateway_apply_request_mapping_v1(' IN v_def) > 0 THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 has a partial API Gateway request mapping patch; refusing to accept incomplete body/context/decision lineage';
  END IF;

  IF position(v_marker IN v_def) = 0 THEN
    RAISE EXCEPTION 'Expected safe body declaration marker not found in workflow_intake_api_gateway_v1';
  END IF;
  IF position(v_insert_after_request IN v_def) = 0 THEN
    RAISE EXCEPTION 'Expected request insert marker not found in workflow_intake_api_gateway_v1';
  END IF;

  v_next := replace(
    v_def,
    v_marker,
    E'  v_safe_body JSONB;\n  v_outbound_body JSONB;\n  v_safe_outbound_body JSONB;\n  v_request_mapping JSONB;\n'
  );

  v_next := replace(v_next, v_insert_after_request, v_mapping_block);

  v_next := replace(
    v_next,
    E'          ''{}''::jsonb,\n          COALESCE(v_safe_body, ''{}''::jsonb),\n          ''permanently_failed'',',
    E'          ''{}''::jsonb,\n          COALESCE(v_safe_outbound_body, v_safe_body, ''{}''::jsonb),\n          ''permanently_failed'','
  );

  v_next := replace(
    v_next,
    E'    COALESCE(v_outbound_headers, ''{}''::jsonb),\n    COALESCE(v_safe_body, ''{}''::jsonb),\n    ''pending_edge'',',
    E'    COALESCE(v_outbound_headers, ''{}''::jsonb),\n    COALESCE(v_safe_outbound_body, v_safe_body, ''{}''::jsonb),\n    ''pending_edge'','
  );

  v_next := replace(
    v_next,
    E'      ''api_gateway_route_name'', v_route_row.route_name,\n      ''api_gateway_path_params'', v_path_params,',
    E'      ''api_gateway_route_name'', v_route_row.route_name,\n      ''api_gateway_request_mapping'', COALESCE(v_request_mapping->''mapping'', ''{}''::jsonb),\n      ''api_gateway_request_mapping_applied'', COALESCE((v_request_mapping->>''mapped'')::BOOLEAN, FALSE),\n      ''api_gateway_path_params'', v_path_params,'
  );

  EXECUTE v_next;

  SELECT pg_get_functiondef('public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)'::regprocedure)
    INTO v_def;

  IF position('public.api_gateway_apply_request_mapping_v1(' IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 request mapping patch did not apply';
  END IF;
  IF position('COALESCE(v_safe_outbound_body, v_safe_body, ''{}''::jsonb)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 outbound body mapping patch did not apply';
  END IF;
  IF position('''api_gateway_request_mapping'', COALESCE(v_request_mapping->''mapping'', ''{}''::jsonb)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 mapping lineage context patch did not apply';
  END IF;
END;
$patch$;

DO $patch_workflow_context$
DECLARE
  v_def TEXT;
  v_next TEXT;
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 definition not found for workflow context request mapping patch';
  END IF;

  IF position('public.api_gateway_apply_request_mapping_v1(' IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 must apply API Gateway request mapping before workflow context patch';
  END IF;

  v_next := v_def;

  IF position(E'    ''body'', COALESCE(v_safe_outbound_body, v_safe_body, ''{}''::jsonb),' IN v_next) = 0 THEN
    IF position(E'    ''body'', COALESCE(v_safe_body, ''{}''::jsonb),' IN v_next) = 0 THEN
      RAISE EXCEPTION 'Expected header render context body marker not found in workflow_intake_api_gateway_v1';
    END IF;

    v_next := replace(
      v_next,
      E'    ''body'', COALESCE(v_safe_body, ''{}''::jsonb),',
      E'    ''body'', COALESCE(v_safe_outbound_body, v_safe_body, ''{}''::jsonb),'
    );
  END IF;

  IF position(E'          ''request_body'', COALESCE(v_safe_outbound_body, v_safe_body, ''{}''::jsonb),' IN v_next) = 0 THEN
    IF position(E'          ''request_body'', COALESCE(v_safe_body, ''{}''::jsonb),\n          ''provider_id'', v_provider_id,' IN v_next) = 0 THEN
      RAISE EXCEPTION 'Expected workflow context request_body marker not found in workflow_intake_api_gateway_v1';
    END IF;

    v_next := replace(
      v_next,
      E'          ''request_body'', COALESCE(v_safe_body, ''{}''::jsonb),\n          ''provider_id'', v_provider_id,',
      E'          ''request_body'', COALESCE(v_safe_outbound_body, v_safe_body, ''{}''::jsonb),\n          ''api_gateway_request_mapping'', COALESCE(v_request_mapping->''mapping'', ''{}''::jsonb),\n          ''api_gateway_request_mapping_applied'', COALESCE((v_request_mapping->>''mapped'')::BOOLEAN, FALSE),\n          ''provider_id'', v_provider_id,'
    );
  END IF;

  IF v_next IS DISTINCT FROM v_def THEN
    EXECUTE v_next;
  END IF;

  SELECT pg_get_functiondef('public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)'::regprocedure)
    INTO v_def;

  IF position(E'    ''body'', COALESCE(v_safe_outbound_body, v_safe_body, ''{}''::jsonb),' IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 header render context mapping patch did not apply';
  END IF;
  IF position(E'          ''request_body'', COALESCE(v_safe_outbound_body, v_safe_body, ''{}''::jsonb),' IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 workflow context mapped request body patch did not apply';
  END IF;
  IF position(E'          ''api_gateway_request_mapping'', COALESCE(v_request_mapping->''mapping'', ''{}''::jsonb),' IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 workflow context mapping lineage patch did not apply';
  END IF;
END;
$patch_workflow_context$;

DO $patch_dispatch_context$
DECLARE
  v_def TEXT;
  v_next TEXT;
BEGIN
  SELECT pg_get_functiondef('workflow_handlers.execute_api_gateway_dispatch_outbound_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'execute_api_gateway_dispatch_outbound_v1 definition not found for request mapping context patch';
  END IF;

  IF position(E'      ''api_gateway_request_mapping'', COALESCE(v_api->''api_gateway_request_mapping'', ''{}''::jsonb),' IN v_def) > 0 THEN
    RETURN;
  END IF;

  IF position(E'      ''api_gateway_route_name'', NULLIF(v_api->>''route_name'', ''''),\n      ''api_gateway_path_params'', COALESCE(v_api->''path_params'', ''{}''::jsonb),' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Expected dispatch outbound context marker not found in execute_api_gateway_dispatch_outbound_v1';
  END IF;

  v_next := replace(
    v_def,
    E'      ''api_gateway_route_name'', NULLIF(v_api->>''route_name'', ''''),\n      ''api_gateway_path_params'', COALESCE(v_api->''path_params'', ''{}''::jsonb),',
    E'      ''api_gateway_route_name'', NULLIF(v_api->>''route_name'', ''''),\n      ''api_gateway_request_mapping'', COALESCE(v_api->''api_gateway_request_mapping'', ''{}''::jsonb),\n      ''api_gateway_request_mapping_applied'', COALESCE((v_api->>''api_gateway_request_mapping_applied'')::BOOLEAN, FALSE),\n      ''api_gateway_path_params'', COALESCE(v_api->''path_params'', ''{}''::jsonb),'
  );

  EXECUTE v_next;

  SELECT pg_get_functiondef('workflow_handlers.execute_api_gateway_dispatch_outbound_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    INTO v_def;

  IF position(E'      ''api_gateway_request_mapping'', COALESCE(v_api->''api_gateway_request_mapping'', ''{}''::jsonb),' IN v_def) = 0 THEN
    RAISE EXCEPTION 'execute_api_gateway_dispatch_outbound_v1 mapping lineage context patch did not apply';
  END IF;
END;
$patch_dispatch_context$;

COMMENT ON FUNCTION public.api_gateway_route_request_mapping_v1(public.api_routes, UUID, UUID, UUID, UUID)
  IS 'Resolves the request-mapping Mapping Studio profile bound to an API Gateway route policy.';
COMMENT ON FUNCTION public.api_gateway_apply_request_mapping_v1(public.api_routes, UUID, UUID, UUID, UUID, JSONB)
  IS 'Applies a route-bound api_gateway_inbound mapping config to an inbound API Gateway request payload.';
COMMENT ON FUNCTION public.api_gateway_mapping_target_intent_v1(TEXT)
  IS 'Normalizes Mapping Studio API Gateway inbound targets into canonical API Gateway shipment intents.';
COMMENT ON FUNCTION public.api_gateway_mapping_intents_compatible_v1(TEXT, TEXT)
  IS 'Fail-closed compatibility check between an API Gateway route intent and a request mapping target intent.';
COMMENT ON FUNCTION public.ui_upsert_api_gateway_route_mapping_v1(JSONB)
  IS 'Backend-backed Console RPC for binding an api_gateway_inbound Mapping Studio profile to an API Gateway route.';
COMMENT ON FUNCTION api.ui_upsert_api_gateway_route_mapping_v1(JSONB)
  IS 'Browser-safe wrapper for binding an api_gateway_inbound Mapping Studio profile to an API Gateway route.';
COMMENT ON FUNCTION public.workflow_intake_api_gateway_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB)
  IS 'Intakes authenticated API Gateway requests, resolves route/source/provider context, applies route-bound request mapping, records redacted request readback, and enqueues provider dispatch.';

SELECT pg_advisory_unlock(hashtext('202605300730_api_gateway_request_mapping_resolution_v1'));

COMMIT;
