BEGIN;

SET LOCAL client_min_messages TO notice;
SELECT plan(1);

DO $$
BEGIN
  RAISE NOTICE 'DIAG347 def=%', pg_get_functiondef('public.complete_label_jobs(jsonb)'::regprocedure);
  RAISE NOTICE 'DIAG347 acl=%', (
    SELECT proacl
    FROM pg_proc
    WHERE oid = 'public.complete_label_jobs(jsonb)'::regprocedure
  );
END;
$$;

SELECT pass('diag');
SELECT * FROM finish();

ROLLBACK;
