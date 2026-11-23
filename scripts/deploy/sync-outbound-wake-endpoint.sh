#!/usr/bin/env bash
set -euo pipefail

relay_psql() {
  PGHOST="$pooler" PGPORT=5432 PGDATABASE=postgres PGUSER="postgres.$SUPABASE_PROJECT_REF" \
    PGPASSWORD="$SUPABASE_DB_PASSWORD" PGSSLMODE=verify-full PGSSLROOTCERT="$ca_file" \
    PGGSSENCMODE=disable PGCONNECT_TIMEOUT=8 \
    timeout 20s psql -X -w -A -q -t -v ON_ERROR_STOP=1
}

relay_policy_status() {
  relay_psql <<'SQL'
\getenv endpoint OUTBOUND_WAKE_ENDPOINT
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '8s';
SET LOCAL search_path = pg_catalog;
SET LOCAL log_parameter_max_length_on_error = 0;
WITH policy AS MATERIALIZED (
  SELECT public.resolve_settings('edge_dispatch_policy', 'global', NULL) AS value
)
SELECT COALESCE(value->>'endpoint_url' = $1::text, false),
       COALESCE(jsonb_typeof(value->'enabled') = 'boolean', false)
FROM policy
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

  state="$(relay_policy_status)" || return 1
  case "$state" in
    't|t') printf '%s\n' "$state"; return 0 ;;
    't|f'|'f|t'|'f|f') ;;
    *) return 1 ;;
  esac
  relay_psql >/dev/null <<'SQL' || return 1
\getenv endpoint OUTBOUND_WAKE_ENDPOINT
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL statement_timeout = '8s';
SET LOCAL search_path = pg_catalog;
SET LOCAL log_parameter_max_length_on_error = 0;
WITH policy AS MATERIALIZED (
  SELECT COALESCE(public.resolve_settings('edge_dispatch_policy', 'global', NULL), '{}'::jsonb) AS value
), changed AS MATERIALIZED (
  SELECT value FROM policy
  WHERE jsonb_typeof(value) = 'object'
    AND (NOT (value ? 'enabled') OR jsonb_typeof(value->'enabled') = 'boolean')
    AND (value->>'endpoint_url' IS DISTINCT FROM $1::text OR NOT (value ? 'enabled'))
)
SELECT 1 FROM changed
CROSS JOIN LATERAL public.upsert_settings_value_v1('edge_dispatch_policy', 'global', NULL,
  jsonb_build_object('enabled', false) || changed.value || jsonb_build_object('endpoint_url', $1::text),
  1, 'Sync outbound wake endpoint from deploy configuration');
\bind :endpoint
\g
COMMIT;
SQL
  relay_policy_status
)

endpoint_matches_expected=false
enabled_explicit=false
if state="$(sync_endpoint 2>/dev/null)"; then
  case "$state" in
    't|t') endpoint_matches_expected=true; enabled_explicit=true ;;
    't|f') endpoint_matches_expected=true ;;
    'f|t') enabled_explicit=true ;;
  esac
fi
printf 'endpoint_matches_expected=%s\nenabled_explicit=%s\n' "$endpoint_matches_expected" "$enabled_explicit"
[[ "$endpoint_matches_expected" == true && "$enabled_explicit" == true ]]
