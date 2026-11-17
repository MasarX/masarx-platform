-- Test Suite: Settings approval workflow wiring (manual review + apply)
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);
SET search_path TO public, pgtap, extensions;

SELECT ok((SELECT EXISTS(SELECT 1 FROM operation_handlers WHERE handler_key = 'manual_review_wait' AND is_active = TRUE)),
          'manual_review_wait handler registered');
SELECT ok((SELECT EXISTS(SELECT 1 FROM operation_handlers WHERE handler_key = 'settings_apply' AND is_active = TRUE)),
          'settings_apply handler registered');

SELECT ok((SELECT EXISTS(SELECT 1 FROM workflow_templates WHERE id = '99990000-0000-0000-0000-000000560020')),
          'settings_change_approval_v1 workflow template seeded');

SELECT ok((SELECT EXISTS(
  SELECT 1 FROM workflow_template_steps
   WHERE id = '99990000-0000-0000-0000-000000560021'
     AND workflow_template_id = '99990000-0000-0000-0000-000000560020'
     AND handler_key = 'manual_review'
)), 'settings_change_approval_v1 has manual_review enqueue step');

SELECT ok((SELECT EXISTS(
  SELECT 1 FROM workflow_template_steps
   WHERE id = '99990000-0000-0000-0000-000000560022'
     AND workflow_template_id = '99990000-0000-0000-0000-000000560020'
     AND handler_key = 'manual_review_wait'
)), 'settings_change_approval_v1 has manual_review_wait step');

SELECT ok((SELECT EXISTS(
  SELECT 1 FROM workflow_template_steps
   WHERE id = '99990000-0000-0000-0000-000000560023'
     AND workflow_template_id = '99990000-0000-0000-0000-000000560020'
     AND handler_key = 'settings_apply'
)), 'settings_change_approval_v1 has settings_apply step');

SELECT * FROM finish();

ROLLBACK;

