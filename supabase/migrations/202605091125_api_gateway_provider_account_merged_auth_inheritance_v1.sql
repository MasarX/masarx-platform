-- Console V2 API gateway provider-account auth inheritance.
--
-- Purpose:
--   First-tenant API shipment intake can resolve a sender/source scoped
--   provider-account row that carries operational account data such as
--   company_id, while the actual auth_config_id is bound at tenant scope by
--   Console V2 credential setup. API gateway must dispatch from the merged
--   row-driven settings value instead of treating that valid setup as
--   provider_auth_config_ambiguous.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605091125_api_gateway_provider_account_merged_auth_inheritance_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $patch$
DECLARE
  v_def TEXT;
  v_new TEXT;
  v_marker TEXT := $marker$      LIMIT 1;

    IF v_provider_account_settings_id IS NOT NULL THEN$marker$;
  v_replacement TEXT := $replacement$      LIMIT 1;

    -- Console V2 first-tenant API intake can bind credentials at tenant scope
    -- while sender/source defaults carry provider account values such as
    -- company_id. Use the canonical merged ladder value for dispatch inputs,
    -- while preserving the winning row metadata for settings-resolution logs.
    IF v_provider_account_settings_id IS NOT NULL THEN
      v_provider_account := COALESCE(
        NULLIF(
          public.resolve_settings_merged_from_context(
            v_provider_account_category,
            jsonb_strip_nulls(jsonb_build_object(
              'organization_id', v_org,
              'client_id', v_client,
              'sender_id', v_sender,
              'webhook_source_id', v_source.id
            ))
          ),
          '{}'::jsonb
        ),
        v_provider_account
      );$replacement$;
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 definition not found';
  END IF;

  IF position('Use the canonical merged ladder value for dispatch inputs' IN v_def) > 0 THEN
    RAISE NOTICE 'workflow_intake_api_gateway_v1 already uses merged provider-account settings';
    RETURN;
  END IF;

  IF position(v_marker IN v_def) = 0 THEN
    RAISE EXCEPTION 'Expected provider-account settings resolution marker not found in workflow_intake_api_gateway_v1';
  END IF;

  v_new := replace(v_def, v_marker, v_replacement);
  EXECUTE v_new;
END;
$patch$;

COMMENT ON FUNCTION public.workflow_intake_api_gateway_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB)
  IS 'API Gateway intake: resolve route/provider account, persist redacted request, queue outbound dispatch, and inherit provider-account auth_config_id from merged row-driven settings when more-specific rows carry only operational account data.';

SELECT pg_advisory_unlock(hashtext('202605091125_api_gateway_provider_account_merged_auth_inheritance_v1'));

COMMIT;
