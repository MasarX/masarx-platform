-- Migration: Console V2 marketing intake recent reads Landing marketing lead truth
-- Goal:
--   - `marketing_intake_recent` must project canonical Landing marketing/contact
--     lead rows from `marketing_demo_requests`, not tenant signup requests.
--   - Keep task/workflow/dispatch lineage visible where the existing workflow
--     binding path produced it.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605291830_console_v2_marketing_intake_recent_demo_requests_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

GRANT SELECT ON TABLE public.marketing_demo_requests TO authenticated;

DROP POLICY IF EXISTS marketing_demo_requests_console_read_policy ON public.marketing_demo_requests;
CREATE POLICY marketing_demo_requests_console_read_policy
  ON public.marketing_demo_requests
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    AND (
      public.user_has_capability_v1('webhooks.read')
      OR public.user_has_capability_v1('observability.read')
      OR public.user_has_capability_v1('audit_log.read')
    )
  );

DROP VIEW IF EXISTS public.marketing_intake_metrics_24h;
DROP VIEW IF EXISTS public.marketing_intake_recent_v1;

CREATE OR REPLACE VIEW public.marketing_intake_recent_v1
WITH (security_invoker = true) AS
WITH latest_task AS (
  SELECT DISTINCT ON (t.resource_id)
    t.resource_id,
    t.id::TEXT AS task_id,
    COALESCE(t.workflow_run_id::TEXT, NULLIF(t.metadata->>'parent_workflow_run_id', '')) AS task_workflow_run_id,
    t.status AS task_status,
    t.queue_key AS task_queue_key,
    t.created_at AS task_created_at
  FROM public.tasks t
  JOIN public.task_types tt
    ON tt.id = t.task_type_id
   AND tt.key = 'marketing_lead_followup'
  WHERE t.resource_type = 'marketing_lead_request'
    AND t.resource_id IS NOT NULL
  ORDER BY t.resource_id, t.created_at DESC, t.id DESC
),
latest_dispatch AS (
  SELECT DISTINCT ON (d.resource_id)
    d.resource_id,
    d.id::TEXT AS dispatch_id,
    d.workflow_run_id::TEXT AS dispatch_workflow_run_id,
    d.outcome AS dispatch_outcome,
    d.created_at AS dispatch_created_at
  FROM public.workflow_binding_dispatches d
  WHERE d.binding_key = 'marketing_lead'
    AND d.stage_key = 'review_requested'
    AND d.resource_type = 'marketing_lead_request'
    AND d.resource_id IS NOT NULL
  ORDER BY d.resource_id, d.created_at DESC, d.id DESC
),
lead_rows AS (
  SELECT
    r.id,
    r.created_at,
    r.email,
    r.company,
    r.volume,
    r.role,
    r.notes,
    r.locale,
    r.page_url,
    r.referrer,
    r.origin,
    r.marketing,
    r.ip_hash,
    r.turnstile_verified,
    COALESCE(
      NULLIF(r.marketing #>> '{intake,dedupe_status}', ''),
      NULLIF(r.marketing->>'dedupe_status', ''),
      'new'
    ) AS resolved_dedupe_status,
    CASE
      WHEN lower(COALESCE(
        NULLIF(r.marketing #>> '{intake,rate_limit_status}', ''),
        NULLIF(r.marketing #>> '{rate_limit,status}', ''),
        NULLIF(r.marketing->>'rate_limit_status', ''),
        'ok'
      )) IN ('limited', 'rate_limited')
        THEN 'limited'
      ELSE COALESCE(
        NULLIF(r.marketing #>> '{intake,rate_limit_status}', ''),
        NULLIF(r.marketing #>> '{rate_limit,status}', ''),
        NULLIF(r.marketing->>'rate_limit_status', ''),
        'ok'
      )
    END AS resolved_rate_limit_status
  FROM public.marketing_demo_requests r
)
SELECT
  l.id::TEXT AS id,
  l.created_at AS received_at,
  l.email,
  l.company,
  l.volume,
  l.role,
  l.notes,
  l.locale,
  l.page_url,
  l.referrer,
  l.origin,
  COALESCE(NULLIF(l.page_url, ''), NULLIF(l.origin, ''), NULLIF(l.referrer, ''), 'landing') AS source,
  COALESCE(NULLIF(l.ip_hash, ''), 'redacted') AS ip_hash,
  COALESCE(
    NULLIF(l.marketing #>> '{intake,turnstile_status}', ''),
    CASE WHEN l.turnstile_verified THEN 'verified' ELSE 'failed' END
  ) AS turnstile_status,
  l.resolved_dedupe_status AS dedupe_status,
  l.resolved_rate_limit_status AS rate_limit_status,
  COALESCE(
    NULLIF(l.marketing #>> '{intake,decision}', ''),
    CASE
      WHEN NOT l.turnstile_verified THEN 'turnstile_failed'
      WHEN l.resolved_rate_limit_status = 'limited' THEN 'rate_limited'
      WHEN l.resolved_dedupe_status = 'duplicate' THEN 'dedupe_dropped'
      ELSE 'accepted'
    END
  ) AS decision,
  latest_task.task_id,
  COALESCE(latest_task.task_workflow_run_id, latest_dispatch.dispatch_workflow_run_id) AS workflow_run_id,
  latest_dispatch.dispatch_id,
  latest_task.task_status,
  latest_task.task_queue_key,
  latest_dispatch.dispatch_outcome,
  GREATEST(
    l.created_at,
    COALESCE(latest_task.task_created_at, l.created_at),
    COALESCE(latest_dispatch.dispatch_created_at, l.created_at)
  ) AS updated_at
FROM lead_rows l
LEFT JOIN latest_task
  ON latest_task.resource_id = l.id
LEFT JOIN latest_dispatch
  ON latest_dispatch.resource_id = l.id;

REVOKE ALL ON public.marketing_intake_recent_v1 FROM PUBLIC;
REVOKE ALL ON public.marketing_intake_recent_v1 FROM anon;
GRANT SELECT ON public.marketing_intake_recent_v1 TO authenticated, service_role;

COMMENT ON VIEW public.marketing_intake_recent_v1 IS
  'Console V2 marketing intake projection over Landing marketing/contact lead truth in marketing_demo_requests, with task/workflow/dispatch lineage from the row-driven workflow binding path.';

CREATE OR REPLACE VIEW public.marketing_intake_metrics_24h
WITH (security_invoker = true) AS
SELECT
  'marketing_intake_metrics_24h'::TEXT AS id,
  COUNT(*)::INTEGER AS total,
  COUNT(*) FILTER (WHERE turnstile_status = 'verified')::INTEGER AS verified,
  COUNT(*) FILTER (WHERE turnstile_status = 'failed')::INTEGER AS turnstile_failed,
  COUNT(*) FILTER (WHERE rate_limit_status = 'limited')::INTEGER AS rate_limited,
  COUNT(*) FILTER (
    WHERE dedupe_status = 'duplicate'
       OR decision = 'dedupe_dropped'
  )::INTEGER AS dedupe_dropped
FROM public.marketing_intake_recent_v1
WHERE received_at >= now() - INTERVAL '24 hours';

REVOKE ALL ON public.marketing_intake_metrics_24h FROM PUBLIC;
REVOKE ALL ON public.marketing_intake_metrics_24h FROM anon;
GRANT SELECT ON public.marketing_intake_metrics_24h TO authenticated, service_role;

COMMENT ON VIEW public.marketing_intake_metrics_24h IS
  'Console V2 24-hour marketing intake aggregate derived from Landing marketing/contact lead truth.';

DO $do$
DECLARE
  v_settings_version_id UUID;
  v_current JSONB;
  v_resource JSONB;
  v_resources JSONB := '[
    {"key":"marketing_intake_recent","relation":"public.marketing_intake_recent_v1","id_column":"id","capability_read":"webhooks.read","default_sort":{"column":"received_at","direction":"desc"},"filters":[{"key":"decision","column":"decision","op":"eq"},{"key":"email","column":"email","op":"ilike"},{"key":"company","column":"company","op":"ilike"},{"key":"task_id","column":"task_id","op":"eq"},{"key":"workflow_run_id","column":"workflow_run_id","op":"eq"}]},
    {"key":"marketing_intake_metrics_24h","relation":"public.marketing_intake_metrics_24h","id_column":"id","capability_read":"webhooks.read","default_sort":{"column":"id","direction":"asc"}}
  ]'::jsonb;
  v_filtered JSONB;
BEGIN
  SELECT s.settings_version_id, s.cached_value
    INTO v_settings_version_id, v_current
    FROM public.settings s
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_current := COALESCE(v_current, '{"resources":[]}'::jsonb);

  FOR v_resource IN
    SELECT value FROM jsonb_array_elements(v_resources) AS value
  LOOP
    SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS value
     WHERE value->>'key' <> v_resource->>'key';

    v_current := jsonb_set(v_current, '{resources}', v_filtered || jsonb_build_array(v_resource), TRUE);
  END LOOP;

  UPDATE public.settings_versions
     SET value = v_current,
         updated_at = now()
   WHERE id = v_settings_version_id;

  UPDATE public.settings
     SET cached_value = v_current,
         last_updated = now()
   WHERE settings_version_id = v_settings_version_id;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605291830_console_v2_marketing_intake_recent_demo_requests_v1'));
COMMIT;
