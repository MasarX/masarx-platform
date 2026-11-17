BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20261020151500_driver_route_load_manifest_hygiene_v1'));
LOCK TABLE public.route_load_manifest_actions IN SHARE ROW EXCLUSIVE MODE;

-- Actions are immutable events: retain their creation time, not a mutable updated_at.
INSERT INTO public.table_contracts
  (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES ('public', 'route_load_manifest_actions', TRUE, FALSE, TRUE,
  'Append-only driver loading actions; creation time and canonical audit remain authoritative.')
ON CONFLICT (table_schema, table_name) DO UPDATE SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes;

-- The row audit already exists; complete only this table's canonical audit pair.
CREATE TRIGGER audit_truncate_change
  AFTER TRUNCATE ON public.route_load_manifest_actions
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_capture_row_change();

-- route_run_id already leads the unique idempotency and parcel indexes.
CREATE INDEX route_load_manifest_actions_organization_fk_idx
  ON public.route_load_manifest_actions (organization_id);
CREATE INDEX route_load_manifest_actions_stop_fk_idx
  ON public.route_load_manifest_actions (route_stop_id);
CREATE INDEX route_load_manifest_actions_box_fk_idx
  ON public.route_load_manifest_actions (shipment_box_id);
CREATE INDEX route_load_manifest_actions_actor_fk_idx
  ON public.route_load_manifest_actions (actor_user_id);

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('route_load_manifest_action', 'Driver route loading action', 'operations', 'tier_1', FALSE)
ON CONFLICT (category) DO NOTHING;
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, v.value, v.label, v.sort_order, FALSE, 'active'
FROM public.lookup_definitions d
CROSS JOIN (VALUES
  ('mark_missing', 'Mark missing', 10),
  ('undo_missing', 'Undo missing', 20),
  ('report_discrepancy', 'Report discrepancy', 30)
) v(value, label, sort_order)
WHERE d.category = 'route_load_manifest_action'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_column_contracts
  (table_schema, table_name, column_name, lookup_category, allow_inactive, allowed_values)
VALUES ('public', 'route_load_manifest_actions', 'action', 'route_load_manifest_action', FALSE,
  ARRAY['mark_missing', 'undo_missing', 'report_discrepancy']::TEXT[])
ON CONFLICT (table_schema, table_name, column_name) DO UPDATE SET
  lookup_category = EXCLUDED.lookup_category,
  allow_inactive = EXCLUDED.allow_inactive,
  allowed_values = EXCLUDED.allowed_values;

-- Target-only application of the existing canonical lookup-trigger contract.
DO $lookup$
DECLARE
  v_trigger TEXT := 'trg_lookup_contract_' || substr(md5('public.route_load_manifest_actions'), 1, 12);
BEGIN
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF action ON public.route_load_manifest_actions
    FOR EACH ROW EXECUTE FUNCTION public.enforce_lookup_column_contracts()', v_trigger);
END;
$lookup$;

ALTER TABLE public.route_load_manifest_actions
  DROP CONSTRAINT route_load_manifest_actions_action_check;
COMMIT;
