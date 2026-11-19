-- Console V2 webhook source token rotation must write a UUID-shaped
-- correlation_id to decision/domain ledgers. The original B6 RPC minted a
-- 16-character hex string then cast it to uuid, which fails at runtime.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605120430_webhook_source_rotate_uuid_correlation_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.ui_rotate_webhook_source_token_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_resource_id UUID := NULLIF(p_args->>'source_id', '')::uuid;
  v_before public.webhook_sources%ROWTYPE;
  v_minted_token TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_rotate_webhook_source_token_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('webhooks.write');

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'ui_rotate_webhook_source_token_v1 requires source_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_before
    FROM public.webhook_sources
   WHERE id = v_resource_id
   FOR UPDATE;

  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'ui_rotate_webhook_source_token_v1 webhook_source % not found', v_resource_id
      USING ERRCODE = '23503';
  END IF;

  IF v_org_id IS NOT NULL
     AND v_before.organization_id <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'ui_rotate_webhook_source_token_v1 webhook_source % outside tenant scope', v_resource_id
      USING ERRCODE = '42501';
  END IF;

  v_minted_token := encode(gen_random_bytes(32), 'hex');

  UPDATE public.webhook_sources
     SET auth_token = v_minted_token,
         updated_at = now()
   WHERE id = v_resource_id;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_before.organization_id,
    'webhooks.rotate_source_token', 'webhook_source', v_resource_id,
    'ui_rotate_webhook_source_token_v1', 'rotated',
    '{}'::jsonb,
    'ui_rotate_webhook_source_token_v1', v_correlation_id
  );

  IF v_before.organization_id IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_before.organization_id, 'webhook_source.token_rotated', 'webhook_source', v_resource_id,
      '{}'::jsonb, v_correlation_id, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'webhook_source_id', v_resource_id,
    'auth_token', v_minted_token,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_rotate_webhook_source_token_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_rotate_webhook_source_token_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_rotate_webhook_source_token_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_rotate_webhook_source_token_v1(jsonb)
  IS 'Canonical write RPC: rotate webhook_sources.auth_token (returned ONCE; bcrypt hash persisted via trigger) with UUID correlation lineage. Capability: webhooks.write.';

SELECT pg_advisory_unlock(hashtext('202605120430_webhook_source_rotate_uuid_correlation_v1'));
COMMIT;
