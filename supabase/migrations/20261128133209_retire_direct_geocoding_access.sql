BEGIN;

SET LOCAL lock_timeout = '10s';

DROP POLICY IF EXISTS geocodes_select_manual ON public.geocodes;
DROP POLICY IF EXISTS geocodes_worker_mutation ON public.geocodes;
DROP POLICY IF EXISTS geocoding_attempts_select_manual ON public.geocoding_attempts;
DROP POLICY IF EXISTS geocoding_attempts_worker_mutation ON public.geocoding_attempts;
DROP POLICY IF EXISTS geocoding_alias_audit_manual_select ON public.geocoding_alias_audit;
DROP POLICY IF EXISTS geocoding_alias_audit_worker_policy ON public.geocoding_alias_audit;

REVOKE SELECT ON TABLE public.geocodes, public.geocoding_attempts, public.geocoding_alias_audit
  FROM geocoding_manual_role;
REVOKE SELECT, INSERT, UPDATE ON TABLE public.geocodes, public.geocoding_attempts, public.geocoding_alias_audit
  FROM geocoding_worker_role;
REVOKE SELECT ON TABLE public.addresses, public.providers, public.settings_versions, public.settings
  FROM geocoding_worker_role;
REVOKE EXECUTE ON FUNCTION public.resolve_settings(text, text, uuid), public.resolve_settings_row(text, text, uuid)
  FROM geocoding_worker_role;

-- The service role has its own grants and policies.
REVOKE geocoding_worker_role FROM service_role;

COMMIT;
