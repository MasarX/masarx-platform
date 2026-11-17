-- Migration: Align webhook intake defaults and client B policy wiring
-- Purpose:
--   1) Ensure webhook_intake settings include an entry_template_id so intake
--      requests do not downgrade to error_status when defaults are used.
--   2) Restore the test fixture client (ffb856c6-9c61-45aa-a259-0ee8816567b1)
--      and point the client B sender to it so client-scoped webhook policies
--      are applied during intake.

BEGIN;

SET search_path TO public, pg_temp;

-- 1) Ensure client B exists under its organization and is marked active.
/* objectives:allow TENANT_LITERAL Justification: canonical test org/client/sender fixture ids restored for webhook policy coverage; scoped to deterministic test data, not tenant-specific configuration */
WITH org AS (
  SELECT id AS organization_id
  FROM organizations
  WHERE id = /* objectives:allow TENANT_LITERAL Justification: canonical test org fixture id used only for deterministic webhook policy coverage */ 'e5e9cafd-e2fc-4a55-8294-dd792ec8303a'::UUID
),
upserted AS (
  INSERT INTO clients (
    id,
    organization_id,
    name,
    slug,
    status
  )
  SELECT
    /* objectives:allow TENANT_LITERAL Justification: canonical test client fixture id used only in seeded test data */ 'ffb856c6-9c61-45aa-a259-0ee8816567b1'::UUID,
    org.organization_id,
    'Client B ACK',
    'client-b-ack',
    'active'
  FROM org
  WHERE org.organization_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM clients WHERE id = /* objectives:allow TENANT_LITERAL Justification: canonical test client fixture id used only in seeded test data */ 'ffb856c6-9c61-45aa-a259-0ee8816567b1'::UUID
    )
  RETURNING 1
)
SELECT 1 WHERE EXISTS (SELECT 1 FROM upserted); -- no-op, keeps BEGIN/COMMIT for psql

-- 2) Point the client B sender at the restored client id so client-scoped
--    webhook_ingest_policy rows apply during intake resolution.
UPDATE senders
SET client_id = /* objectives:allow TENANT_LITERAL Justification: canonical test client fixture id used only in seeded test data */ 'ffb856c6-9c61-45aa-a259-0ee8816567b1'::UUID
WHERE id = /* objectives:allow TENANT_LITERAL Justification: canonical test sender fixture id used only in seeded test data */ 'd1a90236-2ed4-4b55-9bc3-16a7500eea93'::UUID
  AND client_id IS DISTINCT FROM /* objectives:allow TENANT_LITERAL Justification: canonical test client fixture id used only in seeded test data */ 'ffb856c6-9c61-45aa-a259-0ee8816567b1'::UUID;

-- 3) Ensure webhook_intake defaults carry an entry_template_id so intake
--    requests succeed with the canonical entry workflow.
DO $$
DECLARE
  v_settings_id UUID;
  v_settings_version_id UUID;
  v_entry_template CONSTANT UUID := '77770000-0000-0000-0000-000000770001'::UUID;
BEGIN
  SELECT s.id, s.settings_version_id
  INTO v_settings_id, v_settings_version_id
  FROM settings s
  WHERE s.category = 'webhook_intake'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1;

  IF v_settings_id IS NOT NULL THEN
    UPDATE settings_versions sv
    SET value = jsonb_set(
      value,
      '{entry_template_id}',
      to_jsonb(v_entry_template),
      true
    )
    WHERE sv.id = v_settings_version_id;

    UPDATE settings
    SET cached_value = jsonb_set(
          cached_value,
          '{entry_template_id}',
          to_jsonb(v_entry_template),
          true
        ),
        last_updated = now()
    WHERE id = v_settings_id;
  END IF;
END $$;

COMMIT;
