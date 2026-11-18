-- Console V2 Plugin Studio: route shipment-create API plugins through
-- shipment materialization plus first-label queueing by row-driven policy.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605222350_plugin_activation_shipment_label_defaults_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $policy$
DECLARE
  v_setting RECORD;
  v_value JSONB;
  v_route_policy JSONB := jsonb_build_object(
    'postprocess', jsonb_build_object(
      'enabled', TRUE,
      'mode', 'shipment_create_v1',
      'extract', jsonb_build_object(
        'provider_shipment_id_path', 'id',
        'provider_reference_id_path', 'id',
        'provider_tracking_number_path', 'barcode',
        'recipient_name_path', 'recipient.name',
        'recipient_phone_path', 'recipient.phone',
        'box_count_path', 'pieces',
        'cod_amount_path', 'cod_amount',
        'client_reference_path', 'client_reference_number',
        'service_type_path', 'service_type',
        'service_level_path', 'service_level',
        'special_instructions_path', 'special_instructions',
        'promised_delivery_date_path', 'promised_delivery_date'
      ),
      'label', jsonb_build_object(
        'enabled', TRUE,
        'label_type', 'shipping'
      )
    )
  );
BEGIN
  FOR v_setting IN
    SELECT s.scope_type, s.scope_id, s.cached_value
      FROM public.settings s
     WHERE s.category = 'integration_plugin_policy'
  LOOP
    v_value := public.jsonb_deep_merge(
      COALESCE(v_setting.cached_value, '{}'::jsonb),
      jsonb_build_object(
        'studio_defaults', jsonb_build_object(
          'route_policy', jsonb_build_object(
            'api', v_route_policy
          )
        )
      )
    );

    PERFORM public.upsert_settings_value_v1(
      'integration_plugin_policy',
      v_setting.scope_type,
      v_setting.scope_id,
      v_value,
      1,
      'Console V2 Plugin Studio API shipment label defaults'
    );
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'integration_plugin_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
  ) THEN
    PERFORM public.upsert_settings_value_v1(
      'integration_plugin_policy',
      'global',
      NULL,
      jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'studio_defaults', jsonb_build_object(
          'route_policy', jsonb_build_object('api', v_route_policy)
        )
      ),
      1,
      'Console V2 Plugin Studio API shipment label defaults'
    );
  END IF;
END;
$policy$;

