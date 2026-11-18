-- Extend the current readback receipt while retaining its sealed predecessor.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '10s';

DO $receipt$
DECLARE
  prior_seal TEXT := obj_description('public.marketplace_review_readback_state_v1'::regclass,'pg_class');
  prior_before JSONB;
  prior_after JSONB;
  current_plan JSONB;
  dependencies JSONB;
  expected_after JSONB;
  digest TEXT;
BEGIN
  LOCK TABLE public.marketplace_review_readback_state_v1 IN EXCLUSIVE MODE;
  IF (SELECT relowner FROM pg_class WHERE oid='public.marketplace_review_readback_state_v1'::regclass)
      IS DISTINCT FROM current_user::regrole::oid THEN
    RAISE EXCEPTION 'Settings dependency receipt requires the existing receipt owner' USING ERRCODE='42501';
  END IF;
  SELECT encode(pg_catalog.sha256(convert_to(jsonb_object_agg(key,value ORDER BY key)::text,'UTF8')),'hex')
    INTO digest FROM public.marketplace_review_readback_state_v1;
  IF prior_seal IS DISTINCT FROM 'marketplace_review_readback_state_v1:sha256:'||digest THEN
    RAISE EXCEPTION 'Marketplace predecessor receipt integrity mismatch';
  END IF;
  SELECT value INTO STRICT prior_before FROM public.marketplace_review_readback_state_v1 WHERE key='plan_before';
  SELECT value INTO STRICT prior_after FROM public.marketplace_review_readback_state_v1 WHERE key='plan_after';
  SELECT jsonb_agg(jsonb_build_object('object_kind','function','object_id',signature::regprocedure::oid,
    'privilege','EXECUTE','column_name',NULL)) INTO dependencies
  FROM unnest(ARRAY['public.resolve_settings(text,text,uuid)',
    'public.resolve_settings_row(text,text,uuid)']) signature;
  SELECT jsonb_agg(to_jsonb(p) ORDER BY object_kind,object_id,privilege,column_name) INTO current_plan
  FROM public.ui_rpc_executor_privilege_plan_v1() p;
  SELECT jsonb_agg(entry ORDER BY entry->>'object_kind',(entry->>'object_id')::oid,
    entry->>'privilege',entry->>'column_name') INTO expected_after
  FROM jsonb_array_elements(prior_after || dependencies) entry;
  IF current_plan IS DISTINCT FROM expected_after THEN
    RAISE EXCEPTION 'Only the two reviewed settings dependencies may extend the receipt';
  END IF;

  INSERT INTO public.marketplace_review_readback_state_v1(key,value) VALUES ('settings_dependency_extension_v1',
    jsonb_build_object('migration','20261114122100_executor_settings_plan_receipt_v1',
      'predecessor_seal',prior_seal,'plan_before',prior_before,'plan_after',prior_after,
      'added',dependencies,'plan_definition',pg_get_functiondef('public.ui_rpc_executor_privilege_plan_v1()'::regprocedure)));
  -- Both sides gain the shared dependencies; the marketplace-only view/grant delta stays exact.
  UPDATE public.marketplace_review_readback_state_v1 SET value=(
    SELECT jsonb_agg(entry ORDER BY entry->>'object_kind',(entry->>'object_id')::oid,
      entry->>'privilege',entry->>'column_name') FROM jsonb_array_elements(value || dependencies) entry
  ) WHERE key IN ('plan_before','plan_after');
  IF (SELECT value FROM public.marketplace_review_readback_state_v1 WHERE key='plan_after')
      IS DISTINCT FROM current_plan THEN
    RAISE EXCEPTION 'Settings dependency receipt readback mismatch';
  END IF;
  SELECT encode(pg_catalog.sha256(convert_to(jsonb_object_agg(key,value ORDER BY key)::text,'UTF8')),'hex')
    INTO digest FROM public.marketplace_review_readback_state_v1;
  EXECUTE format('COMMENT ON TABLE public.marketplace_review_readback_state_v1 IS %L',
    'marketplace_review_readback_state_v1:sha256:'||digest);
END;
$receipt$;
COMMIT;
