-- Plan: PLAN-202601-schema-audit-improvements / Step: S95
-- pgTAP: Reference integrity contracts for labels/alerts.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.label_jobs'::regclass
      AND contype = 'f'
      AND conname = 'label_jobs_shipment_fk'
  ),
  'label_jobs_shipment_fk exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.label_jobs'::regclass
      AND contype = 'f'
      AND conname = 'label_jobs_template_fk'
  ),
  'label_jobs_template_fk exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.label_jobs'::regclass
      AND contype = 'f'
      AND conname = 'label_jobs_label_fk'
  ),
  'label_jobs_label_fk exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.labels'::regclass
      AND contype = 'f'
      AND conname = 'labels_layout_template_fk'
  ),
  'labels_layout_template_fk exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.alert_rules'::regclass
      AND contype = 'f'
      AND conname = 'alert_rules_message_template_fk'
  ),
  'alert_rules_message_template_fk exists'
);

SELECT * FROM finish();

ROLLBACK;

