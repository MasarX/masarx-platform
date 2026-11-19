BEGIN;
SET LOCAL lock_timeout = '10s';

-- Console alerts use the existing invoker view and the registry executor.
CREATE POLICY ops_alerts_executor_tenant_select
  ON public.ops_alerts
  FOR SELECT TO ui_rpc_executor
  USING (
    (SELECT public.current_user_scope_type()) = 'tenant'
    AND organization_id = (SELECT public.current_user_org_id())
    AND organization_id = (SELECT public.current_user_scope_id())
    AND (SELECT public.user_has_capability_v1(
      'alerts.read', 'tenant', public.current_user_scope_id()
    ))
  );

CREATE OR REPLACE VIEW public.command_ops_alerts_console_v1
WITH (security_invoker = true) AS
SELECT
  oa.id,
  oa.organization_id,
  oa.alert_type,
  oa.alert_type AS source,
  oa.severity,
  oa.message,
  -- The notification rail uses this timestamp alias from older alert rows.
  jsonb_strip_nulls(jsonb_build_object('resolved_at', COALESCE(
    to_jsonb(oa.resolved_at),
    CASE WHEN oa.details->>'resolved_at' ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}(:[0-9]{2})?)$'
      THEN oa.details->'resolved_at'
    END
  ))) AS details,
  oa.decision_log_id,
  oa.correlation_id,
  oa.acknowledged_at,
  oa.acknowledged_by,
  oa.acknowledged_by_user_id,
  oa.resolved_at,
  oa.resolved_by_user_id,
  oa.resolution_notes,
  oa.created_at AS opened_at,
  oa.created_at,
  oa.updated_at
FROM public.ops_alerts oa;

COMMIT;
