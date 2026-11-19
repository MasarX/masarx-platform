BEGIN;
SELECT pg_advisory_lock(hashtext('202605041050_console_v2_bank_statement_ingest_ui_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_record_bank_statement_event_v1(
  p_args JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args JSONB := COALESCE(p_args, '{}'::jsonb);
  v_org_id UUID := public.current_user_org_id();
  v_requested_org_id UUID := NULL;
  v_bank_account_id UUID := NULL;
  v_bank_account_key TEXT := lower(NULLIF(btrim(COALESCE(v_args->>'bank_account_key', '')), ''));
  v_resolved_bank_account_id UUID := NULL;
  v_resolved_bank_account_key TEXT := NULL;
  v_metadata JSONB := COALESCE(v_args->'metadata', '{}'::jsonb);
  v_payload JSONB;
  v_result RECORD;
BEGIN
  IF jsonb_typeof(v_args) <> 'object' THEN
    RAISE EXCEPTION 'ui_record_bank_statement_event_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_record_bank_statement_event_v1 requires authenticated organization scope'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_requested_org_id := NULLIF(v_args->>'organization_id', '')::uuid;
  EXCEPTION WHEN others THEN
    v_requested_org_id := NULL;
  END;

  IF v_requested_org_id IS NOT NULL AND v_requested_org_id IS DISTINCT FROM v_org_id THEN
    RAISE EXCEPTION 'ui_record_bank_statement_event_v1 cannot ingest statement lines for another organization'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_capability_v1('finance.write', 'tenant', v_org_id) THEN
    RAISE EXCEPTION 'ui_record_bank_statement_event_v1 requires finance.write capability'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_bank_account_id := NULLIF(v_args->>'bank_account_id', '')::uuid;
  EXCEPTION WHEN others THEN
    v_bank_account_id := NULL;
  END;

  SELECT ba.id, ba.key
    INTO v_resolved_bank_account_id, v_resolved_bank_account_key
    FROM public.bank_accounts ba
   WHERE ba.organization_id = v_org_id
     AND ba.is_active IS TRUE
     AND (
       (v_bank_account_id IS NOT NULL AND ba.id = v_bank_account_id)
       OR (v_bank_account_key IS NOT NULL AND ba.key = v_bank_account_key)
     )
   LIMIT 1;

  IF v_resolved_bank_account_id IS NULL THEN
    RAISE EXCEPTION 'ui_record_bank_statement_event_v1 requires an active bank account in the caller organization'
      USING ERRCODE = '23514';
  END IF;

  IF v_bank_account_id IS NOT NULL AND v_resolved_bank_account_id IS DISTINCT FROM v_bank_account_id THEN
    RAISE EXCEPTION 'ui_record_bank_statement_event_v1 bank_account_id does not match bank_account_key'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(v_metadata) <> 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  v_payload :=
    v_args
    || jsonb_build_object(
      'organization_id', v_org_id,
      'bank_account_id', v_resolved_bank_account_id,
      'bank_account_key', v_resolved_bank_account_key,
      'metadata',
        v_metadata || jsonb_strip_nulls(jsonb_build_object(
          'ingested_via', 'console_v2_bank_recon',
          'ingested_by_user_id', auth.uid()
        ))
    );

  SELECT finance_event_id, created, decision_log_id
    INTO v_result
    FROM public.record_bank_statement_event_v1(v_payload)
   LIMIT 1;

  IF v_result.finance_event_id IS NULL THEN
    RAISE EXCEPTION 'ui_record_bank_statement_event_v1 did not return a finance_event_id'
      USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'finance_event_id', v_result.finance_event_id,
    'created', COALESCE(v_result.created, FALSE),
    'decision_log_id', v_result.decision_log_id,
    'correlation_id', public.current_correlation_id(),
    'settings_resolution_id', NULL
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_record_bank_statement_event_v1(JSONB) IS
  'Browser-safe Console V2 bank statement ingestion wrapper. Requires finance.write, scopes to current_user_org_id, validates active bank account ownership, then delegates to service-only record_bank_statement_event_v1.';

REVOKE ALL ON FUNCTION public.ui_record_bank_statement_event_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_record_bank_statement_event_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_record_bank_statement_event_v1(JSONB) TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_record_bank_statement_event_v1(
  p_args JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_record_bank_statement_event_v1($1);
$function$;

COMMENT ON FUNCTION api.ui_record_bank_statement_event_v1(JSONB) IS
  'api schema wrapper for browser clients using db.schema=api. Delegates to public.ui_record_bank_statement_event_v1.';

REVOKE ALL ON FUNCTION api.ui_record_bank_statement_event_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_record_bank_statement_event_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_record_bank_statement_event_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605041050_console_v2_bank_statement_ingest_ui_v1'));
COMMIT;
