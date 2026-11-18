-- Spec-Issue: W14-2 (INSIGHTS api-gateway gap closure — W7 audit + W10-5 deferred)
-- Migration: paired projection view for the FE-friendly api_gateway observability shape.
--
-- Purpose:
--   The Console FE consumer (`apps/console-v2/src/modules/insights/api-gateway.tsx`)
--   exposes an `ApiCallRow` projection that spans 4-5 canonical backend tables
--   (`api_call_log` + `api_gateway_requests` + `api_routes` + `api_route_packs`
--   + `webhook_sources` + `provider_health_logs`). W11/W13 deferred 8 REMOVE +
--   6 RENAME drift items per `__audit__/SCHEMA-DRIFT/INSIGHTS.md §1` citing
--   the need for a paired projection view. This migration closes that gap
--   additively without renaming canonical columns — SSOT remains the
--   underlying base tables.
--
--   Likewise W11/W13 deferred 4 REMOVE + 2 RENAME on `RateLimitRow`
--   (`__audit__/SCHEMA-DRIFT/INSIGHTS.md §2`); this migration adds a paired
--   `v_api_gateway_rate_limits_summary` view that joins
--   `api_gateway_rate_limits` + `webhook_sources` and computes
--   `limit_per_min` (rate_limit_per_hour / 60) + `saturated`
--   (request_count >= limit).
--
-- Field projection contract — v_api_gateway_observability:
--   id              = api_call_log.id
--   request_id      = api_gateway_requests.id (joined via correlation_id; NULL if no joined request)
--   organization_id = api_call_log.organization_id
--   provider_id     = api_call_log.provider_id
--   operation       = api_call_log.operation
--   method          = api_call_log.method
--   url             = api_call_log.url                      (canonical SSOT)
--   path            = path component of api_call_log.url    (RENAME → path)
--   request_headers = api_call_log.request_headers
--   response_status = api_call_log.response_status          (canonical SSOT)
--   status_code     = api_call_log.response_status          (RENAME → status_code)
--   response_headers= api_call_log.response_headers
--   response_body   = api_call_log.response_body
--   response_body_sample = LEFT(response_body::text, 4096)  (truncation projection)
--   response_size_bytes  = octet_length(response_body::text)(derived)
--   duration_ms     = api_call_log.duration_ms
--   error_message   = api_call_log.error_message
--   error_code      = derived from response_status / error_message
--                       'rate_limited' when response_status = 429
--                       'upstream_error' when response_status >= 500
--                       'forbidden' when response_status = 403
--                       'unauthorized' when response_status = 401
--                       'not_found' when response_status = 404
--                       error_message otherwise (when response_status >= 400)
--                       NULL otherwise
--   circuit_breaker_state = api_call_log.circuit_breaker_state
--   timestamp       = api_call_log.timestamp                (canonical SSOT)
--   occurred_at     = api_call_log.timestamp                (RENAME → occurred_at)
--   route_id        = api_gateway_requests.route_id         (joined; NULL when no request)
--   route_pack_id   = api_routes.pack_id                    (joined via route_id; NULL when no route)
--   source_id       = api_gateway_requests.source_id        (joined; NULL when no request)
--   source_label    = webhook_sources.name                  (joined via source_id)
--   source_org_id   = webhook_sources.organization_id       (joined via source_id)
--
-- Field projection contract — v_api_gateway_rate_limits_summary:
--   id              = api_gateway_rate_limits.id
--   source_id       = api_gateway_rate_limits.source_id
--   source_label    = webhook_sources.name (joined via source_id)
--   limit_per_min   = floor(webhook_sources.rate_limit_per_hour / 60)
--                     (rate_limit_per_hour is the canonical column; per-minute
--                     is computed for the FE chip)
--   limit_per_hour  = webhook_sources.rate_limit_per_hour    (canonical SSOT)
--   current_usage   = api_gateway_rate_limits.request_count  (RENAME → current_usage)
--   request_count   = api_gateway_rate_limits.request_count  (canonical SSOT)
--   saturated       = (request_count >= limit_per_hour)      (derived)
--   window_start    = api_gateway_rate_limits.window_start
--   updated_at      = api_gateway_rate_limits.updated_at
--
-- Cross-references:
--   - `apps/console-v2/__audit__/SCHEMA-DRIFT/INSIGHTS.md §1-§2` (FE shape)
--   - `apps/console-v2/src/modules/insights/api-gateway.tsx:113-145` (FE consumer)
--   - `supabase/migrations/202510110003_mapping_lookup.sql:301-320` (api_call_log SSOT)
--   - `supabase/migrations/202512251100_api_gateway_core.sql:67-148` (api_gateway_* SSOT)
--   - `supabase/migrations/202510110004_webhook_integration.sql:185-197` (webhook_sources SSOT)
--   - `supabase/migrations/202512011801_ops_alerts_health.sql:27-37` (provider_health_logs SSOT)

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301800_v_api_gateway_observability'));
SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) v_api_gateway_observability — joined projection over api_call_log
-------------------------------------------------------------------------------

DROP VIEW IF EXISTS public.v_api_gateway_observability;

