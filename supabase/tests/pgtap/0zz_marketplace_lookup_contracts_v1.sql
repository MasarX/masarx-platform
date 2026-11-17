-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S95
-- Test: Marketplace lookup contracts replace literal enum CHECK constraints

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

SELECT is(
  (
    SELECT COUNT(*)::INT
      FROM public.lookup_column_contracts
     WHERE table_schema = 'public'
       AND table_name IN (
         'marketplace_participant_profiles',
         'marketplace_participant_memberships',
         'marketplace_participant_requests',
         'marketplace_participant_capabilities',
         'marketplace_verification_records',
         'marketplace_availability_windows',
         'marketplace_requests',
         'marketplace_request_items',
         'marketplace_offers',
         'marketplace_awards',
         'marketplace_contracts',
         'marketplace_work_packages',
         'marketplace_disputes'
       )
  ),
  18,
  'Marketplace lifecycle/listing columns are bound through lookup_column_contracts'
);

WITH missing AS (
  SELECT DISTINCT lc.lookup_category
    FROM public.lookup_column_contracts lc
    LEFT JOIN public.lookup_definitions ld
      ON ld.category = lc.lookup_category
   WHERE lc.table_schema = 'public'
     AND lc.table_name LIKE 'marketplace_%'
     AND lc.column_name IN (
       'status',
       'listing_status',
       'compliance_state',
       'review_decision',
       'availability_status',
       'release_state',
       'materialization_state'
     )
     AND ld.id IS NULL
)
SELECT diag('Missing marketplace lookup definition: ' || lookup_category)
  FROM missing;

WITH missing AS (
  SELECT DISTINCT lc.lookup_category
    FROM public.lookup_column_contracts lc
    LEFT JOIN public.lookup_definitions ld
      ON ld.category = lc.lookup_category
   WHERE lc.table_schema = 'public'
     AND lc.table_name LIKE 'marketplace_%'
     AND lc.column_name IN (
       'status',
       'listing_status',
       'compliance_state',
       'review_decision',
       'availability_status',
       'release_state',
       'materialization_state'
     )
     AND ld.id IS NULL
)
SELECT is(
  (SELECT COUNT(*)::INT FROM missing),
  0,
  'Marketplace lookup contracts resolve to registered lookup_definitions categories'
);

SELECT throws_ok(
  $$
    WITH org AS (
      INSERT INTO public.organizations (id, name, slug)
      VALUES (
        gen_random_uuid(),
        'pgTAP marketplace requests org',
        'pgtap-marketplace-request-' || left(gen_random_uuid()::text, 8)
      )
      RETURNING id
    )
    INSERT INTO public.marketplace_requests (
      id,
      requester_organization_id,
      request_kind_key,
      status,
      title
    )
    SELECT
      gen_random_uuid(),
      org.id,
      'driver_shift_market',
      'bogus_marketplace_request_status',
      'pgTAP invalid request status'
    FROM org;
  $$,
  '23514',
  'Invalid lookup value for public.marketplace_requests.status: "bogus_marketplace_request_status" is not an allowed value for category "marketplace_request_status"',
  'marketplace_requests.status rejects invalid lookup values via lookup contracts'
);

SELECT throws_ok(
  $$
    WITH org AS (
      INSERT INTO public.organizations (id, name, slug)
      VALUES (
        gen_random_uuid(),
        'pgTAP marketplace participant org',
        'pgtap-marketplace-profile-' || left(gen_random_uuid()::text, 8)
      )
      RETURNING id
    )
    INSERT INTO public.marketplace_participant_profiles (
      id,
      organization_id,
      participant_type_key,
      listing_status,
      display_name
    )
    SELECT
      gen_random_uuid(),
      org.id,
      'provider_tenant',
      'bogus_listing_status',
      'pgTAP invalid listing status'
    FROM org;
  $$,
  '23514',
  'Invalid lookup value for public.marketplace_participant_profiles.listing_status: "bogus_listing_status" is not an allowed value for category "marketplace_participant_listing_status"',
  'marketplace_participant_profiles.listing_status rejects invalid lookup values via lookup contracts'
);

WITH marketplace_literal_checks AS (
  SELECT
    c.relname AS table_name,
    con.conname AS constraint_name,
    pg_get_constraintdef(con.oid) AS definition
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE con.contype = 'c'
    AND n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relispartition = false
    AND c.relname LIKE 'marketplace_%'
    AND (
      pg_get_constraintdef(con.oid) ILIKE '% IN (%'
      OR pg_get_constraintdef(con.oid) ILIKE '% IN(%'
      OR pg_get_constraintdef(con.oid) ILIKE '%ANY (ARRAY[%'
    )
)
SELECT diag(format('Marketplace literal-list CHECK still present: %s %s :: %s', table_name, constraint_name, definition))
  FROM marketplace_literal_checks;

WITH marketplace_literal_checks AS (
  SELECT 1
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE con.contype = 'c'
    AND n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relispartition = false
    AND c.relname LIKE 'marketplace_%'
    AND (
      pg_get_constraintdef(con.oid) ILIKE '% IN (%'
      OR pg_get_constraintdef(con.oid) ILIKE '% IN(%'
      OR pg_get_constraintdef(con.oid) ILIKE '%ANY (ARRAY[%'
    )
)
SELECT is(
  (SELECT COUNT(*)::INT FROM marketplace_literal_checks),
  0,
  'Marketplace tables have no literal-list CHECK constraints after lookup contract migration'
);

SELECT * FROM finish();

ROLLBACK;
