-- Migration: Align Billing void command capability with canonical draft-void RPC.
-- Date: 2026-05-18
--
-- `void_billing_invoice_v1` is a draft billing update and gates on
-- `billing.write`. Keep the command palette aligned with the Billing drawer
-- and backend RPC so operators do not see different permission rules by entry
-- point.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605182205_billing_void_command_capability_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_scope RECORD;
  v_commands JSONB;
  v_updated JSONB;
BEGIN
  FOR v_scope IN
    SELECT s.scope_type,
           s.scope_id,
           s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
  LOOP
    v_commands := COALESCE(v_scope.value->'commands', '[]'::jsonb);

    WITH command_items AS (
      SELECT item, ordinality
        FROM jsonb_array_elements(v_commands) WITH ORDINALITY AS e(item, ordinality)
    ),
    patched AS (
      SELECT COALESCE(
        jsonb_agg(
          CASE
            WHEN item->>'key' = 'invoices.void'
              THEN jsonb_set(item, '{capability}', to_jsonb('billing.write'::text), true)
            ELSE item
          END
          ORDER BY ordinality
        ),
        '[]'::jsonb
      ) AS commands
      FROM command_items
    )
    SELECT jsonb_set(v_scope.value, '{commands}', patched.commands, true)
      INTO v_updated
      FROM patched;

    UPDATE public.settings_versions sv
       SET value = v_updated,
           version = v_scope.version + 1,
           change_reason = 'Align Billing void command capability with billing.write',
           approved_at = now(),
           effective_from = now()
     WHERE sv.id = v_scope.settings_version_id
       AND v_updated IS DISTINCT FROM sv.value;

    UPDATE public.settings s
       SET cached_value = v_updated,
           last_updated = now()
     WHERE s.category = 'ui_command_registry'
       AND s.scope_type = v_scope.scope_type
       AND s.scope_id IS NOT DISTINCT FROM v_scope.scope_id
       AND s.settings_version_id = v_scope.settings_version_id
       AND v_updated IS DISTINCT FROM s.cached_value;
  END LOOP;
END $$;

SELECT pg_advisory_unlock(hashtext('202605182205_billing_void_command_capability_v1'));
COMMIT;
