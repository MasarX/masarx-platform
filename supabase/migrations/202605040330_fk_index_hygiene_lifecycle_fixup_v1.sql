-- Fixup: supporting indexes for foreign keys introduced or exposed by the
-- Console V2 lifecycle/backend coverage work.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031460_fk_index_hygiene_lifecycle_fixup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_alert_rule_revisions_changed_by
  ON public.alert_rule_revisions (changed_by);

CREATE INDEX IF NOT EXISTS idx_bank_recon_matches_matched_by
  ON public.bank_recon_matches (matched_by);
CREATE INDEX IF NOT EXISTS idx_bank_recon_matches_unmatched_by
  ON public.bank_recon_matches (unmatched_by);

CREATE INDEX IF NOT EXISTS idx_capability_grant_requests_decided_by
  ON public.capability_grant_requests (decided_by);
CREATE INDEX IF NOT EXISTS idx_capability_grant_requests_requested_by
  ON public.capability_grant_requests (requested_by);

CREATE INDEX IF NOT EXISTS idx_driver_hours_of_service_driver_id
  ON public.driver_hours_of_service (driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_hours_of_service_recorded_by_user_id
  ON public.driver_hours_of_service (recorded_by_user_id);

CREATE INDEX IF NOT EXISTS idx_feature_flag_kill_events_acted_by
  ON public.feature_flag_kill_events (acted_by);

CREATE INDEX IF NOT EXISTS idx_import_jobs_submitted_by_user_id
  ON public.import_jobs (submitted_by_user_id);

CREATE INDEX IF NOT EXISTS idx_lookup_definitions_organization_id
  ON public.lookup_definitions (organization_id);

CREATE INDEX IF NOT EXISTS idx_lookup_value_revisions_changed_by
  ON public.lookup_value_revisions (changed_by);

CREATE INDEX IF NOT EXISTS idx_lookup_values_archived_by
  ON public.lookup_values (archived_by);
CREATE INDEX IF NOT EXISTS idx_lookup_values_organization_id
  ON public.lookup_values (organization_id);
CREATE INDEX IF NOT EXISTS idx_lookup_values_published_by
  ON public.lookup_values (published_by);

CREATE INDEX IF NOT EXISTS idx_mapping_config_revisions_changed_by
  ON public.mapping_config_revisions (changed_by);

CREATE INDEX IF NOT EXISTS idx_ops_alert_events_acted_by
  ON public.ops_alert_events (acted_by);

CREATE INDEX IF NOT EXISTS idx_password_reset_intents_organization_id
  ON public.password_reset_intents (organization_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_intents_requested_by
  ON public.password_reset_intents (requested_by);

CREATE INDEX IF NOT EXISTS idx_revocation_audit_organization_id
  ON public.revocation_audit (organization_id);
CREATE INDEX IF NOT EXISTS idx_revocation_audit_revoked_by
  ON public.revocation_audit (revoked_by);

CREATE INDEX IF NOT EXISTS idx_task_bulk_transition_runs_triggered_by
  ON public.task_bulk_transition_runs (triggered_by);

CREATE INDEX IF NOT EXISTS idx_vehicle_maintenance_windows_scheduled_by_user_id
  ON public.vehicle_maintenance_windows (scheduled_by_user_id);

CREATE INDEX IF NOT EXISTS idx_webhook_inbox_replays_changed_by
  ON public.webhook_inbox_replays (changed_by);

CREATE INDEX IF NOT EXISTS idx_workflow_binding_registrations_changed_by
  ON public.workflow_binding_registrations (changed_by);
CREATE INDEX IF NOT EXISTS idx_workflow_binding_registrations_organization_id
  ON public.workflow_binding_registrations (organization_id);

CREATE INDEX IF NOT EXISTS idx_workflow_binding_simulations_organization_id
  ON public.workflow_binding_simulations (organization_id);
CREATE INDEX IF NOT EXISTS idx_workflow_binding_simulations_triggered_by
  ON public.workflow_binding_simulations (triggered_by);

SELECT pg_advisory_unlock(hashtext('202605031460_fk_index_hygiene_lifecycle_fixup_v1'));
COMMIT;
