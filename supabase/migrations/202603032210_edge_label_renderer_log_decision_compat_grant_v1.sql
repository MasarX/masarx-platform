-- Migration: edge label renderer log_decision compatibility grants
-- Purpose:
--   - Keep label-renderer decision logging working across environments that
--     may still expose either legacy or canonical log_decision signatures.
--   - Enforce least privilege by revoking PUBLIC and granting only the
--     edge_label_renderer_role for existing signatures.
-- Date: 2026-03-03

BEGIN;

DO $$
DECLARE
  v_log_decision_canonical REGPROCEDURE;
  v_log_decision_legacy REGPROCEDURE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    RETURN;
  END IF;

  v_log_decision_canonical := to_regprocedure(
    'public.log_decision(uuid, text, text, uuid, text, text, text, uuid, jsonb, text, uuid)'
  );
  IF v_log_decision_canonical IS NOT NULL THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', v_log_decision_canonical);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO edge_label_renderer_role', v_log_decision_canonical);
  END IF;

  v_log_decision_legacy := to_regprocedure(
    'public.log_decision(uuid, text, text, uuid, text, text, text, uuid, jsonb, text)'
  );
  IF v_log_decision_legacy IS NOT NULL THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', v_log_decision_legacy);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO edge_label_renderer_role', v_log_decision_legacy);
  END IF;
END;
$$;

COMMIT;
