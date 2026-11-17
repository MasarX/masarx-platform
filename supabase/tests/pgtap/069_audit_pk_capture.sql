-- Test: audit_table_changes.pk captures composite primary keys (dynamic PK extraction)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

SELECT has_table('public','audit_table_changes','audit_table_changes table exists');
SELECT has_function('public','audit_capture_row_change', ARRAY[]::text[], 'audit_capture_row_change trigger exists');

CREATE TABLE public.pgtap_audit_pk_capture (
  organization_id UUID NOT NULL,
  a INT NOT NULL,
  b INT NOT NULL,
  note TEXT,
  PRIMARY KEY (a, b)
);

CREATE TRIGGER audit_row_change
  BEFORE INSERT OR UPDATE OR DELETE ON public.pgtap_audit_pk_capture
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_capture_row_change();

CREATE TRIGGER audit_truncate_change
  AFTER TRUNCATE ON public.pgtap_audit_pk_capture
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.audit_capture_row_change();

INSERT INTO public.pgtap_audit_pk_capture (organization_id, a, b, note)
VALUES ('11111111-1111-1111-1111-111111111111', 1, 2, 'hello');

SELECT is(
  (
    SELECT pk
    FROM public.audit_table_changes
    WHERE table_name = 'pgtap_audit_pk_capture'
      AND organization_id = '11111111-1111-1111-1111-111111111111'
      AND op = 'INSERT'
      AND pk = '{"a":1,"b":2}'::jsonb
    LIMIT 1
  ),
  '{"a":1,"b":2}'::jsonb,
  'INSERT audit row captures composite PK (a,b)'
);

UPDATE public.pgtap_audit_pk_capture
SET note = 'updated'
WHERE organization_id = '11111111-1111-1111-1111-111111111111'
  AND a = 1
  AND b = 2;

SELECT is(
  (
    SELECT pk
    FROM public.audit_table_changes
    WHERE table_name = 'pgtap_audit_pk_capture'
      AND organization_id = '11111111-1111-1111-1111-111111111111'
      AND op = 'UPDATE'
      AND pk = '{"a":1,"b":2}'::jsonb
    LIMIT 1
  ),
  '{"a":1,"b":2}'::jsonb,
  'UPDATE audit row captures composite PK (a,b)'
);

DELETE FROM public.pgtap_audit_pk_capture
WHERE organization_id = '11111111-1111-1111-1111-111111111111'
  AND a = 1
  AND b = 2;

SELECT is(
  (
    SELECT pk
    FROM public.audit_table_changes
    WHERE table_name = 'pgtap_audit_pk_capture'
      AND organization_id = '11111111-1111-1111-1111-111111111111'
      AND op = 'DELETE'
      AND pk = '{"a":1,"b":2}'::jsonb
    LIMIT 1
  ),
  '{"a":1,"b":2}'::jsonb,
  'DELETE audit row captures composite PK (a,b)'
);

INSERT INTO public.pgtap_audit_pk_capture (organization_id, a, b, note)
VALUES ('11111111-1111-1111-1111-111111111111', 3, 4, 'to-truncate');

TRUNCATE TABLE public.pgtap_audit_pk_capture;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.audit_table_changes
    WHERE table_name = 'pgtap_audit_pk_capture'
      AND organization_id = '00000000-0000-0000-0000-000000000000'
      AND op = 'TRUNCATE'
      AND pk IS NULL
  ),
  'TRUNCATE audit row is recorded with pk NULL'
);

SELECT finish();
ROLLBACK;
