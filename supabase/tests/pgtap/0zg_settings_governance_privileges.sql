-- Test Suite: settings governance internal function privileges
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(15);

SELECT ok(
  has_function_privilege('service_role', 'public.settings_version_resolved_organization_v1(uuid)', 'EXECUTE'),
  'service_role can execute settings_version_resolved_organization_v1 for maintenance'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.settings_version_resolved_organization_v1(uuid)', 'EXECUTE'),
  'anon cannot execute settings_version_resolved_organization_v1'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.settings_version_resolved_organization_v1(uuid)', 'EXECUTE'),
  'authenticated cannot execute settings_version_resolved_organization_v1'
);

SELECT ok(
  has_function_privilege('service_role', 'public.settings_approval_review_task_defaults_v1()', 'EXECUTE'),
  'service_role can execute settings_approval_review_task_defaults_v1 for maintenance'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.settings_approval_review_task_defaults_v1()', 'EXECUTE'),
  'anon cannot execute settings_approval_review_task_defaults_v1'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.settings_approval_review_task_defaults_v1()', 'EXECUTE'),
  'authenticated cannot execute settings_approval_review_task_defaults_v1'
);

SELECT ok(
  has_function_privilege('service_role', 'public.settings_approval_review_queue_task_sync_v1(uuid)', 'EXECUTE'),
  'service_role can execute settings_approval_review_queue_task_sync_v1 for maintenance'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.settings_approval_review_queue_task_sync_v1(uuid)', 'EXECUTE'),
  'anon cannot execute settings_approval_review_queue_task_sync_v1'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.settings_approval_review_queue_task_sync_v1(uuid)', 'EXECUTE'),
  'authenticated cannot execute settings_approval_review_queue_task_sync_v1'
);

SELECT ok(
  has_function_privilege('service_role', 'public.settings_approval_operator_task_resolve_v1()', 'EXECUTE'),
  'service_role can execute settings_approval_operator_task_resolve_v1 for maintenance'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.settings_approval_operator_task_resolve_v1()', 'EXECUTE'),
  'anon cannot execute settings_approval_operator_task_resolve_v1'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.settings_approval_operator_task_resolve_v1()', 'EXECUTE'),
  'authenticated cannot execute settings_approval_operator_task_resolve_v1'
);

SELECT ok(
  has_function_privilege('service_role', 'public.settings_change_requested_inline_approval_v1()', 'EXECUTE'),
  'service_role can execute settings_change_requested_inline_approval_v1 for maintenance'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.settings_change_requested_inline_approval_v1()', 'EXECUTE'),
  'anon cannot execute settings_change_requested_inline_approval_v1'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.settings_change_requested_inline_approval_v1()', 'EXECUTE'),
  'authenticated cannot execute settings_change_requested_inline_approval_v1'
);

SELECT * FROM finish();
ROLLBACK;
