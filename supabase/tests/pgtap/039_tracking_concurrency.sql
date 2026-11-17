-- pgTAP: Tracking generator concurrency and scope uniqueness guarantees

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

-- 1) Thousands of generated numbers remain case-insensitively unique.
WITH policy AS (
  SELECT cached_value AS body
  FROM settings
  WHERE category = 'tracking_policy'
    AND scope_type = 'global'
    AND scope_id IS NULL
  LIMIT 1
), generated AS (
  SELECT generate_tracking_number('tenant', NULL, body) AS tn
  FROM policy, generate_series(1, 2000)
)
SELECT is(
  (SELECT COUNT(*) FROM generated),
  (SELECT COUNT(DISTINCT upper(tn)) FROM generated),
  'First 2k generated tracking numbers are unique by upper() scope'
);

-- 2) Same tracking number can be reused across different clients (scope-aware uniqueness).
DO $$
DECLARE
  v_client1 UUID;
  v_client2 UUID;
  v_org1 UUID;
  v_org2 UUID;
  v_tracking TEXT := 'SCOPE' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
BEGIN
  SELECT id, organization_id
    INTO v_client1, v_org1
  FROM clients
  ORDER BY created_at
  LIMIT 1;

  SELECT id, organization_id
    INTO v_client2, v_org2
  FROM clients
  WHERE id <> v_client1
  ORDER BY created_at
  LIMIT 1;

  IF v_client1 IS NULL OR v_client2 IS NULL THEN
    PERFORM ok(FALSE, 'Expected at least two clients for scope uniqueness test');
    RETURN;
  END IF;

  BEGIN
    INSERT INTO shipments (id, organization_id, client_id, service_type, tracking_number, status, box_count)
    VALUES (gen_random_uuid(), v_org1, v_client1, 'delivery', v_tracking, 'pending', 1);

    INSERT INTO shipments (id, organization_id, client_id, service_type, tracking_number, status, box_count)
    VALUES (gen_random_uuid(), v_org2, v_client2, 'delivery', lower(v_tracking), 'pending', 1);

    PERFORM ok(TRUE, 'Identical tracking across different clients succeeds');
  EXCEPTION WHEN unique_violation THEN
    PERFORM ok(FALSE, 'Unique violation raised unexpectedly for cross-client tracking reuse');
  END;
END;
$$;

-- 3) tracking_upper column stores uppercase variant automatically.
WITH any_client AS (
  SELECT id AS client_id, organization_id
  FROM clients
  ORDER BY created_at
  LIMIT 1
), values AS (
  SELECT 'lower' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10) AS tracking
), inserted AS (
  INSERT INTO shipments (
    id, organization_id, client_id, service_type,
    tracking_number, status, box_count
  )
  SELECT
    gen_random_uuid(),
    any_client.organization_id,
    any_client.client_id,
    'delivery',
    values.tracking,
    'pending',
    1
  FROM any_client, values
  RETURNING tracking_number, tracking_upper
)
SELECT is(
  tracking_upper,
  upper(tracking_number),
  'tracking_upper stores uppercase variant of tracking_number'
)
FROM inserted;

SELECT * FROM finish();

ROLLBACK;
