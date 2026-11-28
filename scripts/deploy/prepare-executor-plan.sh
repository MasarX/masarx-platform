#!/usr/bin/env bash
set -euo pipefail

refuse() {
  echo '::error::Database pre-apply could not verify the linked target or prepare the pending migration.' >&2
  exit 1
}

# Resolve the migration by suffix so a rename-only re-stamp needs no script change.
shopt -s nullglob
planner_fix=(supabase/migrations/*_executor_partition_write_plan_v1.sql)
mode="${1:-executor}"
case "$mode:${DEPLOY_ENV:-}" in
  executor:dev|renderer:dev|renderer:stg|renderer:prod) ;;
  *) refuse ;;
esac
[[ ${#planner_fix[@]} == 1 && -n "${SUPABASE_DB_PASSWORD:-}" ]] || refuse

# Reuse the pinned CLI's session-pooler link without passing connection secrets in argv.
pooler="$(node 2>/dev/null <<'NODE'
const { readFileSync } = require('node:fs');
const ref = process.env.SUPABASE_PROJECT_REF;
const url = new URL(readFileSync('supabase/.temp/pooler-url', 'utf8').trim());
if (!/^[a-z]{20}$/.test(ref) || url.protocol !== 'postgresql:' ||
    url.username !== 'postgres.' + ref || url.port !== '5432' || url.pathname !== '/postgres' ||
    !/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname)) process.exit(1);
console.log(url.hostname);
NODE
)" || refuse

ca_file=config/certs/supabase-prod-ca-2021.crt
printf '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7  %s\n' "$ca_file" |
  sha256sum --check --status 2>/dev/null || refuse

state="$(
  PGHOST="$pooler" PGPORT=5432 PGDATABASE=postgres PGUSER="postgres.$SUPABASE_PROJECT_REF" \
    PGPASSWORD="$SUPABASE_DB_PASSWORD" PGSSLMODE=verify-full PGSSLROOTCERT="$ca_file" \
    PGGSSENCMODE=disable PGCONNECT_TIMEOUT=8 PGOPTIONS='-c search_path=pg_catalog -c statement_timeout=15000' \
    timeout 30s psql -X -w -A -q -t -v ON_ERROR_STOP=1 -v "planner_fix=${planner_fix[0]}" \
      -v "renderer_only=$([[ $mode == renderer ]] && echo true || echo false)" 2>/dev/null <<'SQL'
SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS has_history,
       to_regclass('public.outbound_calls') IS NOT NULL AS has_outbound \gset
\if :has_history
SELECT max(version) IS NULL AS fresh,
       count(*) FILTER (WHERE version = '20261126163709') = 1 AS closure_applied,
       COALESCE(max(version) = '20261124213942', false) AS at_predecessor,
       count(*) FILTER (WHERE version = '20261124213942') = 1 AS renderer_gate_applied,
       COALESCE(max(version) < '20261123047400', false) AND NOT EXISTS (
         SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public.outbound_calls')
            AND attname = 'renderer_request_id' AND NOT attisdropped
       ) AS before_renderer_cutover
FROM supabase_migrations.schema_migrations \gset
\else
\set fresh true
\endif
\if :fresh
\if :renderer_only
SELECT CASE WHEN :'has_outbound'::boolean THEN 'renderer_history_unprotected' ELSE 'renderer_fresh' END;
\else
\echo fresh
\endif
\elif :renderer_only
\if :renderer_gate_applied
\echo renderer_gate_applied
\elif :before_renderer_cutover
BEGIN;
SET LOCAL lock_timeout = '10s';
\i scripts/deploy/hold-renderer-upgrade-jobs.sql
COMMIT;
\echo renderer_jobs_held
\else
-- A stopped apply can safely continue only if the durable hold is still installed.
SELECT EXISTS (
  SELECT 1 FROM pg_trigger
   WHERE tgrelid = 'public.outbound_calls'::regclass
     AND tgfoid = to_regprocedure('public.hold_renderer_upgrade_job_v1()')
     AND tgname = 'hold_renderer_upgrade_job_v1' AND tgtype = 7 AND tgenabled IN ('O', 'A')
) AS renderer_hold_active \gset
\if :renderer_hold_active
\echo renderer_jobs_held
\else
\echo renderer_history_unprotected
\endif
\endif
\elif :closure_applied
\echo closure_applied
\elif :at_predecessor
\i :planner_fix
\echo ready
\else
\echo unexpected_history
\endif
SQL
)" || refuse

case "$state" in
  fresh|closure_applied|ready) printf 'executor_plan_preapply=%s\n' "$state" ;;
  renderer_fresh) printf 'renderer_upgrade_preapply=fresh\n' ;;
  renderer_gate_applied|renderer_jobs_held) printf 'renderer_upgrade_preapply=%s\n' "$state" ;;
  renderer_history_unprotected)
    echo '::error::The leased renderer migration started without the upgrade hold. Review the existing renderer receipts before resuming.' >&2
    exit 1 ;;
  *) refuse ;;
esac
