-- Spec-Issue: W8-4 FINANCE gap closure (REVISION 77%)
-- Step: W8-4-RPC-1
-- Migration: Canonical projection RPC public.compute_bank_account_balance_v1(p_args jsonb).
-- Capability: finance.read
-- Behavior:
--   Project derived bank-account totals (balance, last_match_at, open_items)
--   from the immutable finance_events ledger + bank_recon_matches relation.
--
--   FE bank-recon module currently relies on three fields that are NOT columns
--   on `public.bank_accounts`:
--     - balance        : sum(direction='in') - sum(direction='out')
--                        scoped to (account_type='bank', account_id=<bank_account.id>)
--     - last_match_at  : MAX(updated_at) of matched bank_recon_matches that
--                        reference any finance_event for this account.
--     - open_items     : COUNT of bank_statement finance_events for this
--                        account that do not yet have a matched bank_recon_match
--                        row in 'matched' status.
--
--   This projection is read-only and tenant-scoped via:
--     a) `assert_capability_v1('finance.read')` — capability gate
--     b) `bank_accounts.organization_id = current_user_org_id()` — tenant isolation
--   Cross-tenant access requires `is_platform_user()`.
--
-- Contract:
--   p_args := {
--     "bank_account_id": uuid (required)
--   }
--   Returns: {
--     ok, bank_account_id, organization_id,
--     balance, currency, last_match_at, open_items,
--     correlation_id, settings_resolution_id
--   }
--
-- Notes:
--   - Reads are SECURITY DEFINER but capability-gated; tenant isolation is
--     enforced by an explicit organization-membership check.
--   - balance/open_items derive from finance_events.account_type='bank'
--     (not yet a registered lookup value at time of writing — kept tolerant
--     so the projection returns 0 when the ledger has no rows for this account).
--   - Idempotent: projection is recomputed on every call; no state mutated.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301110_compute_bank_account_balance_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.compute_bank_account_balance_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
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

  BEGIN v_bank_account_id := NULLIF(p_args->>'bank_account_id', '')::UUID;
  EXCEPTION WHEN others THEN v_bank_account_id := NULL; END;
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

  -- Tenant isolation: caller must be a platform user OR member of the same org.
  IF NOT public.is_platform_user() AND v_account.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'compute_bank_account_balance_v1 cannot read accounts in other organizations'
      USING ERRCODE = '42501';
  END IF;

  -- Project balance from finance_events. account_type='bank' is the canonical
  -- key for bank-account ledgers; tolerant of empty ledger (returns 0).
  SELECT
    COALESCE(SUM(CASE WHEN fe.direction = 'in'  THEN fe.amount ELSE 0 END), 0)
    - COALESCE(SUM(CASE WHEN fe.direction = 'out' THEN fe.amount ELSE 0 END), 0)
    INTO v_balance
    FROM public.finance_events fe
   WHERE fe.organization_id = v_account.organization_id
     AND fe.account_type   = 'bank'
     AND fe.account_id     = v_bank_account_id;

  -- Open items: bank_statement events without an active matched row.
  SELECT COUNT(*)
    INTO v_open_items
    FROM public.finance_events fe
   WHERE fe.organization_id = v_account.organization_id
     AND fe.account_type   = 'bank'
     AND fe.account_id     = v_bank_account_id
     AND fe.event_type     = 'bank_statement'
     AND NOT EXISTS (
       SELECT 1
         FROM public.bank_recon_matches m
        WHERE m.bank_statement_event_id = fe.id
          AND m.status = 'matched'
     );

  -- Latest match timestamp for this account.
  SELECT MAX(m.updated_at)
    INTO v_last_match_at
    FROM public.bank_recon_matches m
    JOIN public.finance_events fe
      ON fe.id = m.bank_statement_event_id
   WHERE fe.organization_id = v_account.organization_id
     AND fe.account_type   = 'bank'
     AND fe.account_id     = v_bank_account_id
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
$$;

REVOKE ALL ON FUNCTION public.compute_bank_account_balance_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.compute_bank_account_balance_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.compute_bank_account_balance_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.compute_bank_account_balance_v1(jsonb)
  IS 'Canonical projection RPC: derive (balance, last_match_at, open_items) for a bank_account from finance_events + bank_recon_matches. Capability: finance.read.';

SELECT pg_advisory_unlock(hashtext('202604301110_compute_bank_account_balance_v1'));
COMMIT;