CREATE VIEW public.v_api_gateway_observability AS
SELECT
  acl.id,
  agr.id                                AS request_id,
  acl.organization_id,
  acl.provider_id,
  acl.operation,
  acl.method,
  acl.url,
  CASE
    WHEN position('?' IN COALESCE(acl.url, '')) > 0
      THEN left(acl.url, position('?' IN acl.url) - 1)
    ELSE acl.url
  END                                   AS path,
  acl.request_headers,
  acl.response_status,
  acl.response_status                   AS status_code,
  acl.response_headers,
  acl.response_body,
  CASE
    WHEN acl.response_body IS NULL THEN NULL
    ELSE left(acl.response_body::text, 4096)
  END                                   AS response_body_sample,
  CASE
    WHEN acl.response_body IS NULL THEN 0
    ELSE octet_length(acl.response_body::text)
  END                                   AS response_size_bytes,
  acl.duration_ms,
  acl.error_message,
  CASE
    WHEN acl.response_status = 401 THEN 'unauthorized'
    WHEN acl.response_status = 403 THEN 'forbidden'
    WHEN acl.response_status = 404 THEN 'not_found'
    WHEN acl.response_status = 422 THEN 'validation_failed'
    WHEN acl.response_status = 429 THEN 'rate_limited'
    WHEN acl.response_status >= 500 AND acl.response_status < 504
      THEN 'upstream_error'
    WHEN acl.response_status = 504 THEN 'upstream_timeout'
    WHEN acl.response_status >= 400 THEN COALESCE(acl.error_message, 'error')
    ELSE NULL
  END                                   AS error_code,
  acl.circuit_breaker_state,
  acl.timestamp,
  acl.timestamp                         AS occurred_at,
  agr.route_id,
  ar.pack_id                            AS route_pack_id,
  agr.source_id,
  ws.name                               AS source_label,
  ws.organization_id                    AS source_org_id,
  CASE
    WHEN jsonb_typeof(acl.request_headers) = 'object'
      THEN jsonb_strip_nulls(acl.request_headers) <> '{}'::jsonb
    ELSE FALSE
  END                                   AS has_request_headers
FROM public.api_call_log acl
LEFT JOIN public.api_gateway_requests agr
  ON  agr.organization_id = acl.organization_id
  AND agr.path             = CASE
                                WHEN position('?' IN COALESCE(acl.url, '')) > 0
                                  THEN left(acl.url, position('?' IN acl.url) - 1)
                                ELSE acl.url
                              END
  AND upper(agr.method)    = upper(acl.method)
  AND agr.received_at      <= acl.timestamp
  AND agr.received_at      >  acl.timestamp - INTERVAL '5 minutes'
LEFT JOIN public.api_routes ar
  ON ar.id = agr.route_id
LEFT JOIN public.webhook_sources ws
  ON ws.id = agr.source_id;

COMMENT ON VIEW public.v_api_gateway_observability IS
  'W14-2 — FE-friendly projection of api_call_log joined to api_gateway_requests
  (organization + path + method window-bounded), api_routes (pack_id), and
  webhook_sources (source_label / source_org_id). Derives error_code from
  response_status, path from url, and response_size_bytes from response_body.
  SSOT remains public.api_call_log; api_gateway intake / postprocess writers
  continue to use canonical column names.';

-- RLS access mirrors the underlying tables: views inherit base-table RLS,
-- and api_call_log + api_gateway_requests + api_routes + webhook_sources +
-- api_route_packs are all service-role-only with explicit policies.
REVOKE ALL ON public.v_api_gateway_observability FROM PUBLIC;
REVOKE ALL ON public.v_api_gateway_observability FROM anon;
REVOKE ALL ON public.v_api_gateway_observability FROM authenticated;
GRANT SELECT ON public.v_api_gateway_observability TO service_role;

-------------------------------------------------------------------------------
-- 2) v_api_gateway_rate_limits_summary — joined projection over rate_limits
-------------------------------------------------------------------------------

DROP VIEW IF EXISTS public.v_api_gateway_rate_limits_summary;

CREATE VIEW public.v_api_gateway_rate_limits_summary AS
SELECT
  rl.id,
  rl.source_id,
  ws.name                               AS source_label,
  ws.organization_id                    AS source_org_id,
  ws.rate_limit_per_hour                AS limit_per_hour,
  -- Per-minute is computed (FE chip surface). The canonical column is
  -- rate_limit_per_hour; the per-minute view is a deterministic
  -- floor-divide.
  GREATEST(floor(COALESCE(ws.rate_limit_per_hour, 0) / 60.0)::INT, 0)
                                        AS limit_per_min,
  rl.request_count,
  rl.request_count                      AS current_usage,
  -- Saturated when the current request_count meets or exceeds the canonical
  -- per-hour limit. (rate_limit_per_hour=0 ⇒ never saturated, since the
  -- gateway treats 0 as "no limit configured" — see api_gateway_core
  -- migration 202512251100 §4.)
  CASE
    WHEN COALESCE(ws.rate_limit_per_hour, 0) = 0 THEN FALSE
    ELSE rl.request_count >= ws.rate_limit_per_hour
  END                                   AS saturated,
  rl.window_start,
  rl.updated_at
FROM public.api_gateway_rate_limits rl
LEFT JOIN public.webhook_sources ws
  ON ws.id = rl.source_id;

COMMENT ON VIEW public.v_api_gateway_rate_limits_summary IS
  'W14-2 — FE-friendly projection of api_gateway_rate_limits joined to
  webhook_sources. Computes limit_per_min (floor(rate_limit_per_hour / 60))
  and saturated (request_count >= rate_limit_per_hour). SSOT remains
  public.api_gateway_rate_limits + public.webhook_sources; the gateway
  intake RPC continues to write via canonical column names.';

REVOKE ALL ON public.v_api_gateway_rate_limits_summary FROM PUBLIC;
REVOKE ALL ON public.v_api_gateway_rate_limits_summary FROM anon;
REVOKE ALL ON public.v_api_gateway_rate_limits_summary FROM authenticated;
GRANT SELECT ON public.v_api_gateway_rate_limits_summary TO service_role;

SELECT pg_advisory_unlock(hashtext('202604301800_v_api_gateway_observability'));
COMMIT;
