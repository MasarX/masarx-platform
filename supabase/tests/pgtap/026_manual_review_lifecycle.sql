-- Test Suite: Manual Review Lifecycle Wiring

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SET search_path TO public, pgtap, extensions;

SELECT ok((SELECT EXISTS(SELECT 1 FROM operation_handlers WHERE handler_key = 'manual_review_assign')),
          'manual_review_assign handler registered');

SELECT ok((SELECT EXISTS(SELECT 1 FROM operation_handlers WHERE handler_key = 'manual_review_resolve')),
          'manual_review_resolve handler registered');

SELECT ok((SELECT EXISTS(
  SELECT 1 FROM workflow_template_steps
   WHERE workflow_template_id = '99990000-0000-0000-0000-000000560001'
     AND handler_key = 'manual_review_assign'
)), 'manual_review_v1 has assign step');

SELECT ok((SELECT EXISTS(
  SELECT 1 FROM workflow_template_steps
   WHERE workflow_template_id = '99990000-0000-0000-0000-000000560001'
     AND handler_key = 'manual_review_resolve'
)), 'manual_review_v1 has resolve step');

SELECT * FROM finish();

ROLLBACK;

