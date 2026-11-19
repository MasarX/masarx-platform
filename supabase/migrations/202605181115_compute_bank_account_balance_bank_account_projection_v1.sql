BEGIN;
SELECT pg_advisory_lock(hashtext('202605181115_compute_bank_account_balance_bank_account_projection_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.compute_bank_account_balance_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_bank_account_id UUID;
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_account public.bank_accounts%ROWTYPE;
  v_balance NUMERIC := 0;
  v_open_items INT := 0;
  v_last_match_at TIMESTAMPTZ := NULL;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'compute_bank_account_balance_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('finance.read');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'compute_bank_account_balance_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_bank_account_id := NULLIF(p_args->>'bank_account_id', '')::UUID;
  EXCEPTION WHEN others THEN
    v_bank_account_id := NULL;
  END;
  IF v_bank_account_id IS NULL THEN
    RAISE EXCEPTION 'compute_bank_account_balance_v1 requires bank_account_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_account
    FROM public.bank_accounts
   WHERE id = v_bank_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'compute_bank_account_balance_v1 bank_account_id % not found', v_bank_account_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_platform_user() AND v_account.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'compute_bank_account_balance_v1 cannot read accounts in other organizations'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    COALESCE(SUM(CASE WHEN fe.direction = 'in'  THEN fe.amount ELSE 0 END), 0)
    - COALESCE(SUM(CASE WHEN fe.direction = 'out' THEN fe.amount ELSE 0 END), 0)
    INTO v_balance
    FROM public.finance_events fe
   WHERE fe.organization_id = v_account.organization_id
     AND fe.account_type IN ('bank_account', 'bank')
     AND fe.account_id = v_bank_account_id;

  SELECT COUNT(*)
    INTO v_open_items
    FROM public.finance_events fe
   WHERE fe.organization_id = v_account.organization_id
     AND fe.account_type IN ('bank_account', 'bank')
     AND fe.account_id = v_bank_account_id
     AND fe.event_type = 'bank_statement'
     AND NOT EXISTS (
       SELECT 1
         FROM public.bank_recon_matches m
        WHERE m.bank_statement_event_id = fe.id
          AND m.status = 'matched'
     );

  SELECT MAX(m.updated_at)
    INTO v_last_match_at
    FROM public.bank_recon_matches m
    JOIN public.finance_events fe
      ON fe.id = m.bank_statement_event_id
   WHERE fe.organization_id = v_account.organization_id
     AND fe.account_type IN ('bank_account', 'bank')
     AND fe.account_id = v_bank_account_id
     AND m.status = 'matched';

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', TRUE,
    'bank_account_id', v_bank_account_id,
    'organization_id', v_account.organization_id,
    'currency', v_account.currency,
    'balance', v_balance,
    'last_match_at', v_last_match_at,
    'open_items', v_open_items,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  ));
END;
$function$;

COMMENT ON FUNCTION public.compute_bank_account_balance_v1(jsonb)
  IS 'Canonical projection RPC: derive (balance, last_match_at, open_items) for a bank_account from finance_events + bank_recon_matches. Reads canonical account_type=bank_account and legacy account_type=bank. Capability: finance.read.';

REVOKE ALL ON FUNCTION public.compute_bank_account_balance_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.compute_bank_account_balance_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.compute_bank_account_balance_v1(jsonb) TO service_role;

SELECT pg_advisory_unlock(hashtext('202605181115_compute_bank_account_balance_bank_account_projection_v1'));
COMMIT;
