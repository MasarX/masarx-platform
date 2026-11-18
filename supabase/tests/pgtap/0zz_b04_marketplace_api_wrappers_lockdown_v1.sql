-- Plan: PHASE B / Step: B4 (NETWORK marketplace API wrapper coverage)
-- pgTAP: Marketplace browser-safe api schema wrapper grants
-- Purpose:
--   Console V2 uses the browser Supabase client pinned to db.schema='api'.
--   This test proves the marketplace API wrappers mirror the intended public
--   RPC grant split: authenticated operator RPCs are callable by authenticated
--   users, service-only lifecycle RPCs are not, and anon cannot execute any of
--   the marketplace write wrappers.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(38);

-- Authenticated operator wrappers.
SELECT ok(to_regprocedure('api.marketplace_offer_submit_v1(uuid,text,jsonb,jsonb,timestamp with time zone,jsonb)') IS NOT NULL, 'api.marketplace_offer_submit_v1 exists');
SELECT ok(has_function_privilege('authenticated', 'api.marketplace_offer_submit_v1(uuid,text,jsonb,jsonb,timestamp with time zone,jsonb)', 'EXECUTE'), 'authenticated can EXECUTE api.marketplace_offer_submit_v1');
SELECT ok(NOT has_function_privilege('anon', 'api.marketplace_offer_submit_v1(uuid,text,jsonb,jsonb,timestamp with time zone,jsonb)', 'EXECUTE'), 'anon cannot EXECUTE api.marketplace_offer_submit_v1');

SELECT ok(to_regprocedure('api.marketplace_offer_withdraw_v1(uuid,text)') IS NOT NULL, 'api.marketplace_offer_withdraw_v1 exists');
SELECT ok(has_function_privilege('authenticated', 'api.marketplace_offer_withdraw_v1(uuid,text)', 'EXECUTE'), 'authenticated can EXECUTE api.marketplace_offer_withdraw_v1');
SELECT ok(NOT has_function_privilege('anon', 'api.marketplace_offer_withdraw_v1(uuid,text)', 'EXECUTE'), 'anon cannot EXECUTE api.marketplace_offer_withdraw_v1');

SELECT ok(to_regprocedure('api.marketplace_award_offer_v1(uuid,text,jsonb,timestamp with time zone,jsonb)') IS NOT NULL, 'api.marketplace_award_offer_v1 exists');
SELECT ok(has_function_privilege('authenticated', 'api.marketplace_award_offer_v1(uuid,text,jsonb,timestamp with time zone,jsonb)', 'EXECUTE'), 'authenticated can EXECUTE api.marketplace_award_offer_v1');
SELECT ok(NOT has_function_privilege('anon', 'api.marketplace_award_offer_v1(uuid,text,jsonb,timestamp with time zone,jsonb)', 'EXECUTE'), 'anon cannot EXECUTE api.marketplace_award_offer_v1');

SELECT ok(to_regprocedure('api.marketplace_award_respond_v1(uuid,text,jsonb)') IS NOT NULL, 'api.marketplace_award_respond_v1 exists');
SELECT ok(has_function_privilege('authenticated', 'api.marketplace_award_respond_v1(uuid,text,jsonb)', 'EXECUTE'), 'authenticated can EXECUTE api.marketplace_award_respond_v1');
SELECT ok(NOT has_function_privilege('anon', 'api.marketplace_award_respond_v1(uuid,text,jsonb)', 'EXECUTE'), 'anon cannot EXECUTE api.marketplace_award_respond_v1');

SELECT ok(to_regprocedure('api.marketplace_request_create_v1(text,text,text,jsonb,jsonb,jsonb,timestamp with time zone,jsonb)') IS NOT NULL, 'api.marketplace_request_create_v1 exists');
SELECT ok(has_function_privilege('authenticated', 'api.marketplace_request_create_v1(text,text,text,jsonb,jsonb,jsonb,timestamp with time zone,jsonb)', 'EXECUTE'), 'authenticated can EXECUTE api.marketplace_request_create_v1');
SELECT ok(NOT has_function_privilege('anon', 'api.marketplace_request_create_v1(text,text,text,jsonb,jsonb,jsonb,timestamp with time zone,jsonb)', 'EXECUTE'), 'anon cannot EXECUTE api.marketplace_request_create_v1');

SELECT ok(to_regprocedure('api.marketplace_request_publish_v1(uuid,text)') IS NOT NULL, 'api.marketplace_request_publish_v1 exists');
SELECT ok(has_function_privilege('authenticated', 'api.marketplace_request_publish_v1(uuid,text)', 'EXECUTE'), 'authenticated can EXECUTE api.marketplace_request_publish_v1');
SELECT ok(NOT has_function_privilege('anon', 'api.marketplace_request_publish_v1(uuid,text)', 'EXECUTE'), 'anon cannot EXECUTE api.marketplace_request_publish_v1');

