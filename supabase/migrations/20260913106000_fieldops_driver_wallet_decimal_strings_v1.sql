-- Preserve exact arbitrary-scale wallet amounts across JSON transport.
BEGIN;
SELECT pg_advisory_lock(hashtext('20260913106000_fieldops_driver_wallet_decimal_strings_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.compute_driver_wallet_summary_v1(
  p_organization_id UUID,p_driver_user_id UUID,p_currency TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public,extensions,pg_temp SET row_security TO on
AS $function$
DECLARE
  currency_code TEXT:=upper(NULLIF(btrim(COALESCE(p_currency,'')),''));
  balance_amount NUMERIC:=0;
  remitted_amount NUMERIC:=0;
  reserved_amount NUMERIC:=0;
BEGIN
  IF p_organization_id IS NULL OR p_driver_user_id IS NULL
    OR currency_code IS NULL OR currency_code !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'driver_wallet_invalid_scope' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(sum(CASE direction WHEN 'in' THEN amount ELSE -amount END),0),
    COALESCE(sum(amount) FILTER(WHERE direction='out' AND event_type='payout'),0)
  INTO balance_amount,remitted_amount
  FROM public.finance_events
  WHERE organization_id=p_organization_id AND account_type='driver_wallet'
    AND account_id=p_driver_user_id AND upper(currency)=currency_code;

  SELECT COALESCE(sum((t.metadata->>'requested_amount')::numeric),0)
  INTO reserved_amount
  FROM public.tasks t JOIN public.task_types tt ON tt.id=t.task_type_id
  WHERE t.organization_id=p_organization_id AND tt.key='wallet_withdrawal_request'
    AND t.resource_type='user' AND t.resource_id=p_driver_user_id
    AND upper(t.metadata->>'currency')=currency_code
    AND t.canceled_at IS NULL AND lower(t.status)<>'canceled'
    AND NULLIF(t.metadata->>'payout_finance_event_id','') IS NULL
    AND COALESCE(t.metadata->>'requested_amount','') ~ '^[0-9]+([.][0-9]+)?$';

  RETURN jsonb_build_object(
    'organization_id',p_organization_id,'driver_user_id',p_driver_user_id,
    'currency',currency_code,'balance',balance_amount::text,
    'remitted_payout',remitted_amount::text,
    'reserved_withdrawal',reserved_amount::text,
    'available',GREATEST(balance_amount-reserved_amount,0)::text);
END;
$function$;
COMMENT ON FUNCTION public.compute_driver_wallet_summary_v1(UUID,UUID,TEXT)
  IS 'Service-only exact decimal-string projection of driver_wallet finance events and unlinked withdrawal-task reservations.';
REVOKE ALL ON FUNCTION public.compute_driver_wallet_summary_v1(UUID,UUID,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.compute_driver_wallet_summary_v1(UUID,UUID,TEXT) TO service_role;

SELECT pg_advisory_unlock(hashtext('20260913106000_fieldops_driver_wallet_decimal_strings_v1'));
COMMIT;
