#!/usr/bin/env bash
set -euo pipefail

relay_psql() {
  PGHOST="$pooler" PGPORT=5432 PGDATABASE=postgres PGUSER="postgres.$SUPABASE_PROJECT_REF" \
    PGPASSWORD="$SUPABASE_DB_PASSWORD" PGSSLMODE=verify-full PGSSLROOTCERT="$ca_file" \
    PGGSSENCMODE=disable PGCONNECT_TIMEOUT=8 \
    timeout 20s psql -X -w -A -q -t -v ON_ERROR_STOP=1
}

relay_endpoint_matches() {
  relay_psql <<'SQL'
\getenv endpoint OUTBOUND_WAKE_ENDPOINT
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '8s';
SET LOCAL search_path = pg_catalog;
SET LOCAL log_parameter_max_length_on_error = 0;
SELECT COALESCE(public.resolve_settings('edge_dispatch_policy', 'global', NULL)->>'endpoint_url' = $1::text, false)
\bind :endpoint
\g
COMMIT;
SQL
}

sync_endpoint() (
  [[ "${SUPABASE_PROJECT_REF:-}" =~ ^[a-z]{20}$ && -n "${SUPABASE_ACCESS_TOKEN:-}" && -n "${SUPABASE_DB_PASSWORD:-}" ]] || return 1
  export OUTBOUND_WAKE_ENDPOINT="https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/api-caller"
  pooler="$(
    printf 'Authorization: Bearer %s\n' "$SUPABASE_ACCESS_TOKEN" |
      curl --fail --silent --max-time 20 --header @- \
        "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/config/database/pooler" |
      jq -ers 'select(length == 1) | .[0] | map(select(.database_type == "PRIMARY"))
        | select(length == 1) | .[0].db_host | strings
        | select(test("\\Aaws-[0-9]+-[a-z0-9-]+\\.pooler\\.supabase\\.com\\z"))'
  )" || return 1
  ca_file="$(mktemp)" || return 1
  trap 'rm -f "$ca_file"' EXIT
  curl --fail --silent --max-time 20 --output "$ca_file" \
    https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt &&
    printf '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7  %s\n' "$ca_file" |
      sha256sum --check --status || return 1

  matches="$(relay_endpoint_matches)" || return 1
  case "$matches" in
    t) return 0 ;;
    f) ;;
    *) return 1 ;;
  esac
  relay_psql >/dev/null <<'SQL' || return 1
\getenv endpoint OUTBOUND_WAKE_ENDPOINT
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL statement_timeout = '8s';
SET LOCAL search_path = pg_catalog;
SET LOCAL log_parameter_max_length_on_error = 0;
WITH policy AS MATERIALIZED (
  SELECT public.resolve_settings('edge_dispatch_policy', 'global', NULL) AS value
), changed AS MATERIALIZED (
  SELECT value FROM policy WHERE value->>'endpoint_url' IS DISTINCT FROM $1::text
)
SELECT 1 FROM changed
CROSS JOIN LATERAL public.upsert_settings_value_v1('edge_dispatch_policy', 'global', NULL,
  jsonb_set(COALESCE(changed.value, '{}'::jsonb), '{endpoint_url}', to_jsonb($1::text)),
  1, 'Sync outbound wake endpoint from deploy configuration');
\bind :endpoint
\g
COMMIT;
SQL
  matches="$(relay_endpoint_matches)" && [[ "$matches" == t ]]
)

if sync_endpoint 2>/dev/null; then
  printf 'endpoint_matches_expected=true\n'
else
  printf 'endpoint_matches_expected=false\n'
  exit 1
fi
