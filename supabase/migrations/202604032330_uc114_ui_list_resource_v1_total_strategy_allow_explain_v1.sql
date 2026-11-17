-- Migration: restore VOLATILE on ui_list_resource_v1 after UC114 replaced the function body.
BEGIN;

SELECT pg_advisory_lock(hashtext('202604032330_uc114_ui_list_resource_v1_total_strategy_allow_explain_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER FUNCTION public.ui_list_resource_v1(TEXT, JSONB, INT, INT, JSONB) VOLATILE;

COMMIT;
