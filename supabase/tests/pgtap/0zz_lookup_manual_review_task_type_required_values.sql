-- Plan: PLAN-202602-ci-cd-deploy-hardening / Step: S04
-- Guardrail: manual_review_task_type lookup values required by runtime workflows.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions d
    JOIN public.lookup_values v
      ON v.lookup_definition_id = d.id
    WHERE d.category = 'manual_review_task_type'
      AND v.value = 'geocoding'
      AND v.status = 'active'
      AND v.retired_at IS NULL
  ),
  'manual_review_task_type includes geocoding'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions d
    JOIN public.lookup_values v
      ON v.lookup_definition_id = d.id
    WHERE d.category = 'manual_review_task_type'
      AND v.value = 'geocoding_auto_learn'
      AND v.status = 'active'
      AND v.retired_at IS NULL
  ),
  'manual_review_task_type includes geocoding_auto_learn'
);

SELECT * FROM finish();

ROLLBACK;
