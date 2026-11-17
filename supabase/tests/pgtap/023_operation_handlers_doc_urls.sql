-- Test Suite: Operation handler documentation coverage

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(1);

SELECT ok(
  (
    SELECT COUNT(*)
    FROM operation_handlers
    WHERE is_active
      AND (doc_url IS NULL OR length(trim(doc_url)) = 0)
  ) = 0,
  'All active operation handlers define doc_url references'
);

SELECT * FROM finish();

ROLLBACK;

