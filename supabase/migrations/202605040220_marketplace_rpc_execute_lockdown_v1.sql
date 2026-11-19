-- Migration: Marketplace RPC execute lockdown
-- Date: 2026-05-03
-- Purpose:
--   Revoke PostgreSQL default PUBLIC/anon EXECUTE on marketplace write RPCs
--   and re-grant only the intended runtime roles.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031390_marketplace_rpc_execute_lockdown_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

CREATE OR REPLACE FUNCTION api.marketplace_refresh_reputation_snapshot_v1(
  p_participant_profile_id UUID
)
RETURNS JSONB
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.marketplace_refresh_reputation_snapshot_v1(p_participant_profile_id);
$function$;

REVOKE ALL ON FUNCTION
  public.marketplace_offer_submit_v1(uuid,text,jsonb,jsonb,timestamp with time zone,jsonb),
  public.marketplace_offer_withdraw_v1(uuid,text),
  public.marketplace_award_offer_v1(uuid,text,jsonb,timestamp with time zone,jsonb),
  public.marketplace_award_respond_v1(uuid,text,jsonb),
  public.marketplace_request_create_v1(text,text,text,jsonb,jsonb,jsonb,timestamp with time zone,jsonb),
  public.marketplace_request_publish_v1(uuid,text),
  public.marketplace_request_cancel_v1(uuid,text),
  public.marketplace_dispute_open_v1(uuid,uuid,text,text,text,jsonb),
  public.marketplace_dispute_resolve_v1(uuid,text,text,jsonb),
  public.marketplace_work_package_materialize_v1(uuid,uuid,jsonb,jsonb,jsonb),
  api.marketplace_offer_submit_v1(uuid,text,jsonb,jsonb,timestamp with time zone,jsonb),
  api.marketplace_offer_withdraw_v1(uuid,text),
  api.marketplace_award_offer_v1(uuid,text,jsonb,timestamp with time zone,jsonb),
  api.marketplace_award_respond_v1(uuid,text,jsonb),
  api.marketplace_request_create_v1(text,text,text,jsonb,jsonb,jsonb,timestamp with time zone,jsonb),
  api.marketplace_request_publish_v1(uuid,text),
  api.marketplace_request_cancel_v1(uuid,text),
  api.marketplace_dispute_open_v1(uuid,uuid,text,text,text,jsonb),
  api.marketplace_dispute_resolve_v1(uuid,text,text,jsonb),
  api.marketplace_work_package_materialize_v1(uuid,uuid,jsonb,jsonb,jsonb)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.marketplace_offer_submit_v1(uuid,text,jsonb,jsonb,timestamp with time zone,jsonb),
  public.marketplace_offer_withdraw_v1(uuid,text),
  public.marketplace_award_offer_v1(uuid,text,jsonb,timestamp with time zone,jsonb),
  public.marketplace_award_respond_v1(uuid,text,jsonb),
  public.marketplace_request_create_v1(text,text,text,jsonb,jsonb,jsonb,timestamp with time zone,jsonb),
  public.marketplace_request_publish_v1(uuid,text),
  public.marketplace_request_cancel_v1(uuid,text),
  public.marketplace_dispute_open_v1(uuid,uuid,text,text,text,jsonb),
  public.marketplace_dispute_resolve_v1(uuid,text,text,jsonb),
  public.marketplace_work_package_materialize_v1(uuid,uuid,jsonb,jsonb,jsonb),
  api.marketplace_offer_submit_v1(uuid,text,jsonb,jsonb,timestamp with time zone,jsonb),
  api.marketplace_offer_withdraw_v1(uuid,text),
  api.marketplace_award_offer_v1(uuid,text,jsonb,timestamp with time zone,jsonb),
  api.marketplace_award_respond_v1(uuid,text,jsonb),
  api.marketplace_request_create_v1(text,text,text,jsonb,jsonb,jsonb,timestamp with time zone,jsonb),
  api.marketplace_request_publish_v1(uuid,text),
  api.marketplace_request_cancel_v1(uuid,text),
  api.marketplace_dispute_open_v1(uuid,uuid,text,text,text,jsonb),
  api.marketplace_dispute_resolve_v1(uuid,text,text,jsonb),
  api.marketplace_work_package_materialize_v1(uuid,uuid,jsonb,jsonb,jsonb)
TO authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.marketplace_participant_request_review_apply_v1(uuid,text,uuid,uuid,boolean,text,uuid,uuid,jsonb),
  public.marketplace_refresh_reputation_snapshot_v1(uuid),
  api.marketplace_participant_request_review_apply_v1(uuid,text,uuid,uuid,boolean,text,uuid,uuid,jsonb),
  api.marketplace_refresh_reputation_snapshot_v1(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.marketplace_participant_request_review_apply_v1(uuid,text,uuid,uuid,boolean,text,uuid,uuid,jsonb),
  public.marketplace_refresh_reputation_snapshot_v1(uuid),
  api.marketplace_participant_request_review_apply_v1(uuid,text,uuid,uuid,boolean,text,uuid,uuid,jsonb),
  api.marketplace_refresh_reputation_snapshot_v1(uuid)
TO service_role;

GRANT USAGE ON SCHEMA api TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605031390_marketplace_rpc_execute_lockdown_v1'));
COMMIT;