CREATE OR REPLACE FUNCTION public.integration_plugin_default_route_policy_v1(
  p_plugin_kind TEXT,
  p_workflow_binding JSONB DEFAULT '{}'::jsonb,
  p_organization_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_kind TEXT := lower(COALESCE(NULLIF(btrim(p_plugin_kind), ''), ''));
  v_policy JSONB := public.integration_plugin_resolve_policy_v1('integration_plugin_policy', p_organization_id);
  v_route_policy JSONB;
  v_template_name TEXT := public.integration_plugin_resolve_template_name_v1(COALESCE(p_workflow_binding, '{}'::jsonb));
  v_intent TEXT := lower(NULLIF(btrim(COALESCE(
    p_workflow_binding #>> '{workflow,intent}',
    p_workflow_binding #>> '{intent}',
    p_workflow_binding #>> '{canonical_intent}'
  )), ''));
BEGIN
  IF v_kind = '' THEN
    RETURN '{}'::jsonb;
  END IF;

  v_route_policy := COALESCE(v_policy #> ARRAY['studio_defaults', 'route_policy', v_kind], '{}'::jsonb);
  IF jsonb_typeof(v_route_policy) <> 'object' THEN
    RETURN '{}'::jsonb;
  END IF;

  IF v_kind = 'api'
     AND (
       v_intent = 'shipment.create'
       OR v_template_name = 'api_gateway_shipment_create_default_v1'
     )
  THEN
    RETURN v_route_policy;
  END IF;

  RETURN '{}'::jsonb;
END;
$function$;

COMMENT ON FUNCTION public.integration_plugin_default_route_policy_v1(TEXT, JSONB, UUID)
  IS 'Resolves row-driven default API route policy for Plugin Studio activations, including shipment-create label queueing defaults.';

REVOKE ALL ON FUNCTION public.integration_plugin_default_route_policy_v1(TEXT, JSONB, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_default_route_policy_v1(TEXT, JSONB, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.integration_plugin_default_route_policy_v1(TEXT, JSONB, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.integration_plugin_default_route_policy_v1(TEXT, JSONB, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.integration_plugin_resolve_api_route_path_v1(
  p_plugin_key TEXT,
  p_plugin_version_id UUID,
  p_method TEXT,
  p_path_template TEXT,
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_method TEXT := upper(COALESCE(NULLIF(btrim(p_method), ''), 'POST'));
  v_scope_type TEXT := COALESCE(NULLIF(btrim(p_scope_type), ''), 'tenant');
  v_path TEXT := COALESCE(NULLIF(btrim(p_path_template), ''), '/');
  v_slug TEXT := COALESCE(NULLIF(regexp_replace(lower(COALESCE(NULLIF(btrim(p_plugin_key), ''), 'plugin')), '[^a-z0-9_-]+', '-', 'g'), ''), 'plugin');
  v_suffix TEXT := replace(left(COALESCE(p_plugin_version_id::text, gen_random_uuid()::text), 8), '-', '');
  v_candidate TEXT;
BEGIN
  IF left(v_path, 1) <> '/' THEN
    v_path := '/' || v_path;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.api_routes ar
     WHERE upper(ar.method) = v_method
       AND ar.path_template = v_path
       AND ar.scope_type = v_scope_type
       AND COALESCE(ar.scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
           = COALESCE(p_scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) THEN
    RETURN v_path;
  END IF;

  v_candidate := '/plugins/' || v_slug || v_path;
  IF NOT EXISTS (
    SELECT 1
      FROM public.api_routes ar
     WHERE upper(ar.method) = v_method
       AND ar.path_template = v_candidate
       AND ar.scope_type = v_scope_type
       AND COALESCE(ar.scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
           = COALESCE(p_scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) THEN
    RETURN v_candidate;
  END IF;

  RETURN '/plugins/' || v_slug || '/' || v_suffix || v_path;
END;
$function$;

COMMENT ON FUNCTION public.integration_plugin_resolve_api_route_path_v1(TEXT, UUID, TEXT, TEXT, TEXT, UUID)
  IS 'Resolves Plugin Studio API route path collisions by retaining the operator path when unique and namespacing under /plugins/{plugin_key} when already claimed.';

REVOKE ALL ON FUNCTION public.integration_plugin_resolve_api_route_path_v1(TEXT, UUID, TEXT, TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_resolve_api_route_path_v1(TEXT, UUID, TEXT, TEXT, TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.integration_plugin_resolve_api_route_path_v1(TEXT, UUID, TEXT, TEXT, TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.integration_plugin_resolve_api_route_path_v1(TEXT, UUID, TEXT, TEXT, TEXT, UUID) TO service_role;

DO $patch$
DECLARE
  v_def TEXT;
  v_from TEXT := $from$    v_route_policy := COALESCE(v_version.inbound_config #> '{route,policy}', '{}'::jsonb);
    v_route_policy := jsonb_set(v_route_policy, '{workflow,enabled}', 'true'::jsonb, TRUE);
$from$;
  v_to TEXT := $to$    v_route_policy := public.jsonb_deep_merge(
      public.integration_plugin_default_route_policy_v1(
        v_plugin.plugin_kind,
        COALESCE(v_version.workflow_binding, '{}'::jsonb),
        v_plugin.organization_id
      ),
      COALESCE(v_version.inbound_config #> '{route,policy}', '{}'::jsonb)
    );
    v_route_policy := jsonb_set(v_route_policy, '{workflow,enabled}', 'true'::jsonb, TRUE);
$to$;
  v_from_object_guard TEXT := $from$    v_route_policy := COALESCE(v_version.inbound_config #> '{route,policy}', '{}'::jsonb);
    IF jsonb_typeof(v_route_policy) <> 'object' THEN
      v_route_policy := '{}'::jsonb;
    END IF;
$from$;
  v_to_object_guard TEXT := $to$    v_route_policy := public.jsonb_deep_merge(
      public.integration_plugin_default_route_policy_v1(
        v_plugin.plugin_kind,
        COALESCE(v_version.workflow_binding, '{}'::jsonb),
        v_plugin.organization_id
      ),
      COALESCE(v_version.inbound_config #> '{route,policy}', '{}'::jsonb)
    );
    IF jsonb_typeof(v_route_policy) <> 'object' THEN
      v_route_policy := '{}'::jsonb;
    END IF;
$to$;
BEGIN
  SELECT pg_get_functiondef('public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 definition not found';
  END IF;

  IF position('integration_plugin_default_route_policy_v1(' IN v_def) = 0 THEN
    IF position(v_from_object_guard IN v_def) > 0 THEN
      v_def := replace(v_def, v_from_object_guard, v_to_object_guard);
    ELSIF position(v_from IN v_def) > 0 THEN
      v_def := replace(v_def, v_from, v_to);
    ELSE
      RAISE EXCEPTION 'integration_plugin_activate_core_v1 route policy marker not found';
    END IF;
    EXECUTE v_def;
  END IF;
END;
$patch$;

DO $route_path_patch$
DECLARE
  v_def TEXT;
  v_from TEXT := $from$    v_upstream_path_template := COALESCE(
      NULLIF(v_version.inbound_config #>> '{route,upstream_path_template}', ''),
      v_path_template
    );

    v_route_policy := public.jsonb_deep_merge(
$from$;
  v_to TEXT := $to$    v_upstream_path_template := COALESCE(
      NULLIF(v_version.inbound_config #>> '{route,upstream_path_template}', ''),
      v_path_template
    );
    v_path_template := public.integration_plugin_resolve_api_route_path_v1(
      v_plugin.plugin_key,
      v_version.id,
      v_method,
      v_path_template,
      v_scope_type,
      v_scope_id
    );

    v_route_policy := public.jsonb_deep_merge(
$to$;
  v_from_legacy TEXT := $from$    v_upstream_path_template := COALESCE(
      NULLIF(v_version.inbound_config #>> '{route,upstream_path_template}', ''),
      v_path_template
    );

    v_route_policy := COALESCE(v_version.inbound_config #> '{route,policy}', '{}'::jsonb);
$from$;
  v_to_legacy TEXT := $to$    v_upstream_path_template := COALESCE(
      NULLIF(v_version.inbound_config #>> '{route,upstream_path_template}', ''),
      v_path_template
    );
    v_path_template := public.integration_plugin_resolve_api_route_path_v1(
      v_plugin.plugin_key,
      v_version.id,
      v_method,
      v_path_template,
      v_scope_type,
      v_scope_id
    );

    v_route_policy := COALESCE(v_version.inbound_config #> '{route,policy}', '{}'::jsonb);
$to$;
BEGIN
  SELECT pg_get_functiondef('public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 definition not found';
  END IF;

  IF position('integration_plugin_resolve_api_route_path_v1(' IN v_def) = 0 THEN
    IF position(v_from IN v_def) > 0 THEN
      v_def := replace(v_def, v_from, v_to);
    ELSIF position(v_from_legacy IN v_def) > 0 THEN
      v_def := replace(v_def, v_from_legacy, v_to_legacy);
    ELSE
      RAISE EXCEPTION 'integration_plugin_activate_core_v1 route path marker not found';
    END IF;
    EXECUTE v_def;
  END IF;
END;
$route_path_patch$;

UPDATE public.api_routes ar
   SET policy = public.jsonb_deep_merge(
       public.integration_plugin_default_route_policy_v1(
         p.plugin_kind,
         COALESCE(pv.workflow_binding, '{}'::jsonb),
         p.organization_id
       ),
       COALESCE(ar.policy, '{}'::jsonb)
     ),
       updated_at = now()
  FROM public.integration_plugin_versions pv
  JOIN public.integration_plugins p
    ON p.id = pv.plugin_id
 WHERE ar.managed_by = 'integration_plugin'
   AND ar.enabled = TRUE
   AND ar.managed_metadata->>'plugin_version_id' = pv.id::text
   AND public.api_gateway_route_canonical_intent_v1(COALESCE(ar.policy, '{}'::jsonb)) = 'shipment.create'
   AND public.integration_plugin_default_route_policy_v1(
         p.plugin_kind,
         COALESCE(pv.workflow_binding, '{}'::jsonb),
         p.organization_id
       ) <> '{}'::jsonb;

DO $validate_patch$
DECLARE
  v_def TEXT;
  v_declare_from TEXT := $from$  v_security_policy JSONB;
  v_allowed_auth_modes TEXT[] := ARRAY[]::TEXT[];
$from$;
  v_declare_to TEXT := $to$  v_security_policy JSONB;
  v_egress_policy JSONB;
  v_enforce_https_only BOOLEAN := TRUE;
  v_http_allowed_hosts TEXT[] := ARRAY[]::TEXT[];
  v_url_host TEXT;
  v_allowed_http_host TEXT;
  v_allowed_http BOOLEAN;
  v_allowed_auth_modes TEXT[] := ARRAY[]::TEXT[];
$to$;
  v_policy_from TEXT := $from$  v_policy := public.integration_plugin_resolve_policy_v1('integration_plugin_policy', v_plugin.organization_id);
  v_security_policy := public.integration_plugin_resolve_policy_v1('integration_plugin_security_policy', v_plugin.organization_id);

  SELECT COALESCE(array_agg(mode_value), ARRAY[]::TEXT[])
$from$;
  v_policy_to TEXT := $to$  v_policy := public.integration_plugin_resolve_policy_v1('integration_plugin_policy', v_plugin.organization_id);
  v_security_policy := public.integration_plugin_resolve_policy_v1('integration_plugin_security_policy', v_plugin.organization_id);
  v_egress_policy := public.integration_plugin_resolve_policy_v1('integration_plugin_egress_policy', v_plugin.organization_id);
  v_enforce_https_only := COALESCE((v_egress_policy->>'enforce_https_only')::BOOLEAN, TRUE);

  SELECT COALESCE(array_agg(lower(host_value)), ARRAY[]::TEXT[])
    INTO v_http_allowed_hosts
    FROM jsonb_array_elements_text(COALESCE(v_egress_policy->'http_allowed_hosts', '[]'::jsonb)) AS host_value;

  SELECT COALESCE(array_agg(mode_value), ARRAY[]::TEXT[])
$to$;
  v_https_from TEXT := $from$      IF NULLIF(COALESCE(v_op->>'url_template', ''), '') IS NOT NULL
         AND lower(v_op->>'url_template') !~ '^https://'
      THEN
        v_errors := array_append(v_errors, format('outbound_operations[%s].url_template must use https://', v_idx));
      END IF;
$from$;
  v_https_to TEXT := $to$      IF NULLIF(COALESCE(v_op->>'url_template', ''), '') IS NOT NULL
         AND lower(v_op->>'url_template') !~ '^https://'
      THEN
        v_url_host := lower(COALESCE(substring(v_op->>'url_template' FROM '^https?://([^/:]+)'), ''));
        v_allowed_http := FALSE;
        FOREACH v_allowed_http_host IN ARRAY v_http_allowed_hosts
        LOOP
          IF v_allowed_http_host = v_url_host THEN
            v_allowed_http := TRUE;
            EXIT;
          END IF;
        END LOOP;

        IF v_enforce_https_only IS TRUE AND v_allowed_http IS FALSE THEN
          v_errors := array_append(
            v_errors,
            format('outbound_operations[%s].url_template must use https:// or an integration_plugin_egress_policy.http_allowed_hosts entry', v_idx)
          );
        END IF;
      END IF;
$to$;
BEGIN
  SELECT pg_get_functiondef('public.integration_plugin_validate_v1(uuid,jsonb,boolean)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'integration_plugin_validate_v1 definition not found';
  END IF;

  IF position('v_egress_policy JSONB' IN v_def) = 0 THEN
    IF position(v_declare_from IN v_def) = 0 THEN
      RAISE EXCEPTION 'integration_plugin_validate_v1 declaration marker not found';
    END IF;
    v_def := replace(v_def, v_declare_from, v_declare_to);
  END IF;

  IF position($marker$jsonb_array_elements_text(COALESCE(v_egress_policy->'http_allowed_hosts'$marker$ IN v_def) = 0 THEN
    IF position(v_policy_from IN v_def) = 0 THEN
      RAISE EXCEPTION 'integration_plugin_validate_v1 policy marker not found';
    END IF;
    v_def := replace(v_def, v_policy_from, v_policy_to);
  END IF;

  IF position('integration_plugin_egress_policy.http_allowed_hosts' IN v_def) = 0 THEN
    IF position(v_https_from IN v_def) = 0 THEN
      RAISE EXCEPTION 'integration_plugin_validate_v1 https marker not found';
    END IF;
    v_def := replace(v_def, v_https_from, v_https_to);
  END IF;

  EXECUTE v_def;
END;
$validate_patch$;

DO $effective_egress_patch$
DECLARE
  v_def TEXT;
  v_from TEXT := $from$      'domain_denylist', public.jsonb_text_array_union_v1(v_base_policy->'domain_denylist', v_plugin_policy->'domain_denylist')
    ));
$from$;
  v_to TEXT := $to$      'domain_denylist', public.jsonb_text_array_union_v1(v_base_policy->'domain_denylist', v_plugin_policy->'domain_denylist'),
      'http_allowed_hosts', public.jsonb_text_array_union_v1(v_base_policy->'http_allowed_hosts', v_plugin_policy->'http_allowed_hosts')
    ));
$to$;
BEGIN
  SELECT pg_get_functiondef('public.resolve_effective_outbound_egress_policy_v1(uuid)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'resolve_effective_outbound_egress_policy_v1 definition not found';
  END IF;

  IF position('http_allowed_hosts' IN v_def) = 0 THEN
    IF position(v_from IN v_def) = 0 THEN
      RAISE EXCEPTION 'resolve_effective_outbound_egress_policy_v1 policy marker not found';
    END IF;
    v_def := replace(v_def, v_from, v_to);
    EXECUTE v_def;
  END IF;
END;
$effective_egress_patch$;

SELECT pg_advisory_unlock(hashtext('202605222350_plugin_activation_shipment_label_defaults_v1'));
COMMIT;
