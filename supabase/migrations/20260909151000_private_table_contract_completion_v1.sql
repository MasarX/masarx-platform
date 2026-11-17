-- Complete private table contracts without granting direct mutation authority.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20260909151000_private_table_contract_completion_v1'));

-- Only existing SECURITY DEFINER lifecycle functions may touch driver intent.
-- An explicit deny policy documents that boundary; table grants remain revoked.
CREATE POLICY fieldops_reassignment_requests_service_private
  ON public.fieldops_reassignment_requests
  FOR ALL TO service_role USING (FALSE) WITH CHECK (FALSE);

INSERT INTO public.table_contracts
  (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES ('public', 'driver_application_document_attempts', TRUE, TRUE, TRUE,
  'Private immutable document attempt manifests and terminal receipts; lifecycle RPC authority only.');
INSERT INTO public.audit_redaction_rules
  (table_schema, table_name, mode, columns, redaction_token)
VALUES ('public', 'driver_application_document_attempts', 'denylist',
  ARRAY['manifest', 'result', 'note'], '[REDACTED]');
-- Target-only equivalents of apply_table_contracts / ensure_audit_triggers.
-- Both timestamp columns already exist; no unrelated contracts are reconciled.
CREATE TRIGGER trg_driver_application_document_attempts_set_updated_at
  BEFORE UPDATE ON public.driver_application_document_attempts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER audit_row_change
  BEFORE INSERT OR UPDATE OR DELETE ON public.driver_application_document_attempts
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture_row_change();
CREATE TRIGGER audit_truncate_change
  AFTER TRUNCATE ON public.driver_application_document_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_capture_row_change();

-- Existing uniqueness indexes are partial and lead with organization_id.
-- Preserve them; the FK requires a complete referencing-key access path.
CREATE INDEX label_versions_artifact_fk_idx
  ON public.label_versions(label_artifact_id, organization_id);

COMMIT;
