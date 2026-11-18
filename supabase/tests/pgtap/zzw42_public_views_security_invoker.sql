-- W42 Wave 4 closure — pgTAP guarding the AGENTS.md invariant:
--   "Every public view uses security_invoker = true"
--
-- Companion migration: supabase/migrations/202605020010_w42_public_views_security_invoker_sweep.sql
--
-- Strategy: enumerate every regular view in schema 'public' and assert
-- that its `reloptions` contains `security_invoker=true`. The sweep
-- migration converts every view in one pass; any future view that ships
-- without `WITH (security_invoker = true)` will fail this gate so the
-- invariant cannot regress silently.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

DO $$
DECLARE
  v_view_count INT;
BEGIN
  SELECT count(*)
    INTO v_view_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'v'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        JOIN pg_extension e ON e.oid = d.refobjid
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.deptype = 'e'
      );

  -- One assertion per public view + one for the "no public view exists
  -- without security_invoker=true" aggregate check.
  PERFORM plan(v_view_count + 1);
END
$$;

CREATE OR REPLACE FUNCTION test_w42_public_views_security_invoker()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_view RECORD;
  v_has_invoker BOOLEAN;
BEGIN
  FOR v_view IN
    SELECT n.nspname AS schema_name, c.relname AS view_name, c.reloptions
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'v'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        JOIN pg_extension e ON e.oid = d.refobjid
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.deptype = 'e'
      )
    ORDER BY c.relname
  LOOP
    v_has_invoker := FALSE;
    IF v_view.reloptions IS NOT NULL THEN
      v_has_invoker := EXISTS (
        SELECT 1
        FROM unnest(v_view.reloptions) AS opt(value)
        WHERE lower(opt.value) = 'security_invoker=true'
           OR lower(opt.value) = 'security_invoker=on'
      );
    END IF;

    RETURN NEXT ok(
      v_has_invoker,
      format('public.%I has security_invoker = true', v_view.view_name)
    );
  END LOOP;
END
$function$;

SELECT * FROM test_w42_public_views_security_invoker();

-- Aggregate failure check (helps future drift diagnosis). Counts the
-- number of public views WITHOUT security_invoker=true; should always be
-- zero post-sweep.
SELECT is(
  (
    SELECT count(*)::int
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1
        FROM unnest(COALESCE(c.reloptions, ARRAY[]::text[])) AS opt(value)
        WHERE lower(opt.value) IN ('security_invoker=true', 'security_invoker=on')
      ) AS has_invoker
    ) flag ON TRUE
    WHERE n.nspname = 'public'
      AND c.relkind = 'v'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        JOIN pg_extension e ON e.oid = d.refobjid
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.deptype = 'e'
      )
      AND NOT COALESCE(flag.has_invoker, FALSE)
  ),
  0,
  'no public view runs in definer-rights mode (security_invoker = false / unset)'
);

ROLLBACK;
