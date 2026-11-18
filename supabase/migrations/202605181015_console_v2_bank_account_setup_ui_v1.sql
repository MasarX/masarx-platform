BEGIN;
SELECT pg_advisory_lock(hashtext('202605181015_console_v2_bank_account_setup_ui_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_create_bank_account_v1(
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
  v_key TEXT := lower(NULLIF(btrim(COALESCE(v_args->>'key', '')), ''));
  v_name TEXT := NULLIF(btrim(COALESCE(v_args->>'name', '')), '');
  v_bank_name TEXT := NULLIF(btrim(COALESCE(v_args->>'bank_name', '')), '');
  v_currency TEXT := upper(NULLIF(btrim(COALESCE(v_args->>'currency', '')), ''));
  v_iban_last4 TEXT := NULLIF(regexp_replace(COALESCE(v_args->>'iban_last4', ''), '\s+', '', 'g'), '');
  v_account_last4 TEXT := NULLIF(regexp_replace(COALESCE(v_args->>'account_last4', ''), '\s+', '', 'g'), '');
  v_metadata JSONB := COALESCE(v_args->'metadata', '{}'::jsonb);
  v_row public.bank_accounts%ROWTYPE;
BEGIN
  IF jsonb_typeof(v_args) <> 'object' THEN
    RAISE EXCEPTION 'ui_create_bank_account_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_bank_account_v1 requires authenticated organization scope'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_requested_org_id := NULLIF(v_args->>'organization_id', '')::uuid;
  EXCEPTION WHEN others THEN
    v_requested_org_id := NULL;
  END;

  IF v_requested_org_id IS NOT NULL AND v_requested_org_id IS DISTINCT FROM v_org_id THEN
    RAISE EXCEPTION 'ui_create_bank_account_v1 cannot create a bank account for another organization'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_capability_v1('finance.write', 'tenant', v_org_id) THEN
    RAISE EXCEPTION 'ui_create_bank_account_v1 requires finance.write capability'
      USING ERRCODE = '42501';
  END IF;

  IF v_args ?| ARRAY['iban', 'full_iban', 'account_number', 'full_account_number'] THEN
    RAISE EXCEPTION 'ui_create_bank_account_v1 accepts only safe last4 identifiers, not full bank identifiers'
      USING ERRCODE = '23514';
  END IF;

  IF v_key IS NULL THEN
    RAISE EXCEPTION 'ui_create_bank_account_v1 requires key'
      USING ERRCODE = '23514';
  END IF;

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'ui_create_bank_account_v1 requires name'
      USING ERRCODE = '23514';
  END IF;

  IF v_currency IS NULL THEN
    RAISE EXCEPTION 'ui_create_bank_account_v1 requires currency'
      USING ERRCODE = '23514';
  END IF;

  IF v_iban_last4 IS NOT NULL AND v_iban_last4 !~ '^[0-9A-Za-z]{4}$' THEN
    RAISE EXCEPTION 'ui_create_bank_account_v1 iban_last4 must contain exactly four characters'
      USING ERRCODE = '23514';
  END IF;

  IF v_account_last4 IS NOT NULL AND v_account_last4 !~ '^[0-9A-Za-z]{4}$' THEN
    RAISE EXCEPTION 'ui_create_bank_account_v1 account_last4 must contain exactly four characters'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(v_metadata) <> 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  INSERT INTO public.bank_accounts (
    organization_id,
    key,
    name,
    bank_name,
    currency,
    iban_last4,
    account_last4,
    is_active,
    metadata
  )
  VALUES (
    v_org_id,
    v_key,
    v_name,
    v_bank_name,
    v_currency,
    upper(v_iban_last4),
    upper(v_account_last4),
    TRUE,
    v_metadata || jsonb_strip_nulls(jsonb_build_object(
      'created_via', 'console_v2_bank_recon',
      'created_by_user_id', auth.uid()
    ))
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'bank_account_id', v_row.id,
    'key', v_row.key,
    'organization_id', v_row.organization_id,
    'correlation_id', public.current_correlation_id(),
    'settings_resolution_id', NULL
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_create_bank_account_v1(JSONB) IS
  'Browser-safe Console V2 bank account setup wrapper. Requires finance.write, scopes to current_user_org_id, stores only safe non-sensitive identifiers, and creates public.bank_accounts rows for bank reconciliation.';

REVOKE ALL ON FUNCTION public.ui_create_bank_account_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_create_bank_account_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_create_bank_account_v1(JSONB) TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_create_bank_account_v1(
  p_args JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_create_bank_account_v1($1);
$function$;

COMMENT ON FUNCTION api.ui_create_bank_account_v1(JSONB) IS
  'api schema wrapper for browser clients using db.schema=api. Delegates to public.ui_create_bank_account_v1.';

REVOKE ALL ON FUNCTION api.ui_create_bank_account_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_create_bank_account_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_create_bank_account_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605181015_console_v2_bank_account_setup_ui_v1'));
COMMIT;
