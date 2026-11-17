-- Plan: PLAN-202603-go-live-readiness-remediation-a422 / Step: S04
-- Purpose:
--   - Remove legacy renderer_defaults settings_versions rows that were
--     incorrectly persisted as tenant scope with the global sentinel scope_id.
--   - Keep settings scope contract fail-closed (tenant scope must never use sentinel).

BEGIN;

DELETE FROM public.settings s
WHERE s.category = 'renderer_defaults'
  AND s.scope_type = 'tenant'
  AND s.scope_id = '00000000-0000-0000-0000-000000000000'::uuid;

DELETE FROM public.settings_versions sv
WHERE sv.category = 'renderer_defaults'
  AND sv.scope_type = 'tenant'
  AND sv.scope_id = '00000000-0000-0000-0000-000000000000'::uuid;

COMMIT;
