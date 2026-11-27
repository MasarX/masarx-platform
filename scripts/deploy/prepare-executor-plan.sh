#!/usr/bin/env bash
set -euo pipefail

refuse() {
  echo '::error::Executor planner pre-apply could not verify the linked target or prepare the pending closure.' >&2
  exit 1
}

# Resolve the migration by suffix so a rename-only re-stamp needs no script change.
shopt -s nullglob
planner_fix=(supabase/migrations/*_executor_partition_write_plan_v1.sql)
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
    timeout 30s psql -X -w -A -q -t -v ON_ERROR_STOP=1 -v "planner_fix=${planner_fix[0]}" 2>/dev/null <<'SQL'
SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS has_history \gset
\if :has_history
SELECT max(version) IS NULL AS fresh,
       count(*) FILTER (WHERE version = '20261126163709') = 1 AS closure_applied,
       COALESCE(max(version) = '20261124213942', false) AS at_predecessor
FROM supabase_migrations.schema_migrations \gset
\if :fresh
\echo fresh
\elif :closure_applied
\echo closure_applied
\elif :at_predecessor
\i :planner_fix
\echo ready
\else
\echo unexpected_history
\endif
\else
\echo fresh
\endif
SQL
)" || refuse

case "$state" in
  fresh|closure_applied|ready) printf 'executor_plan_preapply=%s\n' "$state" ;;
  *) refuse ;;
esac
