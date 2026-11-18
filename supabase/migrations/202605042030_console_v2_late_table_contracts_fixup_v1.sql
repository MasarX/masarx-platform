-- Keep late Console V2 support/catalog/planning tables in the table contract
-- SSOT so timestamp and audit enforcement remains row-driven.

BEGIN;

INSERT INTO public.table_contracts (
  table_schema,
  table_name,
  created_at_required,
  updated_at_required,
  audit_enabled,
  notes
)
VALUES
  (
    'public',
    'planning_os_execution_cards',
    TRUE,
    TRUE,
    TRUE,
    'Console V2 Planning OS execution-card mirror; local write path is service-only and audited.'
  ),
  (
    'public',
    'planning_os_project_items',
    TRUE,
    TRUE,
    TRUE,
    'Console V2 Planning OS project-item mirror; local write path is service-only and audited.'
  ),
  (
    'public',
    'support_user_roster_policy',
    TRUE,
    TRUE,
    TRUE,
    'Row-driven support assignee roster policy used by Console V2 support views.'
  ),
  (
    'public',
    'wave_catalog',
    TRUE,
    TRUE,
    TRUE,
    'Row-driven dispatch wave catalog used by Console V2 route planning and pickup scheduling.'
  )
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

SELECT * FROM public.ensure_audit_triggers();

COMMIT;
