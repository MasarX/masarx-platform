-- Test Suite: RLS and access guards for label_sections, label_design_tokens, label_template_validation

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='label_sections'),
  'RLS enabled on label_sections'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='label_design_tokens'),
  'RLS enabled on label_design_tokens'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='label_template_validation'),
  'RLS enabled on label_template_validation'
);

SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT 1 FROM public.label_sections LIMIT 1 $$, '42501', 'permission denied for table label_sections');
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT 1 FROM public.label_design_tokens LIMIT 1 $$, '42501', 'permission denied for table label_design_tokens');
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT 1 FROM public.label_template_validation LIMIT 1 $$, '42501', 'permission denied for table label_template_validation');
RESET ROLE;

SELECT finish();

ROLLBACK;
