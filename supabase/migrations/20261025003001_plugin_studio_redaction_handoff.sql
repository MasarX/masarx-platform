BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;

-- The older evidence redactor rewrites executable fields before the context-aware guard runs.
DO $handoff$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger legacy
    JOIN pg_trigger canonical ON canonical.tgrelid = legacy.tgrelid
      AND canonical.tgtype = legacy.tgtype AND canonical.tgattr = legacy.tgattr
    WHERE legacy.tgrelid = 'public.integration_plugin_versions'::regclass
      AND legacy.tgname = 'trg_integration_plugin_versions_redact_sensitive_v1'
      AND canonical.tgname = 'trg_plugin_studio_version_redaction_v1'
      AND canonical.tgfoid = 'public.plugin_studio_redact_write_v1()'::regprocedure
      AND canonical.tgenabled IN ('O', 'A')
  ) THEN
    RAISE EXCEPTION 'Plugin version redaction requires the canonical trigger for the same write events';
  END IF;
END;
$handoff$;

DROP TRIGGER trg_integration_plugin_versions_redact_sensitive_v1 ON public.integration_plugin_versions;
COMMIT;
