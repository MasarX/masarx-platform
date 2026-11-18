-- Manual negative qualification on an installed disposable candidate, outside normal pgTAP discovery.
-- Each case MUST exit nonzero with its documented inverse guard error. Connection exit rolls back the tamper.
-- psql -X -v ON_ERROR_STOP=1 -v tamper_case=snapshot -f <this file>
\set ON_ERROR_STOP on
SELECT :'tamper_case'='snapshot' AS snapshot,
  :'tamper_case'='baseline' AS baseline,
  :'tamper_case'='registry' AS registry,
  :'tamper_case'='view' AS view,
  :'tamper_case'='function' AS function,
  :'tamper_case'='policy' AS policy,
  :'tamper_case'='acl' AS acl,
  :'tamper_case' IN ('snapshot','baseline','registry','view','function','policy','acl') AS valid_case
\gset
\if :valid_case
\else
  \echo Unknown tamper_case; no mutation performed
  \quit 2
\endif
BEGIN;
\if :snapshot
  UPDATE public.marketplace_review_readback_state_v1 SET value='"tampered"' WHERE key='baseline_seal';
\endif
\if :baseline
  COMMENT ON TABLE public.ui_rpc_executor_rollback_state_v1 IS 'tampered-baseline';
\endif
\if :registry
  UPDATE public.settings SET cached_value=cached_value||'{"w2_inverse_tamper":true}'::jsonb
    WHERE category='ui_read_registry' AND scope_type=public.get_root_scope_type_key_v1() AND scope_id IS NULL;
\endif
\if :view
  ALTER VIEW public.marketplace_participant_request_review_read_v1 SET (security_invoker=false);
\endif
\if :function
  ALTER FUNCTION api.ui_get_resource_v1(text,uuid) SET search_path TO pg_catalog,public,pg_temp;
\endif
\if :policy
  ALTER POLICY ui_rpc_executor_trusted ON public.marketplace_participant_requests USING (FALSE);
\endif
\if :acl
  GRANT SELECT ON public.marketplace_participant_request_review_read_v1 TO authenticated;
\endif
-- The inverse begins within this transaction; its refusal aborts before restoration or COMMIT.
\ir ../20261114121000_marketplace_participant_review_readback_v1.sql
\echo ERROR: inverse unexpectedly accepted tampered inputs
\quit 3
