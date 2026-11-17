-- Migration: Ops alerts and provider health logs (partitioned, RLS, retention)

BEGIN;

-- Ops alerts table (HASH on organization_id, RANGE monthly on created_at)
CREATE TABLE IF NOT EXISTS public.ops_alerts (
  id UUID DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  message TEXT,
  details JSONB,
  decision_log_id UUID,
  correlation_id UUID,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, created_at, id)
) PARTITION BY HASH (organization_id);

CREATE TABLE IF NOT EXISTS public.ops_alerts_p0
  PARTITION OF public.ops_alerts
  FOR VALUES WITH (MODULUS 1, REMAINDER 0)
  PARTITION BY RANGE (created_at);

-- Provider health logs table
CREATE TABLE IF NOT EXISTS public.provider_health_logs (
  id UUID DEFAULT gen_random_uuid(),
  organization_id UUID,
  provider_id UUID NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  metadata JSONB,
  decision_log_id UUID,
  correlation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, created_at, id)
) PARTITION BY HASH (provider_id);

CREATE TABLE IF NOT EXISTS public.provider_health_logs_p0
  PARTITION OF public.provider_health_logs
  FOR VALUES WITH (MODULUS 1, REMAINDER 0)
  PARTITION BY RANGE (created_at);

-- Partitioning config entries
INSERT INTO partitioning_config (
  table_name, partition_strategy, partition_key, partition_interval, partitions_ahead, retention_months, config
) VALUES
  ('ops_alerts', 'HASH+RANGE', 'organization_id|created_at', 'monthly', 6, 6, '{"hash_modulus":1,"range_interval":"monthly","retention_policy":"archive"}'),
  ('provider_health_logs', 'HASH+RANGE', 'provider_id|created_at', 'monthly', 6, 6, '{"hash_modulus":1,"range_interval":"monthly","retention_policy":"archive"}')
ON CONFLICT (table_name) DO UPDATE
  SET partition_strategy = EXCLUDED.partition_strategy,
      partition_key = EXCLUDED.partition_key,
      partition_interval = EXCLUDED.partition_interval,
      partitions_ahead = EXCLUDED.partitions_ahead,
      retention_months = EXCLUDED.retention_months,
      config = EXCLUDED.config;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ops_alerts_org_created ON public.ops_alerts_p0 (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_alerts_corr ON public.ops_alerts_p0 (correlation_id);
CREATE INDEX IF NOT EXISTS idx_ops_alerts_decision ON public.ops_alerts_p0 (decision_log_id);

CREATE INDEX IF NOT EXISTS idx_provider_health_org_created ON public.provider_health_logs_p0 (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_health_corr ON public.provider_health_logs_p0 (correlation_id);
CREATE INDEX IF NOT EXISTS idx_provider_health_decision ON public.provider_health_logs_p0 (decision_log_id);
CREATE INDEX IF NOT EXISTS idx_provider_health_provider ON public.provider_health_logs_p0 (provider_id, created_at DESC);

-- RLS and service_role policy
ALTER TABLE public.ops_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ops_alerts_p0 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_health_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_health_logs_p0 ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ops_alerts FROM PUBLIC;
REVOKE ALL ON TABLE public.ops_alerts FROM anon;
REVOKE ALL ON TABLE public.ops_alerts FROM authenticated;
REVOKE ALL ON TABLE public.ops_alerts_p0 FROM PUBLIC;
REVOKE ALL ON TABLE public.ops_alerts_p0 FROM anon;
REVOKE ALL ON TABLE public.ops_alerts_p0 FROM authenticated;

REVOKE ALL ON TABLE public.provider_health_logs FROM PUBLIC;
REVOKE ALL ON TABLE public.provider_health_logs FROM anon;
REVOKE ALL ON TABLE public.provider_health_logs FROM authenticated;
REVOKE ALL ON TABLE public.provider_health_logs_p0 FROM PUBLIC;
REVOKE ALL ON TABLE public.provider_health_logs_p0 FROM anon;
REVOKE ALL ON TABLE public.provider_health_logs_p0 FROM authenticated;

GRANT ALL ON TABLE public.ops_alerts TO service_role;
GRANT ALL ON TABLE public.ops_alerts_p0 TO service_role;
GRANT ALL ON TABLE public.provider_health_logs TO service_role;
GRANT ALL ON TABLE public.provider_health_logs_p0 TO service_role;

DROP POLICY IF EXISTS ops_alerts_service_policy ON public.ops_alerts;
CREATE POLICY ops_alerts_service_policy
  ON public.ops_alerts
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS ops_alerts_service_policy ON public.ops_alerts_p0;
CREATE POLICY ops_alerts_service_policy
  ON public.ops_alerts_p0
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS provider_health_logs_service_policy ON public.provider_health_logs;
CREATE POLICY provider_health_logs_service_policy
  ON public.provider_health_logs
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS provider_health_logs_service_policy ON public.provider_health_logs_p0;
CREATE POLICY provider_health_logs_service_policy
  ON public.provider_health_logs_p0
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- Create future partitions
SELECT * FROM public.create_next_partitions();

COMMIT;
