-- Missing provider metadata is resolved from the already authorized source, never invented.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
DO $repair$
DECLARE
  v_def text;
  v_old text := $old$    IF NOT EXISTS (SELECT 1 FROM public.webhook_inbox WHERE id = v_webhook_id) THEN
        PERFORM public.insert_webhook_inbox_record($old$;
  v_new text := $new$    IF NOT EXISTS (SELECT 1 FROM public.webhook_inbox WHERE id = v_webhook_id) THEN
        IF v_provider_type IS NULL THEN
            SELECT ws.provider_type INTO v_provider_type
              FROM public.webhook_sources ws
             WHERE ws.id = v_source_id AND ws.organization_id = v_organization_id;
            IF NOT FOUND OR v_provider_type IS NULL THEN
                RAISE EXCEPTION 'Webhook provider source authority missing' USING ERRCODE = '42501';
            END IF;
        END IF;
        PERFORM public.insert_webhook_inbox_record($new$;
  v_provider_old text := $old$            COALESCE(v_provider_type, 'unknown'),$old$;
  v_provider_new text := $new$            v_provider_type,$new$;
BEGIN
  SELECT pg_get_functiondef('workflow_handlers.persist_http_response_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure) INTO v_def;
  IF (length(v_def)-length(replace(v_def,v_old,''))) <> length(v_old)
     OR (length(v_def)-length(replace(v_def,v_provider_old,''))) <> length(v_provider_old) THEN
    RAISE EXCEPTION 'Unexpected HTTP persistence provider definition shape';
  END IF;
  EXECUTE replace(replace(v_def,v_old,v_new),v_provider_old,v_provider_new);
END;
$repair$;
COMMIT;
