-- Migration: Create request_contexts if missing (trace correlation table)
-- Purpose: Ensure worker/runtime helpers can record request context. Some cloud
--          environments are missing this table due to prior divergent history.

BEGIN;

CREATE TABLE IF NOT EXISTS public.request_contexts (
    id UUID PRIMARY KEY,
    entry_point TEXT NOT NULL,
    client_id UUID,
    user_id UUID,
    primary_entity_type TEXT,
    primary_entity_id UUID,
    batch_size INT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    total_duration_ms INT,
    error_occurred BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Helpful indexes (idempotent)
CREATE INDEX IF NOT EXISTS idx_request_contexts_entry_point ON public.request_contexts(entry_point);
CREATE INDEX IF NOT EXISTS idx_request_contexts_started ON public.request_contexts(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_contexts_error ON public.request_contexts(error_occurred) WHERE error_occurred = true;
CREATE INDEX IF NOT EXISTS idx_request_contexts_entity ON public.request_contexts(primary_entity_type, primary_entity_id) WHERE primary_entity_type IS NOT NULL;

COMMENT ON TABLE public.request_contexts IS 'Request tracing context - threads all operations together (correlation_id).';

COMMIT;

