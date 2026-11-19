-- Console V2 webhook remediation: create a fresh intake attempt from a failed
-- inbox row only when the backend can do so without mutating terminal failure
-- truth or replaying a stale idempotency response.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605151145_webhook_inbox_retry_as_new_intake_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, status)
SELECT
  ld.id,
  'retry_as_new_intake',
  'Create fresh intake',
  'Operator-created fresh webhook intake attempt from a failed inbox row.',
  30,
  false,
  'active'
FROM public.lookup_definitions ld
WHERE ld.category = 'webhook_inbox_replay_action'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    retired_at = NULL,
    updated_at = now();

UPDATE public.lookup_column_contracts
   SET allowed_values = ARRAY['replay', 'force_status', 'retry_as_new_intake'],
       updated_at = now()
 WHERE table_schema = 'public'
   AND table_name = 'webhook_inbox_replays'
   AND column_name = 'action';

ALTER TABLE public.webhook_inbox_replays
  DROP CONSTRAINT IF EXISTS webhook_inbox_replays_action_ck;

ALTER TABLE public.webhook_inbox_replays
  ADD CONSTRAINT webhook_inbox_replays_action_ck CHECK (
    action IN ('replay', 'force_status', 'retry_as_new_intake')
  );

CREATE OR REPLACE FUNCTION public.ui_retry_webhook_inbox_as_new_intake_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_actor_org_id UUID := public.current_user_org_id();
  v_original_id UUID := NULLIF(p_args->>'webhook_inbox_id', '')::UUID;
  v_reason TEXT := COALESCE(NULLIF(btrim(p_args->>'reason'), ''), 'operator_create_fresh_intake');
  v_original public.webhook_inbox%ROWTYPE;
  v_source public.webhook_sources%ROWTYPE;
  v_policy RECORD;
  v_policy_body JSONB := '{}'::jsonb;
  v_hmac_config JSONB := '{}'::jsonb;
  v_headers JSONB := '{}'::jsonb;
  v_idempotency_header TEXT := 'idempotency-key';
  v_new_idempotency_key TEXT;
  v_result JSONB := '{}'::jsonb;
  v_new_webhook_id UUID;
  v_decision_id UUID := gen_random_uuid();
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_retry_webhook_inbox_as_new_intake_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('webhooks.write');

  IF v_original_id IS NULL THEN
    RAISE EXCEPTION 'ui_retry_webhook_inbox_as_new_intake_v1 requires webhook_inbox_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_original
    FROM public.webhook_inbox
   WHERE id = v_original_id
   FOR UPDATE;

  IF v_original.id IS NULL THEN
    RAISE EXCEPTION 'ui_retry_webhook_inbox_as_new_intake_v1 webhook_inbox % not found', v_original_id
      USING ERRCODE = '23503';
  END IF;

  SELECT * INTO v_source
    FROM public.webhook_sources
   WHERE id = v_original.webhook_source_id;

  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'ui_retry_webhook_inbox_as_new_intake_v1 webhook source missing for inbox %', v_original_id
      USING ERRCODE = '23503';
  END IF;

  IF v_actor_org_id IS NOT NULL
     AND v_source.organization_id <> v_actor_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'ui_retry_webhook_inbox_as_new_intake_v1 webhook_inbox % outside tenant scope', v_original_id
      USING ERRCODE = '42501';
  END IF;

  IF v_original.processing_status NOT IN ('failed', 'dead_letter') THEN
    RAISE EXCEPTION 'ui_retry_webhook_inbox_as_new_intake_v1 requires failed or dead_letter webhook_inbox, got %', v_original.processing_status
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_policy
    FROM public.resolve_webhook_ingest_policy(p_webhook_source_id := v_source.id)
   LIMIT 1;
  v_policy_body := COALESCE(v_policy.policy, '{}'::jsonb);
  v_hmac_config := COALESCE(v_policy_body#>'{validation,hmac}', '{}'::jsonb);

  IF v_source.enabled IS DISTINCT FROM TRUE THEN
    v_result := jsonb_build_object(
      'ok', true,
      'status', 'external_resend_required',
      'retry_queued', false,
      'reason', 'webhook_source_disabled',
      'webhook_inbox_id', v_original_id
    );
  ELSIF NULLIF(v_source.auth_token, '') IS NULL THEN
    v_result := jsonb_build_object(
      'ok', true,
      'status', 'external_resend_required',
      'retry_queued', false,
      'reason', 'source_token_not_recoverable',
      'webhook_inbox_id', v_original_id
    );
  ELSIF COALESCE((v_hmac_config->>'enabled')::BOOLEAN, FALSE) IS TRUE THEN
    v_result := jsonb_build_object(
      'ok', true,
      'status', 'external_resend_required',
      'retry_queued', false,
      'reason', 'hmac_requires_original_request_body',
      'webhook_inbox_id', v_original_id
    );
  ELSE
    v_idempotency_header := lower(COALESCE(NULLIF(v_policy_body#>>'{validation,idempotency,header}', ''), 'Idempotency-Key'));
    v_new_idempotency_key := format('console-fresh-intake:%s:%s', v_original_id, gen_random_uuid());
    v_headers := COALESCE(v_original.headers, '{}'::jsonb)
      - ARRAY['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-webhook-token', 'x-internal-edge-token'];
    v_headers := jsonb_set(v_headers, ARRAY[v_idempotency_header], to_jsonb(v_new_idempotency_key), TRUE);
    v_headers := jsonb_set(v_headers, ARRAY['x-masarx-remediation-from'], to_jsonb(v_original_id::TEXT), TRUE);

    v_result := public.workflow_intake_webhook_core_v1(
      v_source.auth_token,
      v_headers,
      COALESCE(v_original.raw_payload, '{}'::jsonb)::TEXT,
      COALESCE(v_original.raw_payload, '{}'::jsonb)
    );

    BEGIN
      v_new_webhook_id := NULLIF(v_result->>'webhook_id', '')::UUID;
    EXCEPTION WHEN others THEN
      v_new_webhook_id := NULL;
    END;

    v_result := jsonb_strip_nulls(v_result || jsonb_build_object(
      'ok', TRUE,
      'status', CASE WHEN v_new_webhook_id IS NULL THEN 'new_intake_not_created' ELSE 'new_intake_started' END,
      'retry_queued', v_new_webhook_id IS NOT NULL,
      'webhook_inbox_id', v_original_id,
      'original_webhook_inbox_id', v_original_id,
      'new_webhook_inbox_id', v_new_webhook_id,
      'new_idempotency_key', v_new_idempotency_key,
      'correlation_id', v_correlation_id::TEXT
    ));
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, decision_reason,
    performed_by_system, correlation_id
  ) VALUES (
    v_decision_id,
    v_source.organization_id,
    'webhooks.replay',
    'webhook_inbox',
    v_original_id,
    'ui_retry_webhook_inbox_as_new_intake_v1',
    COALESCE(v_result->>'status', 'new_intake_unknown'),
    jsonb_strip_nulls(jsonb_build_object(
      'prior_status', v_original.processing_status,
      'reason', v_reason,
      'new_webhook_inbox_id', NULLIF(v_result->>'new_webhook_inbox_id', ''),
      'new_idempotency_key', NULLIF(v_result->>'new_idempotency_key', ''),
      'backend_reason', NULLIF(v_result->>'reason', ''),
      'ack_outcome', NULLIF(v_result->>'ack_outcome', ''),
      'response_outcome', NULLIF(v_result->>'response_outcome', '')
    )),
    CASE
      WHEN v_result->>'status' = 'new_intake_started' THEN 'Operator created a fresh webhook intake attempt from a failed inbox row.'
      ELSE 'Operator requested fresh webhook intake, but backend requires an external resend.'
    END,
    'ui_retry_webhook_inbox_as_new_intake_v1',
    v_correlation_id
  );

  INSERT INTO public.webhook_inbox_replays (
    webhook_inbox_id, organization_id, webhook_source_id, action,
    prior_status, forced_status, reason, changed_by, correlation_id, decision_log_id
  ) VALUES (
    v_original_id,
    v_source.organization_id,
    v_source.id,
    'retry_as_new_intake',
    v_original.processing_status,
    NULLIF(v_result->>'status', ''),
    v_reason,
    v_user_id,
    v_correlation_id::TEXT,
    v_decision_id
  );

  RETURN v_result || jsonb_build_object('settings_resolution_id', v_decision_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_retry_webhook_inbox_as_new_intake_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_retry_webhook_inbox_as_new_intake_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_retry_webhook_inbox_as_new_intake_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_retry_webhook_inbox_as_new_intake_v1(jsonb)
  IS 'Console V2 remediation RPC: preserve a failed webhook_inbox row and create a separate fresh intake attempt only when safe; otherwise return external_resend_required. Capability: webhooks.write.';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_retry_webhook_inbox_as_new_intake_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$
  SELECT public.ui_retry_webhook_inbox_as_new_intake_v1(COALESCE(p_args, '{}'::jsonb));
$wrapper$;

REVOKE ALL ON FUNCTION api.ui_retry_webhook_inbox_as_new_intake_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_retry_webhook_inbox_as_new_intake_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_retry_webhook_inbox_as_new_intake_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION api.ui_retry_webhook_inbox_as_new_intake_v1(jsonb)
  IS 'Console V2 api-schema wrapper for backend-backed webhook fresh-intake remediation.';

SELECT pg_advisory_unlock(hashtext('202605151145_webhook_inbox_retry_as_new_intake_v1'));

COMMIT;
