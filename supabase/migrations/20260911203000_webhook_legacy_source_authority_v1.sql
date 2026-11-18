-- Legacy inbox helpers leave organization unbound; resolve it from exact source authority.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
DO $repair$
DECLARE
  v_def text;
  v_old text := $old$OR (v_inbox.id IS NOT NULL AND (
              v_inbox.organization_id IS DISTINCT FROM v_organization_id$old$;
  v_new text := $new$OR v_source_id IS DISTINCT FROM NULLIF(v_owned_run.context->>'webhook_source_id','')::uuid
         OR v_source_identifier IS DISTINCT FROM NULLIF(v_owned_run.context->>'source_identifier','')
         OR (v_inbox.id IS NULL AND NOT EXISTS (
           SELECT 1 FROM public.webhook_sources ws
            WHERE ((v_source_id IS NOT NULL AND ws.id=v_source_id)
              OR (v_source_id IS NULL AND ws.source_identifier=v_source_identifier))
              AND ws.organization_id IS NOT NULL AND ws.organization_id=v_organization_id))
         OR (v_inbox.id IS NOT NULL AND (
              (v_inbox.organization_id IS NOT NULL AND v_inbox.organization_id IS DISTINCT FROM v_organization_id)
              OR (v_inbox.organization_id IS NULL AND NOT EXISTS (
                SELECT 1 FROM public.webhook_sources ws
                 WHERE ws.id = v_inbox.webhook_source_id
                   AND ws.organization_id IS NOT NULL
                   AND ws.organization_id = v_organization_id))$new$;
  v_source_old text := $old$         WHERE ws.source_identifier = v_source_identifier
         ORDER BY ws.created_at DESC$old$;
  v_source_new text := $new$         WHERE ws.source_identifier = v_source_identifier
           AND ws.organization_id = v_organization_id
         ORDER BY ws.created_at DESC$new$;
BEGIN
  SELECT pg_get_functiondef('workflow_handlers.persist_http_response_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure) INTO v_def;
  IF (length(v_def)-length(replace(v_def,v_old,''))) <> length(v_old) THEN
    RAISE EXCEPTION 'Unexpected HTTP persistence ownership definition shape';
  END IF;
  IF (length(v_def)-length(replace(v_def,v_source_old,''))) <> length(v_source_old) THEN
    RAISE EXCEPTION 'Unexpected HTTP persistence source binding definition shape';
  END IF;
  EXECUTE replace(replace(v_def,v_old,v_new),v_source_old,v_source_new);
END;
$repair$;
COMMIT;
