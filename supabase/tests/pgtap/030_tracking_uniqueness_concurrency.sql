-- Test Suite: tracking uniqueness and case-insensitive constraint behavior

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

-- 1) Generate a set of tracking numbers and ensure case-insensitive uniqueness within the set
WITH policy AS (
  SELECT cached_value AS body
    FROM settings
   WHERE category = 'tracking_policy' AND scope_type = 'global' AND scope_id IS NULL
   LIMIT 1
), gens AS (
  SELECT generate_tracking_number('tenant', NULL, (SELECT body FROM policy)) AS tn
  FROM generate_series(1, 30)
)
SELECT is(
  (SELECT COUNT(DISTINCT upper(tn)) FROM gens),
  (SELECT COUNT(*) FROM gens),
  'Generated tracking numbers are unique by upper() in a small batch'
);

-- 2) Prepare a client and org to test shipments uniqueness constraint
WITH any_client AS (
  SELECT c.id AS client_id, c.organization_id
  FROM clients c
  ORDER BY c.created_at ASC
  LIMIT 1
)
SELECT ok(EXISTS(SELECT 1 FROM any_client), 'At least one client exists for uniqueness test');

-- 3) Insert duplicate tracking with different case and expect unique violation on the second insert
DO $$
DECLARE
  v_client UUID;
  v_org UUID;
BEGIN
  SELECT c.id, c.organization_id INTO v_client, v_org
  FROM clients c
  ORDER BY c.created_at ASC
  LIMIT 1;

  IF v_client IS NULL OR v_org IS NULL THEN
    PERFORM ok(FALSE, 'No client/org available to test uniqueness');
    RETURN;
  END IF;

  INSERT INTO shipments (id, organization_id, client_id, service_type, tracking_number, status, box_count)
  VALUES (gen_random_uuid(), v_org, v_client, 'delivery', 'TeStXx123', 'pending', 1);

  BEGIN
    INSERT INTO shipments (id, organization_id, client_id, service_type, tracking_number, status, box_count)
    VALUES (gen_random_uuid(), v_org, v_client, 'delivery', lower('TeStXx123'), 'pending', 1);
    PERFORM ok(FALSE, 'Expected unique violation for duplicate tracking (case-insensitive)');
  EXCEPTION WHEN unique_violation THEN
    PERFORM ok(TRUE, 'Duplicate tracking triggers unique violation (case-insensitive)');
  END;
END$$;

SELECT is(
  (
    SELECT COUNT(*)
    FROM shipments
    WHERE tracking_number ILIKE 'testxx123'
  ),
  1::bigint,
  'Duplicate tracking insert leaves a single row persisted'
);

SELECT * FROM finish();

ROLLBACK;
