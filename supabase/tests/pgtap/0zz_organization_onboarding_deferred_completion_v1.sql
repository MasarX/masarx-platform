-- Native predicate/catalog and queued-enforcement checks. Full real-tenant
-- provisioning, API authorization and actual COMMIT/reconnect proof remain separate.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

SELECT has_function('public', 'organization_onboarding_deferred_v1', ARRAY[]::text[],
  'canonical timing predicate exists');
SELECT ok(EXISTS (
  SELECT 1 FROM pg_trigger
  WHERE tgrelid = 'public.organizations'::regclass
    AND tgname = 'trg_organizations_deferred_onboarding_v1'
    AND tgdeferrable AND tginitdeferred AND tgenabled = 'O'
    AND (tgtype & 1) = 1 AND (tgtype & 4) = 4 AND (tgtype & 16) = 16
    AND tgfoid = 'public.trigger_complete_deferred_tenant_onboarding_v1()'::regprocedure
), 'organization INSERT/UPDATE completion is enabled and initially deferred');

SELECT set_config('app.organization_onboarding_source', '', true);
SELECT is(public.organization_onboarding_deferred_v1(), false, 'ordinary timing remains immediate');
SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
SELECT is(public.organization_onboarding_deferred_v1(), true, 'selected demo timing is policy eligible');
SELECT set_config('app.organization_onboarding_source', 'unrecognized-native-probe', true);
SELECT is(public.organization_onboarding_deferred_v1(), false, 'unknown source does not defer');
SELECT set_config('app.organization_onboarding_source', '', true);

CREATE TEMP TABLE onboarding_deferred_probe(id UUID NOT NULL);
CREATE CONSTRAINT TRIGGER trg_onboarding_deferred_probe
AFTER INSERT ON onboarding_deferred_probe
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (public.organization_onboarding_deferred_v1())
EXECUTE FUNCTION public.trigger_complete_deferred_tenant_onboarding_v1();

CREATE FUNCTION pg_temp.check_onboarding_queued_enforcement()
RETURNS SETOF TEXT LANGUAGE plpgsql AS $function$
DECLARE
  v_id UUID := gen_random_uuid();
  v_queued BOOLEAN := FALSE;
  v_rejected BOOLEAN := FALSE;
BEGIN
  -- No canonical data/function is replaced: the real bootstrap must reject
  -- the nonexistent organization when the native queued event is executed.
  BEGIN
    PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
    INSERT INTO onboarding_deferred_probe VALUES (v_id);
    v_queued := TRUE;
    PERFORM set_config('app.organization_onboarding_source', '', true);
    EXECUTE 'SET CONSTRAINTS pg_temp.trg_onboarding_deferred_probe IMMEDIATE';
  EXCEPTION WHEN foreign_key_violation THEN
    v_rejected := POSITION('not found' IN SQLERRM) > 0;
  END;
  RETURN NEXT ok(v_queued, 'eligible row queues instead of calling canonical bootstrap immediately');
  RETURN NEXT ok(v_rejected, 'source restoration cannot cancel queued canonical failure');
END;
$function$;
SELECT * FROM pg_temp.check_onboarding_queued_enforcement();
SELECT ok(NOT has_function_privilege('authenticated',
  'public.trigger_complete_deferred_tenant_onboarding_v1()', 'EXECUTE'),
  'completion helper gains no authenticated direct execute grant');
SELECT * FROM finish();
ROLLBACK;
