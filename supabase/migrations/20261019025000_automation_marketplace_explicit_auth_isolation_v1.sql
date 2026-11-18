-- Scoped marketplace credentials are never implicit provider defaults, even after unlink/revoke.
BEGIN;
SET LOCAL search_path TO public,extensions,pg_temp;
SET LOCAL lock_timeout='10s';
SELECT pg_advisory_xact_lock(hashtext('20261019025000_automation_marketplace_explicit_auth_isolation_v1'));

-- Preserve the effective functions, ingress wrapper, ownership, and ACLs. Only the two
-- implicit provider+auth_type selectors change; explicitly configured IDs stay untouched.
DO $isolation$
DECLARE
  target REGPROCEDURE;
  definition TEXT;
  selector TEXT;
  matches INT;
  predicate TEXT := 'WHERE[[:space:]]+provider_id[[:space:]]*=[[:space:]]*v_provider_id[[:space:]]+AND[[:space:]]+auth_type[[:space:]]*=[[:space:]]*v_auth_type';
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'public.get_job_call_spec_without_ingress_vault_v1(uuid)'::regprocedure,
    'public.workflow_intake_api_gateway_base_v1(text,text,text,text,jsonb,jsonb)'::regprocedure
  ] LOOP
    definition := pg_get_functiondef(target);
    SELECT count(*),min(match_result.captures[1]) INTO matches,selector
      FROM regexp_matches(definition,predicate,'g') AS match_result(captures);
    IF matches<>1 OR definition LIKE '%marketplace_explicit_only%' THEN
      RAISE EXCEPTION 'Marketplace credential isolation requires the expected native selector: %',target;
    END IF;
    EXECUTE replace(definition,selector,selector || E'\n          AND NOT marketplace_explicit_only');
  END LOOP;
END;
$isolation$;
COMMIT;
