-- Plan: TBD / Step: TBD

-- Ensure SECURITY DEFINER functions pin a safe search_path.
-- pgTAP expects: first=public, last=pg_temp, and only {public, extensions, workflow_handlers, pg_temp}.

ALTER FUNCTION public.upsert_webhook_ingest_policy(text, uuid, jsonb)
  SET search_path TO public, extensions, workflow_handlers, pg_temp;
