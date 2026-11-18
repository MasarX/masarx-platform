-- Plan: Console V2 production backend API-schema wrapper closure
-- Step: expose remaining browser-called public RPCs through api schema.
--
-- Console V2 shared/prod browser clients are pinned to db.schema='api'. The
-- canonical public RPCs below already enforce their auth, capability, RLS, and
-- audit contracts. These wrappers are thin schema redirects so PostgREST can
-- resolve the existing production calls without app-side fallbacks.
--
-- compute_cod_payment_collection_summary_v1 is intentionally not wrapped here:
-- the public function is currently service_role-only and has no authenticated
-- capability guard. Granting an api wrapper to authenticated callers would
-- widen access rather than preserve the current auth semantics.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605031900_console_v2_backend_api_schema_wrappers_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_list_resource_v1(
  p_resource TEXT,
  p_filters JSONB DEFAULT '{}'::jsonb,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0,
  p_sort JSONB DEFAULT NULL::jsonb
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_list_resource_v1($1, $2, $3, $4, $5);
$function$;

CREATE OR REPLACE FUNCTION api.ui_get_resource_v1(
  p_resource TEXT,
  p_id UUID
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_get_resource_v1($1, $2);
$function$;

CREATE OR REPLACE FUNCTION api.ui_resource_metrics_v1(
  p_resource TEXT,
  p_filters JSONB DEFAULT '{}'::jsonb,
  p_columns TEXT[] DEFAULT NULL::text[]
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_resource_metrics_v1($1, $2, $3);
$function$;

CREATE OR REPLACE FUNCTION api.ui_filter_distinct_values_v1(
  p_resource TEXT,
  p_filter_key TEXT,
  p_query TEXT DEFAULT NULL::text,
  p_limit INTEGER DEFAULT 25
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_filter_distinct_values_v1($1, $2, $3, $4);
$function$;

CREATE OR REPLACE FUNCTION api.ui_log_event_v1(
  p_event JSONB,
  p_app TEXT
)
RETURNS UUID
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_log_event_v1($1, $2);
$function$;

CREATE OR REPLACE FUNCTION api.ui_start_workflow_run_v1(
  p_workflow_template_id UUID,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_require_active BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_start_workflow_run_v1($1, $2, $3);
$function$;

DO $$
DECLARE
  v_name TEXT;
  v_jsonb_wrapper_names TEXT[] := ARRAY[
    'create_billing_invoice_v1',
    'update_billing_invoice_v1',
    'void_billing_invoice_v1',
    'billing_invoice_send_v1',
    'billing_invoice_refund_v1',
    'cancel_subscription_v1',
    'apply_settlement_v1',
    'reject_settlement_v1',
    'bank_recon_match_v1',
    'bank_recon_unmatch_v1',
    'dispute_resolve_v1',
    'dispute_reject_v1',
    'dispute_acknowledge_v1',
    'dispute_escalate_v1',
    'warehouse_transfer_execute_v1',
    'ui_upsert_webhook_source_v1',
    'ui_rotate_webhook_source_token_v1',
    'ui_upsert_webhook_rule_v1',
    'ui_delete_webhook_rule_v1',
    'ui_reorder_webhook_rule_v1',
    'webhook_inbox_replay_v1',
    'webhook_inbox_force_status_v1',
    'block_api_gateway_source_v1',
    'adjust_api_gateway_rate_limit_v1'
  ];
BEGIN
  FOREACH v_name IN ARRAY v_jsonb_wrapper_names
  LOOP
    IF to_regprocedure(format('public.%I(jsonb)', v_name)) IS NULL THEN
      RAISE EXCEPTION 'Console V2 api wrapper closure: public.%(jsonb) is missing', v_name
        USING ERRCODE = '42883';
    END IF;

    EXECUTE format(
      $sql$
      CREATE OR REPLACE FUNCTION api.%1$I(p_args jsonb)
      RETURNS jsonb
      LANGUAGE sql
      VOLATILE
      SECURITY DEFINER
      SET search_path TO public, extensions, pg_temp
      AS $wrapper$
        SELECT public.%1$I(p_args);
      $wrapper$;
      $sql$,
      v_name
    );

    EXECUTE format('REVOKE ALL ON FUNCTION api.%I(jsonb) FROM PUBLIC', v_name);
    EXECUTE format('REVOKE ALL ON FUNCTION api.%I(jsonb) FROM anon', v_name);
    EXECUTE format('GRANT EXECUTE ON FUNCTION api.%I(jsonb) TO authenticated, service_role', v_name);
    EXECUTE format(
      'COMMENT ON FUNCTION api.%I(jsonb) IS %L',
      v_name,
      format('Console V2 api-schema wrapper delegating to canonical public.%s(jsonb).', v_name)
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION api.ui_list_resource_v1(TEXT, JSONB, INTEGER, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_list_resource_v1(TEXT, JSONB, INTEGER, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_list_resource_v1(TEXT, JSONB, INTEGER, INTEGER, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_get_resource_v1(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_get_resource_v1(TEXT, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_get_resource_v1(TEXT, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_resource_metrics_v1(TEXT, JSONB, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_resource_metrics_v1(TEXT, JSONB, TEXT[]) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_resource_metrics_v1(TEXT, JSONB, TEXT[]) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_filter_distinct_values_v1(TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_filter_distinct_values_v1(TEXT, TEXT, TEXT, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_filter_distinct_values_v1(TEXT, TEXT, TEXT, INTEGER) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_log_event_v1(JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_log_event_v1(JSONB, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_log_event_v1(JSONB, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_start_workflow_run_v1(UUID, JSONB, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_start_workflow_run_v1(UUID, JSONB, BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_start_workflow_run_v1(UUID, JSONB, BOOLEAN) TO authenticated, service_role;

COMMENT ON FUNCTION api.ui_list_resource_v1(TEXT, JSONB, INTEGER, INTEGER, JSONB)
  IS 'Console V2 api-schema wrapper delegating to canonical public.ui_list_resource_v1.';
COMMENT ON FUNCTION api.ui_get_resource_v1(TEXT, UUID)
  IS 'Console V2 api-schema wrapper delegating to canonical public.ui_get_resource_v1.';
COMMENT ON FUNCTION api.ui_resource_metrics_v1(TEXT, JSONB, TEXT[])
  IS 'Console V2 api-schema wrapper delegating to canonical public.ui_resource_metrics_v1.';
COMMENT ON FUNCTION api.ui_filter_distinct_values_v1(TEXT, TEXT, TEXT, INTEGER)
  IS 'Console V2 api-schema wrapper delegating to canonical public.ui_filter_distinct_values_v1.';
COMMENT ON FUNCTION api.ui_log_event_v1(JSONB, TEXT)
  IS 'Console V2 api-schema wrapper delegating to canonical public.ui_log_event_v1.';
COMMENT ON FUNCTION api.ui_start_workflow_run_v1(UUID, JSONB, BOOLEAN)
  IS 'Console V2 api-schema wrapper delegating to canonical public.ui_start_workflow_run_v1.';

SELECT pg_advisory_unlock(hashtext('202605031900_console_v2_backend_api_schema_wrappers_v1'));

COMMIT;
