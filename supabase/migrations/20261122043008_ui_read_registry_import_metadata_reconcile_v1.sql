-- Plan: PLAN-202604-production-readiness-coverage-closure / Step: registry import metadata reconcile
-- Purpose:
--   - Reconcile stored ui_read_registry settings rows through the canonical normalizer.
--   - Keep persisted registry metadata aligned with the read-time import contract.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('20261122029012_ui_read_registry_import_metadata_reconcile_v1'));
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_row RECORD;
  v_next JSONB;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      s.scope_type,
      s.scope_id,
      sv.schema_version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
    WHERE s.category = 'ui_read_registry'
    ORDER BY s.id
    FOR UPDATE OF s, sv
  LOOP
    v_next := public.ui_read_registry_apply_required_import_contracts_v1(
      public.normalize_settings_value_v1('ui_read_registry', v_row.value)
    );

    IF v_next IS DISTINCT FROM v_row.value THEN
      PERFORM public.upsert_settings_value_v1(
        'ui_read_registry', v_row.scope_type, v_row.scope_id,
        v_next, v_row.schema_version, 'Reconcile persisted ui_read_registry import metadata through canonical normalization.'
      );
    END IF;
  END LOOP;
END;
$do$;


COMMIT;
