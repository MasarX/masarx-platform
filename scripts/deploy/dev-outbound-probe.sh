#!/usr/bin/env bash
set -euo pipefail

[[ "${GITHUB_EVENT_NAME:-}:${DEPLOY_ENV:-}:${GITHUB_REF:-}" == workflow_dispatch:dev:refs/heads/main ]] || exit 1
probe_count="${PROBE_COUNT:-20}"
[[ "$probe_count" =~ ^([2-4][0-9]|50)$ ]] || exit 1
[[ "${SUPABASE_PROJECT_REF:-}" =~ ^[a-z]{20}$ && -n "${SUPABASE_ACCESS_TOKEN:-}" && -n "${SUPABASE_DB_PASSWORD:-}" ]] || exit 1
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] || exit 1

probe_marker=dev-outbound-probe
probe_run="$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
probe_base="https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1"
pooler="$(
  printf 'Authorization: Bearer %s\n' "$SUPABASE_ACCESS_TOKEN" |
    curl --fail --silent --max-time 20 --header @- \
      "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/config/database/pooler" |
    jq -ers 'select(length == 1) | .[0] | map(select(.database_type == "PRIMARY"))
      | select(length == 1) | .[0].db_host | strings
      | select(test("\\Aaws-[0-9]+-[a-z0-9-]+\\.pooler\\.supabase\\.com\\z"))' 2>/dev/null
)"
ca_file="$(mktemp)"
trap 'rm -f "$ca_file"' EXIT
curl --fail --silent --max-time 20 --output "$ca_file" \
  https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt
printf '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7  %s\n' "$ca_file" |
  sha256sum --check --status

probe_psql() {
  local limit="$1"
  shift
  PGHOST="$pooler" PGPORT=5432 PGDATABASE=postgres PGUSER="postgres.$SUPABASE_PROJECT_REF" \
    PGPASSWORD="$SUPABASE_DB_PASSWORD" PGSSLMODE=verify-full PGSSLROOTCERT="$ca_file" \
    PGGSSENCMODE=disable PGCONNECT_TIMEOUT=8 \
    timeout "$limit" psql -X -w -A -q -t -v ON_ERROR_STOP=1 \
      -v "probe_marker=$probe_marker" -v "probe_run=$probe_run" "$@" 2>/dev/null
}

enqueue_sql() {
  cat <<'SQL'
BEGIN;
SET LOCAL statement_timeout = '8s';
SET LOCAL search_path = pg_catalog;
SELECT COALESCE(public.resolve_edge_dispatch_enabled_v1() AND
  public.resolve_settings('edge_dispatch_policy', 'global', NULL)->>'endpoint_url' = :'probe_base' || '/api-caller',
  false) AS ready
\gset
\if :ready
\else
  \quit
\endif

-- Keep the synthetic fixture and its tagged jobs for audit. Enqueues use the normal workflow guards.
INSERT INTO public.organizations (name, slug)
VALUES ('DEV outbound probe', :'probe_marker' || '-' || :'probe_run')
RETURNING id AS org_id
\gset
INSERT INTO public.providers (organization_id, name, provider_type)
VALUES (:'org_id', :'probe_marker', 'http')
RETURNING id AS provider_id
\gset
INSERT INTO public.mapping_configs (organization_id, mapping_type, mapping_key, mapping_config)
VALUES (:'org_id', 'provider_response', :'probe_marker' || '-' || :'probe_run', '{}')
RETURNING id AS mapping_id
\gset
INSERT INTO public.operation_templates (provider_id, operation_name, method, url_template, mapping_config_id)
VALUES (:'provider_id', :'probe_marker', 'GET', :'probe_base' || '/outbound-probe-ack', :'mapping_id')
RETURNING id AS operation_id
\gset
COMMIT;
SQL

  local i
  for ((i = 0; i <= probe_count; i++)); do
    if ((i == 0)); then
      printf '\\set lane relay\n'
    else
      printf '\\set lane inline\n'
    fi
    cat <<'SQL'
BEGIN;
SET LOCAL statement_timeout = '8s';
SET LOCAL search_path = pg_catalog;
SELECT public.enqueue_outbound_call_from_operation_template_v1(:'operation_id'::uuid, '{}'::jsonb,
  jsonb_build_object('probe_marker', :'probe_marker', 'probe_run', :'probe_run',
    'probe_lane', :'lane', 'organization_id', :'org_id'), NULL, p_max_retries => 1) AS job_id,
  :'lane' = 'inline' AS use_inline
\gset
\if :use_inline
  SELECT public.dispatch_outbound_call_inline(:'job_id'::uuid,
    public.resolve_settings('comms_reply_policy', 'global', NULL)->'dispatch') AS dispatch_result
  \gset
  SELECT status = 'pending_edge' AS handed_off FROM public.outbound_calls WHERE id = :'job_id'::uuid
  \gset
  \if :handed_off
  \else
    \quit
  \endif
\endif
COMMIT;
SQL
  done
  printf "SELECT 'ready';\n"
}

