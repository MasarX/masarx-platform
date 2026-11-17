-- Plan: PLAN-202602-integration-plugin-studio-v1 / Step: S99
-- Migration: integration plugin FK index hygiene v1
-- Purpose:
--   - Add missing supporting indexes for integration plugin foreign keys.
--   - Satisfy enterprise FK hygiene contract (0zz_fk_index_hygiene.sql).

BEGIN;
SELECT pg_advisory_lock(hashtext('202602220130_integration_plugin_fk_indexes_hygiene_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_integration_plugins_active_version_id
  ON public.integration_plugins(active_version_id);
CREATE INDEX IF NOT EXISTS idx_integration_plugins_base_plugin_id
  ON public.integration_plugins(base_plugin_id);
CREATE INDEX IF NOT EXISTS idx_integration_plugins_created_by
  ON public.integration_plugins(created_by);
CREATE INDEX IF NOT EXISTS idx_integration_plugins_updated_by
  ON public.integration_plugins(updated_by);

CREATE INDEX IF NOT EXISTS idx_integration_plugin_versions_created_by
  ON public.integration_plugin_versions(created_by);
CREATE INDEX IF NOT EXISTS idx_integration_plugin_versions_updated_by
  ON public.integration_plugin_versions(updated_by);
CREATE INDEX IF NOT EXISTS idx_integration_plugin_versions_submitted_by
  ON public.integration_plugin_versions(submitted_by);
CREATE INDEX IF NOT EXISTS idx_integration_plugin_versions_approved_by
  ON public.integration_plugin_versions(approved_by);
CREATE INDEX IF NOT EXISTS idx_integration_plugin_versions_activated_by
  ON public.integration_plugin_versions(activated_by);

CREATE INDEX IF NOT EXISTS idx_integration_plugin_bindings_created_by
  ON public.integration_plugin_bindings(created_by);

CREATE INDEX IF NOT EXISTS idx_integration_plugin_validation_runs_executed_by
  ON public.integration_plugin_validation_runs(executed_by);

CREATE INDEX IF NOT EXISTS idx_integration_plugin_approval_events_actor_user_id
  ON public.integration_plugin_approval_events(actor_user_id);

SELECT pg_advisory_unlock(hashtext('202602220130_integration_plugin_fk_indexes_hygiene_v1'));
COMMIT;
