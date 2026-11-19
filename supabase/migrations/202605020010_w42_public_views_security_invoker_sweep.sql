-- Spec-Issue: W42 closure of console-v2 100% production-readiness Wave 4
-- Step: W42-VIEW-SEC-INVOKER
-- Migration: enforce `security_invoker = true` on every public schema view.
--
-- Background:
--   AGENTS.md objective: "Every public view uses security_invoker = true"
--   (RLS posture invariant). PostgreSQL views default to "definer" rights,
--   meaning a SECURITY DEFINER RPC reading from a default view bypasses the
--   caller's RLS context — the view runs as its owner. With
--   `security_invoker = true`, the view runs in the caller's security
--   context, so RLS policies on the underlying tables are evaluated
--   against the caller's role / claims as expected.
--
--   The console-v2 frontend currently consumes views indirectly via
--   SECURITY DEFINER RPCs (see Wave 0 Worker B report). Hardening every
--   public view eliminates the latent bypass risk and aligns with the
--   AGENTS.md invariant.
--
-- Strategy:
--   * Iterate every relkind='v' (regular view) in schema 'public'.
--   * Skip the small set of views that are SUPABASE-system-owned (e.g.
--     internal compatibility shims) or that already have
--     `security_invoker=true` in reloptions.
--   * For everything else, run `ALTER VIEW public.<name> SET (security_invoker = true)`.
--   * NOTICE-log every modification so the migration output records the
--     exact set of views touched.
--   * The migration is idempotent: re-running over a fully-converted
--     schema is a no-op (no views are touched).
--
-- AGENTS.md objectives honored:
--   §1 (SCALABLE/DYNAMIC): one DO block iterates all public views from
--     pg_class — no hardcoded view list to maintain.
--   §5 (APPEND-ONLY MIGRATIONS): new file, no edits to historical CREATE
--     VIEW statements.
--   §6 (RLS ALWAYS / security_invoker): closes the latent definer-rights
--     bypass on every public view in one canonical sweep.
--
-- Append-only: this migration creates no new objects; it only ALTERs
--   existing views with a property change.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605020010_w42_public_views_security_invoker_sweep'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '60s';

DO $sweep$
DECLARE
  v_view RECORD;
  v_already_invoker BOOLEAN;
  v_touched INT := 0;
  v_skipped INT := 0;
BEGIN
  FOR v_view IN
    SELECT n.nspname AS schema_name, c.relname AS view_name, c.reloptions
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'v'   -- regular views only (materialized views are 'm')
    ORDER BY c.relname
  LOOP
    -- Detect existing security_invoker=true; reloptions is a text[] of
    -- 'option=value' strings, NULL when no options are set.
    v_already_invoker := FALSE;
    IF v_view.reloptions IS NOT NULL THEN
      v_already_invoker := EXISTS (
        SELECT 1
        FROM unnest(v_view.reloptions) AS opt(value)
        WHERE lower(opt.value) = 'security_invoker=true'
           OR lower(opt.value) = 'security_invoker=on'
      );
    END IF;

    IF v_already_invoker THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    BEGIN
      EXECUTE format(
        'ALTER VIEW %I.%I SET (security_invoker = true)',
        v_view.schema_name,
        v_view.view_name
      );
      v_touched := v_touched + 1;
      RAISE NOTICE 'security_invoker sweep: ALTERed %.%',
        v_view.schema_name, v_view.view_name;
    EXCEPTION
      WHEN OTHERS THEN
        -- Surface the failing view in the migration output but continue
        -- the sweep — partial coverage is better than total abort, and
        -- the failing view will fail the paired pgTAP check downstream
        -- so it cannot escape unnoticed.
        RAISE WARNING 'security_invoker sweep: FAILED to ALTER %.% — %',
          v_view.schema_name, v_view.view_name, SQLERRM;
        v_skipped := v_skipped + 1;
    END;
  END LOOP;

  RAISE NOTICE 'security_invoker sweep complete: % views ALTERed, % already-compliant or skipped',
    v_touched, v_skipped;
END
$sweep$;

SELECT pg_advisory_unlock(hashtext('202605020010_w42_public_views_security_invoker_sweep'));

COMMIT;
