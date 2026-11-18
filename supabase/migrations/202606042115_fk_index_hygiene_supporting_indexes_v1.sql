-- Purpose: keep foreign-key maintenance paths indexed for late local verifier
-- hygiene. These are non-behavioral supporting indexes only; FK ownership and
-- RLS remain unchanged.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606042115_fk_index_hygiene_supporting_indexes_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_fieldops_user_roles_user_id_fk
  ON public.fieldops_user_roles (user_id);

CREATE INDEX IF NOT EXISTS idx_fieldops_v2_cleaning_checks_user_id_fk
  ON public.fieldops_v2_cleaning_checks (user_id);

CREATE INDEX IF NOT EXISTS idx_fieldops_v2_incidents_reported_by_user_id_fk
  ON public.fieldops_v2_incidents (reported_by_user_id);

CREATE INDEX IF NOT EXISTS idx_fieldops_v2_inductions_client_id_fk
  ON public.fieldops_v2_inductions (client_id);

CREATE INDEX IF NOT EXISTS idx_fieldops_v2_inductions_inducted_by_user_id_fk
  ON public.fieldops_v2_inductions (inducted_by_user_id);

CREATE INDEX IF NOT EXISTS idx_fieldops_v2_inductions_shipment_id_client_id_fk
  ON public.fieldops_v2_inductions (shipment_id, client_id);

CREATE INDEX IF NOT EXISTS idx_fieldops_v2_kyc_docs_user_id_fk
  ON public.fieldops_v2_kyc_docs (user_id);

CREATE INDEX IF NOT EXISTS idx_fieldops_v2_pre_shift_passes_user_id_fk
  ON public.fieldops_v2_pre_shift_passes (user_id);

CREATE INDEX IF NOT EXISTS idx_fieldops_v2_vehicle_photos_user_id_fk
  ON public.fieldops_v2_vehicle_photos (user_id);

CREATE INDEX IF NOT EXISTS idx_fieldops_v2_vehicles_user_id_fk
  ON public.fieldops_v2_vehicles (user_id);

CREATE INDEX IF NOT EXISTS idx_intake_auth_rejections_client_id_fk
  ON public.intake_auth_rejections (client_id);

CREATE INDEX IF NOT EXISTS idx_intake_auth_rejections_organization_id_fk
  ON public.intake_auth_rejections (organization_id);

CREATE INDEX IF NOT EXISTS idx_intake_auth_rejections_provider_auth_config_id_fk
  ON public.intake_auth_rejections (provider_auth_config_id);

CREATE INDEX IF NOT EXISTS idx_intake_auth_rejections_sender_id_fk
  ON public.intake_auth_rejections (sender_id);

CREATE INDEX IF NOT EXISTS idx_intake_auth_rejections_source_id_fk
  ON public.intake_auth_rejections (source_id);

CREATE INDEX IF NOT EXISTS idx_label_design_drafts_archived_by_fk
  ON public.label_design_drafts (archived_by);

CREATE INDEX IF NOT EXISTS idx_shipment_holds_reported_by_user_id_fk
  ON public.shipment_holds (reported_by_user_id);

CREATE INDEX IF NOT EXISTS idx_webhook_rules_mapping_config_id_fk
  ON public.webhook_rules (mapping_config_id);

CREATE INDEX IF NOT EXISTS idx_webhook_rules_workflow_template_id_fk
  ON public.webhook_rules (workflow_template_id);

CREATE INDEX IF NOT EXISTS idx_webhook_source_token_history_client_id_fk
  ON public.webhook_source_token_history (client_id);

CREATE INDEX IF NOT EXISTS idx_webhook_source_token_history_retired_by_user_id_fk
  ON public.webhook_source_token_history (retired_by_user_id);

CREATE INDEX IF NOT EXISTS idx_webhook_source_token_history_sender_id_fk
  ON public.webhook_source_token_history (sender_id);

CREATE INDEX IF NOT EXISTS idx_workflow_binding_stage_registry_template_id_fk
  ON public.workflow_binding_stage_registry (workflow_template_id);

CREATE INDEX IF NOT EXISTS idx_workflow_run_triggers_deleted_by_fk
  ON public.workflow_run_triggers (deleted_by);

SELECT pg_advisory_unlock(hashtext('202606042115_fk_index_hygiene_supporting_indexes_v1'));
COMMIT;
