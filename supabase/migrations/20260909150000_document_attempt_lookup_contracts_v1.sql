-- Replace literal attempt domains with canonical row-driven lookup enforcement.
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_definitions(category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('driver_application_document_attempt_state', 'Private document attempt lifecycle', 'engineering', 'tier_1', false),
  ('driver_application_document_cleanup_state', 'Private document attempt cleanup receipt', 'engineering', 'tier_1', false)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values(lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, v.value, v.label, v.sort_order, v.is_default, 'active'
FROM public.lookup_definitions d
JOIN (VALUES
  ('driver_application_document_attempt_state', 'reserved', 'Reserved', 10, true),
  ('driver_application_document_attempt_state', 'committed', 'Committed', 20, false),
  ('driver_application_document_attempt_state', 'aborted', 'Aborted', 30, false),
  ('driver_application_document_cleanup_state', 'not_required', 'Not required', 10, true),
  ('driver_application_document_cleanup_state', 'pending', 'Pending', 20, false),
  ('driver_application_document_cleanup_state', 'complete', 'Complete', 30, false)
) v(category, value, label, sort_order, is_default) ON d.category = v.category
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_column_contracts
  (table_schema, table_name, column_name, lookup_category, allow_inactive, allowed_values)
VALUES
  ('public', 'driver_application_document_attempts', 'state', 'driver_application_document_attempt_state', false, NULL),
  ('public', 'driver_application_document_attempts', 'cleanup_state', 'driver_application_document_cleanup_state', false, NULL)
ON CONFLICT ON CONSTRAINT lookup_column_contracts_unique DO UPDATE
SET lookup_category = EXCLUDED.lookup_category,
    allow_inactive = EXCLUDED.allow_inactive, allowed_values = EXCLUDED.allowed_values;

SELECT public.apply_lookup_column_contracts('public');

ALTER TABLE public.driver_application_document_attempts
  DROP CONSTRAINT driver_application_document_attempts_state_check,
  DROP CONSTRAINT driver_application_document_attempts_cleanup_state_check;

COMMIT;