read_probe() {
  probe_psql 15s <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout = '8s';
SET LOCAL search_path = pg_catalog;
WITH jobs AS (
  SELECT o.status, o.context->>'probe_lane' AS lane,
    EXTRACT(EPOCH FROM o.completed_at - o.created_at) * 1000 AS elapsed_ms,
    o.status IN ('permanently_failed', 'skipped', 'cancelled') OR
      (o.status = 'failed' AND o.retry_count >= o.max_retries) AS failed,
    CASE
      WHEN o.error_message IN (
        'Egress policy violation: guarded proxy transport is unavailable',
        'Guarded egress proxy URL is not configured',
        'Deno guarded proxy transport is unavailable'
      ) THEN 'egress_proxy_unavailable'
      WHEN o.error_message IN (
        'Guarded egress proxy URL must be an exact HTTPS origin',
        'Guarded egress proxy username and password must be configured together',
        'Guarded egress proxy credentials are invalid',
        'Deno guarded proxy client initialization failed'
      ) THEN 'egress_proxy_misconfigured'
      WHEN o.error_message = 'Guarded egress proxy request failed' THEN 'egress_proxy_request_failed'
      ELSE 'other'
    END AS failure_reason,
    o.status = 'completed' AND EXISTS (
      SELECT 1 FROM public.audit_table_changes a
      WHERE a.schema_name = 'public' AND a.table_name = 'outbound_calls' AND a.op = 'UPDATE'
        AND a.created_at >= o.created_at AND a.created_at = o.updated_at AND a.pk->>'id' = o.id::text
        AND a.row_old->>'status' = 'in_progress_edge' AND a.row_old->>'edge_lease_token' IS NOT NULL
        AND a.row_new->>'status' = 'completed'
    ) AS edge_completed
  FROM public.outbound_calls o
  WHERE o.created_at >= now() - interval '15 minutes'
    AND o.context @> jsonb_build_object('probe_marker', :'probe_marker', 'probe_run', :'probe_run')
), samples AS (
  SELECT *, status = 'completed' AND lane = 'inline' AND elapsed_ms >= 0 AS inline_sample,
    edge_completed AND elapsed_ms >= 0 AS edge_sample FROM jobs
)
SELECT count(*), count(*) FILTER (WHERE status = 'completed'), count(*) FILTER (WHERE failed),
  count(*) FILTER (WHERE status <> 'completed' AND NOT failed),
  count(*) FILTER (WHERE edge_completed AND lane = 'relay'),
  count(*) FILTER (WHERE inline_sample), count(*) FILTER (WHERE edge_sample),
  CASE WHEN count(*) FILTER (WHERE inline_sample) >= 20 THEN
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY elapsed_ms) FILTER (WHERE inline_sample))::bigint END,
  CASE WHEN count(*) FILTER (WHERE inline_sample) >= 20 THEN
    round(percentile_cont(0.95) WITHIN GROUP (ORDER BY elapsed_ms) FILTER (WHERE inline_sample))::bigint END,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY elapsed_ms) FILTER (WHERE edge_sample))::bigint,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY elapsed_ms) FILTER (WHERE edge_sample))::bigint,
  count(*) FILTER (WHERE failed AND failure_reason = 'egress_proxy_unavailable'),
  count(*) FILTER (WHERE failed AND failure_reason = 'egress_proxy_misconfigured'),
  count(*) FILTER (WHERE failed AND failure_reason = 'egress_proxy_request_failed'),
  count(*) FILTER (WHERE failed AND failure_reason = 'other')
FROM samples;
COMMIT;
SQL
}

enqueue_result="$(enqueue_sql | probe_psql 60s -v "probe_base=$probe_base")" || enqueue_result=''
# Leave room for the last sleep and query within the 10-minute wait.
deadline=$((SECONDS + 575))
count='(0|[1-9][0-9]?)'
timing='[0-9]{0,6}'
metrics_pattern="^$count\|$count\|$count\|$count\|$count\|$count\|$count\|$timing\|$timing\|$timing\|$timing\|$count\|$count\|$count\|$count$"
while :; do
  metrics="$(read_probe)"
  [[ "$metrics" =~ $metrics_pattern ]] || exit 1
  IFS='|' read -r enqueued completed failed pending relay inline edge inline_p50 inline_p95 edge_p50 edge_p95 \
    proxy_unavailable proxy_misconfigured proxy_request_failed failed_other <<< "$metrics"
  if [[ "$enqueue_result" != ready || "$pending" == 0 ]] || ((SECONDS >= deadline)); then
    break
  fi
  sleep 10
done

{
  printf 'probe_enqueued=%s\nprobe_completed=%s\nprobe_failed=%s\nprobe_pending=%s\n' \
    "$enqueued" "$completed" "$failed" "$pending"
  printf 'probe_relay_completed=%s\nprobe_inline_samples=%s\nprobe_edge_samples=%s\n' "$relay" "$inline" "$edge"
  printf 'probe_inline_p50_ms=%s\nprobe_inline_p95_ms=%s\nprobe_edge_p50_ms=%s\nprobe_edge_p95_ms=%s\n' \
    "${inline_p50:-null}" "${inline_p95:-null}" "${edge_p50:-null}" "${edge_p95:-null}"
  printf 'probe_failed_egress_proxy_unavailable=%s\nprobe_failed_egress_proxy_misconfigured=%s\nprobe_failed_egress_proxy_request_failed=%s\nprobe_failed_other=%s\n' \
    "$proxy_unavailable" "$proxy_misconfigured" "$proxy_request_failed" "$failed_other"
} | tee -a "$GITHUB_STEP_SUMMARY"

[[ "$enqueue_result" == ready ]] && ((enqueued == probe_count + 1 && completed >= 1 && relay >= 1 && inline >= 20))
