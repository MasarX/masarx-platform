-- UPDATE OF uses statement target columns, not columns changed by BEFORE triggers.
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP TRIGGER webhook_sources_capture_token_lineage_trg ON public.webhook_sources;
CREATE TRIGGER webhook_sources_capture_token_lineage_trg
AFTER UPDATE OF auth_token, auth_token_hash, enabled, managed_metadata ON public.webhook_sources
FOR EACH ROW
EXECUTE FUNCTION public.capture_webhook_source_token_lineage_v1();
COMMIT;
