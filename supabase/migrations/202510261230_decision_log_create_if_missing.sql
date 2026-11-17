-- Migration: Create decision_log if missing (minimal schema for auditing)

BEGIN;

CREATE TABLE IF NOT EXISTS public.decision_log (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    decision_category TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id UUID NOT NULL,
    decision_point TEXT NOT NULL,
    decision_outcome TEXT NOT NULL,
    decision_inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
    decision_reason TEXT,
    performed_by_system TEXT NOT NULL,
    correlation_id UUID,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decision_log_org_time ON public.decision_log(organization_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_decision_log_resource ON public.decision_log(resource_type, resource_id);

COMMENT ON TABLE public.decision_log IS 'Audit trail of system/workflow decisions (minimal non-partitioned schema).';

COMMIT;

