#!/usr/bin/env bash
set -euo pipefail

relay_psql() {
  local status sqlstate reason
  LC_ALL=C PGHOST="$pooler" PGPORT=5432 PGDATABASE=postgres PGUSER="postgres.$SUPABASE_PROJECT_REF" \
    PGPASSWORD="$SUPABASE_DB_PASSWORD" PGSSLMODE=verify-full PGSSLROOTCERT="$ca_file" \
    PGGSSENCMODE=disable PGCONNECT_TIMEOUT=8 \
    timeout 20s psql -X -w -A -q -t -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate 2>"$psql_stderr" && return 0
  status=$?
  sqlstate="$(LC_ALL=C sed -nE '/^(ERROR|FATAL):  [0-9A-Z]{5}$/ { s/^.*:  //; p; q; }' "$psql_stderr" 2>/dev/null)" || sqlstate=''
  reason="psql-exit-$status"
  if [[ -n "$sqlstate" ]]; then
    reason="sqlstate-$sqlstate"
  fi
  printf 'outbound_wake_sync=FAILED reason=%s\n' "$reason" >&2
  return "$status"
}

relay_policy_status() {
  relay_psql <<'SQL'
\getenv endpoint OUTBOUND_WAKE_ENDPOINT
\getenv desired_enabled EDGE_DISPATCH_ENABLED
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '8s';
SET LOCAL search_path = pg_catalog;
SET LOCAL log_parameter_max_length_on_error = 0;
WITH policy AS MATERIALIZED (
  SELECT public.resolve_settings('edge_dispatch_policy', 'global', NULL) AS value
)
SELECT COALESCE(value->>'endpoint_url' = $1::text, false),
       COALESCE(value->'enabled' = to_jsonb($2::boolean), false)
FROM policy
\bind :endpoint :desired_enabled
\g
COMMIT;
SQL
}

sync_endpoint() (
  export EDGE_DISPATCH_ENABLED="${EDGE_DISPATCH_ENABLED-false}"
  case "$EDGE_DISPATCH_ENABLED" in
    true|false) ;;
    *) return 1 ;;
  esac
  [[ "${SUPABASE_PROJECT_REF:-}" =~ ^[a-z]{20}$ && -n "${SUPABASE_ACCESS_TOKEN:-}" && -n "${SUPABASE_DB_PASSWORD:-}" ]] || return 1
  export OUTBOUND_WAKE_ENDPOINT="https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/api-caller"
  pooler="$(
    printf 'Authorization: Bearer %s\n' "$SUPABASE_ACCESS_TOKEN" |
      curl --fail --silent --max-time 20 --header @- \
        "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/config/database/pooler" |
      jq -ers 'select(length == 1) | .[0] | map(select(.database_type == "PRIMARY"))
        | select(length == 1) | .[0].db_host | strings
        | select(test("\\Aaws-[0-9]+-[a-z0-9-]+\\.pooler\\.supabase\\.com\\z"))' 2>/dev/null
  )" || return 1
  relay_temp="$(mktemp -d 2>/dev/null)" || return 1
  ca_file="$relay_temp/root.crt"
  psql_stderr="$relay_temp/psql.stderr"
  trap 'rm -f "$ca_file" "$psql_stderr"; rmdir "$relay_temp"' EXIT
  curl --fail --silent --max-time 20 --output "$ca_file" \
    https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt &&
    printf '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7  %s\n' "$ca_file" |
      sha256sum --check --status || return 1

  state="$(relay_policy_status)" || return 1
  case "$state" in
    't|t') printf '%s\n' "$state"; return 0 ;;
    't|f'|'f|t'|'f|f') ;;
    *) return 1 ;;
  esac
  relay_psql >/dev/null <<'SQL' || return 1
\getenv endpoint OUTBOUND_WAKE_ENDPOINT
\getenv desired_enabled EDGE_DISPATCH_ENABLED
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL statement_timeout = '8s';
SET LOCAL search_path = pg_catalog;
SET LOCAL log_parameter_max_length_on_error = 0;
-- Leave this statement open so psql binds the parameters before sending it with \g.
WITH policy AS MATERIALIZED (
  SELECT COALESCE(public.resolve_settings('edge_dispatch_policy', 'global', NULL), '{}'::jsonb) AS value
), changed AS MATERIALIZED (
  SELECT value FROM policy
  WHERE jsonb_typeof(value) = 'object'
    AND (NOT (value ? 'enabled') OR jsonb_typeof(value->'enabled') = 'boolean')
    AND (value->>'endpoint_url' IS DISTINCT FROM $1::text OR value->'enabled' IS DISTINCT FROM to_jsonb($2::boolean))
)
SELECT 1 FROM changed
CROSS JOIN LATERAL public.upsert_settings_value_v1('edge_dispatch_policy', 'global', NULL,
  changed.value || jsonb_build_object('endpoint_url', $1::text, 'enabled', $2::boolean),
  1, 'Sync outbound wake endpoint from deploy configuration')
\bind :endpoint :desired_enabled
\g
COMMIT;
SQL
  relay_policy_status
)

endpoint_matches_expected=false
enabled_matches_expected=false
if state="$(sync_endpoint)"; then
  case "$state" in
    't|t') endpoint_matches_expected=true; enabled_matches_expected=true ;;
    't|f') endpoint_matches_expected=true ;;
    'f|t') enabled_matches_expected=true ;;
  esac
fi
printf 'endpoint_matches_expected=%s\nenabled_matches_expected=%s\n' "$endpoint_matches_expected" "$enabled_matches_expected"
[[ "$endpoint_matches_expected" == true && "$enabled_matches_expected" == true ]]
