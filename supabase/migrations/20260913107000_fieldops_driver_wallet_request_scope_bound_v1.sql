-- Bind a wallet request to the identity verified by the client before its async RPC.
BEGIN;
SET LOCAL search_path TO public,api,extensions,pg_temp;

CREATE FUNCTION public.ui_request_driver_wallet_withdrawal_v2(
  p_amount NUMERIC,p_currency TEXT,p_idempotency_key TEXT,
  p_expected_actor_id UUID,p_expected_organization_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,extensions,pg_temp SET row_security TO on
AS $function$
DECLARE receipt JSONB;
BEGIN
  IF p_expected_actor_id IS NULL OR p_expected_organization_id IS NULL
    OR auth.uid() IS DISTINCT FROM p_expected_actor_id
    OR public.current_user_org_id() IS DISTINCT FROM p_expected_organization_id THEN
    RAISE EXCEPTION 'driver_wallet_scope_changed' USING ERRCODE='42501';
  END IF;
  receipt:=public.ui_request_driver_wallet_withdrawal_v1(
    p_amount,p_currency,p_idempotency_key);
  IF receipt#>>'{wallet,organization_id}' IS DISTINCT FROM p_expected_organization_id::text
    OR receipt#>>'{wallet,driver_user_id}' IS DISTINCT FROM p_expected_actor_id::text THEN
    RAISE EXCEPTION 'driver_wallet_scope_changed' USING ERRCODE='42501';
  END IF;
  RETURN receipt;
END;
$function$;
COMMENT ON FUNCTION public.ui_request_driver_wallet_withdrawal_v2(NUMERIC,TEXT,TEXT,UUID,UUID)
  IS 'Identity-bound request-only driver wallet withdrawal; delegates capability, balance, and idempotency checks to v1.';
REVOKE ALL ON FUNCTION public.ui_request_driver_wallet_withdrawal_v2(NUMERIC,TEXT,TEXT,UUID,UUID)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ui_request_driver_wallet_withdrawal_v2(NUMERIC,TEXT,TEXT,UUID,UUID)
  TO authenticated;

CREATE FUNCTION api.ui_request_driver_wallet_withdrawal_v2(
  p_amount NUMERIC,p_currency TEXT,p_idempotency_key TEXT,
  p_expected_actor_id UUID,p_expected_organization_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public,api,extensions,pg_temp
AS $function$ SELECT public.ui_request_driver_wallet_withdrawal_v2($1,$2,$3,$4,$5) $function$;
REVOKE ALL ON FUNCTION api.ui_request_driver_wallet_withdrawal_v2(NUMERIC,TEXT,TEXT,UUID,UUID)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION api.ui_request_driver_wallet_withdrawal_v2(NUMERIC,TEXT,TEXT,UUID,UUID)
  TO authenticated;
COMMIT;
