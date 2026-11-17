BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT ok(
  has_table_privilege('authenticated', 'public.workflow_templates', 'select'),
  'authenticated has SELECT on workflow_templates'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.workflow_templates', 'insert')
  AND NOT has_table_privilege('authenticated', 'public.workflow_templates', 'update')
  AND NOT has_table_privilege('authenticated', 'public.workflow_templates', 'delete'),
  'authenticated direct workflow_templates writes are revoked'
);

SELECT ok(
  has_table_privilege('authenticated', 'public.workflow_template_steps', 'select'),
  'authenticated has SELECT on workflow_template_steps'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.workflow_template_steps', 'insert')
  AND NOT has_table_privilege('authenticated', 'public.workflow_template_steps', 'update')
  AND NOT has_table_privilege('authenticated', 'public.workflow_template_steps', 'delete'),
  'authenticated direct workflow_template_steps writes are revoked'
);

SELECT * FROM finish();
ROLLBACK;