SELECT ok(to_regprocedure('api.marketplace_request_cancel_v1(uuid,text)') IS NOT NULL, 'api.marketplace_request_cancel_v1 exists');
SELECT ok(has_function_privilege('authenticated', 'api.marketplace_request_cancel_v1(uuid,text)', 'EXECUTE'), 'authenticated can EXECUTE api.marketplace_request_cancel_v1');
SELECT ok(NOT has_function_privilege('anon', 'api.marketplace_request_cancel_v1(uuid,text)', 'EXECUTE'), 'anon cannot EXECUTE api.marketplace_request_cancel_v1');

SELECT ok(to_regprocedure('api.marketplace_dispute_open_v1(uuid,uuid,text,text,text,jsonb)') IS NOT NULL, 'api.marketplace_dispute_open_v1 exists');
SELECT ok(has_function_privilege('authenticated', 'api.marketplace_dispute_open_v1(uuid,uuid,text,text,text,jsonb)', 'EXECUTE'), 'authenticated can EXECUTE api.marketplace_dispute_open_v1');
SELECT ok(NOT has_function_privilege('anon', 'api.marketplace_dispute_open_v1(uuid,uuid,text,text,text,jsonb)', 'EXECUTE'), 'anon cannot EXECUTE api.marketplace_dispute_open_v1');

SELECT ok(to_regprocedure('api.marketplace_dispute_resolve_v1(uuid,text,text,jsonb)') IS NOT NULL, 'api.marketplace_dispute_resolve_v1 exists');
SELECT ok(has_function_privilege('authenticated', 'api.marketplace_dispute_resolve_v1(uuid,text,text,jsonb)', 'EXECUTE'), 'authenticated can EXECUTE api.marketplace_dispute_resolve_v1');
SELECT ok(NOT has_function_privilege('anon', 'api.marketplace_dispute_resolve_v1(uuid,text,text,jsonb)', 'EXECUTE'), 'anon cannot EXECUTE api.marketplace_dispute_resolve_v1');

SELECT ok(to_regprocedure('api.marketplace_work_package_materialize_v1(uuid,uuid,jsonb,jsonb,jsonb)') IS NOT NULL, 'api.marketplace_work_package_materialize_v1 exists');
SELECT ok(has_function_privilege('authenticated', 'api.marketplace_work_package_materialize_v1(uuid,uuid,jsonb,jsonb,jsonb)', 'EXECUTE'), 'authenticated can EXECUTE api.marketplace_work_package_materialize_v1');
SELECT ok(NOT has_function_privilege('anon', 'api.marketplace_work_package_materialize_v1(uuid,uuid,jsonb,jsonb,jsonb)', 'EXECUTE'), 'anon cannot EXECUTE api.marketplace_work_package_materialize_v1');

-- Service-only wrappers.
SELECT ok(to_regprocedure('api.marketplace_participant_request_review_apply_v1(uuid,text,uuid,uuid,boolean,text,uuid,uuid,jsonb)') IS NOT NULL, 'api.marketplace_participant_request_review_apply_v1 exists');
SELECT ok(has_function_privilege('service_role', 'api.marketplace_participant_request_review_apply_v1(uuid,text,uuid,uuid,boolean,text,uuid,uuid,jsonb)', 'EXECUTE'), 'service_role can EXECUTE api.marketplace_participant_request_review_apply_v1');
SELECT ok(NOT has_function_privilege('authenticated', 'api.marketplace_participant_request_review_apply_v1(uuid,text,uuid,uuid,boolean,text,uuid,uuid,jsonb)', 'EXECUTE'), 'authenticated cannot EXECUTE api.marketplace_participant_request_review_apply_v1');
SELECT ok(NOT has_function_privilege('anon', 'api.marketplace_participant_request_review_apply_v1(uuid,text,uuid,uuid,boolean,text,uuid,uuid,jsonb)', 'EXECUTE'), 'anon cannot EXECUTE api.marketplace_participant_request_review_apply_v1');

SELECT ok(to_regprocedure('api.marketplace_refresh_reputation_snapshot_v1(uuid)') IS NOT NULL, 'api.marketplace_refresh_reputation_snapshot_v1 exists');
SELECT ok(has_function_privilege('service_role', 'api.marketplace_refresh_reputation_snapshot_v1(uuid)', 'EXECUTE'), 'service_role can EXECUTE api.marketplace_refresh_reputation_snapshot_v1');
SELECT ok(NOT has_function_privilege('authenticated', 'api.marketplace_refresh_reputation_snapshot_v1(uuid)', 'EXECUTE'), 'authenticated cannot EXECUTE api.marketplace_refresh_reputation_snapshot_v1');
SELECT ok(NOT has_function_privilege('anon', 'api.marketplace_refresh_reputation_snapshot_v1(uuid)', 'EXECUTE'), 'anon cannot EXECUTE api.marketplace_refresh_reputation_snapshot_v1');

SELECT * FROM finish();

ROLLBACK;
